// Phase 2 helper: fail closed unless every verification group has real test files for every pattern, then export the file lists.
import { readFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const missing = [];
const picked = new Set();
for (const g of config.verification.groups) {
  for (const pattern of g.patterns) {
    const hits = files.filter((f) => new RegExp(pattern).test(f));
    if (hits.length === 0) missing.push(`${g.name}: no test file matches /${pattern}/`);
    hits.forEach((h) => picked.add(h));
  }
  console.log(`${g.name}: ok`);
}
if (missing.length) { for (const m of missing) console.error(`::error::${m}`); process.exit(1); }
const list = [...picked];
const out = {
  api_tests: list.filter((f) => f.startsWith('apps/api/test/')).map((f) => f.replace('apps/api/', '')).join(' '),
  web_tests: list.filter((f) => f.startsWith('apps/web/src/')).map((f) => f.replace('apps/web/', '')).join(' '),
  e2e_specs: list.filter((f) => f.startsWith('e2e/')).join(' ')
};
console.log(out);
if (process.env.GITHUB_OUTPUT) for (const [k, v] of Object.entries(out)) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
