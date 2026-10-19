import { existsSync, rmSync } from 'node:fs';
import { basename } from 'node:path';
import { ApiError, HttpApi } from './api-client.js';
import { allowInsecureLoopback } from './config.js';
import {
  acquireLock, AGENT_VERSION, buildEngine, loadCredentials, openRuntime, osDescription, pairComputer, type Runtime
} from './runtime.js';
import { autostartState, installAutostart, removeAutostart } from './tasks.js';

const HELP = `Printout Buddy Windows Print Agent ${AGENT_VERSION}

Usage: printout-agent <command> [options]

  pair --server <https://...> --code <PB-XXXX-XXXX> [--name <computer name>]
        Connect this computer to a shop with a pairing code from Shop > Devices.
  status        Show pairing, connection and printer status.
  printers      List detected printers and whether the shop has authorized them.
  run           Run the agent in this window (this is what autostart runs).
  rotate        Replace the stored device credential now.
  install       Start automatically when you sign in to Windows (Scheduled Task).
  uninstall     Remove the automatic start.   [--purge  also delete local data and the stored credential]
  unpair        Forget this pairing on this computer (also remove the device in Shop > Devices).
  doctor        Check this computer for problems.
  version

The shop owner decides which printer is used: authorize it in Shop > Devices.
`;

function parseArgs(argv: string[]): { cmd: string; opts: Map<string, string | true> } {
  const [cmd = 'help', ...rest] = argv;
  const opts = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith('--')) throw new Error(`Unexpected argument: ${a}`);
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      opts.set(key, next);
      i++;
    } else opts.set(key, true);
  }
  return { cmd, opts };
}

const out = (s = '') => process.stdout.write(s + '\n');
const str = (v: string | true | undefined) => (typeof v === 'string' ? v : undefined);

async function requireCreds(rt: Runtime) {
  const creds = await loadCredentials(rt);
  if (!creds) throw new Error('This computer is not paired yet. Run: printout-agent pair --server <address> --code <code>');
  return creds;
}

