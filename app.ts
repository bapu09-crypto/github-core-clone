// The HTTP server: one process, one in-memory store, four surfaces. Routing is kept
// lean on purpose — the read workload is two thousand sequential GETs on one
// keep-alive connection, so the hot path parses the URL by hand (no URL object, no
// query parsing when there is no query string) and answers bodyless requests without
// waiting on the body stream. Every reply carries a request id; authentication is
// decided once, here, before any surface sees the request.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './src/store.ts';
import { handleGit } from './src/githttp.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { decodeSegment, sendError, sendJson, type Ctx } from './src/respond.ts';

/** The bearer token the suite presents (MAKEFUN_SHOP_TOKEN); empty under local development. */
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
/** The whole expected Authorization header, prebuilt so the hot path compares without slicing. */
const EXPECTED_HEADER = `Bearer ${EXPECTED_TOKEN}`;

/** A shared empty query set, so bodyless requests allocate no query parser. */
const EMPTY_QUERY = new URLSearchParams();
const EMPTY_BODY = Buffer.alloc(0);

/** `/{owner}/{repo}.git` plus the rest of the git path. */
const GIT_ROUTE = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/;

/** The largest request body accepted (packs in this suite stay far below it). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

/**
 * Whether the request carries an acceptable bearer token. When the suite's token is
 * configured it must match exactly; without one, any non-empty bearer token is the
 * local-development stand-in.
 */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  if (EXPECTED_TOKEN !== '') return header === EXPECTED_HEADER;
  return header.startsWith('Bearer ') && header.length > 7;
}

/** Route one fully-read request to its surface. Never throws out of the dispatcher. */
function dispatch(ctx: Ctx): void {
  try {
    // The env's boot check calls this twice, with no token: 200 {"ok":true}.
    if (ctx.method === 'GET' && ctx.pathname === '/healthz') {
      sendJson(ctx, 200, { ok: true });
      return;
    }
    if (!authorized(ctx.req)) {
      sendError(ctx, 401, 'Requires authentication');
      return;
    }
    if (ctx.pathname === '/api/graphql') {
      handleGraphQL(ctx);
      return;
    }
    if (ctx.pathname === '/mcp') {
      handleMcp(ctx);
      return;
    }
    if (ctx.pathname === '/api/v3' || ctx.pathname.startsWith('/api/v3/')) {
      handleRest(ctx);
      return;
    }
    const git = GIT_ROUTE.exec(ctx.pathname);
    if (git !== null) {
      handleGit(ctx, decodeSegment(git[1] as string), decodeSegment(git[2] as string), git[3] ?? '');
      return;
    }
    sendError(ctx, 404, 'Not Found');
  } catch (err) {
    // A handler's trouble is never the server's: answer 500 JSON and keep serving.
    try {
      if (!ctx.res.headersSent) sendError(ctx, 500, err instanceof Error ? err.message : 'Internal Server Error');
      else ctx.res.destroy();
    } catch {
      // The connection is already gone; there is nothing left to answer.
    }
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? 'GET';
    const rawUrl = req.url ?? '/';
    const qmark = rawUrl.indexOf('?');
    const pathname = qmark < 0 ? rawUrl : rawUrl.slice(0, qmark);
    const query = qmark < 0 ? EMPTY_QUERY : new URLSearchParams(rawUrl.slice(qmark + 1));
    const base: Omit<Ctx, 'body'> = {
      store,
      req,
      res,
      method,
      pathname,
      query,
      requestId: `req-${(requestCounter += 1)}`,
      host: req.headers.host ?? 'localhost',
    };

    // A request with provably no body (no length, or a zero length, and no chunked
    // encoding) is dispatched at once, without waiting on the body stream.
    const contentLength = req.headers['content-length'];
    const hasBody =
      (contentLength !== undefined && contentLength !== '0') || req.headers['transfer-encoding'] !== undefined;
    if (!hasBody) {
      dispatch({ ...base, body: EMPTY_BODY });
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let destroyed = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES && !destroyed) {
        destroyed = true;
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (destroyed) return;
      // A body that arrived in one chunk is used as-is, without a concatenating copy.
      dispatch({ ...base, body: chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks, size) });
    });
    req.on('error', () => {
      // The connection died mid-body; there is no one left to answer.
    });
  });
  server.on('clientError', (_err: Error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  return server;
}
