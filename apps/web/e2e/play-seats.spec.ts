import { test, expect, type Page } from '@playwright/test';

// A three-player pod from the setup: the human at seat 0 and two AI seats. Three plates render (one for the viewer,
// two opponent seats in the ring), the game id encodes every deck, and the first decision arrives.

async function firstSavedOr(page: Page, selector: string, fallback: string): Promise<string> {
  const saved = await page.locator(`${selector} option[value^="s."]`).first().getAttribute('value').catch(() => null);
  return saved ?? fallback;
}

test('seats: a three-player pod deals, shows three plates and reaches the first decision', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/play');
  await page.waitForSelector('[data-testid=play-my-deck] option[value="b.mono-red-burn"]', { state: 'attached', timeout: 60_000 });
  await page.getByText('Pod · 3').click();
  await page.waitForSelector('[data-testid=play-seat-deck-2]', { state: 'attached' });
  await page.selectOption('[data-testid=play-my-deck]', 'b.mono-red-burn');
  await page.selectOption('[data-testid=play-opp-deck]', 'b.mono-green-stompy');
  await page.selectOption('[data-testid=play-seat-deck-2]', await firstSavedOr(page, '[data-testid=play-seat-deck-2]', 'b.mono-red-burn'));
  await page.getByText('Quick · 100').click();
  await page.fill('[data-testid=play-seed]', '42');
  await page.click('button[name=Deal]');
  // the game id carries every seat's deck
  await expect(page).toHaveURL(/\/play\/42~[^~]+~[^~]+~[^~]+/, { timeout: 30_000 });
  await page.waitForSelector('[data-testid=decision-sheet], [data-testid=priority-bar][data-state=mine]', { timeout: 120_000 });
  const keep = page.getByRole('button', { name: /keep/i }).first();
  if (await keep.isVisible().catch(() => false)) await keep.click();

  const table = page.getByTestId('play-table');
  await expect(table).toHaveAttribute('data-seats', '3');
  await expect(page.getByTestId('plate-me')).toHaveCount(1);
  await expect(page.getByTestId('plate-opp')).toHaveCount(2);
  await expect(page.getByTestId('seat-ring')).toHaveAttribute('data-seats', '2');
  await expect(page.getByTestId('seat')).toHaveCount(2);
  await expect(page.getByTestId('battlefield-opp')).toHaveCount(2);
  // three distinct seats carry player ids 0, 1 and 2
  const ids = await page.locator('[data-testid^="plate-"]').evaluateAll(els => els.map(e => e.getAttribute('data-player-id')).sort());
  expect(ids).toEqual(['0', '1', '2']);
  // the game runs: the priority bar reports a state and the table settles
  await expect(page.getByTestId('priority-bar')).toHaveAttribute('data-state', /mine|thinking|resolving|catching-up/);
  await expect(table).toHaveAttribute('data-settled', 'true', { timeout: 60_000 });
  expect(errors, errors.join('\n')).toEqual([]);
});
