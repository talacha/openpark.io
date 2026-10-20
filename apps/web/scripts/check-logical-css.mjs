// CI guard: physical left/right properties break right-to-left layout. Use logical ones.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BAD = /(?<![-\w])(margin-left|margin-right|padding-left|padding-right|border-left|border-right|text-align:\s*(left|right)|float:\s*(left|right)|(?:^|[\s{;])(left|right)\s*:)/;
const roots = ['src', '../../packages/ui/src'];
let bad = 0;
const walk = (d) => readdirSync(d).forEach((f) => {
  const p = join(d, f);
  if (statSync(p).isDirectory()) return walk(p);
  if (!p.endsWith('.css')) return;
  readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
    if (BAD.test(line) && !line.includes('rtl-ok')) { console.error(`${p}:${i + 1}: ${line.trim()}`); bad++; }
  });
});
roots.forEach(walk);
if (bad) { console.error(`${bad} physical CSS propert${bad === 1 ? 'y' : 'ies'} found; use logical properties`); process.exit(1); }
console.log('css: logical properties only');
