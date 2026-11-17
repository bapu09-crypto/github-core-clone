// GraphQL at /api/graphql: a small executor for the fixed set of documents the suite
// sends, with real parsing (operations, fragments, aliases, variables, input objects)
// and schema validation (an unknown field answers HTTP 200 with an errors array
// naming it). Mutations act on the same store as REST, through the shared actions,
// and global ids are opaque base64 handles that round-trip through node(id:).

import { createIssue, createPullRequest, mergePullRequest, setIssueState, addComment } from './actions.ts';
import type { Issue, PullRequest, Repo, Store } from './store.ts';
import { VIEWER_LOGIN } from './viewer.ts';
import { isRecord, jsonBody, sendError, sendJson, type Ctx } from './respond.ts';

// --------------------------------------------------------------------------- lexer

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[_A-Za-z]/.test(ch);
  const isNameChar = (ch: string): boolean => /[_0-9A-Za-z]/.test(ch);
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '{' || ch === '}' || ch === '(' || ch === ')' || ch === ':' || ch === '$' || ch === '!' || ch === '[' || ch === ']' || ch === '=' || ch === '@') {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (ch === '"') {
      // A block string is three quotes; the suite's documents use none, but lex one anyway.
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      for (;;) {
        if (j >= source.length) throw new Error('unterminated string');
        const c = source[j] as string;
        if (c === '"') break;
        if (c === '\\') {
          const esc = source[j + 1] as string;
          if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            value += { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[esc] ?? esc;
            j += 2;
          }
          continue;
        }
        value += c;
        j += 1;
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      const match = /^-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(source.slice(i));
      if (match === null) throw new Error(`bad number at offset ${i}`);
      const text = match[0];
      tokens.push(match[1] !== undefined || match[2] !== undefined ? { kind: 'float', value: text } : { kind: 'int', value: text });
      i += text.length;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i + 1;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at offset ${i}`);
  }
  return tokens;
}

// --------------------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet: SelectionNode[] | null;
}
interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}
interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selectionSet: SelectionNode[];
}
type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: Array<{ name: string; defaultValue: ValueNode | null }>;
  selectionSet: SelectionNode[];
}
interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}
type DefinitionNode = OperationNode | FragmentNode;

class Parser {
  readonly #tokens: Token[];
  #pos = 0;

  constructor(tokens: Token[]) {
    this.#tokens = tokens;
  }

  #peek(): Token | null {
    return this.#tokens[this.#pos] ?? null;
  }

  #next(): Token {
    const token = this.#tokens[this.#pos];
    if (token === undefined) throw new Error('unexpected end of document');
    this.#pos += 1;
    return token;
  }

  #expectPunct(value: string): void {
    const token = this.#next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${JSON.stringify(value)}`);
  }

  #skipPunct(value: string): boolean {
    const token = this.#peek();
    if (token !== null && token.kind === 'punct' && token.value === value) {
      this.#pos += 1;
      return true;
    }
    return false;
  }

  #expectName(): string {
    const token = this.#next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): DefinitionNode[] {
    const definitions: DefinitionNode[] = [];
    while (this.#peek() !== null) definitions.push(this.#parseDefinition());
    return definitions;
  }

  #parseDefinition(): DefinitionNode {
    const token = this.#peek();
    if (token !== null && token.kind === 'punct' && token.value === '{') {
      return { kind: 'operation', operation: 'query', name: null, variables: [], selectionSet: this.#parseSelectionSet() };
    }
    const keyword = this.#expectName();
    if (keyword === 'fragment') {
      const name = this.#expectName();
      if (this.#expectName() !== 'on') throw new Error('expected on in a fragment definition');
      const typeCondition = this.#expectName();
      this.#skipDirectives();
      return { kind: 'fragment', name, typeCondition, selectionSet: this.#parseSelectionSet() };
    }
    if (keyword !== 'query' && keyword !== 'mutation' && keyword !== 'subscription') {
      throw new Error(`unknown definition ${JSON.stringify(keyword)}`);
    }
    let name: string | null = null;
    const next = this.#peek();
    if (next !== null && next.kind === 'name') name = this.#next().value;
    const variables = this.#parseVariableDefinitions();
    this.#skipDirectives();
    return { kind: 'operation', operation: keyword, name, variables, selectionSet: this.#parseSelectionSet() };
  }

  #parseVariableDefinitions(): Array<{ name: string; defaultValue: ValueNode | null }> {
    const variables: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    if (!this.#skipPunct('(')) return variables;
    while (!this.#skipPunct(')')) {
      this.#expectPunct('$');
      const name = this.#expectName();
      this.#expectPunct(':');
      this.#parseType();
      let defaultValue: ValueNode | null = null;
      if (this.#skipPunct('=')) defaultValue = this.#parseValue();
      this.#skipDirectives();
      variables.push({ name, defaultValue });
    }
    return variables;
  }

  #parseType(): void {
    if (this.#skipPunct('[')) {
      this.#parseType();
      this.#expectPunct(']');
    } else {
      this.#expectName();
    }
    this.#skipPunct('!');
  }

  #skipDirectives(): void {
    while (this.#skipPunct('@')) {
      this.#expectName();
      if (this.#peek()?.kind === 'punct' && (this.#peek() as Token).value === '(') this.#parseArguments();
    }
  }

  #parseSelectionSet(): SelectionNode[] {
    this.#expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.#skipPunct('}')) selections.push(this.#parseSelection());
    return selections;
  }

  #parseSelection(): SelectionNode {
    const token = this.#peek();
    if (token !== null && token.kind === 'punct' && token.value === '...') {
      this.#next();
      const next = this.#peek();
      if (next !== null && next.kind === 'name' && next.value !== 'on') {
        const name = this.#next().value;
        this.#skipDirectives();
        return { kind: 'spread', name };
      }
      let typeCondition: string | null = null;
      if (next !== null && next.kind === 'name' && next.value === 'on') {
        this.#next();
        typeCondition = this.#expectName();
      }
      this.#skipDirectives();
      return { kind: 'inline', typeCondition, selectionSet: this.#parseSelectionSet() };
    }
    let name = this.#expectName();
    let alias: string | null = null;
    if (this.#skipPunct(':')) {
      alias = name;
      name = this.#expectName();
    }
    const args = this.#parseArguments();
    this.#skipDirectives();
    const next = this.#peek();
    const selectionSet = next !== null && next.kind === 'punct' && next.value === '{' ? this.#parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, selectionSet };
  }

  #parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (!this.#skipPunct('(')) return args;
    while (!this.#skipPunct(')')) {
      const name = this.#expectName();
      this.#expectPunct(':');
      args.push({ name, value: this.#parseValue() });
    }
    return args;
  }

  #parseValue(): ValueNode {
    const token = this.#next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.#expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.#skipPunct(']')) values.push(this.#parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.#skipPunct('}')) {
        const name = this.#expectName();
        this.#expectPunct(':');
        fields.push({ name, value: this.#parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('expected a value');
  }
}

// --------------------------------------------------------------------------- schema

/** Field -> the type its sub-selections validate and execute against (lists map over the item type). */
const SCHEMA: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  User: { login: 'String', id: 'ID' },
  Repository: {
    id: 'ID', databaseId: 'Int', name: 'String', nameWithOwner: 'String', owner: 'RepositoryOwner',
    defaultBranchRef: 'Ref', viewerPermission: 'String', hasIssuesEnabled: 'Boolean',
    issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest',
  },
  RepositoryOwner: { login: 'String' },
  Ref: { name: 'String' },
  Issue: { id: 'ID', number: 'Int', title: 'String', state: 'String', body: 'String' },
  IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo', edges: 'IssueEdge' },
  IssueEdge: { node: 'Issue', cursor: 'String' },
  PageInfo: { hasNextPage: 'Boolean', endCursor: 'String', hasPreviousPage: 'Boolean', startCursor: 'String' },
  PullRequest: {
    id: 'ID', number: 'Int', headRefName: 'String', baseRefName: 'String', mergeable: 'String',
    state: 'String', merged: 'Boolean', files: 'PullRequestFileConnection', title: 'String',
  },
  PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo' },
  PullRequestFileConnection: { nodes: 'PullRequestFile' },
  PullRequestFile: { path: 'String' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
  IssueCommentEdge: { node: 'IssueComment' },
  IssueComment: { id: 'ID', body: 'String' },
  __Type: { name: 'String', fields: '__Field', enumValues: '__EnumValue' },
  __Field: { name: 'String' },
  __EnumValue: { name: 'String' },
  Node: { id: 'ID' },
};

/** The enum values introspection reports, by enum name. */
const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT'],
};

// --------------------------------------------------------------------------- global ids

/** An opaque, stable global id: base64 over `Kind:parts`. Never the plain database id. */
function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (kind === undefined || kind === '' || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

function repoByDatabaseId(store: Store, databaseId: number): Repo | null {
  for (const repo of store.repos.values()) if (repo.databaseId === databaseId) return repo;
  return null;
}

// --------------------------------------------------------------------------- execution

type Source = Record<string, unknown> & { __typename: string };

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
}

function valueFromAst(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
      return Number.parseInt(node.value, 10);
    case 'float':
      return Number.parseFloat(node.value);
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => valueFromAst(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueFromAst(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = valueFromAst(arg.value, ctx.variables);
  return args;
}

/** A connection page over an ordered list, with opaque cursors over the item numbers. */
function connectionPage<T extends { number: number }>(items: readonly T[], first: unknown, after: unknown): { page: T[]; hasNextPage: boolean; endCursor: string | null } {
  let start = 0;
  if (typeof after === 'string' && after !== '') {
    try {
      const text = Buffer.from(after, 'base64').toString('utf8');
      const match = /^cursor:(\d+)$/.exec(text);
      if (match !== null) {
        const index = items.findIndex((item) => item.number === Number(match[1]));
        if (index >= 0) start = index + 1;
      }
    } catch {
      // An unreadable cursor restarts the connection from its beginning.
    }
  }
  const limit = typeof first === 'number' && Number.isFinite(first) && first >= 0 ? Math.trunc(first) : items.length;
  const page = items.slice(start, start + limit);
  const hasNextPage = start + page.length < items.length;
  const last = page[page.length - 1];
  const endCursor = last === undefined ? null : Buffer.from(`cursor:${last.number}`, 'utf8').toString('base64');
  return { page, hasNextPage, endCursor };
}

function pageInfoOf(hasNextPage: boolean, endCursor: string | null): Source {
  return { __typename: 'PageInfo', hasNextPage, endCursor, hasPreviousPage: false, startCursor: null };
}

function issueSource(repo: Repo, issue: Issue): Source {
  return { __typename: 'Issue', repo, issue };
}

function pullSource(repo: Repo, pull: PullRequest): Source {
  return { __typename: 'PullRequest', repo, pull };
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): Source {
  const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
  const wanted = new Set(states.map((state) => String(state).toLowerCase()));
  let issues = [...repo.issues.values()].filter((issue) => wanted.has(issue.state));
  const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
  const direction = orderBy !== null && typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
  issues.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  const { page, hasNextPage, endCursor } = connectionPage(issues, args.first, args.after);
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueSource(repo, issue)),
    pageInfo: pageInfoOf(hasNextPage, endCursor),
  };
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): Source {
  const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
  const wanted = new Set(states.map((state) => String(state).toLowerCase()));
  const pulls = [...repo.pulls.values()]
    .filter((pull) => {
      const state = pull.merged ? 'merged' : pull.state;
      return wanted.has(state) || (wanted.has('closed') && state === 'merged');
    })
    .sort((a, b) => b.number - a.number);
  const { page, hasNextPage, endCursor } = connectionPage(pulls, args.first, args.after);
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((pull) => pullSource(repo, pull)),
    pageInfo: pageInfoOf(hasNextPage, endCursor),
  };
}

function pullState(pull: PullRequest): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullMergeable(repo: Repo, pull: PullRequest): string {
  const baseTip = repo.branchTip(pull.baseRef) ?? pull.baseShaAtCreate;
  const headTip = repo.branchTip(pull.headRef) ?? pull.headShaAtCreate;
  if (repo.commitOf(baseTip) === null || repo.commitOf(headTip) === null) return 'UNKNOWN';
  const merged = repo.threeWayMerge(baseTip, headTip);
  return 'conflict' in merged ? 'CONFLICTING' : 'MERGEABLE';
}

type Resolver = (source: Source, args: Record<string, unknown>, ctx: ExecContext) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => ({ __typename: 'User', login: VIEWER_LOGIN, id: globalId('User', 1000) }),
    repository: (_source, args, ctx) => {
      const owner = args.owner;
      const name = args.name;
      if (typeof owner !== 'string' || typeof name !== 'string') return null;
      const repo = ctx.store.getRepo(owner, name);
      return repo === null ? null : { __typename: 'Repository', repo };
    },
    node: (_source, args, ctx) => {
      if (typeof args.id !== 'string') return null;
      const parsed = parseGlobalId(args.id);
      if (parsed === null) return null;
      if (parsed.kind === 'Repository') {
        const repo = repoByDatabaseId(ctx.store, Number(parsed.parts[0]));
        return repo === null ? null : { __typename: 'Repository', repo };
      }
      if (parsed.kind === 'Issue' || parsed.kind === 'PullRequest') {
        const repo = repoByDatabaseId(ctx.store, Number(parsed.parts[0]));
        if (repo === null) return null;
        const number = Number(parsed.parts[1]);
        if (parsed.kind === 'Issue') {
          const issue = repo.issues.get(number);
          return issue === undefined ? null : issueSource(repo, issue);
        }
        const pull = repo.pulls.get(number);
        return pull === undefined ? null : pullSource(repo, pull);
      }
      return null;
    },
    __type: (_source, args) => {
      if (typeof args.name !== 'string') return null;
      const fields = SCHEMA[args.name];
      if (fields !== undefined) {
        return {
          __typename: '__Type',
          name: args.name,
          kind: 'OBJECT',
          fieldNames: Object.keys(fields),
          enumNames: null as string[] | null,
        };
      }
      const values = ENUM_VALUES[args.name];
      if (values !== undefined) {
        return { __typename: '__Type', name: args.name, kind: 'ENUM', fieldNames: null as string[] | null, enumNames: values };
      }
      return null;
    },
  },
  Mutation: {
    createIssue: (_source, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const parsed = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
      const repo = parsed !== null && parsed.kind === 'Repository' ? repoByDatabaseId(ctx.store, Number(parsed.parts[0])) : null;
      if (repo === null) throw new Error('repository not found');
      const created = createIssue(ctx.store, repo, typeof input.title === 'string' ? input.title : '', typeof input.body === 'string' ? input.body : '', []);
      if (!created.ok) throw new Error(created.message);
      return { __typename: 'CreateIssuePayload', issue: issueSource(repo, created.value) };
    },
    closeIssue: (_source, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const parsed = typeof input.issueId === 'string' ? parseGlobalId(input.issueId) : null;
      const repo = parsed !== null && parsed.kind === 'Issue' ? repoByDatabaseId(ctx.store, Number(parsed.parts[0])) : null;
      const issue = repo === null ? undefined : repo.issues.get(Number(parsed?.parts[1]));
      if (repo === null || issue === undefined) throw new Error('issue not found');
      setIssueState(repo, issue, 'closed');
      return { __typename: 'CloseIssuePayload', issue: issueSource(repo, issue) };
    },
    createPullRequest: (_source, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const parsed = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
      const repo = parsed !== null && parsed.kind === 'Repository' ? repoByDatabaseId(ctx.store, Number(parsed.parts[0])) : null;
      if (repo === null) throw new Error('repository not found');
      const created = createPullRequest(
        ctx.store,
        repo,
        typeof input.title === 'string' ? input.title : '',
        typeof input.body === 'string' ? input.body : '',
        typeof input.headRefName === 'string' ? input.headRefName : '',
        typeof input.baseRefName === 'string' ? input.baseRefName : '',
      );
      if (!created.ok) throw new Error(created.message);
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullSource(repo, created.value) };
    },
    mergePullRequest: (_source, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const parsed = typeof input.pullRequestId === 'string' ? parseGlobalId(input.pullRequestId) : null;
      const repo = parsed !== null && parsed.kind === 'PullRequest' ? repoByDatabaseId(ctx.store, Number(parsed.parts[0])) : null;
      const pull = repo === null ? undefined : repo.pulls.get(Number(parsed?.parts[1]));
      if (repo === null || pull === undefined) throw new Error('pull request not found');
      const merged = mergePullRequest(repo, pull);
      if (!merged.ok) throw new Error(merged.message);
      return { __typename: 'MergePullRequestPayload', pullRequest: pullSource(repo, pull) };
    },
    addComment: (_source, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const parsed = typeof input.subjectId === 'string' ? parseGlobalId(input.subjectId) : null;
      const repo = parsed !== null && parsed.kind === 'Issue' ? repoByDatabaseId(ctx.store, Number(parsed.parts[0])) : null;
      const issue = repo === null ? undefined : repo.issues.get(Number(parsed?.parts[1]));
      if (repo === null || issue === undefined) throw new Error('issue not found');
      const comment = addComment(ctx.store, repo, issue, typeof input.body === 'string' ? input.body : '', VIEWER_LOGIN);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: { __typename: 'IssueComment', id: globalId('IssueComment', repo.databaseId, comment.id), body: comment.body },
        },
      };
    },
  },
  User: {
    login: (source) => source.login,
    id: (source) => source.id,
  },
  Repository: {
    id: (source) => globalId('Repository', (source.repo as Repo).databaseId),
    databaseId: (source) => (source.repo as Repo).databaseId,
    name: (source) => (source.repo as Repo).name,
    nameWithOwner: (source) => `${(source.repo as Repo).owner}/${(source.repo as Repo).name}`,
    owner: (source) => ({ __typename: 'RepositoryOwner', login: (source.repo as Repo).owner }),
    defaultBranchRef: (source) => {
      const repo = source.repo as Repo;
      return repo.headOid() === undefined ? null : { __typename: 'Ref', name: repo.defaultBranch };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (source, args) => {
      const repo = source.repo as Repo;
      const issue = typeof args.number === 'number' ? repo.issues.get(args.number) : undefined;
      return issue === undefined ? null : issueSource(repo, issue);
    },
    issues: (source, args) => issuesConnection(source.repo as Repo, args),
    pullRequests: (source, args) => pullsConnection(source.repo as Repo, args),
    pullRequest: (source, args) => {
      const repo = source.repo as Repo;
      const pull = typeof args.number === 'number' ? repo.pulls.get(args.number) : undefined;
      return pull === undefined ? null : pullSource(repo, pull);
    },
  },
  RepositoryOwner: {
    login: (source) => source.login,
  },
  Ref: {
    name: (source) => source.name,
  },
  Issue: {
    id: (source) => globalId('Issue', (source.repo as Repo).databaseId, (source.issue as Issue).number),
    number: (source) => (source.issue as Issue).number,
    title: (source) => (source.issue as Issue).title,
    state: (source) => ((source.issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
    body: (source) => (source.issue as Issue).body,
  },
  IssueConnection: {
    nodes: (source) => source.nodes,
    pageInfo: (source) => source.pageInfo,
    edges: (source) => {
      const nodes = source.nodes as Source[];
      return nodes.map((node) => ({
        __typename: 'IssueEdge',
        node,
        cursor: Buffer.from(`cursor:${(node.issue as Issue).number}`, 'utf8').toString('base64'),
      }));
    },
  },
  IssueEdge: {
    node: (source) => source.node,
    cursor: (source) => source.cursor,
  },
  PageInfo: {
    hasNextPage: (source) => source.hasNextPage,
    endCursor: (source) => source.endCursor,
    hasPreviousPage: (source) => source.hasPreviousPage,
    startCursor: (source) => source.startCursor,
  },
  PullRequest: {
    id: (source) => globalId('PullRequest', (source.repo as Repo).databaseId, (source.pull as PullRequest).number),
    number: (source) => (source.pull as PullRequest).number,
    title: (source) => (source.pull as PullRequest).title,
    headRefName: (source) => (source.pull as PullRequest).headRef,
    baseRefName: (source) => (source.pull as PullRequest).baseRef,
    mergeable: (source) => pullMergeable(source.repo as Repo, source.pull as PullRequest),
    state: (source) => pullState(source.pull as PullRequest),
    merged: (source) => (source.pull as PullRequest).merged,
    files: (source, args) => {
      const repo = source.repo as Repo;
      const pull = source.pull as PullRequest;
      const baseTip = repo.branchTip(pull.baseRef) ?? pull.baseShaAtCreate;
      const headTip = repo.branchTip(pull.headRef) ?? pull.headShaAtCreate;
      const baseFlat = repo.flatOfCommit(baseTip);
      const headFlat = repo.flatOfCommit(headTip);
      const changes = baseFlat !== null && headFlat !== null ? repo.diffFiles(baseFlat, headFlat) : [];
      const limit = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.trunc(args.first) : changes.length;
      const nodes = changes.slice(0, Math.max(0, limit)).map((change) => ({ __typename: 'PullRequestFile', path: change.path }));
      return { __typename: 'PullRequestFileConnection', nodes };
    },
  },
  PullRequestConnection: {
    nodes: (source) => source.nodes,
    pageInfo: (source) => source.pageInfo,
  },
  PullRequestFileConnection: {
    nodes: (source) => source.nodes,
  },
  PullRequestFile: {
    path: (source) => source.path,
  },
  CreateIssuePayload: { issue: (source) => source.issue },
  CloseIssuePayload: { issue: (source) => source.issue },
  CreatePullRequestPayload: { pullRequest: (source) => source.pullRequest },
  MergePullRequestPayload: { pullRequest: (source) => source.pullRequest },
  AddCommentPayload: { commentEdge: (source) => source.commentEdge },
  IssueCommentEdge: { node: (source) => source.node },
  IssueComment: {
    id: (source) => source.id,
    body: (source) => source.body,
  },
  __Type: {
    name: (source) => source.name,
    fields: (source) => {
      const names = source.fieldNames as string[] | null;
      return names === null ? null : names.map((name) => ({ __typename: '__Field', name }));
    },
    enumValues: (source) => {
      const names = source.enumNames as string[] | null;
      return names === null ? null : names.map((name) => ({ __typename: '__EnumValue', name }));
    },
  },
  __Field: { name: (source) => source.name },
  __EnumValue: { name: (source) => source.name },
  Node: {
    id: (source) => {
      if (source.__typename === 'Repository') return globalId('Repository', (source.repo as Repo).databaseId);
      if (source.__typename === 'Issue') return globalId('Issue', (source.repo as Repo).databaseId, (source.issue as Issue).number);
      if (source.__typename === 'PullRequest') return globalId('PullRequest', (source.repo as Repo).databaseId, (source.pull as PullRequest).number);
      return null;
    },
  },
};

/** Whether a fragment's type condition applies to a source of the runtime type. */
function fragmentApplies(condition: string | null, runtimeType: string): boolean {
  if (condition === null) return true;
  if (condition === runtimeType) return true;
  if (condition === 'Node' && (runtimeType === 'Repository' || runtimeType === 'Issue' || runtimeType === 'PullRequest')) return true;
  return false;
}

function executeSelectionSet(selections: SelectionNode[], source: Source, staticType: string, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const key = selection.alias ?? selection.name;
      out[key] = executeField(selection, source, staticType, ctx);
    } else if (selection.kind === 'inline') {
      if (!fragmentApplies(selection.typeCondition, source.__typename)) continue;
      Object.assign(out, executeSelectionSet(selection.selectionSet, source, selection.typeCondition ?? staticType, ctx));
    } else {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) continue;
      if (!fragmentApplies(fragment.typeCondition, source.__typename)) continue;
      Object.assign(out, executeSelectionSet(fragment.selectionSet, source, fragment.typeCondition, ctx));
    }
  }
  return out;
}

