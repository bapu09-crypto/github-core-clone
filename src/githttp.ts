// Git smart HTTP: the `/{owner}/{repo}.git` surface. upload-pack speaks protocol v2
// (capability advertisement, ls-refs, fetch) with a v0 fallback; receive-pack is v0
// only. Repositories are created via REST alone: a push never invents one, and a
// missing repository answers 404 on info/refs while the server stays up. Every ref
// update must fast-forward; a refused ref is reported per ref while the pack still
// unpacks. Generated wire bytes are cached per repository and dropped on any git
// mutation, so repeated identical clones cost one pack generation.

import {
  ZERO_OID,
  encodePktLine,
  encodePktLines,
  isObjectId,
  pktDelim,
  pktFlush,
  PktReader,
  readPack,
  writePack,
  type GitObject,
} from './objects.ts';
import type { Repo } from './store.ts';
import { sendBytes, sendError, type Ctx } from './respond.ts';

const UPLOAD_ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_ADVERTISEMENT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

/** The v2 capability advertisement: it names no refs, so it is one constant. */
const V2_ADVERTISEMENT = encodePktLines(['version 2\n', 'ls-refs=unborn\n', 'fetch=shallow\n', 'flush']);

/** The capabilities a v0 upload-pack advertisement carries (shallow is required for v0 depth fetches). */
function uploadCaps(repo: Repo): string {
  return `side-band-64k symref=HEAD:refs/heads/${repo.defaultBranch} thin-pack ofs-delta shallow`;
}

/** The capabilities a v0 receive-pack advertisement carries. */
function receiveCaps(): string {
  return 'report-status side-band-64k delete-refs';
}

/** A ref's peeled commit, when the ref points at an annotated tag. */
function peeledOf(repo: Repo, oid: string): string | null {
  const object = repo.getObject(oid);
  if (object === undefined || object.type !== 'tag') return null;
  return repo.peelToCommit(oid);
}

