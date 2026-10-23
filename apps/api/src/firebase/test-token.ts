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
  /** Google tokens: the address and whether Google verified it (default true when `email` is given). */
  email?: string;
  emailVerified?: boolean;
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
  if (o.provider === 'google.com') {
    // A Google token carries email claims and no phone number.
    if (o.email !== undefined) {
      payload.email = o.email;
      payload.email_verified = o.emailVerified ?? true;
    }
  } else if (o.phone !== null) payload.phone_number = o.phone ?? '+919876543210';
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.`;
}

/** Convenience: a Google (google.com) ID token whose email Google has verified (override with emailVerified:false to test rejection). */
export function mintGoogleToken(o: Omit<TestTokenOptions, 'provider' | 'phone'> & { email: string }): string {
  return mintEmulatorToken({ ...o, provider: 'google.com', phone: null });
}