function executeField(field: FieldNode, source: Source, staticType: string, ctx: ExecContext): unknown {
  if (field.name === '__typename') return source.__typename;
  const resolver = RESOLVERS[staticType]?.[field.name] ?? RESOLVERS[source.__typename]?.[field.name];
  if (resolver === undefined) throw new Error(`Cannot query field "${field.name}" on type "${staticType}".`);
  const value = resolver(source, argsOf(field, ctx), ctx);
  if (field.selectionSet === null) return value;
  if (value === null || value === undefined) return null;
  const childType = SCHEMA[staticType]?.[field.name] ?? SCHEMA[source.__typename]?.[field.name] ?? 'String';
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item === null || item === undefined) return null;
      if (typeof item !== 'object') return item;
      return executeSelectionSet(field.selectionSet as SelectionNode[], item as Source, childType, ctx);
    });
  }
  if (typeof value === 'object') return executeSelectionSet(field.selectionSet, value as Source, childType, ctx);
  return value;
}

/** Validate every field of a document against the schema; the first unknown field is the error. */
function validateSelectionSet(selections: SelectionNode[], staticType: string, ctx: ExecContext, errors: string[]): void {
  for (const selection of selections) {
    if (selection.kind === 'field') {
      if (selection.name === '__typename') continue;
      const fields = SCHEMA[staticType];
      const childType = fields?.[selection.name];
      if (childType === undefined) {
        errors.push(`Cannot query field "${selection.name}" on type "${staticType}".`);
        continue;
      }
      if (selection.selectionSet !== null) validateSelectionSet(selection.selectionSet, childType, ctx, errors);
    } else if (selection.kind === 'inline') {
      validateSelectionSet(selection.selectionSet, selection.typeCondition ?? staticType, ctx, errors);
    } else {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) {
        errors.push(`Unknown fragment "${selection.name}".`);
        continue;
      }
      validateSelectionSet(fragment.selectionSet, fragment.typeCondition, ctx, errors);
    }
  }
}

