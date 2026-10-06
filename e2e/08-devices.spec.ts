import { expect, test } from '@playwright/test';
import { API } from './env';
import { VIEWPORTS, dbQuery, expectNoOverflow, jfetch, uiLogin } from './support';

test.use({ viewport: VIEWPORTS.desktop });

const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

// Drives the REAL owner UI and the REAL device API: the "device" is played by this spec through /api/v1/device/*.
test('Printing Devices: add via pairing code, device appears Online, rename, disconnect, revoked credential is rejected', async ({ page }) => {
  await uiLogin(page, 'owner@central.test');
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('link', { name: /Printing Devices/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Printing Devices' })).toBeVisible();

  // empty state
  await expect(page.getByTestId('devices-empty')).toBeVisible();
  await expect(page.getByTestId('device-card')).toHaveCount(0);
  await expectNoOverflow(page, 'devices empty 1440');

  // Add device: PB- code and countdown
  await page.getByRole('button', { name: 'Add your first device' }).click();
  const codeEl = page.getByTestId('pairing-code');
  await expect(codeEl).toHaveText(/^PB-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  const code = (await codeEl.textContent())!.trim();
  await expect(page.getByRole('timer')).toContainText(/Expires in \d+:\d{2}/);
  expect(dbQuery(`select count(*) from "DevicePairingCode" where "usedAt" is null`)).toBe('1');
  // raw code is never stored
  expect(dbQuery(`select count(*) from "DevicePairingCode" where "codeHash" like '%${code.slice(3, 7)}%'`)).toBe('0');

  // the device pairs through the real API
  const pair = await jfetch(`${API}/api/v1/device/pair`, {
    method: 'POST',
    json: { code, deviceName: 'E2E Counter Phone', platform: 'ANDROID', appVersion: '1.2.3', osVersion: 'Android 14' }
  });
  expect(pair.status).toBe(200);
  const secret: string = pair.body.data.deviceCredential;
  const deviceId: string = pair.body.data.deviceId;
  expect(secret).toMatch(/^pbd_/);
  expect(pair.body.data.shop.displayName).toBeTruthy();
  // the code is single use
  const replay = await jfetch(`${API}/api/v1/device/pair`, { method: 'POST', json: { code, deviceName: 'Again', platform: 'WINDOWS' } });
  expect(replay.status).toBe(400);
  expect(replay.body.error.code).toBe('PAIRING_CODE_INVALID');

  // heartbeat, then close the dialog: the list refreshes and shows the device Online
  const hb = await jfetch(`${API}/api/v1/device/heartbeat`, { method: 'POST', headers: bearer(secret), json: {} });
  expect(hb.status).toBe(200);
  await page.getByRole('button', { name: 'Done' }).click();
  const card = page.getByTestId('device-card').filter({ hasText: 'E2E Counter Phone' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Online');
  await expect(card).toContainText('Android');
  await expect(card).toContainText('1.2.3');
  await expect(page.getByTestId('devices-empty')).toHaveCount(0);

  // device API works while active
  const orders = await jfetch(`${API}/api/v1/device/orders`, { headers: bearer(secret) });
  expect(orders.status).toBe(200);

  // rename
  await card.getByRole('button', { name: /Rename E2E Counter Phone/ }).click();
  const nameInput = page.getByLabel('Device name');
  await nameInput.fill('Front Desk Phone');
  await page.getByRole('button', { name: 'Save name' }).click();
  const renamed = page.getByTestId('device-card').filter({ hasText: 'Front Desk Phone' });
  await expect(renamed).toBeVisible();
  expect(dbQuery(`select name from "ShopDevice" where id='${deviceId}'`)).toBe('Front Desk Phone');

  // layout at 1440 and 390
  await expectNoOverflow(page, 'devices list 1440');
  await page.setViewportSize(VIEWPORTS.mobile);
  await expectNoOverflow(page, 'devices list 390');

  // disconnect with confirmation
  await renamed.getByRole('button', { name: /Disconnect Front Desk Phone/ }).click();
  await expect(page.getByRole('heading', { name: 'Disconnect this device?' })).toBeVisible();
  await expectNoOverflow(page, 'disconnect dialog 390');
  await page.getByRole('button', { name: 'Disconnect device' }).click();
  const revoked = page.getByTestId('device-card').filter({ hasText: 'Front Desk Phone' });
  await expect(revoked).toContainText('Revoked');
  await expect(revoked.getByRole('button', { name: /Disconnect|Rename/ })).toHaveCount(0);
  expect(dbQuery(`select status from "ShopDevice" where id='${deviceId}'`)).toBe('REVOKED');
  expect(dbQuery(`select count(*) from "AuditLog" where action='device.revoked' and "targetId"='${deviceId}'`)).toBe('1');
  await expectNoOverflow(page, 'devices revoked 390');
  await page.setViewportSize(VIEWPORTS.desktop);
  await expectNoOverflow(page, 'devices revoked 1440');

  // the revoked credential is dead immediately, on every device route
  const after = await jfetch(`${API}/api/v1/device/orders`, { headers: bearer(secret) });
  expect(after.status).toBe(401);
  expect(after.body.error.code).toBe('DEVICE_REVOKED');
  expect((await jfetch(`${API}/api/v1/device/heartbeat`, { method: 'POST', headers: bearer(secret), json: {} })).status).toBe(401);

  // a reload still lists it as Revoked (history is kept)
  await page.reload();
  await expect(page.getByTestId('device-card').filter({ hasText: 'Front Desk Phone' })).toContainText('Revoked');
});

test('Add device dialog fits a 390px phone without horizontal overflow', async ({ page }) => {
  await page.setViewportSize(VIEWPORTS.mobile);
  await uiLogin(page, 'owner@central.test');
  await page.goto('/shop/devices');
  await expect(page.getByRole('heading', { level: 1, name: 'Printing Devices' })).toBeVisible();
  await page.getByRole('button', { name: 'Add device' }).click();
  await expect(page.getByTestId('pairing-code')).toHaveText(/^PB-/);
  await expectNoOverflow(page, 'add device dialog 390');
});
