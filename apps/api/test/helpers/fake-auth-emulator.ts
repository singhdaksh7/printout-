import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';

/**
 * TEST/E2E ONLY. A minimal stand-in for the Firebase Auth emulator's REST surface. With FIREBASE_AUTH_EMULATOR_HOST
 * pointing here, the real Admin SDK verifies UNSIGNED tokens from src/firebase/test-token.ts (claims, audience, issuer,
 * expiry) and then asks "does this user exist / is it disabled?" (accounts:lookup), which this server answers.
 * Signature verification against Google's certificates is NOT exercised by this setup.
 */
export interface FakeAuthEmulator {
  host: string;
  /** uids answered as disabled (the SDK then throws auth/user-disabled). */
  disabled: Set<string>;
  /** uids whose refresh tokens were revoked through accounts:update (observed, for assertions). */
  revoked: string[];
  close(): Promise<void>;
}

export async function startFakeAuthEmulator(port = 0): Promise<FakeAuthEmulator> {
  const disabled = new Set<string>();
  const revoked: string[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: { localId?: string[] | string } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        /* empty */
      }
      res.setHeader('content-type', 'application/json');
      if ((req.url ?? '').includes('accounts:lookup')) {
        const ids = Array.isArray(body.localId) ? body.localId : body.localId ? [body.localId] : [];
        res.end(JSON.stringify({ users: ids.map((localId) => ({ localId, validSince: '0', disabled: disabled.has(localId) })) }));
        return;
      }
      if ((req.url ?? '').includes('accounts:update') && typeof body.localId === 'string') revoked.push(body.localId);
      res.end(JSON.stringify({ localId: typeof body.localId === 'string' ? body.localId : undefined }));
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    host,
    disabled,
    revoked,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

// CLI for the Playwright suite:  node --import tsx test/helpers/fake-auth-emulator.ts 9099
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const emu = await startFakeAuthEmulator(Number(process.argv[2] ?? 9099));
  console.log(`fake auth emulator on ${emu.host}`);
}
