import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateGate, STATES, tagNames, brandingApproval } from './gate.mjs';

const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const pr = (branch, n, over = {}) => ({ number: n, merged_at: '2026-10-17T00:00:00Z', merge_commit_sha: `sha-${n}`, base: { ref: 'development' }, head: { ref: branch, repo: { full_name: config.repo } }, ...over });
const fakeApi = ({ prs = {}, history = null, tags = {}, files = [], events = [] } = {}) => ({
  prFiles: async () => files,
  labelEvents: async () => events,
  listClosedPrs: async (b) => prs[b] ?? [],
  inHistory: async (sha) => (history ? history.has(sha) : true),
  tagSha: async (n) => tags[n] ?? null,
  headSha: async () => 'dev-tip'
});
const [a, b, c] = config.features.map((f) => f.branch);

test('0, 1 and 2 of 3 merged: WAITING', async () => {
  assert.equal((await evaluateGate(config, fakeApi())).state, STATES.WAITING);
  assert.equal((await evaluateGate(config, fakeApi({ prs: { [a]: [pr(a, 1)] } }))).merged, 1);
  const two = await evaluateGate(config, fakeApi({ prs: { [a]: [pr(a, 1)], [b]: [pr(b, 2)] } }));
  assert.deepEqual([two.state, two.merged], [STATES.WAITING, 2]);
});

test('3 of 3 merged and present in development history: READY', async () => {
  const r = await evaluateGate(config, fakeApi({ prs: { [a]: [pr(a, 1)], [b]: [pr(b, 2)], [c]: [pr(c, 3)] } }));
  assert.equal(r.state, STATES.READY);
  assert.equal(r.devSha, 'dev-tip');
});

test('closed-but-unmerged, wrong base, fork, and not-in-history PRs never count', async () => {
  const bad = {
    [a]: [pr(a, 1, { merged_at: null })],
    [b]: [pr(b, 2, { base: { ref: 'main' } }), pr(b, 4, { head: { ref: b, repo: { full_name: 'evil/printout-' } } })],
    [c]: [pr(c, 3)]
  };
  const r = await evaluateGate(config, fakeApi({ prs: bad, history: new Set() }));
  assert.deepEqual([r.state, r.merged], [STATES.WAITING, 0]);
});

test('a reused branch name falls back to an older merged PR that is in history', async () => {
  const r = await evaluateGate(config, fakeApi({ prs: { [a]: [pr(a, 1), pr(a, 9)], [b]: [pr(b, 2)], [c]: [pr(c, 3)] }, history: new Set(['sha-1', 'sha-2', 'sha-3']) }));
  assert.equal(r.state, STATES.READY);
  assert.equal(r.features[0].pr, 1);
});

test('unrelated merged PRs are ignored', async () => {
  const r = await evaluateGate(config, fakeApi({ prs: { 'feature/someone-else': [pr('feature/someone-else', 77)] } }));
  assert.equal(r.state, STATES.WAITING);
});

test('release tag resumes deploy; deployed tag completes (and is final)', async () => {
  const t = tagNames(config.releaseId);
  const all = { [a]: [pr(a, 1)], [b]: [pr(b, 2)], [c]: [pr(c, 3)] };
  const resume = await evaluateGate(config, fakeApi({ prs: all, tags: { [t.release]: 'rel-sha' } }));
  assert.deepEqual([resume.state, resume.releaseSha], [STATES.RESUME_DEPLOY, 'rel-sha']);
  const done = await evaluateGate(config, fakeApi({ prs: all, tags: { [t.release]: 'rel-sha', [t.deployed]: 'rel-sha' } }));
  assert.equal(done.state, STATES.COMPLETE);
});

test('required checks match both active rulesets exactly', () => {
  for (const f of ['main', 'development']) {
    const rs = JSON.parse(readFileSync(new URL(`../rulesets/${f}.json`, import.meta.url), 'utf8'));
    const rule = rs.rules.find((r) => r.type === 'required_status_checks');
    assert.deepEqual(rule.parameters.required_status_checks.map((x) => x.context), config.requiredChecks, f);
  }
  assert.equal(config.requiredChecks.length, 5);
});

test('coordinator workflow never uses pull_request_target and never lets the token write secrets', () => {
  const wf = readFileSync(new URL('../workflows/release-coordinator.yml', import.meta.url), 'utf8');
  assert.ok(!/pull_request_target/.test(wf));
  assert.ok(!/deploy\/deploy\.sh/.test(wf), 'the standalone Caddy deploy script must never be called');
  assert.ok(/group: release-coordinator/.test(wf) && /cancel-in-progress: false/.test(wf));
});

test('the exact three approved feature branches are configured', () => {
  assert.deepEqual(config.features.map((f) => f.branch), ['feature/daksh-orange-primary-ui', 'feature/daksh-shop-hours', 'feature/daksh-qr-poster']);
});

test('new brand assets without owner approval BLOCK the release; approval by the owner READIES it', async () => {
  const all = { [a]: [pr(a, 1)], [b]: [pr(b, 2)], [c]: [pr(c, 3)] };
  const logo = ['apps/web/public/brand/printout-buddy-logo.svg'];
  const blocked = await evaluateGate(config, fakeApi({ prs: all, files: logo }));
  assert.equal(blocked.state, STATES.BLOCKED);
  const ev = (login, event = 'labeled', at = '2026-10-17T01:00:00Z') => ({ event, created_at: at, label: { name: config.branding.approvalLabel }, actor: { login } });
  assert.equal((await evaluateGate(config, fakeApi({ prs: all, files: logo, events: [ev('someone-else')] }))).state, STATES.BLOCKED);
  assert.equal((await evaluateGate(config, fakeApi({ prs: all, files: logo, events: [ev('singhdaksh7'), ev('singhdaksh7', 'unlabeled', '2026-10-17T02:00:00Z')] }))).state, STATES.BLOCKED);
  assert.equal((await evaluateGate(config, fakeApi({ prs: all, files: logo, events: [ev('singhdaksh7')] }))).state, STATES.READY);
});

test('PRs that touch no brand asset need no approval (existing approved logo reused)', async () => {
  assert.deepEqual(await brandingApproval(config, fakeApi({ files: ['apps/web/src/index.css'] }), 1), { required: false, approved: true, assets: [] });
});

test('release is a squash merge with an annotated tag, and deploy scripts come from main', () => {
  const sh = readFileSync(new URL('./release-pr.sh', import.meta.url), 'utf8');
  assert.ok(/gh pr merge .*--squash/.test(sh) && !/--merge /.test(sh));
  assert.ok(/git\/tags/.test(sh) && /type=commit/.test(sh));
  const wf = readFileSync(new URL('../workflows/release-coordinator.yml', import.meta.url), 'utf8');
  const deploy = wf.slice(wf.indexOf('  deploy:'), wf.indexOf('  complete:'));
  assert.ok(/ref: '\$\{\{ steps\.sha\.outputs\.sha \}\}'/.test(deploy) && !/dev_sha/.test(deploy.split('Deploy the exact')[0]));
});