/** The v0 ref advertisement: the service preamble, the refs, and the capabilities on the first line. */
function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const cached = repo.gitCache.get(service === 'git-upload-pack' ? 'adv:upload:0' : 'adv:receive:0');
  if (cached !== undefined) return cached;
  const caps = service === 'git-upload-pack' ? uploadCaps(repo) : receiveCaps();
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), pktFlush()];
  const names = [...repo.refs.keys()].sort();
  if (names.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const head = repo.headOid();
    const headLine = head === undefined ? `${ZERO_OID} HEAD\0${caps}\n` : `${head} HEAD\0${caps}\n`;
    parts.push(encodePktLine(headLine));
    for (const name of names) {
      const oid = repo.refs.get(name) as string;
      parts.push(encodePktLine(`${oid} ${name}\n`));
      const peeled = peeledOf(repo, oid);
      if (peeled !== null) parts.push(encodePktLine(`${peeled} ${name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  const out = Buffer.concat(parts);
  repo.gitCache.set(service === 'git-upload-pack' ? 'adv:upload:0' : 'adv:receive:0', out);
  return out;
}

/** Split a pkt-line body into its data lines (delim/flush packets become section breaks). */
function bodySections(body: Buffer): string[][] {
  const reader = new PktReader(body);
  const sections: string[][] = [[]];
  for (;;) {
    const packet = reader.next();
    if (packet === null) break;
    if (packet.kind === 'data') (sections[sections.length - 1] as string[]).push(packet.payload.toString('utf8'));
    else if (packet.kind === 'delim' || packet.kind === 'flush') sections.push([]);
  }
  return sections;
}

// --------------------------------------------------------------------------- ls-refs

/** Answer a v2 ls-refs command. Ref-prefix filtering is server-side: with a prefix, HEAD is not returned. */
function lsRefs(repo: Repo, args: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    const line = arg.replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const cacheKey = `ls:${peel ? 1 : 0}${symrefs ? 1 : 0}${unborn ? 1 : 0}:${prefixes.join(',')}`;
  const cached = repo.gitCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const head = repo.headOid();
  if (matches('HEAD')) {
    if (head !== undefined) {
      lines.push(symrefs ? `${head} HEAD symref-target:refs/heads/${repo.defaultBranch}\n` : `${head} HEAD\n`);
    } else if (unborn) {
      lines.push(symrefs ? `unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n` : 'unborn HEAD\n');
    }
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name) as string;
    let line = `${oid} ${name}`;
    if (peel) {
      const peeled = peeledOf(repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  const out = encodePktLines([...lines, 'flush']);
  repo.gitCache.set(cacheKey, out);
  return out;
}

// --------------------------------------------------------------------------- fetch planning

interface FetchRequest {
  wants: string[];
  haves: string[];
  depth: number | null;
  shallow: string[];
}

/** Walk a tree's closure, calling `visit` for the tree and every entry beneath it. */
function walkTree(repo: Repo, treeOid: string, visit: (oid: string) => void, seen: Set<string>): void {
  if (seen.has(treeOid)) return;
  seen.add(treeOid);
  visit(treeOid);
  const entries = repo.treeOf(treeOid);
  if (entries === null) return;
  for (const entry of entries) {
    if (entry.mode === '40000') walkTree(repo, entry.oid, visit, seen);
    else visit(entry.oid);
  }
}

/**
 * Plan a fetch: the objects to pack, the acknowledgments, and the shallow boundary.
 * The haves closure is cut at the client's declared shallow boundaries (a deepen must
 * still deliver the parents past a boundary the client holds shallow), and the walk
 * from the wants stops at the requested depth.
 */
function planFetch(repo: Repo, request: FetchRequest): { pack: Buffer; acks: string[]; shallow: string[]; unshallow: string[] } {
  const boundarySet = new Set(request.shallow);

  // The objects the client already holds: the haves' closures, never past a boundary.
  const haveSet = new Set<string>();
  const haveSeen = new Set<string>();
  const haveStack = [...request.haves];
  while (haveStack.length > 0) {
    const oid = haveStack.pop() as string;
    if (haveSeen.has(oid)) continue;
    haveSeen.add(oid);
    const object = repo.getObject(oid);
    if (object === undefined) continue;
    haveSet.add(oid);
    if (object.type === 'commit') {
      const view = repo.commitOf(oid);
      if (view !== null) {
        walkTree(repo, view.tree, (entry) => haveSet.add(entry), new Set<string>());
        if (!boundarySet.has(oid)) for (const parent of view.parents) haveStack.push(parent);
      }
    } else if (object.type === 'tree') {
      walkTree(repo, oid, (entry) => haveSet.add(entry), new Set<string>());
    } else if (object.type === 'tag') {
      const peeled = repo.peelToCommit(oid);
      if (peeled !== null) haveStack.push(peeled);
    }
  }

  // The wants' commits, breadth-first so depth is the shortest distance from a want.
  const commits: string[] = [];
  const commitSet = new Set<string>();
  const boundary: string[] = [];
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const want of request.wants) {
    const peeled = repo.peelToCommit(want);
    if (peeled !== null) queue.push({ oid: peeled, depth: 1 });
  }
  const seenCommits = new Set<string>();
  for (let head = 0; head < queue.length; head += 1) {
    const { oid, depth } = queue[head] as { oid: string; depth: number };
    if (seenCommits.has(oid)) continue;
    seenCommits.add(oid);
    const view = repo.commitOf(oid);
    if (view === null) continue;
    commits.push(oid);
    commitSet.add(oid);
    if (request.depth !== null && depth >= request.depth) {
      if (view.parents.length > 0) boundary.push(oid);
      continue;
    }
    for (const parent of view.parents) queue.push({ oid: parent, depth: depth + 1 });
  }

  // The pack: the walked commits, their trees and blobs, and any direct wants,
  // minus everything the client holds. Order is deterministic (walk order).
  const packMap = new Map<string, GitObject>();
  const addIfNew = (oid: string): void => {
    if (haveSet.has(oid) || packMap.has(oid)) return;
    const object = repo.getObject(oid);
    if (object !== undefined) packMap.set(oid, object);
  };
  for (const oid of commits) addIfNew(oid);
  for (const oid of commits) {
    const view = repo.commitOf(oid);
    if (view !== null) walkTree(repo, view.tree, addIfNew, new Set<string>());
  }
  for (const want of request.wants) {
    const object = repo.getObject(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      addIfNew(want);
      const peeled = repo.peelToCommit(want);
      if (peeled !== null && !commitSet.has(peeled)) {
        const view = repo.commitOf(peeled);
        if (view !== null) walkTree(repo, view.tree, addIfNew, new Set<string>());
      }
    } else if (object.type === 'tree') {
      walkTree(repo, want, addIfNew, new Set<string>());
    } else if (object.type === 'blob') {
      addIfNew(want);
    }
  }

  const boundaryNames = new Set(boundary);
  const unshallow = request.shallow.filter((oid) => commitSet.has(oid) && !boundaryNames.has(oid));
  const acks = request.haves.filter((oid) => repo.getObject(oid) !== undefined);
  return { pack: writePack(packMap.values()), acks, shallow: boundary, unshallow };
}

/** Split pack bytes into sideband band-1 packets, each within the pkt-line limit. */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (parts.length === 0) parts.push(encodePktLine(Buffer.from([1])));
  return parts;
}

/** A v2 fetch answer: acknowledgments, shallow-info, and the packfile section. */
function fetchV2(repo: Repo, request: FetchRequest): Buffer {
  const cacheKey = `f2:${request.wants.join(',')}|${request.haves.join(',')}|${request.depth ?? ''}|${request.shallow.join(',')}`;
  const cached = repo.gitCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const planned = planFetch(repo, request);
  const parts: Buffer[] = [encodePktLine('acknowledgments\n')];
  if (planned.acks.length > 0) {
    for (const ack of planned.acks) parts.push(encodePktLine(`ACK ${ack}\n`));
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  parts.push(pktDelim());
  if (planned.shallow.length > 0 || planned.unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of planned.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of planned.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(...sidebandPack(planned.pack));
  parts.push(pktFlush());
  const out = Buffer.concat(parts);
  repo.gitCache.set(cacheKey, out);
  return out;
}

/** A v0 fetch answer: acknowledgments and shallow lines, then the sideband pack. */
function fetchV0(repo: Repo, request: FetchRequest): Buffer {
  const cacheKey = `f0:${request.wants.join(',')}|${request.haves.join(',')}|${request.depth ?? ''}|${request.shallow.join(',')}`;
  const cached = repo.gitCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const planned = planFetch(repo, request);
  const parts: Buffer[] = [];
  if (planned.acks.length > 0) {
    for (const ack of planned.acks) parts.push(encodePktLine(`ACK ${ack}\n`));
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  for (const oid of planned.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of planned.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPack(planned.pack));
  parts.push(pktFlush());
  const out = Buffer.concat(parts);
  repo.gitCache.set(cacheKey, out);
  return out;
}

// --------------------------------------------------------------------------- upload-pack

/** Parse a v2 command request (command line, delimiter, arguments) or a v0 want/have request. */
function handleUploadPack(repo: Repo, body: Buffer): Buffer {
  const sections = bodySections(body);
  const first = sections[0] ?? [];
  const commandLine = (first[0] ?? '').replace(/\n$/, '');
  if (commandLine.startsWith('command=')) {
    const command = commandLine.slice('command='.length);
    const args = sections[1] ?? [];
    if (command === 'ls-refs') return lsRefs(repo, args);
    if (command === 'fetch') {
      const request: FetchRequest = { wants: [], haves: [], depth: null, shallow: [] };
      for (const arg of args) {
        const line = arg.replace(/\n$/, '');
        if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
        else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
        else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) {
          const depth = Number.parseInt(line.slice(7).trim(), 10);
          if (Number.isFinite(depth) && depth >= 1) request.depth = depth;
        }
      }
      return fetchV2(repo, request);
    }
    throw new Error(`unknown upload-pack command ${JSON.stringify(command)}`);
  }
  // v0: wants (with shallow/deepen) in the first section, haves in the second.
  const request: FetchRequest = { wants: [], haves: [], depth: null, shallow: [] };
  for (const line of first) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) {
      const rest = text.slice(5);
      const oid = rest.split(' ')[0] as string;
      if (isObjectId(oid)) request.wants.push(oid);
    } else if (text.startsWith('shallow ')) request.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const depth = Number.parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(depth) && depth >= 1) request.depth = depth;
    }
  }
  for (const section of sections.slice(1)) {
    for (const line of section) {
      const text = line.replace(/\n$/, '');
      if (text.startsWith('have ')) request.haves.push(text.slice(5).trim());
    }
  }
  return fetchV0(repo, request);
}

// --------------------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** The report-status answer, pkt-lined inside band-1 sideband packets. */
function pushReport(results: Array<{ ref: string; ok: boolean; reason: string }>, unpackOk: boolean): Buffer {
  const inner: Buffer[] = [encodePktLine(unpackOk ? 'unpack ok\n' : 'unpack error\n')];
  for (const result of results) {
    inner.push(encodePktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  inner.push(pktFlush());
  const innerBytes = Buffer.concat(inner);
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < innerBytes.length; offset += CHUNK) {
    const chunk = innerBytes.subarray(offset, Math.min(innerBytes.length, offset + CHUNK));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/**
 * Apply a receive-pack exchange: unpack the pack (always, even when every ref is
 * refused), then apply each command that fast-forwards and refuse the rest per ref.
 */
function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const reader = new PktReader(body);
  const commands: PushCommand[] = [];
  for (;;) {
    const packet = reader.next();
    if (packet === null) throw new Error('receive-pack command list ended before a flush');
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length !== 3) throw new Error(`bad push command ${JSON.stringify(line.slice(0, 60))}`);
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isObjectId(oldOid) || !isObjectId(newOid) || !ref.startsWith('refs/')) {
      throw new Error(`bad push command ${JSON.stringify(line.slice(0, 60))}`);
    }
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) throw new Error('receive-pack needs at least one command');
  const packBytes = reader.rest();
  const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);

  // Unpack first: refused updates still store their objects.
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes, { resolveBase: (oid) => repo.getObject(oid) });
      for (const [oid, object] of read.objects) repo.putResolved(oid, object);
    } catch {
      return pushReport(
        commands.map((command) => ({ ref: command.ref, ok: false, reason: 'unpack error' })),
        false,
      );
    }
  } else if (updatesRef) {
    return pushReport(
      commands.map((command) => ({ ref: command.ref, ok: false, reason: 'unpack error' })),
      false,
    );
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  let changed = false;
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // A delete: the ref must exist and the old value must match (or be unsaid).
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(command.ref);
        changed = true;
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (repo.getObject(command.newOid) === undefined) {
      results.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (current === undefined) {
      if (command.oldOid !== ZERO_OID) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        changed = true;
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (command.oldOid !== current) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (command.newOid === current) {
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (!repo.isAncestor(current, command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    changed = true;
    results.push({ ref: command.ref, ok: true, reason: '' });
  }
  if (changed || packBytes.length > 0) repo.bumpGit();
  return pushReport(results, true);
}

// --------------------------------------------------------------------------- routing

/** Handle a `/{owner}/{repo}.git/...` request. The repository must already exist. */
export function handleGit(ctx: Ctx, owner: string, repoName: string, rest: string): void {
  const repo = ctx.store.getRepo(owner, repoName);
  if (repo === null) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  try {
    if (ctx.method === 'GET' && rest === '/info/refs') {
      const service = ctx.query.get('service');
      if (service === 'git-upload-pack') {
        const wantsV2 = (ctx.req.headers['git-protocol'] ?? '') === 'version=2';
        if (wantsV2) {
          sendBytes(ctx, 200, V2_ADVERTISEMENT, UPLOAD_ADVERTISEMENT);
        } else {
          sendBytes(ctx, 200, advertiseV0(repo, 'git-upload-pack'), UPLOAD_ADVERTISEMENT);
        }
        return;
      }
      if (service === 'git-receive-pack') {
        sendBytes(ctx, 200, advertiseV0(repo, 'git-receive-pack'), RECEIVE_ADVERTISEMENT);
        return;
      }
      sendError(ctx, 404, 'Not Found');
      return;
    }
    if (ctx.method === 'POST' && rest === '/git-upload-pack') {
      sendBytes(ctx, 200, handleUploadPack(repo, ctx.body), UPLOAD_RESULT);
      return;
    }
    if (ctx.method === 'POST' && rest === '/git-receive-pack') {
      sendBytes(ctx, 200, handleReceivePack(repo, ctx.body), RECEIVE_RESULT);
      return;
    }
    sendError(ctx, 404, 'Not Found');
  } catch (err) {
    // A malformed exchange never kills the server: answer 400 and keep serving.
    sendError(ctx, 400, err instanceof Error ? err.message : 'Bad Request');
  }
}
