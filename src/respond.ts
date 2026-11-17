// The request context every surface handler receives, and the response helpers they
// share. Every reply carries a non-empty X-GitHub-Request-Id; every JSON reply carries
// application/json and never HTML; errors are JSON bodies with a string message.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';

export interface Ctx {
  readonly store: Store;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: string;
  /** The decoded request path (no query string). */
  readonly pathname: string;
  readonly query: URLSearchParams;
  /** The whole request body, already read. */
  readonly body: Buffer;
  readonly requestId: string;
  /** The request's Host header, for absolute same-origin URLs. */
  readonly host: string;
}

const JSON_TYPE = 'application/json; charset=utf-8';

/** Answer with a JSON body. `extra` headers go beside the JSON ones. */
export function sendJson(ctx: Ctx, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  ctx.res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': ctx.requestId,
    ...extra,
  });
  ctx.res.end(text);
}

/** Answer with raw bytes and an explicit content type. */
export function sendBytes(ctx: Ctx, status: number, body: Buffer, contentType: string, extra: Record<string, string> = {}): void {
  ctx.res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': ctx.requestId,
    ...extra,
  });
  ctx.res.end(body);
}

/** Answer with an empty body (a 204, or a notification's acknowledgement). */
export function sendEmpty(ctx: Ctx, status: number, extra: Record<string, string> = {}): void {
  ctx.res.writeHead(status, { 'content-length': 0, 'x-github-request-id': ctx.requestId, ...extra });
  ctx.res.end();
}

/** A JSON error body: `{message}` with a string message, as GitHub answers errors. */
export function sendError(ctx: Ctx, status: number, message: string, extra: Record<string, string> = {}): void {
  sendJson(ctx, status, { message }, extra);
}

/** Parse the request body as JSON. Returns undefined when the body is empty. Throws on malformed JSON. */
export function jsonBody(ctx: Ctx): unknown {
  if (ctx.body.length === 0) return undefined;
  return JSON.parse(ctx.body.toString('utf8')) as unknown;
}

/** True when a value is a plain JSON record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A record's string field, or undefined when it is absent or not a string. */
export function stringField(body: unknown, name: string): string | undefined {
  if (!isRecord(body)) return undefined;
  const value = body[name];
  return typeof value === 'string' ? value : undefined;
}

/** A record's boolean field, or undefined when it is absent or not a boolean. */
export function booleanField(body: unknown, name: string): boolean | undefined {
  if (!isRecord(body)) return undefined;
  const value = body[name];
  return typeof value === 'boolean' ? value : undefined;
}

/** Decode one path segment; a malformed escape decodes to the raw segment. A segment with no escape is returned as-is, without a decode call. */
export function decodeSegment(segment: string): string {
  if (segment.indexOf('%') < 0) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
