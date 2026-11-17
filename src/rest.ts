// REST v3 under /api/v3: every reply is application/json (never HTML), carries a
// non-empty X-GitHub-Request-Id, and reports errors as a JSON body with a string
// message. A repository under another owner answers 404, never 403. Single-object
// reads serve a cached body until the repository's tracker generation moves.

import { isObjectId, ZERO_OID } from './objects.ts';
import { FIXED_ISO, type Comment, type Issue, type PullRequest, type Repo } from './store.ts';
import { VIEWER_ID, VIEWER_LOGIN } from './viewer.ts';
import { addComment, createIssue, createPullRequest, createRepoAction, mergePullRequest, setIssueState } from './actions.ts';
import {
  booleanField,
  decodeSegment,
  isRecord,
  jsonBody,
  sendBytes,
  sendEmpty,
  sendError,
  sendJson,
  stringField,
  type Ctx,
} from './respond.ts';

const SCOPES = 'repo, read:org';

/** A REST reply: JSON plus the token's scopes. */
function restJson(ctx: Ctx, status: number, body: unknown, extra: Record<string, string> = {}): void {
  sendJson(ctx, status, body, { 'x-oauth-scopes': SCOPES, ...extra });
}

/** A REST error reply: JSON with a string message, plus the scopes. */
function restError(ctx: Ctx, status: number, message: string): void {
  sendError(ctx, status, message, { 'x-oauth-scopes': SCOPES });
}

// --------------------------------------------------------------------------- shapes

function userJson(): Record<string, unknown> {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', site_admin: false };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.databaseId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

export function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    comments: issue.comments.length,
    user: userJson(),
    assignee: null,
    assignees: [],
    locked: false,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: issue.state === 'closed' ? FIXED_ISO : null,
  };
}

export function commentJson(comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: comment.authorLogin, id: VIEWER_ID, type: 'User' },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

/** A pull request's head/base shas resolve to the branches' current tips (the creation shas when a branch is gone). */
export function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  const headSha = repo.branchTip(pull.headRef) ?? pull.headShaAtCreate;
  const baseSha = repo.branchTip(pull.baseRef) ?? pull.baseShaAtCreate;
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: userJson(),
    draft: false,
    locked: false,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: pull.state === 'closed' ? FIXED_ISO : null,
  };
}

/** Parse `Name <email> timestamp tz` into the author/committer shape; fall back to fixed values. */
function identityJson(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: '', email: '', date: FIXED_ISO };
  const timestamp = Number(match[3]);
  const date = Number.isFinite(timestamp) ? new Date(timestamp * 1000).toISOString() : FIXED_ISO;
  return { name: match[1] as string, email: match[2] as string, date };
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> | null {
  const view = repo.commitOf(oid);
  if (view === null) return null;
  return {
    sha: oid,
    commit: {
      // The stored object keeps git's trailing newline; the API serves the
      // message the way GitHub does, without it.
      message: view.message.replace(/\n+$/, ''),
      author: identityJson(view.author),
      committer: identityJson(view.committer),
    },
    parents: view.parents.map((parent) => ({ sha: parent })),
  };
}

// --------------------------------------------------------------------------- helpers

/** A cached single-object read: the cached bytes while the generation holds, else freshly serialized. */
function cachedObject(ctx: Ctx, repo: Repo, key: string, build: () => Record<string, unknown>): void {
  const cached = repo.restCache.get(key);
  if (cached !== undefined && cached.gen === repo.dataGen) {
    sendBytes(ctx, 200, cached.body, 'application/json; charset=utf-8', { 'x-oauth-scopes': SCOPES });
    return;
  }
  const text = `${JSON.stringify(build())}\n`;
  const body = Buffer.from(text, 'utf8');
  repo.restCache.set(key, { gen: repo.dataGen, body });
  sendBytes(ctx, 200, body, 'application/json; charset=utf-8', { 'x-oauth-scopes': SCOPES });
}

