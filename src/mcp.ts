// MCP at /mcp: JSON-RPC 2.0 over Streamable HTTP, speaking the modern 2026-07-28
// era (server/discover, no handshake, no session) with the legacy initialize
// handshake as a fallback. Six tools act on the same store as REST, through the
// shared actions, so an object created over MCP is the same object over REST.

import { createIssue, createPullRequest, createRepoAction, mergePullRequest } from './actions.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import type { Repo } from './store.ts';
import { isRecord, sendEmpty, sendJson, type Ctx } from './respond.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';

/** The six tools, in a fixed order, serialized identically on every tools/list call. */
const TOOLS: ReadonlyArray<Record<string, unknown>> = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'The repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from one branch into another.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

/** Read an argument by its canonical name, then by the documented synonyms. */
function toolArg(args: Record<string, unknown>, canonical: string, synonyms: readonly string[]): unknown {
  if (args[canonical] !== undefined) return args[canonical];
  for (const synonym of synonyms) if (args[synonym] !== undefined) return args[synonym];
  return undefined;
}

function stringArg(args: Record<string, unknown>, canonical: string, synonyms: readonly string[]): string | undefined {
  const value = toolArg(args, canonical, synonyms);
  return typeof value === 'string' ? value : undefined;
}

/** Resolve the owner/repo pair, accepting a combined full_name as well. */
function repoOf(ctx: Ctx, args: Record<string, unknown>): Repo | null {
  let owner = stringArg(args, 'owner', ['owner_login', 'org', 'user', 'login', 'namespace']);
  let repoName = stringArg(args, 'repo', ['repository', 'repository_name', 'repo_name', 'project']);
  if ((owner === undefined || repoName === undefined) && typeof args.full_name === 'string') {
    const slash = args.full_name.indexOf('/');
    if (slash > 0) {
      owner = owner ?? args.full_name.slice(0, slash);
      repoName = repoName ?? args.full_name.slice(slash + 1);
    }
  }
  if (owner === undefined || repoName === undefined) return null;
  return ctx.store.getRepo(owner, repoName);
}

interface ToolOutcome {
  /** A JSON-RPC error code, when the call itself is refused (unknown tool, missing argument). */
  rpcError?: { code: number; message: string };
  /** A tool execution error, reported as isError:true with the message as its text. */
  toolError?: string;
  /** The tool's value, when it succeeded. */
  value?: unknown;
}

function missing(what: string): ToolOutcome {
  return { rpcError: { code: -32602, message: `missing required argument: ${what}` } };
}

