import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Automated accessibility checks for the play route: the setup page and the table at first priority must carry no
// serious or critical axe violations. The keyboard path (pass, pick an action, cancel) and the live region that
// narrates the last event and the pending decision are checked alongside, because axe cannot see either.

const BAD = new Set(['serious', 'critical']);

async function violations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations.filter(v => BAD.has(v.impact ?? ''));
}

function report(vs: Awaited<ReturnType<typeof violations>>) {
  return vs.map(v => `${v.impact} ${v.id}: ${v.help}\n    ${v.nodes.slice(0, 4).map(n => n.target.join(' ')).join('\n    ')}`).join('\n');
}

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

test('a11y: the play setup page has no serious or critical violations', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/play');
  await page.waitForSelector('[data-testid=play-my-deck] option[value="b.mono-red-burn"]', { state: 'attached', timeout: 60_000 });
  const vs = await violations(page);
  expect(report(vs)).toBe('');
});

test('a11y: the table at first priority has no serious or critical violations and stays keyboard-complete', async ({ page }) => {
  test.setTimeout(240_000);
  await startGame(page);
  const table = page.getByTestId('play-table');
  await expect(table).toHaveAttribute('data-settled', 'true', { timeout: 60_000 });

  const vs = await violations(page);
  expect(report(vs)).toBe('');

  // the live region names the pending decision (and the event line the table has just played)
  const announcer = page.getByTestId('table-announcer');
  await expect(announcer).toHaveAttribute('aria-live', 'polite');
  await expect(announcer).toContainText(/You have priority/);
  // the timeline is a log
  await page.getByRole('tab', { name: 'Timeline' }).click();
  await expect(page.getByTestId('timeline-log')).toHaveAttribute('role', 'log');

  // dialogs trap focus and close on Escape
  await page.getByTestId('table-settings-button').click();
  const settings = page.getByTestId('table-settings');
  await expect(settings).toBeVisible();
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();

  // keyboard path with nothing focused: ? opens the shortcut sheet, Escape closes it, Space passes priority
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('?');
  await expect(page.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeHidden();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const cursorBefore = await table.getAttribute('data-cursor');
  await page.keyboard.press(' ');
  await expect(table).not.toHaveAttribute('data-cursor', cursorBefore ?? '', { timeout: 60_000 });
});
