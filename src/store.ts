// The forge's one in-memory store: repositories, their git objects and refs, and the
// issues, pull requests, labels and comments that the REST, GraphQL and MCP surfaces
// all read and write. Everything is deterministic: server-created commits carry a
// fixed identity and timestamp, and every created/updated/merged timestamp is the same
// fixed instant, so two runs of the same requests hold the same bytes.

import {
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  type CommitView,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './objects.ts';
import { VIEWER_LOGIN } from './viewer.ts';

/** The fixed instant every server-created timestamp names (2025-01-01T00:00:00Z). */
export const FIXED_EPOCH = 1735689600;
export const FIXED_ISO = '2025-01-01T00:00:00Z';
/** The fixed author/committer line of every commit this server creates. */
export const SERVER_IDENT = `forge <forge@localhost> ${FIXED_EPOCH} +0000`;

export interface Label {
  readonly name: string;
  readonly color: string;
}

export interface Comment {
  readonly id: number;
  readonly body: string;
  readonly authorLogin: string;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  readonly comments: Comment[];
  readonly createdOrder: number;
}

export interface PullRequest {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  readonly headRef: string;
  readonly baseRef: string;
  readonly headShaAtCreate: string;
  readonly baseShaAtCreate: string;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly createdOrder: number;
}

/** One changed file of a pull request's diff. */
export interface FileChange {
  readonly path: string;
  readonly status: 'added' | 'removed' | 'modified';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

/** A flat tree: every file path to the blob (and mode) that holds it. */
export type FlatTree = Map<string, { oid: string; mode: string }>;

/** Count the lines of a blob's text the way a diff does (a trailing newline ends no line). */
function textLines(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** The length of the longest common subsequence of two line lists (two-row DP). */
function lcsLength(a: string[], b: string[]): number {
  const prev = new Array<number>(b.length + 1).fill(0);
  const curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] = a[i - 1] === b[j - 1] ? (prev[j - 1] as number) + 1 : Math.max(prev[j] as number, curr[j - 1] as number);
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j] as number;
  }
  return prev[b.length] as number;
}

