// Phone (SMS OTP) sign-in on the client. Firebase proves possession of a phone number; the API verifies the resulting ID token
// and decides what that number may access. Nothing here is trusted by the server beyond the token itself.

/** E.164 normalisation, country list and the provider contract used by the login and settings screens. */

export interface Country { code: string; name: string; flag: string; minDigits: number; maxDigits: number }

/** India first (default). Other entries are offered only when the API's allowedCallingCodes contains them. */
export const COUNTRIES: Country[] = [
  { code: '+91', name: 'India', flag: '🇮🇳', minDigits: 10, maxDigits: 10 },
  { code: '+1', name: 'United States / Canada', flag: '🇺🇸', minDigits: 10, maxDigits: 10 },
  { code: '+44', name: 'United Kingdom', flag: '🇬🇧', minDigits: 10, maxDigits: 10 },
  { code: '+61', name: 'Australia', flag: '🇦🇺', minDigits: 9, maxDigits: 9 },
  { code: '+65', name: 'Singapore', flag: '🇸🇬', minDigits: 8, maxDigits: 8 },
  { code: '+971', name: 'United Arab Emirates', flag: '🇦🇪', minDigits: 9, maxDigits: 9 },
  { code: '+977', name: 'Nepal', flag: '🇳🇵', minDigits: 10, maxDigits: 10 },
  { code: '+880', name: 'Bangladesh', flag: '🇧🇩', minDigits: 10, maxDigits: 10 },
  { code: '+94', name: 'Sri Lanka', flag: '🇱🇰', minDigits: 9, maxDigits: 9 }
];

export function countriesFor(allowed: readonly string[] | undefined): Country[] {
  const list = allowed && allowed.length ? COUNTRIES.filter((c) => allowed.includes(c.code)) : COUNTRIES.slice(0, 1);
  return list.length ? list : COUNTRIES.slice(0, 1);
}

export type PhoneCheck = { ok: true; e164: string } | { ok: false; message: string };

/** Validates a national number for a country and returns E.164. Accepts spaces, dashes, brackets and a leading 0 / the country code. */
export function normalizePhone(country: Country, input: string): PhoneCheck {
  const raw = input.trim();
  if (!raw) return { ok: false, message: 'Enter your mobile number.' };
  if (/[^\d\s\-()+]/.test(raw)) return { ok: false, message: 'Use digits only.' };
  let digits = raw.replace(/\D/g, '');
  const cc = country.code.slice(1);
  if (raw.startsWith('+') || (digits.length > country.maxDigits && digits.startsWith(cc))) {
    if (!digits.startsWith(cc)) return { ok: false, message: `This number must start with ${country.code}.` };
    digits = digits.slice(cc.length);
  }
  digits = digits.replace(/^0+/, '');
  if (digits.length < country.minDigits || digits.length > country.maxDigits) {
    return { ok: false, message: country.minDigits === country.maxDigits ? `Enter a valid ${country.minDigits}-digit mobile number.` : `Enter a valid mobile number (${country.minDigits}–${country.maxDigits} digits).` };
  }
  if (country.code === '+91' && !/^[6-9]/.test(digits)) return { ok: false, message: 'Indian mobile numbers start with 6, 7, 8 or 9.' };
  return { ok: true, e164: `${country.code}${digits}` };
}

export const maskPhone = (e164: string): string => (e164.length > 6 ? `${e164.slice(0, 3)}${'•'.repeat(Math.max(0, e164.length - 7))}${e164.slice(-4)}` : e164);

export type PhoneAuthErrorKind =
  | 'invalid-phone' | 'rate-limited' | 'quota' | 'code-expired' | 'code-invalid' | 'captcha' | 'network' | 'region-blocked'
  | 'domain' | 'unavailable' | 'config' | 'cancelled' | 'not-configured' | 'no-session'
  | 'popup-blocked';

export class PhoneAuthError extends Error {
  constructor(public kind: PhoneAuthErrorKind, message: string) { super(message); }
}

const MESSAGES: Record<PhoneAuthErrorKind, string> = {
  'invalid-phone': 'That phone number is not valid. Check it and try again.',
  'rate-limited': 'Too many attempts. Please wait a few minutes before trying again.',
  quota: 'We cannot send more codes right now. Please try again later or use email and password.',
  'code-expired': 'That code has expired. Request a new one.',
  'code-invalid': 'That code is not correct. Check the SMS and try again.',
  captcha: 'We could not verify this device. Reload the page and try again.',
  network: 'Cannot reach the verification service. Check your connection and try again.',
  'region-blocked': 'Codes cannot be sent to this country. Use email and password instead.',
  domain: 'Phone sign-in is not available on this address. Use email and password instead.',
  unavailable: 'Phone sign-in is unavailable right now. Use email and password instead.',
  config: 'Phone sign-in is unavailable right now. Use email and password instead.',
  cancelled: 'Sign-in was cancelled.',
  'not-configured': 'Phone sign-in is not set up. Use email and password instead.',
  'no-session': 'Request a new code first.',
  'popup-blocked': 'The sign-in popup was blocked by your browser. Please allow popups for this site and try again.'
};
export const phoneErrorMessage = (e: unknown): string =>
  e instanceof PhoneAuthError ? MESSAGES[e.kind] : MESSAGES.unavailable;

