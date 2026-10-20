import { loadConfig } from './config.js';
import { buildApp } from './server.js';

const cfg = loadConfig();
const app = await buildApp({ cfg });
await app.listen({ port: cfg.PORT, host: cfg.HOST });
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => app.close().then(() => process.exit(0)));
