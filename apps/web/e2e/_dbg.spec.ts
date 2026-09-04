import { test, expect, type Page } from '@playwright/test';

test('dbg', async ({ page }) => {
  test.setTimeout(180_000);
  const errs: string[] = [];
  page.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await page.goto('/play');
  await page.waitForSelector('[data-testid=play-my-deck] option[value="b.mono-red-burn"]', { state: 'attached', timeout: 60_000 });
  await page.getByText('Pod · 4').click();
  await page.waitForSelector('[data-testid=play-seat-deck-3]', { state: 'attached' });
  await page.selectOption('[data-testid=play-my-deck]', 'b.mono-red-burn');
  await page.selectOption('[data-testid=play-opp-deck]', 'b.mono-green-stompy');
  await page.selectOption('[data-testid=play-seat-deck-2]', 'b.mono-red-burn');
  await page.selectOption('[data-testid=play-seat-deck-3]', 'b.mono-green-stompy');
  await page.getByTestId('play-spectate').check();
  await page.getByText('Quick · 100').click();
  await page.fill('[data-testid=play-seed]', '42');
  await page.click('button[name=Deal]');
  await expect(page.getByTestId('play-table')).toBeVisible({ timeout: 120_000 });
  for (const t of [3000, 6000, 12000]) {
    await page.waitForTimeout(t === 3000 ? 3000 : 3000);
    const table = page.getByTestId('play-table');
    console.log('t=', t, 'status=', await table.getAttribute('data-status'), 'cursor=', await table.getAttribute('data-cursor'), 'settled=', await table.getAttribute('data-settled'), 'prio=', await page.getByTestId('priority-bar').getAttribute('data-state'), 'stack=', await page.getByTestId('stack-column').getAttribute('data-count'));
  }
  console.log('ERRORS', errs.slice(0, 10).join(' | '));
});
