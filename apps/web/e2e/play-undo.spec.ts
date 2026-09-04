import { test, expect, type Locator, type Page } from '@playwright/test';

// Undo and manual mana: playing a land then pressing Ctrl+Z puts the land back in hand and re-asks the priority
// decision; with "ask to pay: always" a cast parks in the pay tray whose confirm sends the chosen sources.

async function startGame(page: Page, seed = 42, before?: () => Promise<void>) {
  await page.goto('/play');
  if (before) await before();
  await page.waitForSelector('[data-testid=play-my-deck] option[value="b.mono-red-burn"]', { state: 'attached', timeout: 60_000 });
  await page.selectOption('[data-testid=play-my-deck]', 'b.mono-red-burn');
  await page.selectOption('[data-testid=play-opp-deck]', 'b.mono-green-stompy');
  await page.fill('[data-testid=play-seed]', String(seed));
  await page.click('button[name=Deal]');
  await page.waitForSelector('[data-testid=decision-sheet], [data-testid=priority-bar][data-state=mine]', { timeout: 120_000 });
  const keep = page.getByRole('button', { name: /keep/i }).first();
  if (await keep.isVisible().catch(() => false)) await keep.click();
  await waitForPriority(page);
}

async function waitForPriority(page: Page) {
  await expect(page.getByTestId('priority-bar')).toHaveAttribute('data-state', 'mine', { timeout: 90_000 });
}

async function dragCard(page: Page, card: Locator, to: { x: number; y: number }) {
  const a = await card.boundingBox();
  if (!a) throw new Error('card has no box');
  const sx = a.x + a.width * 0.3; const sy = a.y + a.height * 0.5;
  await page.mouse.move(sx, sy);
  await page.waitForTimeout(350);
  const b = await card.boundingBox();
  const px = b ? b.x + b.width * 0.3 : sx; const py = b ? b.y + b.height * 0.5 : sy;
  await page.mouse.move(px, py);
  await page.mouse.down();
  await page.mouse.move(px + 12, py - 12, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 16 });
  await page.waitForTimeout(60);
  await page.mouse.up();
}

async function centre(loc: Locator) {
  const b = await loc.boundingBox();
  if (!b) throw new Error('no box');
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

const handCard = (page: Page, name: string) => page.getByTestId('hand').locator(`[data-card-name="${name}"]`);
const myLands = (page: Page) => page.getByTestId('battlefield-me').locator('[data-card-name="Mountain"]');

test('undo: Ctrl+Z after playing a land returns it to hand and re-asks the decision', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await startGame(page);
  await expect(handCard(page, 'Mountain').first()).toBeVisible();
  const landsBefore = await myLands(page).count();
  const handBefore = await handCard(page, 'Mountain').count();
  // before any action there is nothing to take back
  await expect(page.getByTestId('undo-wrap')).toHaveAttribute('data-undo', 'blocked');

  const bf = page.getByTestId('battlefield-me');
  await dragCard(page, handCard(page, 'Mountain').last(), await centre(bf));
  await expect(myLands(page)).toHaveCount(landsBefore + 1, { timeout: 30_000 });
  await waitForPriority(page);
  await expect(page.getByTestId('play-table')).toHaveAttribute('data-settled', 'true', { timeout: 30_000 });
  await expect(page.getByTestId('undo-wrap')).toHaveAttribute('data-undo', 'ready', { timeout: 15_000 });

  await page.keyboard.press('Control+z');
  await expect(myLands(page)).toHaveCount(landsBefore, { timeout: 30_000 });
  await expect(handCard(page, 'Mountain')).toHaveCount(handBefore);
  await waitForPriority(page);
  await expect(page.getByTestId('play-table')).toHaveAttribute('data-settled', 'true', { timeout: 30_000 });
  // the land drop is available again after the undo
  await dragCard(page, handCard(page, 'Mountain').last(), await centre(bf));
  await expect(myLands(page)).toHaveCount(landsBefore + 1, { timeout: 30_000 });
  await waitForPriority(page);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('pay tray: with "ask to pay: always" a Lightning Bolt parks in the tray; confirm sends the chosen source', async ({ page }) => {
  test.setTimeout(300_000);
  const settings = () => page.evaluate(() => { localStorage.setItem('vault.play.settings', JSON.stringify({ askToPay: 'always' })); });
  const castableBolt = () => handCard(page, 'Lightning Bolt').and(page.locator('[data-castable]'));
  let found = false;
  for (const seed of [17, 5, 20]) {
    await startGame(page, seed, settings);
    const bf = page.getByTestId('battlefield-me');
    if (await handCard(page, 'Mountain').count()) {
      const before = await myLands(page).count();
      await dragCard(page, handCard(page, 'Mountain').last(), await centre(bf));
      await expect(myLands(page)).toHaveCount(before + 1, { timeout: 30_000 });
      await waitForPriority(page);
    }
    found = (await castableBolt().count()) > 0;
    if (found) break;
  }
  test.skip(!found, 'No seed produced a castable Lightning Bolt on turn 1');

  const bf = page.getByTestId('battlefield-me');
  // while the spell is dragged, the land the engine would tap wears a dashed rim
  const bolt = castableBolt().first();
  const a = await bolt.boundingBox(); if (!a) throw new Error('no bolt box');
  await page.mouse.move(a.x + a.width * 0.3, a.y + a.height * 0.5);
  await page.waitForTimeout(350);
  const b = (await bolt.boundingBox()) ?? a;
  await page.mouse.move(b.x + b.width * 0.3, b.y + b.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(b.x + 20, b.y - 20, { steps: 4 });
  const to = await centre(bf);
  await page.mouse.move(to.x, to.y, { steps: 16 });
  await expect(page.getByTestId('battlefield-me').locator('[data-will-tap]')).toHaveCount(1);
  await page.mouse.up();

  const slot = page.getByTestId('casting-slot');
  await expect(slot).toBeVisible();
  const plate = page.getByTestId('plate-opp');
  await dragCard(page, slot.locator('[data-cast-slot]'), await centre(plate));
  const tray = page.getByTestId('pay-tray');
  await expect(tray).toBeVisible({ timeout: 15_000 });
  const sources = (await tray.getAttribute('data-sources')) ?? '';
  expect(sources.split(',').filter(Boolean).length).toBe(1);
  await expect(page.getByTestId('battlefield-me').locator('[data-pay-source]')).toHaveCount(1);
  await page.getByTestId('pay-confirm').click();
  await expect(page.getByTestId('stack').locator('[data-card-name="Lightning Bolt"]')).toBeVisible({ timeout: 30_000 });
  await expect(tray).toHaveCount(0);
});