/** A page of items plus the Link header for the next page, when there is one. */
function paginate<T>(ctx: Ctx, items: readonly T[], path: string): { page: T[]; link: string | null } {
  const rawPerPage = Number.parseInt(ctx.query.get('per_page') ?? '', 10);
  const perPage = Number.isFinite(rawPerPage) ? Math.min(100, Math.max(1, rawPerPage)) : 30;
  const rawPage = Number.parseInt(ctx.query.get('page') ?? '', 10);
  const page = Number.isFinite(rawPage) ? Math.max(1, rawPage) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const link = start + perPage < items.length ? `<http://${ctx.host}${path}?per_page=${perPage}&page=${page + 1}>; rel="next"` : null;
  return { page: slice, link };
}

/** Resolve a ref query (?ref=): a branch name, a commit id, or the default branch. */
function resolveRefTip(repo: Repo, ref: string | null): string | undefined {
  if (ref === null || ref === '') return repo.headOid();
  const branch = repo.branchTip(ref);
  if (branch !== undefined) return branch;
  if (isObjectId(ref) && repo.commitOf(ref) !== null) return ref;
  return undefined;
}

/** The issues of a list query, ordered by the requested sort and direction. */
function listedIssues(repo: Repo, ctx: Ctx): Issue[] {
  const state = ctx.query.get('state') ?? 'open';
  let issues = [...repo.issues.values()];
  if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
  const ascending = ctx.query.get('direction') === 'asc';
  issues.sort((a, b) => (ascending ? a.number - b.number : b.number - a.number));
  return issues;
}

/** The pull requests of a list query. */
function listedPulls(repo: Repo, ctx: Ctx): PullRequest[] {
  const state = ctx.query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
  pulls.sort((a, b) => b.number - a.number);
  return pulls;
}

// --------------------------------------------------------------------------- contents

