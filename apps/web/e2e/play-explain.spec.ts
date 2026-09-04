import { test, expect, type Page } from '@playwright/test';

// The explain layer and the animation queue: the table settles (shownView === liveView) at the first decision, the
// Explain tab lists event cards with rule chips whose popover shows the Comprehensive Rules text, and the Timeline
// can scrub back one event once playback is paused.

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

test('explain: the table settles, event cards carry rule chips with CR text, and the timeline scrubs back', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await startGame(page);

  // the animation queue has caught up with the decision's view
  const table = page.getByTestId('play-table');
  await expect(table).toHaveAttribute('data-settled', 'true', { timeout: 30_000 });

  // Explain tab: at least one event card with a rule chip; the chip opens the rule text from the bundled excerpt
  await page.getByRole('tab', { name: 'Explain' }).click();
  const panel = page.getByTestId('explain-panel');
  await expect(panel).toBeVisible();
  const cards = panel.getByTestId('explain-event');
  await expect(cards.first()).toBeVisible();
  expect(await cards.count()).toBeGreaterThan(0);
  const chip = panel.getByTestId('rule-chip').last();
  await expect(chip).toBeVisible();
  const cr = await chip.getAttribute('data-cr');
  expect(cr).toMatch(/^\d{3}\.\d+[a-z]?$/);
  await chip.click();
  const popover = page.getByTestId('rule-popover');
  await expect(popover).toBeVisible();
  await expect(popover).toContainText(`CR ${cr}`);
  const text = (await popover.locator('p').first().textContent()) ?? '';
  expect(text.length).toBeGreaterThan(30);
  await expect(popover).toContainText(/Wizards of the Coast/);
  await page.keyboard.press('Escape');

  // "Show me" pulses something on the table without errors
  const showMe = panel.getByTestId('show-me').last();
  if (await showMe.isVisible().catch(() => false)) await showMe.click();

  // Timeline: locked while a decision is pending; pause, then scrub back one event
  await page.getByRole('tab', { name: 'Timeline' }).click();
  const timeline = page.getByTestId('timeline');
  await expect(timeline).toBeVisible();
  await expect(timeline).toHaveAttribute('data-locked', 'true');
  await page.getByTestId('timeline-pause').click();
  await expect(timeline).toHaveAttribute('data-locked', 'false');
  const before = Number(await page.getByTestId('timeline-cursor').textContent());
  expect(before).toBeGreaterThan(0);
  await page.getByTestId('timeline-back').click();
  await expect(page.getByTestId('timeline-cursor')).toHaveText(String(before - 1));
  await expect(table).toHaveAttribute('data-settled', 'false');
  // back to live restores interaction
  await page.getByTestId('timeline-live').click();
  await expect(table).toHaveAttribute('data-settled', 'true', { timeout: 15_000 });
  await expect(page.getByTestId('priority-bar')).toHaveAttribute('data-state', 'mine');

  // the explain toggle (key E) halves speed and shows inline chips; the rules API serves the same text
  await page.keyboard.press('e');
  await expect(page.getByTestId('explain-key')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('e');
  await expect(page.getByTestId('explain-key')).toHaveAttribute('aria-pressed', 'false');
  const res = await page.request.get(`/api/rules/${cr}`);
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.num).toBe(cr);
  expect(String(body.text).length).toBeGreaterThan(30);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('hover inspector: resting on a hand card opens it with the Why? tab', async ({ page }) => {
  await startGame(page);
  const card = page.getByTestId('hand').locator('[data-obj-id]').first();
  await expect(card).toBeVisible();
  const box = await card.boundingBox();
  if (!box) throw new Error('no card box');
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  const inspector = page.getByTestId('hover-inspector');
  await expect(inspector).toBeVisible({ timeout: 5_000 });
  await inspector.getByRole('tab', { name: 'Why?' }).click();
  await expect(inspector.getByTestId('why-tab')).toBeVisible();
  // pressing the pointer on the table closes it so drags never start under the panel
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.up();
  await expect(inspector).toHaveCount(0);
});
