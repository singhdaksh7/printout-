import { afterEach, describe, expect, it, vi } from 'vitest';
import { COUNTRIES, countriesFor, createPhoneAuth, mapFirebaseError, maskPhone, normalizePhone, phoneErrorMessage, firebaseWebConfig } from './phone-auth';
import { createMockPhoneAuth, mockIdToken, MOCK_OTP } from './phone-auth-mock';

const india = COUNTRIES[0]!;
afterEach(() => { vi.unstubAllEnvs(); vi.doUnmock('firebase/auth'); vi.doUnmock('firebase/app'); vi.resetModules(); });

describe('normalizePhone', () => {
  it.each([
    ['98765 43210', '+919876543210'], ['09876543210', '+919876543210'], ['+91 98765-43210', '+919876543210'],
    ['(987) 654 3210', '+919876543210'], ['919876543210', '+919876543210']
  ])('accepts %s', (input, e164) => { expect(normalizePhone(india, input)).toEqual({ ok: true, e164 }); });
  it.each(['', '12345', '98765432101234', 'abcdefghij', '5876543210', '+44 9876543210'])('rejects %j', (input) => {
    expect(normalizePhone(india, input).ok).toBe(false);
  });
  it('supports other countries', () => {
    expect(normalizePhone(COUNTRIES.find((c) => c.code === '+1')!, '(415) 555-2671')).toEqual({ ok: true, e164: '+14155552671' });
  });
  it('lists India first and filters by the server allow-list', () => {
    expect(countriesFor(['+1', '+91']).map((c) => c.code)).toEqual(['+91', '+1']);
    expect(countriesFor([]).map((c) => c.code)).toEqual(['+91']);
    expect(countriesFor(['+999']).map((c) => c.code)).toEqual(['+91']);
  });
  it('masks numbers', () => { expect(maskPhone('+919876543210')).toBe('+91••••••3210'); });
});

describe('mapFirebaseError', () => {
  it.each([
    ['auth/invalid-phone-number', 'invalid-phone'], ['auth/too-many-requests', 'rate-limited'], ['auth/quota-exceeded', 'quota'],
    ['auth/code-expired', 'code-expired'], ['auth/invalid-verification-code', 'code-invalid'], ['auth/captcha-check-failed', 'captcha'],
    ['auth/network-request-failed', 'network'], ['auth/operation-not-allowed', 'region-blocked'], ['auth/unauthorized-domain', 'domain'],
    ['auth/internal-error', 'unavailable'], ['weird', 'unavailable']
  ])('%s -> %s', (code, kind) => { expect(mapFirebaseError({ code, message: 'SECRET sdk text' }).kind).toBe(kind); });
  it('never exposes SDK text', () => {
    expect(phoneErrorMessage(mapFirebaseError({ code: 'auth/internal-error', message: 'projects/123/apiKey=abc' }))).not.toMatch(/apiKey|projects/);
    expect(phoneErrorMessage(new Error('boom'))).toMatch(/unavailable/i);
  });
});

describe('mock driver', () => {
  it('accepts only 123456 and issues an unsigned emulator-style token', async () => {
    const p = createMockPhoneAuth();
    await expect(p.confirm('123456')).rejects.toMatchObject({ kind: 'no-session' });
    await p.sendCode('+919876543210');
    await expect(p.confirm('000000')).rejects.toMatchObject({ kind: 'code-invalid' });
    const token = await p.confirm(MOCK_OTP);
    const [h, c, s] = token.split('.');
    expect(JSON.parse(atob(h!.replace(/-/g, '+').replace(/_/g, '/')))).toEqual({ alg: 'none', typ: 'JWT' });
    const claims = JSON.parse(atob(c!.replace(/-/g, '+').replace(/_/g, '/')));
    expect(claims).toMatchObject({ phone_number: '+919876543210', firebase: { sign_in_provider: 'phone' } });
    expect(claims.iss).toBe(`https://securetoken.google.com/${claims.aud}`);
    expect(claims.exp - claims.iat).toBe(3600);
    expect(s).toBe('');
    expect(mockIdToken('+911234567890', 'p', 100)).toContain('.');
  });
});