/** Read a file or directory from a commit's tree. */
function readContents(ctx: Ctx, repo: Repo, path: string): void {
  const tip = resolveRefTip(repo, ctx.query.get('ref'));
  if (tip === undefined) {
    restError(ctx, 404, 'Not Found');
    return;
  }
  const flat = repo.flatOfCommit(tip);
  if (flat === null) {
    restError(ctx, 404, 'Not Found');
    return;
  }
  const direct = flat.get(path);
  if (direct !== undefined) {
    const object = repo.getObject(direct.oid);
    if (object === undefined) {
      restError(ctx, 404, 'Not Found');
      return;
    }
    const name = path.split('/').pop() as string;
    restJson(ctx, 200, {
      type: 'file',
      encoding: 'base64',
      content: object.data.toString('base64'),
      sha: direct.oid,
      size: object.data.length,
      name,
      path,
    });
    return;
  }
  // A directory: the immediate children of the path (the root when the path is empty).
  const prefix = path === '' ? '' : `${path}/`;
  const children = new Map<string, { type: 'file' | 'dir'; sha: string }>();
  for (const key of flat.keys()) {
    if (prefix !== '' && !key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    if (rest === '') continue;
    const slash = rest.indexOf('/');
    if (slash < 0) {
      const entry = flat.get(key) as { oid: string };
      children.set(rest, { type: 'file', sha: entry.oid });
    } else {
      const dir = rest.slice(0, slash);
      if (!children.has(dir)) children.set(dir, { type: 'dir', sha: '' });
    }
  }
  if (children.size === 0) {
    restError(ctx, 404, 'Not Found');
    return;
  }
  // Directory entries carry their tree ids: resolve each child directory's tree.
  const view = repo.commitOf(tip);
  const treeShas = new Map<string, string>();
  if (view !== null) {
    const walk = (treeOid: string, dir: string): void => {
      const entries = repo.treeOf(treeOid);
      if (entries === null) return;
      for (const entry of entries) {
        if (entry.mode !== '40000') continue;
        const childDir = dir === '' ? entry.name : `${dir}/${entry.name}`;
        treeShas.set(childDir, entry.oid);
        walk(entry.oid, childDir);
      }
    };
    walk(view.tree, '');
  }
  const items = [...children.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([name, child]) => ({
      type: child.type,
      name,
      path: prefix === '' ? name : `${prefix}${name}`,
      sha: child.type === 'dir' ? (treeShas.get(prefix === '' ? name : `${prefix}${name}`) ?? ZERO_OID) : child.sha,
    }));
  restJson(ctx, 200, items);
}

/** Write (create or update) a file, or delete it, through the contents API. */
function writeContents(ctx: Ctx, repo: Repo, path: string, body: unknown, isDelete: boolean): void {
  const branch = stringField(body, 'branch') ?? repo.defaultBranch;
  const message = stringField(body, 'message') ?? '';
  const sha = stringField(body, 'sha');
  let tip = repo.branchTip(branch);
  if (tip === undefined && branch !== repo.defaultBranch) tip = repo.headOid();
  const flat = tip === undefined ? new Map<string, { oid: string; mode: string }>() : (repo.flatOfCommit(tip) ?? new Map());
  const existing = flat.get(path);

  if (isDelete) {
    if (existing === undefined) {
      restError(ctx, 404, 'Not Found');
      return;
    }
    if (sha !== undefined && sha !== existing.oid) {
      restError(ctx, 409, 'sha does not match the current file content');
      return;
    }
    flat.delete(path);
    const treeOid = repo.buildTreeFromFlat(flat);
    const commitOid = repo.createCommit(treeOid, tip === undefined ? [] : [tip], message);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    repo.bumpGit();
    restJson(ctx, 200, { commit: { sha: commitOid } });
    return;
  }

  const content = stringField(body, 'content');
  if (content === undefined) {
    restError(ctx, 422, 'content is required');
    return;
  }
  if (existing !== undefined) {
    if (sha !== undefined && sha !== existing.oid) {
      restError(ctx, 409, 'sha does not match the current file content');
      return;
    }
  } else if (sha !== undefined) {
    restError(ctx, 409, 'sha does not match the current file content');
    return;
  }
  const blobData = Buffer.from(content, 'base64');
  const blobOid = repo.putObject('blob', blobData);
  flat.set(path, { oid: blobOid, mode: existing?.mode ?? '100644' });
  const treeOid = repo.buildTreeFromFlat(flat);
  const commitOid = repo.createCommit(treeOid, tip === undefined ? [] : [tip], message);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  repo.bumpGit();
  restJson(ctx, existing === undefined ? 201 : 200, {
    content: {
      sha: blobOid,
      encoding: 'base64',
      name: path.split('/').pop() as string,
      path,
      size: blobData.length,
    },
    commit: { sha: commitOid },
  });
}

// --------------------------------------------------------------------------- routing

/** Handle an /api/v3 request. Authentication has already passed in the dispatcher. */
export function handleRest(ctx: Ctx): void {
  const raw = ctx.pathname === '/api/v3' ? '' : ctx.pathname.slice('/api/v3/'.length);
  const segments = raw === '' ? [] : raw.split('/').map(decodeSegment);
  try {
    // The API root and the meta endpoint.
    if (segments.length === 0) {
      if (ctx.method === 'GET') {
        restJson(ctx, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' });
      } else {
        restError(ctx, 404, 'Not Found');
      }
      return;
    }
    if (segments.length === 1 && segments[0] === 'meta') {
      if (ctx.method === 'GET') restJson(ctx, 200, { installed_version: '1.0.0' });
      else restError(ctx, 404, 'Not Found');
      return;
    }
    if (segments.length === 1 && segments[0] === 'user') {
      if (ctx.method === 'GET') restJson(ctx, 200, userJson());
      else restError(ctx, 404, 'Not Found');
      return;
    }
    // The token owner's repositories: list (paginated) and create.
    if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
      if (ctx.method === 'GET') {
        const { page, link } = paginate(ctx, ctx.store.listRepos(), '/api/v3/user/repos');
        restJson(ctx, 200, page.map(repoJson), link === null ? {} : { link });
        return;
      }
      if (ctx.method === 'POST') {
        const body = jsonBody(ctx);
        const name = stringField(body, 'name') ?? '';
        const created = createRepoAction(
          ctx.store,
          name,
          stringField(body, 'description') ?? '',
          booleanField(body, 'private') ?? false,
        );
        if (!created.ok) {
          restError(ctx, created.status, created.message);
          return;
        }
        restJson(ctx, 201, repoJson(created.value));
        return;
      }
      restError(ctx, 404, 'Not Found');
      return;
    }
    // Everything below is a repository route: /repos/{owner}/{repo}/...
    if (segments.length < 3 || segments[0] !== 'repos') {
      restError(ctx, 404, 'Not Found');
      return;
    }
    const owner = segments[1] as string;
    const repoName = segments[2] as string;
    const repo = ctx.store.getRepo(owner, repoName);
    if (repo === null) {
      restError(ctx, 404, 'Not Found');
      return;
    }
    const tail = segments.slice(3);

    // The repository itself: read, patch, delete.
    if (tail.length === 0) {
      if (ctx.method === 'GET') {
        cachedObject(ctx, repo, 'repo', () => repoJson(repo));
        return;
      }
      if (ctx.method === 'PATCH') {
        const body = jsonBody(ctx);
        const description = stringField(body, 'description');
        if (description !== undefined) repo.description = description;
        const isPrivate = booleanField(body, 'private');
        if (isPrivate !== undefined) repo.isPrivate = isPrivate;
        const defaultBranch = stringField(body, 'default_branch');
        if (defaultBranch !== undefined) repo.defaultBranch = defaultBranch;
        repo.touch();
        restJson(ctx, 200, repoJson(repo));
        return;
      }
      if (ctx.method === 'DELETE') {
        ctx.store.deleteRepo(repoName);
        sendEmpty(ctx, 204, { 'x-oauth-scopes': SCOPES });
        return;
      }
      restError(ctx, 404, 'Not Found');
      return;
    }

    const head = tail[0] as string;

    // Branches.
    if (head === 'branches') {
      if (tail.length === 1) {
        if (ctx.method !== 'GET') {
          restError(ctx, 404, 'Not Found');
          return;
        }
        const branches = [...repo.refs.keys()]
          .filter((name) => name.startsWith('refs/heads/'))
          .map((name) => name.slice('refs/heads/'.length))
          .sort()
          .map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`) as string } }));
        restJson(ctx, 200, branches);
        return;
      }
      const branch = tail.slice(1).join('/');
      const tip = repo.branchTip(branch);
      if (ctx.method === 'GET' && tip !== undefined) {
        restJson(ctx, 200, { name: branch, commit: { sha: tip } });
      } else {
        restError(ctx, 404, 'Not Found');
      }
      return;
    }

    // Commits.
    if (head === 'commits') {
      if (tail.length === 1) {
        if (ctx.method !== 'GET') {
          restError(ctx, 404, 'Not Found');
          return;
        }
        const tip = resolveRefTip(repo, ctx.query.get('sha'));
        if (tip === undefined) {
          restError(ctx, 404, 'Not Found');
          return;
        }
        const walked = repo.walkCommits(tip);
        const items: Record<string, unknown>[] = [];
        for (const entry of walked) {
          const json = commitJson(repo, entry.oid);
          if (json !== null) items.push(json);
        }
        restJson(ctx, 200, items);
        return;
      }
      const json = ctx.method === 'GET' ? commitJson(repo, tail[1] as string) : null;
      if (json !== null) restJson(ctx, 200, json);
      else restError(ctx, 404, 'Not Found');
      return;
    }

    // Contents: files and directories.
    if (head === 'contents') {
      const path = tail.slice(1).join('/');
      if (ctx.method === 'GET') {
        readContents(ctx, repo, path);
        return;
      }
      if (ctx.method === 'PUT' || ctx.method === 'DELETE') {
        if (path === '') {
          restError(ctx, 404, 'Not Found');
          return;
        }
        writeContents(ctx, repo, path, jsonBody(ctx), ctx.method === 'DELETE');
        return;
      }
      restError(ctx, 404, 'Not Found');
      return;
    }

    // Git Data: refs.
    if (head === 'git' && tail[1] === 'refs') {
      if (tail.length === 2) {
        if (ctx.method === 'POST') {
          const body = jsonBody(ctx);
          const ref = stringField(body, 'ref') ?? '';
          const sha = stringField(body, 'sha') ?? '';
          if (!ref.startsWith('refs/') || !isObjectId(sha) || repo.getObject(sha) === undefined) {
            restError(ctx, 422, 'ref and sha are required and the sha must exist');
            return;
          }
          if (repo.refs.has(ref)) {
            restError(ctx, 422, `Reference ${ref} already exists`);
            return;
          }
          repo.refs.set(ref, sha);
          repo.bumpGit();
          restJson(ctx, 201, { ref, object: { sha } });
          return;
        }
        if (ctx.method === 'GET') {
          const refs = [...repo.refs.keys()].sort().map((ref) => ({ ref, object: { sha: repo.refs.get(ref) as string } }));
          restJson(ctx, 200, refs);
          return;
        }
        restError(ctx, 404, 'Not Found');
        return;
      }
      const ref = `refs/${tail.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (ctx.method === 'GET' && sha !== undefined) {
        restJson(ctx, 200, { ref, object: { sha } });
      } else {
        restError(ctx, 404, 'Not Found');
      }
      return;
    }

    // Labels.
    if (head === 'labels') {
      if (tail.length !== 1) {
        restError(ctx, 404, 'Not Found');
        return;
      }
      if (ctx.method === 'GET') {
        restJson(ctx, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
        return;
      }
      if (ctx.method === 'POST') {
        const body = jsonBody(ctx);
        const name = stringField(body, 'name') ?? '';
        if (name === '') {
          restError(ctx, 422, 'name is required');
          return;
        }
        if (repo.labels.has(name.toLowerCase())) {
          restError(ctx, 422, `Label ${name} already exists`);
          return;
        }
        const label = { name, color: stringField(body, 'color') ?? '000000' };
        repo.labels.set(name.toLowerCase(), label);
        repo.touch();
        restJson(ctx, 201, { name: label.name, color: label.color });
        return;
      }
      restError(ctx, 404, 'Not Found');
      return;
    }

    // Issues and their comments.
    if (head === 'issues') {
      if (tail.length === 1) {
        if (ctx.method === 'GET') {
          const { page } = paginate(ctx, listedIssues(repo, ctx), `/api/v3/repos/${owner}/${repoName}/issues`);
          restJson(ctx, 200, page.map(issueJson));
          return;
        }
        if (ctx.method === 'POST') {
          const body = jsonBody(ctx);
          const title = stringField(body, 'title') ?? '';
          const labelNames = isRecord(body) && Array.isArray(body.labels) ? body.labels.filter((entry): entry is string => typeof entry === 'string') : [];
          const created = createIssue(ctx.store, repo, title, stringField(body, 'body') ?? '', labelNames);
          if (!created.ok) {
            restError(ctx, created.status, created.message);
            return;
          }
          restJson(ctx, 201, issueJson(created.value));
          return;
        }
        restError(ctx, 404, 'Not Found');
        return;
      }
      const number = Number.parseInt(tail[1] as string, 10);
      const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
      if (issue === undefined) {
        restError(ctx, 404, 'Not Found');
        return;
      }
      if (tail.length === 2) {
        if (ctx.method === 'GET') {
          cachedObject(ctx, repo, `issue:${number}`, () => issueJson(issue));
          return;
        }
        if (ctx.method === 'PATCH') {
          const body = jsonBody(ctx);
          const title = stringField(body, 'title');
          if (title !== undefined) issue.title = title;
          const bodyText = stringField(body, 'body');
          if (bodyText !== undefined) issue.body = bodyText;
          const state = stringField(body, 'state');
          if (state !== undefined) {
            if (state !== 'open' && state !== 'closed') {
              restError(ctx, 422, 'state must be open or closed');
              return;
            }
            setIssueState(repo, issue, state);
          }
          if (title !== undefined || bodyText !== undefined) repo.touch();
          restJson(ctx, 200, issueJson(issue));
          return;
        }
        restError(ctx, 404, 'Not Found');
        return;
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (ctx.method === 'GET') {
          restJson(ctx, 200, issue.comments.map(commentJson));
          return;
        }
        if (ctx.method === 'POST') {
          const body = jsonBody(ctx);
          const text = stringField(body, 'body');
          if (text === undefined) {
            restError(ctx, 422, 'body is required');
            return;
          }
          const comment = addComment(ctx.store, repo, issue, text, VIEWER_LOGIN);
          restJson(ctx, 201, commentJson(comment));
          return;
        }
      }
      restError(ctx, 404, 'Not Found');
      return;
    }

    // Pull requests, their files, and their merges.
    if (head === 'pulls') {
      if (tail.length === 1) {
        if (ctx.method === 'GET') {
          const { page } = paginate(ctx, listedPulls(repo, ctx), `/api/v3/repos/${owner}/${repoName}/pulls`);
          restJson(ctx, 200, page.map((pull) => pullJson(repo, pull)));
          return;
        }
        if (ctx.method === 'POST') {
          const body = jsonBody(ctx);
          const created = createPullRequest(
            ctx.store,
            repo,
            stringField(body, 'title') ?? '',
            stringField(body, 'body') ?? '',
            stringField(body, 'head') ?? '',
            stringField(body, 'base') ?? '',
          );
          if (!created.ok) {
            restError(ctx, created.status, created.message);
            return;
          }
          restJson(ctx, 201, pullJson(repo, created.value));
          return;
        }
        restError(ctx, 404, 'Not Found');
        return;
      }
      const number = Number.parseInt(tail[1] as string, 10);
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) {
        restError(ctx, 404, 'Not Found');
        return;
      }
      if (tail.length === 2) {
        if (ctx.method === 'GET') {
          cachedObject(ctx, repo, `pull:${number}`, () => pullJson(repo, pull));
          return;
        }
        restError(ctx, 404, 'Not Found');
        return;
      }
      if (tail.length === 3 && tail[2] === 'files') {
        if (ctx.method !== 'GET') {
          restError(ctx, 404, 'Not Found');
          return;
        }
        const baseTip = repo.branchTip(pull.baseRef) ?? pull.baseShaAtCreate;
        const headTip = repo.branchTip(pull.headRef) ?? pull.headShaAtCreate;
        const baseFlat = repo.flatOfCommit(baseTip);
        const headFlat = repo.flatOfCommit(headTip);
        if (baseFlat === null || headFlat === null) {
          restError(ctx, 404, 'Not Found');
          return;
        }
        const files = repo.diffFiles(baseFlat, headFlat).map((change) => ({
          filename: change.path,
          status: change.status,
          additions: change.additions,
          deletions: change.deletions,
          changes: change.changes,
        }));
        restJson(ctx, 200, files);
        return;
      }
      if (tail.length === 3 && tail[2] === 'merge') {
        if (ctx.method !== 'PUT') {
          restError(ctx, 404, 'Not Found');
          return;
        }
        const merged = mergePullRequest(repo, pull);
        if (!merged.ok) {
          restError(ctx, merged.status, merged.message);
          return;
        }
        restJson(ctx, 200, { sha: merged.value.sha, merged: true, message: 'Pull request successfully merged' });
        return;
      }
      restError(ctx, 404, 'Not Found');
      return;
    }

    restError(ctx, 404, 'Not Found');
  } catch (err) {
    if (err instanceof SyntaxError) {
      restError(ctx, 400, 'Invalid JSON body');
      return;
    }
    restError(ctx, 500, err instanceof Error ? err.message : 'Internal Server Error');
  }
}
