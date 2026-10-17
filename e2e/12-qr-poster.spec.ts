import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { decode, rasterise, readPdf } from '../apps/web/src/shop/poster/__tests__/pdf-raster';
import { WEB } from './env';
import { ART, SLUG, VIEWPORTS, expectNoOverflow, uiLogin } from './support';

const requireFromWeb = createRequire(path.join(__dirname, '..', 'apps', 'web', 'package.json'));

// Central Print owner. The QR must decode to the API's configured WEB_ORIGIN plus the exact slug.
const EXPECTED_URL = `${WEB}/p/${SLUG}`;

async function openGenerator(page: Page) {
  await uiLogin(page, 'owner@central.test');
  await expect(page.getByRole('heading', { name: 'Print queue' })).toBeVisible();
  await page.goto('/shop/qr/poster');
  await expect(page.getByRole('heading', { name: 'Poster generator' })).toBeVisible();
  await expect(page.getByTestId('poster-preview')).toBeVisible();
}

async function downloadPdf(page: Page): Promise<{ name: string; bytes: Uint8Array }> {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download PDF' }).click()]);
  const file = await dl.path();
  return { name: dl.suggestedFilename(), bytes: new Uint8Array(readFileSync(file!)) };
}

test.describe('QR poster generator', () => {
  test.use({ viewport: VIEWPORTS.desktop });

  test('existing QR page keeps working and links to the generator', async ({ page }) => {
    await uiLogin(page, 'owner@central.test');
    await page.getByRole('link', { name: 'QR & standee' }).first().click();
    await expect(page.getByTestId('qr-poster')).toBeAttached();
    await expect(page.getByRole('img', { name: /QR code for/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy link' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download PNG' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Print A4 poster' })).toBeVisible();
    await page.getByRole('link', { name: 'Design a branded poster' }).click();
    await expect(page).toHaveURL(/\/shop\/qr\/poster$/);
  });

  for (const template of ['Classic', 'Premium', 'Minimal'] as const) {
    for (const size of ['A4', 'A5'] as const) {
      test(`${template} ${size}: downloaded PDF has the right page size and its QR decodes to the shop URL`, async ({ page }) => {
        await openGenerator(page);
        await page.getByRole('radio', { name: new RegExp(template) }).check({ force: true });
        await page.getByRole('radio', { name: size, exact: true }).check({ force: true });
        await expect(page.getByTestId('poster-preview')).toHaveAccessibleName(new RegExp(`${template} poster preview.*${size}`));
        const { name, bytes } = await downloadPdf(page);
        expect(name).toBe(`printout-buddy-poster-${SLUG}-${size.toLowerCase()}.pdf`);
        const pdf = await readPdf(bytes);
        expect(pdf.width / 72 * 25.4).toBeCloseTo(size === 'A4' ? 210 : 148, 0);
        expect(pdf.height / 72 * 25.4).toBeCloseTo(size === 'A4' ? 297 : 210, 0);
        for (const ppp of [1.5, 2.0833, 4.1667]) expect(decode(rasterise(pdf, ppp)), `${template} ${size} @${ppp}`).toBe(EXPECTED_URL);
      });
    }
  }

  test('PNG download is a 300 dpi image and the QR in the browser-rendered PNG decodes', async ({ page }) => {
    await openGenerator(page);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download PNG' }).click()]);
    expect(dl.suggestedFilename()).toBe(`printout-buddy-poster-${SLUG}-a4.png`);
    const buf = readFileSync((await dl.path())!);
    expect(buf.subarray(1, 4).toString()).toBe('PNG');
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    expect([w, h]).toEqual([2480, 3508]);
    // Decode the PNG pixels in the browser with jsQR (a 35 MB pixel array is too big to ship to Node).
    await page.addScriptTag({ path: requireFromWeb.resolve('jsqr') });
    const decoded = await page.evaluate(async (b64) => {
      const img = new Image();
      await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('img')); img.src = `data:image/png;base64,${b64}`; });
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height);
      return (window as unknown as { jsQR: (px: Uint8ClampedArray, w: number, h: number) => { data: string } | null }).jsQR(d.data, d.width, d.height)?.data ?? null;
    }, buf.toString('base64'));
    expect(decoded).toBe(EXPECTED_URL);
  });

  test('settings persist across reloads, reset restores defaults, details stay opt-in', async ({ page }) => {
    await openGenerator(page);
    await page.getByRole('radio', { name: /Premium/ }).check({ force: true });
    await page.getByRole('textbox', { name: 'Call to action' }).fill('Print with us');
    await page.reload();
    await expect(page.getByRole('radio', { name: /Premium/ })).toBeChecked();
    await expect(page.getByRole('textbox', { name: 'Call to action' })).toHaveValue('Print with us');
    await page.getByRole('button', { name: 'Reset to default' }).click();
    await expect(page.getByRole('radio', { name: /Classic/ })).toBeChecked();
    await expect(page.getByRole('textbox', { name: 'Call to action' })).toHaveValue('Scan to upload documents');
    await expect(page.getByRole('checkbox', { name: 'Shop address' })).not.toBeChecked();
  });

  test('keyboard: template radios are reachable and arrow keys switch them', async ({ page }) => {
    await openGenerator(page);
    await page.getByRole('radio', { name: /Classic/ }).focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('radio', { name: /Premium/ })).toBeChecked();
    await expect(page.getByRole('radio', { name: /Premium/ })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('radio', { name: /Minimal/ })).toBeChecked();
  });

  test('accessibility (axe) on the generator, desktop', async ({ page }) => {
    await openGenerator(page);
    const results = await new AxeBuilder({ page }).include('#pb-main').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
  });

  test('another shop never sees this shop poster data (tenant isolation)', async ({ page }) => {
    await uiLogin(page, 'owner@metro.test');
    await expect(page.getByRole('heading', { name: 'Print queue' })).toBeVisible();
    await page.goto('/shop/qr/poster');
    await expect(page.getByTestId('poster-preview')).toBeVisible();
    await expect(page.getByTestId('poster-preview')).toHaveAccessibleName(new RegExp(`${WEB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/p/metro-copies`));
    await expect(page.locator('body')).not.toContainText(SLUG);
  });

  test('unauthenticated visitors are sent to sign in', async ({ page }) => {
    await page.goto('/shop/qr/poster');
    await expect(page).toHaveURL(/\/shop\/login/);
  });
});

for (const [label, vp] of [['360', VIEWPORTS.s360], ['390', VIEWPORTS.mobile], ['768', VIEWPORTS.tablet], ['1440', VIEWPORTS.desktop]] as const) {
  test(`responsive ${label}px: no overflow, preview visible, controls usable; screenshot`, async ({ page }) => {
    await page.setViewportSize(vp);
    await openGenerator(page);
    await expectNoOverflow(page, `poster ${label}`);
    const box = await page.getByTestId('poster-preview').boundingBox();
    expect(box && box.width).toBeGreaterThan(Math.min(vp.width - 40, 250));
    await expect(page.getByRole('button', { name: 'Download PDF' })).toBeVisible();
    for (const t of ['Classic', 'Premium', 'Minimal']) {
      await page.getByRole('radio', { name: new RegExp(t) }).check({ force: true });
      await page.screenshot({ path: path.join(ART, `120-poster-${label}-${t.toLowerCase()}.png`), fullPage: true });
    }
    await expectNoOverflow(page, `poster ${label} after template switch`);
  });
}