/** Maps a Firebase Auth error (by code only; the SDK's own text is never shown) to a safe kind. */
export function mapFirebaseError(e: unknown): PhoneAuthError {
  const code = typeof (e as { code?: unknown })?.code === 'string' ? (e as { code: string }).code : '';
  const kind: PhoneAuthErrorKind =
    code === 'auth/invalid-phone-number' || code === 'auth/missing-phone-number' ? 'invalid-phone'
    : code === 'auth/too-many-requests' ? 'rate-limited'
    : code === 'auth/quota-exceeded' ? 'quota'
    : code === 'auth/code-expired' ? 'code-expired'
    : code === 'auth/invalid-verification-code' || code === 'auth/missing-verification-code' || code === 'auth/invalid-verification-id' ? 'code-invalid'
    : code === 'auth/captcha-check-failed' || code === 'auth/missing-recaptcha-token' || code === 'auth/invalid-recaptcha-token' || code === 'auth/recaptcha-not-enabled' ? 'captcha'
    : code === 'auth/network-request-failed' ? 'network'
    : code === 'auth/operation-not-allowed' ? 'region-blocked'
    : code === 'auth/unauthorized-domain' || code === 'auth/app-not-authorized' || code === 'auth/invalid-app-credential' ? 'domain'
    : code === 'auth/popup-blocked' ? 'popup-blocked'
    : code === 'auth/argument-error' ? 'config' // the SDK was called with a bad argument (a wiring bug), never user input
    : 'unavailable';
  // Only the code is logged (never the SDK text, token, number or key) so an unexplained "unavailable" can be diagnosed from the console.
  if (kind === 'unavailable' || kind === 'config') console.warn('[phone-auth] Firebase error', code || 'unknown');
  return new PhoneAuthError(kind, code || 'unknown');
}

/** User-facing text for a failed Google web sign-in: never the Firebase code, never phone wording. */
export function googleAuthErrorMessage(e: PhoneAuthError): string {
  switch (e.kind) {
    case 'cancelled': return 'Google sign-in was cancelled.';
    case 'popup-blocked': return 'The Google sign-in popup was blocked by your browser. Please allow popups for this site and try again.';
    case 'network': return MESSAGES.network;
    case 'domain': return 'Google sign-in is not available on this address. Use another sign-in method.';
    case 'not-configured': return 'Google sign-in is not set up. Use another sign-in method.';
    default: return 'Google sign-in is unavailable right now. Use another sign-in method.';
  }
}

/**
 * The one Auth instance for this page. It must be created WITH the popup/redirect resolver: initializeAuth() without one makes
 * signInWithPopup() throw auth/argument-error, and phone and Google sign-in share the instance.
 */
function firebaseAuthFor(A: typeof import('firebase/auth'), app: import('firebase/app').FirebaseApp): import('firebase/auth').Auth {
  try {
    // No persistence: the Firebase session is only a stepping stone to one ID token and must not outlive this page.
    return A.initializeAuth(app, { persistence: A.inMemoryPersistence, popupRedirectResolver: A.browserPopupRedirectResolver });
  } catch {
    return A.getAuth(app);
  }
}

/**
 * One phone verification. `sendCode` starts it (invisible reCAPTCHA + SMS), `confirm` returns a Firebase ID token for the API.
 * `reset` discards any pending verification and the reCAPTCHA widget (call before a resend and on unmount).
 */
export interface PhoneAuthProvider {
  sendCode(e164: string): Promise<void>;
  confirm(code: string): Promise<string>;
  reset(): void;
}

export interface FirebaseWebConfig { apiKey: string; authDomain: string; projectId: string; appId: string }

export function firebaseWebConfig(env: Record<string, string | undefined> = import.meta.env as Record<string, string | undefined>): FirebaseWebConfig | null {
  const c = { apiKey: env.VITE_FIREBASE_API_KEY, authDomain: env.VITE_FIREBASE_AUTH_DOMAIN, projectId: env.VITE_FIREBASE_PROJECT_ID, appId: env.VITE_FIREBASE_APP_ID };
  return c.apiKey && c.authDomain && c.projectId && c.appId ? (c as FirebaseWebConfig) : null;
}

/** True when this build can run a phone verification or Google sign-in at all (Firebase env present, or the build-time e2e mock). */
export const phoneAuthConfigured = (): boolean => import.meta.env.VITE_PHONE_AUTH_MOCK === '1' || firebaseWebConfig() !== null;
export const firebaseAuthConfigured = phoneAuthConfigured;

