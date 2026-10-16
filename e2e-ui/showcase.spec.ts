import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// Viewports: desktop, tablet (the 855px width of the admin tablet reference, 2.pdf p20) and phone (3.pdf p23-24 are 375px).
const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'tablet', width: 855, height: 900 },
  { name: 'mobile', width: 375, height: 812 }
] as const;
const OUT = path.join(__dirname, 'artifacts');

async function open(page: Page) {
  await page.goto('/ui-showcase');
  await expect(page.getByRole('heading', { level: 1, name: 'PrintoutBuddy component showcase' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

for (const vp of VIEWPORTS) {
  test.describe(`showcase @ ${vp.name} ${vp.width}px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('has no axe violations (WCAG 2.1 A/AA)', async ({ page }) => {
      await open(page);
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s), e.g. ${v.nodes[0]?.target.join(' ')}`);
      expect(summary, summary.join('\n')).toEqual([]);
    });

    test('has no horizontal page scroll', async ({ page }) => {
      await open(page);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    });

    test('loads the approved fonts and screenshots every section', async ({ page }) => {
      await open(page);
      const fonts = await page.evaluate(() => ({
        rubik: document.fonts.check('700 32px Rubik'),
        dm: document.fonts.check('400 15px "DM Sans"'),
        mono: document.fonts.check('500 13px "JetBrains Mono"')
      }));
      expect(fonts).toEqual({ rubik: true, dm: true, mono: true });
      for (const id of ['tokens', 'actions', 'inputs', 'status', 'feedback', 'containers', 'data', 'charts']) {
        await page.locator(`#${id}`).screenshot({ path: path.join(OUT, `${vp.name}-${id}.png`) });
      }
    });
  });
}

test.describe('keyboard and focus', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('focus ring is the info-blue 3px outline on buttons', async ({ page }) => {
    await open(page);
    await page.keyboard.press('Tab'); // first tabbable: the showcase nav / skip target
    const btn = page.getByRole('button', { name: 'primary md' });
    await btn.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    const outline = await btn.evaluate((el) => {
      const s = getComputedStyle(el);
      return { width: s.outlineWidth, color: s.outlineColor, style: s.outlineStyle };
    });
    expect(outline).toEqual({ width: '3px', color: 'rgb(36, 86, 201)', style: 'solid' });
  });

  test('modal traps focus and Escape returns it to the opener', async ({ page }) => {
    await open(page);
    const opener = page.getByRole('button', { name: 'Open modal' });
    await opener.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });

  for (const [opener, label] of [['Open modal', 'modal'], ['Open danger modal', 'danger modal'], ['Open drawer', 'drawer']] as const) {
    test(`open ${label} has no axe violations`, async ({ page }) => {
      await open(page);
      await page.getByRole('button', { name: opener }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.waitForTimeout(400); // let the 150/250 ms entrance animations finish before measuring contrast
      const results = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s), e.g. ${v.nodes[0]?.target.join(' ')}`);
      expect(summary, summary.join('\n')).toEqual([]);
      await page.screenshot({ path: path.join(OUT, `overlay-${label.replace(' ', '-')}.png`) });
    });
  }

  test('reduced motion disables animation', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page);
    const dur = await page.getByRole('button', { name: 'primary md' }).evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(parseFloat(dur)).toBeLessThan(0.01);
  });
});
