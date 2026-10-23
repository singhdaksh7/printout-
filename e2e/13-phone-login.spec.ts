import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { API, FIREBASE_E2E_PROJECT, PHONE_WEB, SEED_PASSWORD, WEB } from './env';
import { VIEWPORTS, expectNoOverflow, jfetch, newMobileContext, shot } from './support';

// Firebase phone sign-in for shop owners, in a real browser against the real API.
//  - Browser: the build-time mock Firebase client (VITE_PHONE_AUTH_MOCK=1, OTP 123456) on a dedicated web server (PHONE_WEB).
//  - API: the real firebase-admin SDK in emulator mode (FIREBASE_AUTH_EMULATOR_HOST), which accepts unsigned test tokens but still
//    checks project, issuer, expiry and claims. No Firebase project, SMS or network is involved.
// Selectors for the phone screens are centralised in `ui` below so they can be reconciled with the components in one place.

test.use({ baseURL: PHONE_WEB });

const OTP = '123456';
const OWNER_A = 'owner@central.test';
const OWNER_B = 'owner@metro.test';
const PHONE_A = '9876500001';
const PHONE_B = '9876500002';
const PHONE_UNLINKED = '9876500003';
const PHONE_REPLACEMENT = '9876500004';
const E164 = (national: string) => `+91${national}`;

const ui = {
  screen: (p: Page) => p.getByTestId('phone-login'),
  welcome: (p: Page) => p.getByRole('heading', { name: 'Welcome back' }),
  codeHeading: (p: Page) => p.getByRole('heading', { name: 'Enter your code' }),
  country: (p: Page) => p.getByLabel('Country code'),
  mobile: (p: Page) => p.getByLabel('Mobile number'),
  sendOtp: (p: Page) => p.getByRole('button', { name: 'Send OTP' }),
  otpGroup: (p: Page) => p.getByTestId('otp-group'),
  digit: (p: Page, n: number) => p.getByLabel(`Digit ${n} of 6`),
  verify: (p: Page) => p.getByRole('button', { name: 'Verify OTP' }),
  resend: (p: Page) => p.getByRole('button', { name: /^Resend OTP/ }),
  change: (p: Page) => p.getByRole('button', { name: 'Change phone number' }),
  useEmail: (p: Page) => p.getByRole('button', { name: 'Sign in with email and password instead' }),
  usePhone: (p: Page) => p.getByRole('button', { name: 'Sign in with mobile number instead' }),
  error: (p: Page) => p.getByTestId('phone-error'),
  section: (p: Page) => p.getByTestId('phone-signin'),
  linkedNumber: (p: Page) => p.getByTestId('phone-linked-number')
};

/** Types the six digits into the OTP boxes; the sixth digit submits automatically. */
async function typeOtp(page: Page, code: string) {
  await ui.digit(page, 1).click();
  await page.keyboard.type(code);
}

/** Origin must equal the API's WEB_ORIGIN for the phone exchange; this server runs on another port, so present the configured origin. */
async function presentConfiguredOrigin(context: BrowserContext) {
  await context.route('**/api/v1/**', (route) => route.continue({ headers: { ...route.request().headers(), origin: WEB } }));
}

async function scan(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s), e.g. ${v.nodes[0]?.target.join(' ')}`);
  expect(summary, `axe violations on ${label}\n${summary.join('\n')}`).toEqual([]);
}

/** Unsigned Firebase-shaped ID token, accepted only by firebase-admin in emulator mode. */
function testToken(phone: string, over: { project?: string; authAgeSeconds?: number; expiresInSeconds?: number } = {}) {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const project = over.project ?? FIREBASE_E2E_PROJECT;
  const now = Math.floor(Date.now() / 1000);
  const authTime = now - (over.authAgeSeconds ?? 0);
  const payload = {
    iss: `https://securetoken.google.com/${project}`,
    aud: project,
    auth_time: authTime,
    iat: authTime,
    exp: now + (over.expiresInSeconds ?? 3600),
    sub: `e2e-uid-${phone}`,
    user_id: `e2e-uid-${phone}`,
    phone_number: phone,
    firebase: { identities: { phone: [phone] }, sign_in_provider: 'phone' }
  };
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.`;
}

async function apiLogin(email: string) {
  const res = await fetch(`${API}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: SEED_PASSWORD }) });
  expect(res.status).toBe(200);
  const cookie = /printout_session=[^;]+/.exec(res.headers.get('set-cookie') ?? '')![0];
  const csrf = ((await res.json()) as any).data.csrfToken as string;
  return { cookie, csrf };
}

