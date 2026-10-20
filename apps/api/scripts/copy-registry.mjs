// Vercel bundles only the project root, so copy the plate registry next to the API.
import { cpSync, existsSync } from 'node:fs';
const from = new URL('../../../registry/plates', import.meta.url);
if (existsSync(from)) cpSync(from, new URL('../registry/plates', import.meta.url), { recursive: true });