function callTool(ctx: Ctx, name: string, args: Record<string, unknown>): ToolOutcome {
  switch (name) {
    case 'create_repo': {
      const repoName = stringArg(args, 'name', ['repo', 'repository', 'repository_name']);
      if (repoName === undefined || repoName === '') return missing('name');
      const description = stringArg(args, 'description', ['about', 'summary', 'body']) ?? '';
      const isPrivate = toolArg(args, 'private', ['is_private']) === true;
      const created = createRepoAction(ctx.store, repoName, description, isPrivate);
      if (!created.ok) return { toolError: created.message };
      return { value: repoJson(created.value) };
    }
    case 'get_repo': {
      const repo = repoOf(ctx, args);
      if (repo === null) {
        if (stringArg(args, 'owner', []) === undefined || stringArg(args, 'repo', []) === undefined) return missing('owner and repo');
        return { toolError: 'repository not found' };
      }
      return { value: repoJson(repo) };
    }
    case 'create_issue': {
      const repo = repoOf(ctx, args);
      if (repo === null) return missing('owner and repo');
      const title = stringArg(args, 'title', ['issue_title', 'subject']);
      if (title === undefined || title === '') return missing('title');
      const body = stringArg(args, 'body', ['issue_body', 'description', 'content', 'text']) ?? '';
      const created = createIssue(ctx.store, repo, title, body, []);
      if (!created.ok) return { toolError: created.message };
      return { value: issueJson(created.value) };
    }
    case 'list_issues': {
      const repo = repoOf(ctx, args);
      if (repo === null) return missing('owner and repo');
      const state = stringArg(args, 'state', ['status']) ?? 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => b.number - a.number);
      return { value: issues.map(issueJson) };
    }
    case 'create_pull_request': {
      const repo = repoOf(ctx, args);
      if (repo === null) return missing('owner and repo');
      const title = stringArg(args, 'title', ['pr_title', 'subject']);
      if (title === undefined || title === '') return missing('title');
      const head = stringArg(args, 'head', ['head_ref', 'head_branch', 'source', 'source_branch', 'from_branch', 'branch']);
      if (head === undefined || head === '') return missing('head');
      const base = stringArg(args, 'base', ['base_ref', 'base_branch', 'target', 'target_branch', 'into_branch']);
      if (base === undefined || base === '') return missing('base');
      const body = stringArg(args, 'body', ['description', 'content', 'text']) ?? '';
      const created = createPullRequest(ctx.store, repo, title, body, head, base);
      if (!created.ok) return { toolError: created.message };
      return { value: pullJson(repo, created.value) };
    }
    case 'merge_pull_request': {
      const repo = repoOf(ctx, args);
      if (repo === null) return missing('owner and repo');
      const raw = toolArg(args, 'pull_number', ['pull_request_number', 'pr_number', 'number', 'issue_number']);
      const number = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : undefined;
      if (number === undefined) return missing('pull_number');
      const pull = repo.pulls.get(number);
      if (pull === undefined) return { toolError: `pull request #${number} not found` };
      const merged = mergePullRequest(repo, pull);
      if (!merged.ok) return { toolError: merged.message };
      return { value: { sha: merged.value.sha, merged: true, message: 'Pull request successfully merged', number } };
    }
    default:
      return { rpcError: { code: -32602, message: `unknown tool ${JSON.stringify(name)}` } };
  }
}

/** Handle POST /mcp. Authentication has already passed in the dispatcher. */
export function handleMcp(ctx: Ctx): void {
  if (ctx.method === 'DELETE') {
    // A session close: this server holds no sessions, so there is nothing to end.
    sendEmpty(ctx, 200);
    return;
  }
  if (ctx.method !== 'POST') {
    sendJson(ctx, 404, { message: 'Not Found' });
    return;
  }
  let request: unknown;
  try {
    request = JSON.parse(ctx.body.toString('utf8')) as unknown;
  } catch {
    sendJson(ctx, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (!isRecord(request) || typeof request.method !== 'string') {
    sendJson(ctx, 200, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  // A notification carries no id and is acknowledged without a JSON-RPC answer.
  if (!('id' in request) || request.id === undefined) {
    sendEmpty(ctx, 202);
    return;
  }
  const id = request.id as string | number | null;
  const params = isRecord(request.params) ? request.params : {};

  const ok = (result: unknown): void => {
    sendJson(ctx, 200, { jsonrpc: '2.0', id, result });
  };
  const fail = (code: number, message: string): void => {
    sendJson(ctx, 200, { jsonrpc: '2.0', id, error: { code, message } });
  };

  switch (request.method) {
    case 'server/discover': {
      const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
      ok({
        supportedVersions: [PROTOCOL_VERSION],
        capabilities: { tools: {} },
        serverInfo,
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      });
      return;
    }
    case 'initialize': {
      const wanted = typeof params.protocolVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.protocolVersion) ? params.protocolVersion : '2025-11-25';
      ok({
        protocolVersion: wanted,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;
    }
    case 'ping': {
      ok({});
      return;
    }
    case 'tools/list': {
      ok({ tools: TOOLS });
      return;
    }
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      const outcome = callTool(ctx, toolName, args);
      if (outcome.rpcError !== undefined) {
        fail(outcome.rpcError.code, outcome.rpcError.message);
        return;
      }
      if (outcome.toolError !== undefined) {
        ok({ content: [{ type: 'text', text: outcome.toolError }], isError: true });
        return;
      }
      const text = JSON.stringify(outcome.value);
      ok({ content: [{ type: 'text', text }], structuredContent: outcome.value });
      return;
    }
    default:
      fail(-32601, `Method not found: ${request.method}`);
  }
}