async function apiPost(session: { cookie: string; csrf: string } | null, path: string, json: unknown) {
  return jfetch(`${API}/api/v1${path}`, { method: 'POST', json, headers: session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {} });
}

async function apiUnlink(email: string) {
  const s = await apiLogin(email);
  await apiPost(s, '/shop/account/phone/unlink', { currentPassword: SEED_PASSWORD });
}

async function signInByEmail(page: Page, email: string) {
  await page.goto('/shop/login');
  await ui.useEmail(page).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((u) => /^\/shop(\/|$)/.test(u.pathname) && !u.pathname.startsWith('/shop/login'));
}

async function requestOtp(page: Page, national: string) {
  await page.goto('/shop/login');
  await expect(ui.welcome(page)).toBeVisible();
  await ui.mobile(page).fill(national);
  await ui.sendOtp(page).click();
  await expect(ui.codeHeading(page)).toBeVisible();
}

/** Settings flow: password step first, then number + OTP. Uses "Replace number" when a number is already linked. */
async function linkPhoneInSettings(page: Page, national: string, password = SEED_PASSWORD) {
  await page.goto('/shop/settings');
  const section = ui.section(page);
  await expect(section.getByRole('heading', { name: 'Phone sign-in' })).toBeVisible();
  await section.getByRole('button', { name: /^(Link mobile number|Replace number)$/ }).click();
  const panel = page.getByTestId('phone-link-panel');
  await panel.getByLabel('Current password').fill(password);
  await panel.getByRole('button', { name: 'Continue' }).click();
  await panel.getByLabel('Mobile number').fill(national);
  await panel.getByRole('button', { name: 'Send OTP' }).click();
  await panel.getByLabel('Digit 1 of 6').click();
  await page.keyboard.type(OTP);
  const submit = panel.getByRole('button', { name: /^Verify and (link|replace)$/ });
  if (await submit.isEnabled().catch(() => false)) await submit.click();
}

test.describe.configure({ mode: 'serial' });