describe('createPhoneAuth', () => {
  it('reports missing configuration without throwing SDK text', async () => {
    vi.stubEnv('VITE_FIREBASE_API_KEY', '');
    await expect(createPhoneAuth()).rejects.toMatchObject({ kind: 'not-configured' });
    expect(firebaseWebConfig({})).toBeNull();
    expect(firebaseWebConfig({ VITE_FIREBASE_API_KEY: 'k', VITE_FIREBASE_AUTH_DOMAIN: 'd', VITE_FIREBASE_PROJECT_ID: 'p', VITE_FIREBASE_APP_ID: 'a' })).toEqual({ apiKey: 'k', authDomain: 'd', projectId: 'p', appId: 'a' });
  });

  async function withFirebase(auth: Record<string, unknown>) {
    vi.resetModules();
    vi.stubEnv('VITE_FIREBASE_API_KEY', 'k'); vi.stubEnv('VITE_FIREBASE_AUTH_DOMAIN', 'd.example'); vi.stubEnv('VITE_FIREBASE_PROJECT_ID', 'p'); vi.stubEnv('VITE_FIREBASE_APP_ID', 'a');
    const clear = vi.fn();
    vi.doMock('firebase/app', () => ({ initializeApp: vi.fn(() => ({})), getApps: () => [], getApp: vi.fn() }));
    vi.doMock('firebase/auth', () => ({
      initializeAuth: vi.fn(() => ({})), getAuth: vi.fn(() => ({})), inMemoryPersistence: {},
      RecaptchaVerifier: vi.fn(() => ({ clear })), signOut: vi.fn(async () => undefined), ...auth
    }));
    const mod = await import('./phone-auth');
    return { provider: await mod.createPhoneAuth(), clear, mod };
  }

  it('happy path: invisible reCAPTCHA, SMS, confirm, ID token, then signs the Firebase client out', async () => {
    const getIdToken = vi.fn(async () => 'real-id-token');
    const signInWithPhoneNumber = vi.fn(async (_auth: unknown, _phone: string, _verifier: unknown) => ({ confirm: vi.fn(async () => ({ user: { getIdToken } })) }));
    const signOut = vi.fn(async () => undefined);
    const { provider } = await withFirebase({ signInWithPhoneNumber, signOut });
    await provider.sendCode('+919876543210');
    expect(signInWithPhoneNumber.mock.calls[0]![1]).toBe('+919876543210');
    await expect(provider.confirm('123456')).resolves.toBe('real-id-token');
    expect(getIdToken).toHaveBeenCalledWith(true);
    expect(signOut).toHaveBeenCalled();
    await expect(provider.confirm('123456')).rejects.toMatchObject({ kind: 'no-session' }); // one confirmation per SMS
  });

  it('reCAPTCHA failure and SMS outage map to safe kinds and clear the widget', async () => {
    const signInWithPhoneNumber = vi.fn()
      .mockRejectedValueOnce({ code: 'auth/captcha-check-failed', message: 'x' })
      .mockRejectedValueOnce({ code: 'auth/network-request-failed' });
    const { provider, clear } = await withFirebase({ signInWithPhoneNumber });
    await expect(provider.sendCode('+919876543210')).rejects.toMatchObject({ kind: 'captcha' });
    expect(clear).toHaveBeenCalled();
    await expect(provider.sendCode('+919876543210')).rejects.toMatchObject({ kind: 'network' });
  });

  it('wrong and expired codes map to code-invalid / code-expired', async () => {
    const confirm = vi.fn().mockRejectedValueOnce({ code: 'auth/invalid-verification-code' }).mockRejectedValueOnce({ code: 'auth/code-expired' });
    const { provider } = await withFirebase({ signInWithPhoneNumber: vi.fn(async () => ({ confirm })) });
    await provider.sendCode('+919876543210');
    await expect(provider.confirm('111111')).rejects.toMatchObject({ kind: 'code-invalid' });
    await expect(provider.confirm('111111')).rejects.toMatchObject({ kind: 'code-expired' });
  });

  it('is created with the popup/redirect resolver for both phone and Google sign-in', async () => {
    const signInWithPhoneNumber = vi.fn(async () => ({ confirm: vi.fn() }));
    const { mod } = await withFirebase({ signInWithPhoneNumber, browserPopupRedirectResolver: { marker: 'resolver' } });
    const A = await import('firebase/auth');
    const init = vi.mocked(A.initializeAuth);
    expect(init.mock.calls[0]![1]).toMatchObject({ popupRedirectResolver: { marker: 'resolver' } });
    const signInWithPopup = vi.fn(async () => ({ user: { getIdToken: async () => 'g-token' } }));
    vi.mocked(A).signInWithPopup = signInWithPopup as never;
    (A as unknown as { GoogleAuthProvider: unknown }).GoogleAuthProvider = class { setCustomParameters() {} };
    await expect(mod.signInWithGoogleWeb()).resolves.toBe('g-token');
    expect(init.mock.calls.at(-1)![1]).toMatchObject({ popupRedirectResolver: { marker: 'resolver' } });
  });
});

describe('error classification for wiring errors', () => {
  it('maps auth/argument-error to a config kind, logs only the code, and never shows the code to the user', async () => {
    const { mapFirebaseError, phoneErrorMessage, googleAuthErrorMessage } = await import('./phone-auth');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const err = mapFirebaseError({ code: 'auth/argument-error', message: 'secret AIzaSyXXXX +919999999999' });
    expect(err.kind).toBe('config');
    expect(warn).toHaveBeenCalledWith('[phone-auth] Firebase error', 'auth/argument-error');
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/AIza|9999999999/);
    expect(phoneErrorMessage(err)).not.toMatch(/auth\//);
    expect(googleAuthErrorMessage(err)).toBe('Google sign-in is unavailable right now. Use another sign-in method.');
    expect(googleAuthErrorMessage(err)).not.toMatch(/phone|auth\//i);
    expect(googleAuthErrorMessage(mapFirebaseError({ code: 'auth/network-request-failed' }))).toMatch(/connection/);
    warn.mockRestore();
  });
});
