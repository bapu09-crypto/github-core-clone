// Local development runner: starts the forge on a fixed port without the env
// lifecycle, so the kit's local grader can dial it directly. Not the entrypoint;
// the graded entry is main.ts. Usage: node --experimental-strip-types dev.ts [port]

import { createApp } from './app.ts';

const port = Number.parseInt(process.argv[2] ?? '3101', 10);
const server = createApp();
server.listen(Number.isFinite(port) ? port : 3101, () => {
  const address = server.address();
  const bound = address !== null && typeof address === 'object' ? address.port : port;
  process.stdout.write(`[dev] listening on http://127.0.0.1:${bound}\n`);
});

const shutdown = (): void => {
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
