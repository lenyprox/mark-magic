import { test, expect } from '@playwright/test';

test('health reports the data pipeline is ready', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.master).toBe(true);
  expect(body.index).toBe(true);
});

test('browse: grid renders and search narrows it', async ({ page }) => {
  await page.goto('/cards');
  const grid = page.locator('[role="grid"]');
  await expect(grid).toBeVisible();
  await expect(page.locator('[role="gridcell"]').first()).toBeVisible();
  await page.goto('/cards?q=lightning+bolt');
  await expect(page.locator('[role="gridcell"]').first()).toContainText(/Lightning Bolt/i);
});

test('card detail shows printings and legalities', async ({ page, request }) => {
  const ac = await (await request.get('/api/autocomplete?q=lightning+bo')).json();
  await page.goto(`/cards/${ac[0].oracleId}`);
  await expect(page.getByRole('heading', { name: /Lightning Bolt/ }).first()).toBeVisible();
  await expect(page.getByText(/modern/i).first()).toBeVisible();
});

test('decks: import a list and see it saved', async ({ page, request }) => {
  const res = await request.post('/api/decks/import', { data: { text: '// E2E deck\n4 Lightning Bolt\n20 Mountain', save: true, format: 'modern' } });
  expect(res.status()).toBe(201);
  const { deck } = await res.json();
  await page.goto('/decks');
  await expect(page.getByText('E2E deck').first()).toBeVisible();
  await page.goto(`/decks/${deck.id}`);
  await expect(page.getByText(/Lightning Bolt/).first()).toBeVisible();
  await request.delete(`/api/decks/${deck.id}`);
});

test('play: start a game with bundled decks and reach the first decision', async ({ page }) => {
  await page.goto('/play');
  await page.waitForSelector('[data-testid=play-my-deck] option[value="b.mono-red-burn"]', { state: 'attached', timeout: 60_000 });
  await page.selectOption('[data-testid=play-my-deck]', 'b.mono-red-burn');
  await page.selectOption('[data-testid=play-opp-deck]', 'b.mono-green-stompy');
  await page.fill('[data-testid=play-seed]', '42');
  await page.click('button[name=Deal]');
  // the mulligan sheet comes first; keep the hand
  await page.waitForSelector('[data-testid=decision-sheet], [data-testid=priority-bar][data-state=mine]', { timeout: 120_000 });
  const keep = page.getByRole('button', { name: /keep/i }).first();
  if (await keep.isVisible().catch(() => false)) await keep.click();
  await expect(page.getByTestId('priority-bar')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('analysis-panel')).toBeVisible();
  await expect(page.getByTestId('analysis-panel')).toHaveAttribute('data-phase', /quick|update|done/, { timeout: 60_000 });
});
