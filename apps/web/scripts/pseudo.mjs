// Generates the en-XA pseudo-locale (accented, ~40% longer) from en.json so truncation and
// hard-coded text show up in review. Placeholders {like_this} and ICU syntax are left intact.
import { readFileSync, writeFileSync } from 'node:fs';

const MAP = { a: 'à', e: 'é', i: 'î', o: 'ô', u: 'û', c: 'ç', n: 'ñ', y: 'ý', A: 'À', E: 'É', I: 'Î', O: 'Ô', U: 'Û' };
const PAD = 'one two three four five six seven eight nine ten';

export function pseudo(msg) {
  let out = '', depth = 0;
  for (const ch of msg) {
    if (ch === '{') depth++;
    out += depth > 0 ? ch : MAP[ch] ?? ch;
    if (ch === '}') depth = Math.max(0, depth - 1);
  }
  const extra = PAD.slice(0, Math.ceil(msg.replace(/\{[^}]*\}/g, '').length * 0.4));
  return `[${out} ${extra}]`;
}

const dir = new URL('../src/locales/', import.meta.url);
const en = JSON.parse(readFileSync(new URL('en.json', dir), 'utf8'));
writeFileSync(new URL('en-XA.json', dir), JSON.stringify(Object.fromEntries(Object.entries(en).map(([k, v]) => [k, pseudo(v)])), null, 2) + '\n');
