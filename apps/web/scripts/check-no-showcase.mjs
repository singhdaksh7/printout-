// Fails if the development-only component showcase leaked into the production bundle.
// Run after `vite build`:  node scripts/check-no-showcase.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dist = process.argv[2] ?? new URL('../dist', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const MARKERS = ['PrintoutBuddy component showcase', 'ui-showcase', 'sc-swatch', 'Development only · sample data'];

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const hits = [];
for (const file of walk(dist)) {
  if (!/\.(js|css|html|map|webmanifest)$/.test(file)) continue;
  const text = readFileSync(file, 'utf8');
  for (const m of MARKERS) if (text.includes(m)) hits.push(`${file}: contains "${m}"`);
}
if (hits.length) {
  console.error('Showcase leaked into the production bundle:\n' + hits.join('\n'));
  process.exit(1);
}
console.log(`OK: no showcase markers in ${dist}`);