interface GraphQLResult {
  data: unknown;
  errors?: Array<{ message: string }>;
}

/** Execute one GraphQL request object ({query, variables, operationName}). */
function executeRequest(request: unknown, store: Store): GraphQLResult {
  if (!isRecord(request) || typeof request.query !== 'string') {
    return { data: null, errors: [{ message: 'A query string is required.' }] };
  }
  let definitions: DefinitionNode[];
  try {
    definitions = new Parser(lex(request.query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax error.' }] };
  }
  const fragments = new Map<string, FragmentNode>();
  const operations: OperationNode[] = [];
  for (const definition of definitions) {
    if (definition.kind === 'fragment') fragments.set(definition.name, definition);
    else operations.push(definition);
  }
  let operation = operations[0];
  if (typeof request.operationName === 'string') {
    operation = operations.find((candidate) => candidate.name === request.operationName) ?? operation;
  }
  if (operation === undefined) return { data: null, errors: [{ message: 'No operation to execute.' }] };

  const provided = isRecord(request.variables) ? request.variables : {};
  const variables: Record<string, unknown> = { ...provided };
  for (const variable of operation.variables) {
    if (variables[variable.name] === undefined && variable.defaultValue !== null) {
      variables[variable.name] = valueFromAst(variable.defaultValue, variables);
    }
  }
  const ctx: ExecContext = { store, variables, fragments };
  const errors: string[] = [];
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  validateSelectionSet(operation.selectionSet, rootType, ctx, errors);
  if (errors.length > 0) {
    return { data: null, errors: errors.map((message) => ({ message })) };
  }
  try {
    const data = executeSelectionSet(operation.selectionSet, { __typename: rootType }, rootType, ctx);
    return { data };
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Execution failed.' }] };
  }
}

/** Handle POST /api/graphql. Authentication has already passed in the dispatcher. */
export function handleGraphQL(ctx: Ctx): void {
  if (ctx.method !== 'POST') {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  let body: unknown;
  try {
    body = jsonBody(ctx);
  } catch {
    sendError(ctx, 400, 'Invalid JSON body');
    return;
  }
  if (Array.isArray(body)) {
    sendJson(ctx, 200, body.map((request) => executeRequest(request, ctx.store)));
    return;
  }
  sendJson(ctx, 200, executeRequest(body, ctx.store));
}