export async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    out(String((e as Error).message));
    return 2;
  }
  const { cmd, opts } = parsed;
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    out(HELP);
    return 0;
  }
  if (cmd === 'version') {
    out(AGENT_VERSION);
    return 0;
  }
  if (process.platform !== 'win32' && process.env.PRINTOUT_AGENT_ALLOW_NON_WINDOWS !== '1') {
    out('The Printout Buddy agent runs on Windows only.');
    return 2;
  }
  const rt = await openRuntime();

  try {
    switch (cmd) {
      case 'pair': {
        const server = str(opts.get('server'));
        const code = str(opts.get('code'));
        if (!server || !code) {
          out('pair needs --server and --code');
          return 2;
        }
        const name = str(opts.get('name'));
        const creds = await pairComputer(rt, { server, code, ...(name ? { name } : {}) });
        out(`Paired with "${creds.shopName}" as "${creds.deviceName}".`);
        out('Next: open Shop > Devices in Printout Buddy, authorize a printer, then run: printout-agent install');
        return 0;
      }
      case 'status': {
        const creds = await requireCreds(rt);
        out(`Shop:       ${creds.shopName}`);
        out(`Computer:   ${creds.deviceName} (${creds.deviceId})`);
        out(`Server:     ${creds.apiBase}`);
        out(`Credential: rotated ${creds.rotatedAt}`);
        const api = new HttpApi({ baseUrl: creds.apiBase, userAgent: `PrintoutBuddyAgent/${AGENT_VERSION}`, maxAttempts: 1 });
        api.setCredential(creds.credential);
        try {
          await api.heartbeat({ appVersion: AGENT_VERSION, osVersion: osDescription() });
          out('Connection: OK');
        } catch (e) {
          out(`Connection: ${e instanceof ApiError && e.fatalAuth ? 'REVOKED - remove this pairing and pair again' : 'cannot reach the server'}`);
        }
        const formats = await rt.spooler.supportedMimeTypes();
        out(`Formats:    ${formats.join(', ')}`);
        out(`Autostart:  ${await autostartState()}`);
        const active = await api.active().catch(() => null);
        if (active) out(`Jobs:       ${active.length} in progress`);
        return 0;
      }
      case 'printers': {
        const creds = await requireCreds(rt);
        const local = await rt.spooler.listPrinters();
        const api = new HttpApi({ baseUrl: creds.apiBase, userAgent: `PrintoutBuddyAgent/${AGENT_VERSION}`, maxAttempts: 1 });
        api.setCredential(creds.credential);
        const remote = await api.reportPrinters(local);
        for (const p of local) {
          const r = remote.find((x) => x.name === p.name);
          out(`${r?.isDefault ? '*' : ' '} ${p.name}  [${p.connectivity}${p.statusDetail ? `: ${p.statusDetail}` : ''}]  colour:${p.supportsColour ? 'yes' : 'no'} duplex:${p.supportsDuplex ? 'yes' : 'no'}  ${r?.authorized ? 'AUTHORIZED' : 'not authorized'}`);
        }
        out('* = the shop default. Authorize printers in Shop > Devices.');
        return 0;
      }
      case 'run': {
        const creds = await requireCreds(rt);
        const release = acquireLock(rt.p.lock);
        const { engine } = await buildEngine(rt, creds);
        const stop = () => engine.stop('stopped');
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
        rt.log.info('agent started', { version: AGENT_VERSION, device: creds.deviceId });
        try {
          const reason = await engine.run();
          rt.log.info('agent stopped', { reason });
          if (reason === 'revoked') {
            await rt.store.clear();
            out('This computer was disconnected by the shop. Pair it again to continue.');
            return 3;
          }
          return 0;
        } finally {
          release();
        }
      }
      case 'rotate': {
        const creds = await requireCreds(rt);
        const { rotate } = await buildEngine(rt, creds);
        await rotate();
        out('Credential rotated.');
        return 0;
      }
      case 'install': {
        await requireCreds(rt);
        // Packaged exe: run it directly. Developer mode (node + script): run node with the script.
        const packaged = !/^node(\.exe)?$/i.test(basename(process.execPath));
        await installAutostart(process.execPath, packaged ? 'run' : `"${process.argv[1]}" run`);
        out('Autostart enabled: the agent starts when you sign in to Windows.');
        return 0;
      }
      case 'uninstall': {
        await removeAutostart();
        if (opts.get('purge') === true) {
          await rt.store.clear();
          for (const f of [rt.p.config, rt.p.journal, rt.p.lock]) if (existsSync(f)) rmSync(f, { force: true });
          rmSync(`${rt.dir}\\temp`, { recursive: true, force: true });
          out('Autostart removed. Local data and credentials deleted. Remove this computer in Shop > Devices as well.');
        } else out('Autostart removed. Pairing data was kept (use --purge to delete it).');
        return 0;
      }
      case 'unpair': {
        await rt.store.clear();
        out('Local pairing removed. Also remove this computer in Shop > Devices so its credential is revoked.');
        return 0;
      }
      case 'doctor': {
        let problems = 0;
        const check = (ok: boolean, label: string, hint = '') => {
          out(`${ok ? 'OK  ' : 'FAIL'} ${label}${!ok && hint ? ` - ${hint}` : ''}`);
          if (!ok) problems++;
        };
        check(process.platform === 'win32', `Windows (${osDescription()})`);
        try {
          const p = await rt.spooler.listPrinters();
          check(p.length > 0, `Printers detected: ${p.length}`, 'install a printer in Windows Settings');
        } catch {
          check(false, 'Windows print service', 'start the "Print Spooler" service');
        }
        const formats = await rt.spooler.supportedMimeTypes();
        check(formats.includes('application/pdf'), 'PDF renderer', 'install SumatraPDF and set pdfRenderer.path in config.json; images work without it');
        const creds = await loadCredentials(rt).catch(() => null);
        check(!!creds, 'Paired', 'run: printout-agent pair');
        if (creds) {
          const api = new HttpApi({ baseUrl: creds.apiBase, userAgent: `PrintoutBuddyAgent/${AGENT_VERSION}`, maxAttempts: 1 });
          api.setCredential(creds.credential);
          const ok = await api.heartbeat({ appVersion: AGENT_VERSION, osVersion: osDescription() }).then(() => true).catch(() => false);
          check(ok, 'Server reachable with a valid credential', 'check the internet connection or whether the shop removed this computer');
          check(creds.apiBase.startsWith('https://') || allowInsecureLoopback(), 'TLS (https)');
        }
        const task = await autostartState();
        check(task !== 'NotInstalled' && task !== 'Unknown', `Autostart (${task})`, 'run: printout-agent install');
        out('REAL HARDWARE PRINTING is not verified by doctor. Print a test order and check the paper.');
        return problems === 0 ? 0 : 1;
      }
      default:
        out(`Unknown command: ${cmd}\n`);
        out(HELP);
        return 2;
    }
  } catch (e) {
    const msg = e instanceof ApiError ? (e.code === 'PAIRING_CODE_INVALID' ? 'This pairing code is invalid or has expired. Create a new one in Shop > Devices.' : `${e.message} (${e.code})`) : (e as Error).message;
    out(`Error: ${msg}`);
    rt.log.error('command failed', { cmd, error: msg });
    return 1;
  }
}