/** Added/removed line counts between two blob versions, via their longest common subsequence. */
function lineDiffCounts(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const oldLines = oldData === null ? [] : textLines(oldData);
  const newLines = newData === null ? [] : textLines(newData);
  if (oldLines.length > 2000 || newLines.length > 2000) {
    // A huge file: fall back to a multiset difference rather than a quadratic diff.
    const counts = new Map<string, number>();
    for (const line of oldLines) counts.set(line, (counts.get(line) ?? 0) + 1);
    let additions = 0;
    for (const line of newLines) {
      const left = counts.get(line) ?? 0;
      if (left > 0) counts.set(line, left - 1);
      else additions += 1;
    }
    let deletions = 0;
    for (const left of counts.values()) deletions += left;
    return { additions, deletions };
  }
  const common = lcsLength(oldLines, newLines);
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

/** One repository: its objects, refs, and its tracker state. */
export class Repo {
  readonly name: string;
  readonly owner: string;
  readonly databaseId: number;
  description: string;
  isPrivate: boolean;
  defaultBranch = 'main';
  readonly createdOrder: number;

  readonly objects = new Map<string, GitObject>();
  readonly refs = new Map<string, string>();
  /** Cached git wire bytes (advertisements, ls-refs answers, fetch packs), cleared on every git mutation. */
  readonly gitCache = new Map<string, Buffer>();
  /** The tracker generation: bumped on every issue/pull/label/comment change, invalidating cached REST bodies. */
  dataGen = 0;
  /** Cached REST bodies for single-object reads, keyed with the generation that produced them. */
  readonly restCache = new Map<string, { gen: number; body: Buffer }>();
  readonly labels = new Map<string, Label>();
  readonly issues = new Map<number, Issue>();
  readonly pulls = new Map<number, PullRequest>();
  nextNumber = 1;

  readonly #commitCache = new Map<string, CommitView>();
  readonly #treeCache = new Map<string, TreeEntry[]>();

  constructor(name: string, owner: string, databaseId: number, createdOrder: number, description: string, isPrivate: boolean) {
    this.name = name;
    this.owner = owner;
    this.databaseId = databaseId;
    this.createdOrder = createdOrder;
    this.description = description;
    this.isPrivate = isPrivate;
  }

  // ------------------------------------------------------------ objects and refs

  /** Store an object, hashing it; returns its id. Storing twice is a no-op. */
  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  /** Store an object whose id was already recomputed (a pack entry); returns the id. */
  putResolved(oid: string, object: GitObject): void {
    if (!this.objects.has(oid)) this.objects.set(oid, object);
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  /** A commit's parsed form, cached; null when the object is missing, not a commit, or malformed. */
  commitOf(oid: string): CommitView | null {
    const cached = this.#commitCache.get(oid);
    if (cached !== undefined) return cached;
    const object = this.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return null;
    try {
      const view = parseCommit(object.data);
      this.#commitCache.set(oid, view);
      return view;
    } catch {
      return null;
    }
  }

  /** A tree's parsed form, cached; null when the object is missing, not a tree, or malformed. */
  treeOf(oid: string): TreeEntry[] | null {
    const cached = this.#treeCache.get(oid);
    if (cached !== undefined) return cached;
    const object = this.objects.get(oid);
    if (object === undefined || object.type !== 'tree') return null;
    try {
      const entries = parseTree(object.data);
      this.#treeCache.set(oid, entries);
      return entries;
    } catch {
      return null;
    }
  }

  /** The tip of a branch (short name), or undefined when the branch does not exist. */
  branchTip(branch: string): string | undefined {
    return this.refs.get(`refs/heads/${branch}`);
  }

  /** The tip HEAD points at: the default branch's tip, or undefined when unborn. */
  headOid(): string | undefined {
    return this.branchTip(this.defaultBranch);
  }

  /** Drop every cached git wire answer: call after any change to objects or refs. */
  bumpGit(): void {
    this.gitCache.clear();
  }

  /** Note a tracker change: invalidates cached REST bodies for this repository. */
  touch(): void {
    this.dataGen += 1;
  }

  /** Follow tag objects to the commit they name; a commit id answers itself. Null when unreachable. */
  peelToCommit(oid: string): string | null {
    let current = oid;
    for (let hops = 0; hops < 16; hops += 1) {
      const object = this.objects.get(current);
      if (object === undefined) return null;
      if (object.type === 'commit') return current;
      if (object.type !== 'tag') return null;
      try {
        current = parseTag(object.data).object;
      } catch {
        return null;
      }
    }
    return null;
  }

  // ------------------------------------------------------------ history walks

  /** Commits reachable from a tip, newest first (depth-first, parents in order, each once). */
  walkCommits(tipOid: string): Array<{ oid: string; view: CommitView }> {
    const out: Array<{ oid: string; view: CommitView }> = [];
    const seen = new Set<string>();
    const stack: string[] = [tipOid];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const view = this.commitOf(oid);
      if (view === null) continue;
      out.push({ oid, view });
      for (let i = view.parents.length - 1; i >= 0; i -= 1) stack.push(view.parents[i] as string);
    }
    return out;
  }

  /** True when `ancestor` is reachable from `descendant` (or the two are the same commit). */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack: string[] = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const view = this.commitOf(oid);
      if (view === null) continue;
      for (const parent of view.parents) stack.push(parent);
    }
    return false;
  }

  /** The nearest common ancestor of two commits (the merge base), or null when unrelated. */
  mergeBase(a: string, b: string): string | null {
    const ancestorsOfA = new Set<string>();
    const stackA: string[] = [a];
    while (stackA.length > 0) {
      const oid = stackA.pop() as string;
      if (ancestorsOfA.has(oid)) continue;
      ancestorsOfA.add(oid);
      const view = this.commitOf(oid);
      if (view === null) continue;
      for (const parent of view.parents) stackA.push(parent);
    }
    const seen = new Set<string>();
    const stackB: string[] = [b];
    while (stackB.length > 0) {
      const oid = stackB.pop() as string;
      if (ancestorsOfA.has(oid)) return oid;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const view = this.commitOf(oid);
      if (view === null) continue;
      for (const parent of view.parents) stackB.push(parent);
    }
    return null;
  }

  // ------------------------------------------------------------ trees

  /** Flatten a tree into path -> blob, recursing into directories. Gitlinks are leaves. */
  flattenTree(treeOid: string, prefix: string, out: FlatTree): void {
    const entries = this.treeOf(treeOid);
    if (entries === null) throw new Error(`tree ${treeOid} is missing`);
    for (const entry of entries) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') this.flattenTree(entry.oid, path, out);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  }

  /** A commit's whole tree flattened; null when the commit is missing. */
  flatOfCommit(commitOid: string): FlatTree | null {
    const view = this.commitOf(commitOid);
    if (view === null) return null;
    const flat: FlatTree = new Map();
    this.flattenTree(view.tree, '', flat);
    return flat;
  }

  /** Build (and store) the nested trees for a flat map; returns the root tree's id. */
  buildTreeFromFlat(flat: FlatTree): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, entry] of flat) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const part = parts[i] as string;
        let child = node.dirs.get(part);
        if (child === undefined) {
          child = { files: new Map(), dirs: new Map() };
          node.dirs.set(part, child);
        }
        node = child;
      }
      node.files.set(parts[parts.length - 1] as string, entry);
    }
    const materialize = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: materialize(child) });
      return this.putObject('tree', buildTree(entries));
    };
    return materialize(root);
  }

  /** Create a commit with the server's fixed identity and timestamp; returns its id. */
  createCommit(treeOid: string, parents: readonly string[], message: string): string {
    const data = buildCommit({ tree: treeOid, parents, message, author: SERVER_IDENT, committer: SERVER_IDENT });
    return this.putObject('commit', data);
  }

  // ------------------------------------------------------------ diffs and merges

  /** The file-by-file diff between two flattened trees (base -> head). */
  diffFiles(baseFlat: FlatTree, headFlat: FlatTree): FileChange[] {
    const changes: FileChange[] = [];
    const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
    for (const path of [...paths].sort()) {
      const base = baseFlat.get(path);
      const head = headFlat.get(path);
      if (base !== undefined && head !== undefined && base.oid === head.oid) continue;
      const oldData = base === undefined ? null : (this.objects.get(base.oid)?.data ?? null);
      const newData = head === undefined ? null : (this.objects.get(head.oid)?.data ?? null);
      const counts = lineDiffCounts(oldData, newData);
      const status = base === undefined ? 'added' : head === undefined ? 'removed' : 'modified';
      changes.push({ path, status, additions: counts.additions, deletions: counts.deletions, changes: counts.additions + counts.deletions });
    }
    return changes;
  }

  /**
   * A three-way merge of the head tip onto the base tip, against their merge base.
   * Returns the merged tree's id, or the conflicting paths when both sides changed
   * the same path differently from the base.
   */
  threeWayMerge(baseTip: string, headTip: string): { treeOid: string } | { conflict: string[] } {
    const base = this.mergeBase(baseTip, headTip);
    const baseFlat: FlatTree = base === null ? new Map() : (this.flatOfCommit(base) ?? new Map());
    const oursFlat = this.flatOfCommit(baseTip) ?? new Map();
    const theirsFlat = this.flatOfCommit(headTip) ?? new Map();
    const merged: FlatTree = new Map();
    const conflicts: string[] = [];
    const paths = new Set<string>([...baseFlat.keys(), ...oursFlat.keys(), ...theirsFlat.keys()]);
    for (const path of paths) {
      const b = baseFlat.get(path);
      const o = oursFlat.get(path);
      const t = theirsFlat.get(path);
      const same = (x: { oid: string } | undefined, y: { oid: string } | undefined): boolean =>
        (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid);
      if (same(o, t)) {
        if (o !== undefined) merged.set(path, o);
      } else if (same(b, o)) {
        if (t !== undefined) merged.set(path, t);
      } else if (same(b, t)) {
        if (o !== undefined) merged.set(path, o);
      } else {
        conflicts.push(path);
      }
    }
    if (conflicts.length > 0) return { conflict: conflicts.sort() };
    return { treeOid: this.buildTreeFromFlat(merged) };
  }
}

