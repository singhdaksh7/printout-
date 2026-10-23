/**
 * TEST/E2E ONLY. Mints UNSIGNED Firebase-emulator-style ID tokens (alg "none"). The Admin SDK accepts them only while
 * FIREBASE_AUTH_EMULATOR_HOST is set, which loadConfig() refuses in production. Never import this from production code.
 */
export interface TestTokenOptions {
  projectId: string;
  uid?: string;
  phone?: string | null;
  provider?: string;
  /** Seconds since epoch. Default: now. */
  authTime?: number;
  /** Seconds since epoch. Default: authTime + 3600. */
  exp?: number;
  aud?: string;
  iss?: string;
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

export function mintEmulatorToken(o: TestTokenOptions): string {
  const now = Math.floor(Date.now() / 1000);
  const authTime = o.authTime ?? now;
  const uid = o.uid ?? 'test-uid-1';
  const payload: Record<string, unknown> = {
    iss: o.iss ?? `https://securetoken.google.com/${o.projectId}`,
    aud: o.aud ?? o.projectId,
    auth_time: authTime,
    user_id: uid,
    sub: uid,
    iat: Math.min(authTime, now),
    exp: o.exp ?? authTime + 3600,
    firebase: { identities: {}, sign_in_provider: o.provider ?? 'phone' }
  };
  if (o.phone !== null) payload.phone_number = o.phone ?? '+919876543210';
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.`;
}
