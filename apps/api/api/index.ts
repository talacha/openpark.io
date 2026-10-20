import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadConfig } from '../src/config.js';
import { buildApp, type App } from '../src/server.js';

/** Vercel function entry: build the Fastify app once per instance and hand it each request. */
let app: Promise<App> | undefined;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  app ??= buildApp({ cfg: loadConfig() }).then(async (a) => { await a.ready(); return a; });
  (await app).server.emit('request', req, res);
}
