// Packages dist/ into release/PrintoutBuddyAgent-<version>-win-x64.zip and writes SHA256SUMS.txt.
// The binaries are UNSIGNED. No signing credential is used or invented here.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const exe = join(dist, 'printout-agent.exe');
if (!existsSync(exe)) throw new Error('Run "pnpm build" on Windows first (dist/printout-agent.exe is missing).');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const stage = join(root, 'release', 'stage');
rmSync(join(root, 'release'), { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
copyFileSync(exe, join(stage, 'printout-agent.exe'));
copyFileSync(join(dist, 'BUILD-INFO.json'), join(stage, 'BUILD-INFO.json'));
copyFileSync(join(root, 'tools', 'config.sample.json'), join(stage, 'config.sample.json'));
copyFileSync(resolve(root, '..', '..', 'docs', 'WINDOWS_AGENT.md'), join(stage, 'README.md'));

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const zip = join(root, 'release', `PrintoutBuddyAgent-${version}-win-x64.zip`);
// bsdtar ships with Windows 10+; "-a" picks the zip format from the extension.
execFileSync('tar', ['-a', '-cf', zip, '-C', stage, '.'], { stdio: 'inherit' });
const lines = [`${sha(zip)}  ${zip.split(/[\\/]/).pop()}`, `${sha(exe)}  printout-agent.exe (inside the zip)`];
writeFileSync(join(root, 'release', 'SHA256SUMS.txt'), lines.join('\n') + '\n');
rmSync(stage, { recursive: true, force: true });
console.log(lines.join('\n'));
