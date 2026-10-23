// BUILD-TIME TEST DRIVER. Compiled only when VITE_PHONE_AUTH_MOCK=1 (see phone-auth.ts); scripts/check-no-showcase.mjs fails the
// production check if the marker below appears in dist/. It issues unsigned emulator-style tokens that only an API started with
// FIREBASE_AUTH_EMULATOR_HOST (never production) will accept.
import { PhoneAuthError, type PhoneAuthProvider } from './phone-auth';

const PHONE_AUTH_MOCK_MARKER = 'pb-phone-auth-mock-driver';
export const MOCK_OTP = '123456';
const b64url = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function mockIdToken(e164: string, projectId: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = { alg: 'none', typ: 'JWT' };
  const payload = {
    iss: `https://securetoken.google.com/${projectId}`, aud: projectId, sub: `mock-${e164.replace(/\D/g, '')}`, user_id: `mock-${e164.replace(/\D/g, '')}`,
    phone_number: e164, auth_time: nowSeconds, iat: nowSeconds, exp: nowSeconds + 3600,
    firebase: { identities: { phone: [e164] }, sign_in_provider: 'phone' }
  };
  return `${b64url(header)}.${b64url(payload)}.`;
}

export function createMockPhoneAuth(): PhoneAuthProvider {
  let phone: string | null = null;
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID || 'demo-printout';
  return {
    async sendCode(e164) { phone = e164; },
    async confirm(code) {
      if (!phone) throw new PhoneAuthError('no-session', 'no pending verification');
      if (code !== MOCK_OTP) throw new PhoneAuthError('code-invalid', PHONE_AUTH_MOCK_MARKER);
      return mockIdToken(phone, projectId);
    },
    reset() { phone = null; }
  };
}
