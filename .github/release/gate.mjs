// Phase 1: the release gate. Read-only. Decides WAITING / READY / RESUME_DEPLOY / COMPLETE from GitHub's own records.
//   - A feature counts only when a pull request from the exact same-repository head branch was MERGED into the
//     integration branch (merged_at set, base = development) AND its merge commit is an ancestor of development's tip.
//   - Branch existence or deletion is never consulted. Unrelated merged PRs are ignored.
import { readFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const STATES = Object.freeze({ WAITING: 'WAITING', READY: 'READY', RESUME_DEPLOY: 'RESUME_DEPLOY', COMPLETE: 'COMPLETE' });
export const tagNames = (releaseId) => ({ release: `release-${releaseId}`, deployed: `deployed-${releaseId}` });

/** @param {{repo:string,integrationBranch:string,features:{key:string,branch:string}[],releaseId:string}} config
 *  @param {{ listClosedPrs(branch:string):Promise<any[]>, inHistory(sha:string):Promise<boolean>, tagSha(name:string):Promise<string|null>, headSha(branch:string):Promise<string> }} api */
export async function evaluateGate(config, api) {
  const tags = tagNames(config.releaseId);
  const deployedSha = await api.tagSha(tags.deployed);
  if (deployedSha) return { state: STATES.COMPLETE, releaseSha: deployedSha, devSha: '', features: [], merged: 0 };
  const releaseSha = await api.tagSha(tags.release);
  const devSha = await api.headSha(config.integrationBranch);

  const features = [];
  for (const f of config.features) {
    const prs = (await api.listClosedPrs(f.branch)).filter(
      (p) =>
        p.merged_at &&
        p.base?.ref === config.integrationBranch &&
        p.head?.ref === f.branch &&
        p.head?.repo?.full_name === config.repo &&
        p.merge_commit_sha
    );
    let verified = null;
    for (const p of prs.sort((a, b) => b.number - a.number)) {
      if (await api.inHistory(p.merge_commit_sha)) { verified = p; break; }
    }
    features.push({ key: f.key, branch: f.branch, merged: Boolean(verified), pr: verified?.number ?? null, mergeSha: verified?.merge_commit_sha ?? null });
  }
  const merged = features.filter((f) => f.merged).length;
  if (releaseSha) return { state: STATES.RESUME_DEPLOY, releaseSha, devSha, features, merged };
  const state = merged === config.features.length ? STATES.READY : STATES.WAITING;
  return { state, releaseSha: '', devSha, features, merged };
}

export function renderSummary(config, r) {
  const rows = r.features.map((f) => `| ${f.key} | \`${f.branch}\` | ${f.merged ? `merged (#${f.pr})` : 'not merged'} |`);
  return [
    `## Release coordinator \`${config.releaseId}\``,
    `**State: ${r.state}** (${r.merged}/${config.features.length} features merged into \`${config.integrationBranch}\`)`,
    r.devSha ? `Development tip evaluated: \`${r.devSha}\`` : '',
    r.releaseSha ? `Release SHA: \`${r.releaseSha}\`` : '',
    '', '| Feature | Head branch | Status |', '|---|---|---|', ...rows, ''
  ].filter((l) => l !== '').join('\n');
}

function githubApi(config, token) {
  const base = `https://api.github.com/repos/${config.repo}`;
  const owner = config.repo.split('/')[0];
  const call = async (path, okStatuses = [200]) => {
    const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } });
    if (res.status === 404 && okStatuses.includes(404)) return null;
    if (!okStatuses.includes(res.status)) throw new Error(`GitHub API ${path} -> ${res.status}`);
    return res.json();
  };
  return {
    listClosedPrs: (branch) => call(`/pulls?state=closed&base=${encodeURIComponent(config.integrationBranch)}&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`),
    inHistory: async (sha) => {
      const c = await call(`/compare/${sha}...${encodeURIComponent(config.integrationBranch)}`, [200, 404]);
      return Boolean(c) && (c.status === 'ahead' || c.status === 'identical');
    },
    tagSha: async (name) => {
      const ref = await call(`/git/ref/tags/${encodeURIComponent(name)}`, [200, 404]);
      if (!ref) return null;
      if (ref.object.type === 'tag') return (await call(`/git/tags/${ref.object.sha}`)).object.sha;
      return ref.object.sha;
    },
    headSha: async (branch) => (await call(`/branches/${encodeURIComponent(branch)}`)).commit.sha
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
  const token = process.env.GH_TOKEN;
  if (!token) { console.error('GH_TOKEN is required'); process.exit(2); }
  const result = await evaluateGate(config, githubApi(config, token));
  const summary = renderSummary(config, result);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  if (result.state === STATES.WAITING) console.log(`::notice title=Release coordinator::WAITING ${result.merged}/${config.features.length} features merged`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `state=${result.state}\ndev_sha=${result.devSha}\nrelease_sha=${result.releaseSha}\nmerged=${result.merged}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `feature_prs=${result.features.map((f) => `${f.key}#${f.pr}`).join(',')}\n`);
  }
}
