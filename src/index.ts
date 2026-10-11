#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { LocalDev } from './local-dev.js';

const localDev = new LocalDev();
const server = createServer({ localDev });
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await localDev.close();
  await server.close();
}
process.stdin.once('end', () => { void shutdown().catch(console.error); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void shutdown().catch(console.error); });
}
await server.connect(new StdioServerTransport());
