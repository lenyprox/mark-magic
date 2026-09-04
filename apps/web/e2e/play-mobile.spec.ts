import { test, expect, devices, type Locator, type Page } from '@playwright/test';

// The phone layout of the play table (iPhone 13: 390 x 664, touch, device pixel ratio 3). A duel deals, the
// opponent seat collapses to a plate with a tap-to-expand battlefield sheet, the hand is a horizontal snap-scroll
// strip, a land drags from that strip onto the battlefield, and the right rail opens as a bottom sheet.

test.use({ ...devices['iPhone 13'] });

async function startGame(page: Page, seed = 42) {
  await page.goto('/play');
  await page.waitForSelector('[data-testid=play-my-deck] option[value="b.mono-red-burn"]', { state: 'attached', timeout: 60_000 });
  await page.selectOption('[data-testid=play-my-deck]', 'b.mono-red-burn');
  await page.selectOption('[data-testid=play-opp-deck]', 'b.mono-green-stompy');
  await page.fill('[data-testid=play-seed]', String(seed));
  await page.click('button[name=Deal]');
  await page.waitForSelector('[data-testid=decision-sheet], [data-testid=priority-bar][data-state=mine]', { timeout: 120_000 });
  const keep = page.getByRole('button', { name: /keep/i }).first();
  if (await keep.isVisible().catch(() => false)) await keep.click();
  await expect(page.getByTestId('priority-bar')).toHaveAttribute('data-state', 'mine', { timeout: 90_000 });
}

/** Press, hold past the touch long-press threshold, then travel: works for both pointer types. */
async function dragCard(page: Page, card: Locator, to: { x: number; y: number }) {
  const b = await card.boundingBox();
  if (!b) throw new Error('card has no box');
  const sx = b.x + b.width / 2; const sy = b.y + b.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.waitForTimeout(260);
  await page.mouse.move(sx + 10, sy - 10, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 16 });
  await page.waitForTimeout(80);
  await page.mouse.up();
}

async function centre(loc: Locator) {
  const b = await loc.boundingBox();
  if (!b) throw new Error('no box');
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

const handCard = (page: Page, name: string) => page.getByTestId('hand').locator(`[data-card-name="${name}"]`);
const myLands = (page: Page) => page.getByTestId('battlefield-me').locator('[data-card-name="Mountain"]');

test('mobile: the phone table collapses the seats, drags a land from the hand strip and opens the bottom sheet', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await startGame(page);

  // ---- layout: the hand is a strip, the opponent seat is a plate with an expand button, no side rails
  const hand = page.getByTestId('hand');
  await expect(hand).toHaveAttribute('data-layout', 'strip');
  await expect(page.getByTestId('seat')).toHaveAttribute('data-collapsed', '');
  await expect(page.getByTestId('right-rail')).toHaveCount(0);
  // the strip scrolls horizontally rather than overflowing the viewport
  const width = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  expect(width, 'the table must not scroll horizontally').toBe(true);
  // every tool button clears the 44 px touch target
  const small = await page.getByTestId('play-table').locator('button:visible').evaluateAll(els => els.filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 44 && !e.closest('[data-testid=phase-strip]'); }).map(e => `${e.getAttribute('aria-label') ?? e.textContent?.trim()}: ${Math.round(e.getBoundingClientRect().height)}px`));
  expect(small, small.join(' | ')).toEqual([]);

  // ---- the opponent battlefield lives in a tap-to-expand sheet
  await page.getByTestId('seat-expand-1').click();
  const seatSheet = page.getByTestId('seat-sheet');
  await expect(seatSheet).toBeVisible();
  await expect(seatSheet.getByTestId('sheet-grip')).toBeAttached();
  await page.keyboard.press('Escape');
  await expect(seatSheet).toBeHidden();

  // ---- drag a land from the strip onto the battlefield
  await expect(handCard(page, 'Mountain').first()).toBeVisible();
  const before = await myLands(page).count();
  const bf = page.getByTestId('battlefield-me');
  await expect(bf).toBeVisible();
  await dragCard(page, handCard(page, 'Mountain').last(), await centre(bf));
  await expect(myLands(page)).toHaveCount(before + 1, { timeout: 30_000 });

  // ---- the right rail is a bottom sheet with a grab handle
  await page.getByTestId('mobile-rail').click();
  const rail = page.getByTestId('rail-sheet');
  await expect(rail).toBeVisible();
  await expect(rail.getByTestId('sheet-grip')).toBeAttached();
  await expect(rail.getByRole('tab', { name: 'Timeline' })).toBeVisible();
  await rail.getByRole('tab', { name: 'Timeline' }).click();
  await expect(rail.getByTestId('timeline')).toBeVisible();
  // the sheet fits the viewport
  const fits = await rail.evaluate(el => el.getBoundingClientRect().height <= window.innerHeight + 1);
  expect(fits, 'the bottom sheet must fit the viewport').toBe(true);
  await page.keyboard.press('Escape');
  await expect(rail).toBeHidden();

  expect(errors, errors.join('\n')).toEqual([]);
});