/** Id of the DOM node the invisible reCAPTCHA attaches to. */
export const RECAPTCHA_CONTAINER_ID = 'pb-recaptcha';

let override: (() => Promise<PhoneAuthProvider>) | null = null;
/** Test seam: replace the provider factory. Never called by application code. */
export const __setPhoneAuthFactory = (f: (() => Promise<PhoneAuthProvider>) | null) => { override = f; };

export type FirebaseAuthBundle = {
  auth: import('firebase/auth').Auth;
  A: typeof import('firebase/auth');
};

let initPromise: Promise<FirebaseAuthBundle> | null = null;

export function resetFirebaseAuthForTesting(): void {
  initPromise = null;
}

/** Pre-initializes Firebase Auth with popup resolver before user interaction, preventing popup-blocked errors. */
export function initFirebaseAuth(): Promise<FirebaseAuthBundle> {
  if (initPromise) return initPromise;
  if (import.meta.env.VITE_PHONE_AUTH_MOCK === '1') {
    initPromise = Promise.resolve({} as FirebaseAuthBundle);
    return initPromise;
  }
  const config = firebaseWebConfig();
  if (!config) {
    initPromise = Promise.reject(new PhoneAuthError('not-configured', 'missing firebase env'));
    return initPromise;
  }
  initPromise = (async () => {
    let sdk: [typeof import('firebase/app'), typeof import('firebase/auth')];
    try {
      sdk = await Promise.all([import('firebase/app'), import('firebase/auth')]);
    } catch {
      throw new PhoneAuthError('network', 'sdk load failed');
    }
    const [{ initializeApp, getApps, getApp }, A] = sdk;
    const app = getApps().length ? getApp() : initializeApp(config);
    const auth = firebaseAuthFor(A, app);
    return { auth, A };
  })();
  return initPromise;
}

export async function createPhoneAuth(): Promise<PhoneAuthProvider> {
  if (override) return override();
  if (import.meta.env.VITE_PHONE_AUTH_MOCK === '1') {
    const m = await import('./phone-auth-mock');
    return m.createMockPhoneAuth();
  }
  const config = firebaseWebConfig();
  if (!config) throw new PhoneAuthError('not-configured', 'missing firebase env');
  return createFirebasePhoneAuth(config);
}

async function createFirebasePhoneAuth(_config: FirebaseWebConfig): Promise<PhoneAuthProvider> {
  const { auth, A } = await initFirebaseAuth();
  let verifier: import('firebase/auth').RecaptchaVerifier | null = null;
  let pending: import('firebase/auth').ConfirmationResult | null = null;

  const clearVerifier = () => { try { verifier?.clear(); } catch { /* already gone */ } verifier = null; };
  return {
    async sendCode(e164) {
      pending = null;
      clearVerifier();
      try {
        verifier = new A.RecaptchaVerifier(auth, RECAPTCHA_CONTAINER_ID, { size: 'invisible' });
        pending = await A.signInWithPhoneNumber(auth, e164, verifier);
      } catch (e) {
        clearVerifier();
        throw mapFirebaseError(e);
      }
    },
    async confirm(code) {
      if (!pending) throw new PhoneAuthError('no-session', 'no pending verification');
      try {
        const cred = await pending.confirm(code);
        const token = await cred.user.getIdToken(true);
        pending = null;
        await A.signOut(auth).catch(() => undefined);
        return token;
      } catch (e) {
        throw e instanceof PhoneAuthError ? e : mapFirebaseError(e);
      }
    },
    reset() { pending = null; clearVerifier(); }
  };
}

let googleOverride: (() => Promise<string>) | null = null;
/** Test seam: replace the Google sign-in provider. Never called by application code. */
export const __setGoogleAuthFactory = (f: (() => Promise<string>) | null) => { googleOverride = f; };

export async function signInWithGoogleWeb(): Promise<string> {
  if (googleOverride) return googleOverride();
  if (import.meta.env.VITE_PHONE_AUTH_MOCK === '1') {
    return 'mock-google-id-token';
  }
  const config = firebaseWebConfig();
  if (!config) throw new PhoneAuthError('not-configured', 'missing firebase env');
  const { auth, A } = await initFirebaseAuth();
  const provider = new A.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    const cred = await A.signInWithPopup(auth, provider);
    const token = await cred.user.getIdToken(true);
    await A.signOut(auth).catch(() => undefined);
    return token;
  } catch (e: unknown) {
    const code = (e as { code?: unknown })?.code;
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
      throw new PhoneAuthError('cancelled', 'cancelled');
    }
    if (code === 'auth/popup-blocked') {
      throw new PhoneAuthError('popup-blocked', 'popup-blocked');
    }
    throw mapFirebaseError(e);
  }
}