/** Every repository this process holds, keyed by lowercase name (GitHub matches names case-insensitively). */
export class Store {
  readonly repos = new Map<string, Repo>();
  nextDatabaseId = 1;
  nextEntityId = 1;
  #orderCounter = 0;

  /** Create a repository; null when a repository of that name already exists. */
  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    const key = name.toLowerCase();
    if (this.repos.has(key)) return null;
    const repo = new Repo(name, VIEWER_LOGIN, this.nextDatabaseId, this.#orderCounter, description, isPrivate);
    this.nextDatabaseId += 1;
    this.#orderCounter += 1;
    this.repos.set(key, repo);
    return repo;
  }

  /** A repository by owner and name; a foreign owner never resolves, it 404s. */
  getRepo(owner: string, name: string): Repo | null {
    if (owner !== VIEWER_LOGIN) return null;
    return this.repos.get(name.toLowerCase()) ?? null;
  }

  /** Delete a repository and everything in it. */
  deleteRepo(name: string): boolean {
    return this.repos.delete(name.toLowerCase());
  }  /** Every repository, in creation order. */
  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdOrder - b.createdOrder);
  }

  /** The next stable entity id (issues, pull requests, comments share one counter). */
  nextId(): number {
    const id = this.nextEntityId;
    this.nextEntityId += 1;
    return id;
  }
}
