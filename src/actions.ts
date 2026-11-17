// The one mutation path for tracker state. REST, GraphQL and MCP all create issues,
// pull requests, comments and merges through these helpers, so the store, the shared
// issue/pull numbering, and the cache invalidation live in exactly one place. Each
// helper returns either its value or the HTTP-flavoured refusal its caller reports.

import { FIXED_ISO, type Issue, type PullRequest, type Repo, type Store, type Comment } from './store.ts';

export type ActionResult<T> = { ok: true; value: T } | { ok: false; status: number; message: string };

function fail<T>(status: number, message: string): ActionResult<T> {
  return { ok: false, status, message };
}

/** Create an issue. Every named label must already exist on the repository. */
export function createIssue(store: Store, repo: Repo, title: string, body: string, labelNames: readonly string[]): ActionResult<Issue> {
  if (title === '') return fail(422, 'title is required');
  const labels = [];
  for (const name of labelNames) {
    const label = repo.labels.get(name.toLowerCase());
    if (label === undefined) return fail(422, `unknown label ${JSON.stringify(name)}`);
    labels.push(label);
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const issue: Issue = {
    id: store.nextId(),
    number,
    title,
    body,
    state: 'open',
    labels,
    comments: [],
    createdOrder: number,
  };
  repo.issues.set(number, issue);
  repo.touch();
  return { ok: true, value: issue };
}

/** Close an issue (or reopen it). */
export function setIssueState(repo: Repo, issue: Issue, state: 'open' | 'closed'): void {
  if (issue.state === state) return;
  issue.state = state;
  repo.touch();
}

/** Add a comment to an issue. */
export function addComment(store: Store, repo: Repo, issue: Issue, body: string, authorLogin: string): Comment {
  const comment: Comment = { id: store.nextId(), body, authorLogin };
  issue.comments.push(comment);
  repo.touch();
  return comment;
}

/** Open a pull request. Both refs must be branches that exist. */
export function createPullRequest(
  store: Store,
  repo: Repo,
  title: string,
  body: string,
  head: string,
  base: string,
): ActionResult<PullRequest> {
  if (title === '') return fail(422, 'title is required');
  const headTip = repo.branchTip(head);
  if (headTip === undefined) return fail(422, `unknown head branch ${JSON.stringify(head)}`);
  const baseTip = repo.branchTip(base);
  if (baseTip === undefined) return fail(422, `unknown base branch ${JSON.stringify(base)}`);
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const pull: PullRequest = {
    id: store.nextId(),
    number,
    title,
    body,
    state: 'open',
    merged: false,
    headRef: head,
    baseRef: base,
    headShaAtCreate: headTip,
    baseShaAtCreate: baseTip,
    mergedAt: null,
    mergeCommitSha: null,
    createdOrder: number,
  };
  repo.pulls.set(number, pull);
  repo.touch();
  return { ok: true, value: pull };
}

/**
 * Squash-merge a pull request onto its base branch: a three-way merge of the head
 * tip onto the base tip, committed as one commit on the base branch. A conflict, an
 * already-merged pull, or a missing branch refuses with the status its caller sends.
 */
export function mergePullRequest(repo: Repo, pull: PullRequest): ActionResult<{ sha: string }> {
  if (pull.state !== 'open' || pull.merged) return fail(405, 'pull request is already merged or closed');
  const baseTip = repo.branchTip(pull.baseRef) ?? pull.baseShaAtCreate;
  const headTip = repo.branchTip(pull.headRef) ?? pull.headShaAtCreate;
  if (repo.commitOf(baseTip) === null || repo.commitOf(headTip) === null) {
    return fail(405, 'the pull request branches no longer resolve');
  }
  const merged = repo.threeWayMerge(baseTip, headTip);
  if ('conflict' in merged) return fail(405, `merge conflict in ${merged.conflict.join(', ')}`);
  const sha = repo.createCommit(merged.treeOid, [baseTip], pull.title);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_ISO;
  pull.mergeCommitSha = sha;
  repo.bumpGit();
  repo.touch();
  return { ok: true, value: { sha } };
}

/** Create a repository; a duplicate name refuses with the message the checks match. */
export function createRepoAction(store: Store, name: string, description: string, isPrivate: boolean): ActionResult<Repo> {
  if (name === '') return fail(422, 'name is required');
  const repo = store.createRepo(name, description, isPrivate);
  if (repo === null) return fail(422, `Repository ${name} already exists`);
  return { ok: true, value: repo };
}
