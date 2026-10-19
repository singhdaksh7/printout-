// Builds dist/agent.cjs (one bundled file) and, on Windows, dist/printout-agent.exe (Node single-executable application).
// Reproducibility: no timestamps, fixed esbuild target, lockfile-pinned dependencies. The exe embeds the Node binary that ran
// this script, so the Node version is recorded in dist/BUILD-INFO.json. The executable is NOT code-signed.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
await build({
  entryPoints: [join(root, 'src/entry.ts')],
  outfile: join(dist, 'agent.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  legalComments: 'none',
  logLevel: 'warning',
  define: { 'process.env.PRINTOUT_AGENT_BUILD': JSON.stringify(pkg.version) }
});

let commit = 'unknown';
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
} catch {
  /* not a git checkout */
}
const info = { name: pkg.name, version: pkg.version, commit, node: process.version, platform: process.platform, arch: process.arch, signed: false };

if (process.platform === 'win32') {
  const blob = join(dist, 'sea-prep.blob');
  const seaConfig = join(dist, 'sea-config.json');
  writeFileSync(seaConfig, JSON.stringify({ main: join(dist, 'agent.cjs'), output: blob, disableExperimentalSEAWarning: true, useCodeCache: false }));
  execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });
  const exe = join(dist, 'printout-agent.exe');
  copyFileSync(process.execPath, exe);
  const postject = join(root, 'node_modules', 'postject', 'dist', 'cli.js');
  execFileSync(
    process.execPath,
    [postject, exe, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'],
    { stdio: 'inherit' }
  );
  rmSync(blob, { force: true });
  rmSync(seaConfig, { force: true });
  info.executable = 'printout-agent.exe';
} else {
  console.warn('Not on Windows: only dist/agent.cjs was produced (no .exe).');
}
writeFileSync(join(dist, 'BUILD-INFO.json'), JSON.stringify(info, null, 2) + '\n');
console.log('Built', JSON.stringify(info));