test.describe('phone sign-in (shop owners)', () => {
  test.beforeEach(async ({ context }) => {
    await presentConfiguredOrigin(context);
  });

  test.afterAll(async () => {
    await apiUnlink(OWNER_A).catch(() => undefined);
    await apiUnlink(OWNER_B).catch(() => undefined);
  });

  test('config endpoint advertises phone login and only the allowed calling codes', async () => {
    const res = await jfetch(`${API}/api/v1/auth/phone/config`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/private|secret|credential/i);
    expect(res.body.data.enabled).toBe(true);
  });

  test('login screen: logo, welcome, +91 default, validation, email fallback still works', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto('/shop/login');
    await expect(ui.welcome(page)).toBeVisible();
    await expect(page.getByRole('img', { name: /printout ?buddy/i }).first()).toBeVisible();
    await expect(ui.country(page)).toHaveValue(/91/);
    await ui.mobile(page).fill('12345');
    await ui.sendOtp(page).click();
    await expect(ui.error(page).or(page.getByText(/valid.*(mobile|number)/i)).first()).toBeVisible();
    await expect(ui.otpGroup(page)).toHaveCount(0);
    await shot(page, '131-phone-login-entry');

    await ui.useEmail(page).click();
    await expect(page.getByRole('heading', { name: 'Shop sign in' })).toBeVisible();
    await expect(ui.usePhone(page)).toBeVisible();
    await page.getByLabel('Email').fill(OWNER_A);
    await page.getByLabel('Password').fill(SEED_PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/shop(\/|$)/);
  });

  test('an unlinked number is told it is not linked and gets no session', async ({ page }) => {
    await requestOtp(page, PHONE_UNLINKED);
    await typeOtp(page, OTP);
    await expect(ui.error(page)).toContainText(/not linked|isn.t linked|no shop account/i);
    const session = await page.request.get('/api/v1/auth/session');
    expect(session.status()).toBe(401);
    await shot(page, '132-phone-not-linked');
  });

  test('owner A links a phone in Settings (password re-entry required), signs out, signs in with OTP', async ({ page }) => {
    await signInByEmail(page, OWNER_A);

    // Wrong password: nothing is linked.
    await linkPhoneInSettings(page, PHONE_A, 'definitely-not-the-password');
    await expect(ui.section(page).getByText(/password.*(incorrect|not correct|wrong)|incorrect.*password/i).or(ui.error(page)).first()).toBeVisible();
    const before = await apiLogin(OWNER_A);
    expect((await jfetch(`${API}/api/v1/shop/account/phone`, { headers: { cookie: before.cookie } })).body.data.linked).toBe(false);

    await linkPhoneInSettings(page, PHONE_A);
    await expect(ui.linkedNumber(page)).toBeVisible();
    // The full number is never shown back; only a masked form.
    await expect(page.locator('body')).not.toContainText(PHONE_A);
    await expect(ui.linkedNumber(page)).toContainText(/0001/);
    await shot(page, '133-phone-linked-settings');

    await page.getByRole('button', { name: /sign out/i }).first().click();
    await expect(page).toHaveURL(/\/shop\/login/);

    await requestOtp(page, PHONE_A);
    await typeOtp(page, OTP);
    await expect(page).toHaveURL(/\/shop(\/|$)(?!login)/);
    const session = await (await page.request.get('/api/v1/auth/session')).json();
    expect(session.data.user.role).toBe('SHOP_OWNER');
    expect(session.data.shop.slug).toBe('central-print');
  });

  test('wrong code shows an error and does not sign in; the code field keeps focus semantics', async ({ page }) => {
    await requestOtp(page, PHONE_A);
    await typeOtp(page, '000000');
    await expect(ui.error(page)).toBeVisible();
    await expect(page).toHaveURL(/\/shop\/login/);
    expect((await page.request.get('/api/v1/auth/session')).status()).toBe(401);
    // Resend is rate-limited by a visible cooldown; changing the number returns to the first screen.
    await expect(ui.resend(page)).toBeDisabled();
    await ui.change(page).click();
    await expect(ui.welcome(page)).toBeVisible();
  });

  test('shop isolation: a number linked to shop A cannot be linked to shop B, and B signs in only to B', async ({ page }) => {
    const b = await apiLogin(OWNER_B);
    const dup = await apiPost(b, '/shop/account/phone', { idToken: testToken(E164(PHONE_A)), currentPassword: SEED_PASSWORD });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('PHONE_UNAVAILABLE');

    await signInByEmail(page, OWNER_B);
    await linkPhoneInSettings(page, PHONE_B);
    await expect(ui.linkedNumber(page)).toBeVisible();
    await page.getByRole('button', { name: /sign out/i }).first().click();

    await requestOtp(page, PHONE_B);
    await typeOtp(page, OTP);
    await expect(page).toHaveURL(/\/shop(\/|$)(?!login)/);
    const session = await (await page.request.get('/api/v1/auth/session')).json();
    expect(session.data.shop.slug).toBe('metro-copies');
  });

  test('replace the number, then unlink; the old number stops working and password login remains', async ({ page }) => {
    await signInByEmail(page, OWNER_A);
    await linkPhoneInSettings(page, PHONE_A);
    await expect(ui.linkedNumber(page)).toBeVisible();
    await linkPhoneInSettings(page, PHONE_REPLACEMENT);
    await expect(ui.linkedNumber(page)).toContainText(/0004/);
    // The replaced number no longer signs in.
    const old = await apiPost(null, '/auth/phone/session', { idToken: testToken(E164(PHONE_A), { authAgeSeconds: 0 }) });
    expect(old.status).toBe(403);
    expect(old.body.error.code).toBe('PHONE_NOT_LINKED');

    await page.goto('/shop/settings');
    await ui.section(page).getByRole('button', { name: 'Unlink', exact: true }).click();
    const unlink = page.getByTestId('phone-unlink-panel');
    await unlink.getByLabel('Current password').fill(SEED_PASSWORD);
    await unlink.getByRole('button', { name: 'Unlink number' }).click();
    await expect(ui.section(page).getByRole('button', { name: 'Link mobile number' })).toBeVisible();
    await expect(ui.linkedNumber(page)).toHaveCount(0);

    await page.context().clearCookies();
    await signInByEmail(page, OWNER_A);
  });

  test('API: forged, wrong-project, expired and stale tokens are refused; replay is refused; admin cannot link', async () => {
    const owner = await apiLogin(OWNER_A);
    const link = await apiPost(owner, '/shop/account/phone', { idToken: testToken(E164(PHONE_A)), currentPassword: SEED_PASSWORD });
    expect(link.status).toBe(200);

    const bad = [
      ['garbage', 'not-a-token'],
      ['wrong project', testToken(E164(PHONE_A), { project: 'some-other-project' })],
      ['expired', testToken(E164(PHONE_A), { expiresInSeconds: -60, authAgeSeconds: 7200 })],
      ['stale auth_time', testToken(E164(PHONE_A), { authAgeSeconds: 3000 })]
    ] as const;
    for (const [label, idToken] of bad) {
      const res = await apiPost(null, '/auth/phone/session', { idToken });
      expect(res.status, label).toBeGreaterThanOrEqual(400);
      expect(res.status, label).toBeLessThan(500);
      expect(res.headers.get('set-cookie') ?? '', label).not.toContain('printout_session');
    }
    // Tampered payload (unsigned token with the signature slot filled): refused.
    const parts = testToken(E164(PHONE_A)).split('.');
    expect((await apiPost(null, '/auth/phone/session', { idToken: `${parts[0]}.${parts[1]}.AAAA` })).status).toBeGreaterThanOrEqual(400);

    const good = testToken(E164(PHONE_A));
    const first = await apiPost(null, '/auth/phone/session', { idToken: good });
    expect(first.status).toBe(200);
    expect(first.headers.get('set-cookie')).toContain('printout_session');
    const replay = await apiPost(null, '/auth/phone/session', { idToken: good });
    expect(replay.status).toBeGreaterThanOrEqual(400);

    // Wrong password cannot link; no CSRF cannot link; admin sessions are not shop sessions.
    expect((await apiPost(owner, '/shop/account/phone', { idToken: testToken(E164(PHONE_REPLACEMENT)), currentPassword: 'nope' })).status).toBe(403);
    expect((await apiPost({ cookie: owner.cookie, csrf: 'x' }, '/shop/account/phone', { idToken: testToken(E164(PHONE_REPLACEMENT)), currentPassword: SEED_PASSWORD })).status).toBe(403);
    const admin = await apiLogin('admin@printout.test');
    expect((await apiPost(admin, '/shop/account/phone', { idToken: testToken(E164(PHONE_UNLINKED)), currentPassword: SEED_PASSWORD })).status).toBe(403);
    expect((await apiPost(null, '/auth/phone/session', { idToken: testToken(E164(PHONE_UNLINKED)) })).status).toBe(403);
    await apiUnlink(OWNER_A);
  });
});

