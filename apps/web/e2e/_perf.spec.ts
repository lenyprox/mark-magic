import { test, expect, type Page } from '@playwright/test';

// Temporary measurement harness (not part of the suite): 10 s of a four-player AI-vs-AI spectate at 4x, counting
// main-thread long tasks through a PerformanceObserver. Run before and after the D6 performance work.

interface LongTaskStats { count: number; total: number; max: number; blocking: number; frames: number }

async function startPod(page: Page) {
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
  await page.getByRole('radio', { name: '40', exact: true }).click();
  await page.fill('[data-testid=play-seed]', '42');
  await page.click('button[name=Deal]');
  await expect(page.getByTestId('play-table')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('play-table')).toHaveAttribute('data-seats', '4', { timeout: 120_000 });
}

test('perf: 4-seat spectate long tasks over 10 s at 4x', async ({ page }) => {
  test.setTimeout(300_000);
  await startPod(page);
  // 4x playback
  await page.getByTestId('playback').getByRole('radio', { name: '4×' }).click();
  await page.waitForTimeout(2500); // let the first turns settle before sampling

  await page.evaluate(() => {
    const w = window as unknown as { __lt: LongTaskStats; __ltObs?: PerformanceObserver };
    w.__lt = { count: 0, total: 0, max: 0, blocking: 0, frames: 0 };
    const po = new PerformanceObserver(list => {
      for (const e of list.getEntries()) {
        w.__lt.count++;
        w.__lt.total += e.duration;
        w.__lt.blocking += Math.max(0, e.duration - 50);
        if (e.duration > w.__lt.max) w.__lt.max = e.duration;
      }
    });
    po.observe({ entryTypes: ['longtask'] });
    w.__ltObs = po;
    const tick = () => { w.__lt.frames++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });

  await page.waitForTimeout(10_000);
  const stats = await page.evaluate(() => {
    const w = window as unknown as { __lt: LongTaskStats; __ltObs?: PerformanceObserver };
    w.__ltObs?.disconnect();
    return w.__lt;
  });
  const finished = await page.getByTestId('game-over').count();
  const cursor = await page.getByTestId('play-table').getAttribute('data-cursor');
  // eslint-disable-next-line no-console
  console.log(`LONGTASKS ${JSON.stringify({ ...stats, fps: (stats.frames / 10).toFixed(1), finishedDuringSample: finished > 0, cursor })}`);
  expect(stats.count).toBeGreaterThanOrEqual(0);
});