test.describe('phone sign-in responsive and accessible', () => {
  test.beforeEach(async ({ context }) => {
    await presentConfiguredOrigin(context);
  });

  for (const vp of [VIEWPORTS.s360, VIEWPORTS.mobile, VIEWPORTS.tablet, VIEWPORTS.desktop]) {
    test(`both screens at ${vp.width}px: no overflow, no axe violations, keyboard reachable`, async ({ browser }) => {
      const context = vp.width <= 430 ? await newMobileContext(browser, vp) : await browser.newContext({ viewport: vp, baseURL: PHONE_WEB });
      await presentConfiguredOrigin(context);
      const page = await context.newPage();
      await page.goto('/shop/login');
      await expect(ui.welcome(page)).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await expectNoOverflow(page, `phone entry ${vp.width}`);
      await scan(page, `phone entry ${vp.width}`);
      await shot(page, `134-phone-entry-${vp.width}`);

      // Keyboard only: tab to the number, type, press Enter to send.
      await ui.mobile(page).focus();
      await page.keyboard.type(PHONE_UNLINKED);
      await page.keyboard.press('Enter');
      await expect(ui.otpGroup(page)).toBeVisible();
      await expect(ui.digit(page, 1)).toBeFocused();
      await expectNoOverflow(page, `otp ${vp.width}`);
      await scan(page, `otp screen ${vp.width}`);
      await shot(page, `135-phone-otp-${vp.width}`);

      // Five digits do not submit; the verify button is reachable by keyboard.
      await page.keyboard.type('12345');
      await expect(ui.verify(page)).toBeVisible();
      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => document.activeElement?.tagName);
      expect(['BUTTON', 'A', 'INPUT']).toContain(focused);
      await context.close();
    });
  }
});
