import { test, devices, type Page } from '@playwright/test';

const { defaultBrowserType: _e, ...iPhone13 } = devices['iPhone 13'];
test.use(iPhone13);

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
  await page.waitForSelector('[data-testid=priority-bar][data-state=mine]', { timeout: 90_000 });
}

test('dbg3', async ({ page }) => {
  test.setTimeout(180_000);
  await startGame(page);
  await page.evaluate(() => {
    const w = window as unknown as { __log: string[] };
    w.__log = [];
    for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'touchstart', 'touchmove'] as const) {
      window.addEventListener(t, (e) => {
        const pe = e as PointerEvent;
        if (w.__log.length < 40) w.__log.push(`${t} type=${pe.pointerType ?? '-'} x=${Math.round(pe.clientX ?? 0)} y=${Math.round(pe.clientY ?? 0)} target=${(e.target as HTMLElement)?.getAttribute?.('data-card-name') ?? (e.target as HTMLElement)?.tagName}`);
      }, true);
    }
  });
  // mirror the spec: touch-target sweep, seat sheet open/close, then the drag
  const small = await page.getByTestId('play-table').locator('button:visible').evaluateAll(els => els.filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.height < 44 || r.width < 44); }).map(e => `${e.getAttribute('aria-label') ?? e.textContent?.trim()}`));
  console.log('small', JSON.stringify(small));
  await page.getByTestId('seat-expand-1').click();
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  console.log('sheet open?', await page.getByTestId('seat-sheet').evaluate(el => (el as HTMLDialogElement).open));
  console.log('prio state', await page.getByTestId('priority-bar').getAttribute('data-state'), 'settled', await page.getByTestId('play-table').getAttribute('data-settled'));

  const card = page.getByTestId('hand').locator('[data-card-name="Mountain"]').first();
  await card.scrollIntoViewIfNeeded();
  const b = (await card.boundingBox())!;
  const bfBox = (await page.getByTestId('battlefield-me').boundingBox())!;
  const sx = b.x + b.width / 2; const sy = b.y + b.height / 2;
  const tx = bfBox.x + bfBox.width / 2; const ty = bfBox.y + bfBox.height / 2;
  console.log('card box', JSON.stringify(b), 'bf box', JSON.stringify(bfBox));
  console.log('at card centre:', await page.evaluate(([x, y]) => { const el = document.elementFromPoint(x, y) as HTMLElement; return el ? `${el.tagName}.${el.className}` : 'null'; }, [sx, sy]));
  console.log('at drop point :', await page.evaluate(([x, y]) => { let el = document.elementFromPoint(x, y) as HTMLElement | null; const chain: string[] = []; while (el && chain.length < 6) { chain.push(`${el.tagName}[dz=${el.dataset?.dropZone ?? '-'}]`); el = el.parentElement; } return chain.join(' < '); }, [tx, ty]));

  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.waitForTimeout(260);
  console.log('after down, phase ghost count =', await page.getByTestId('drag-ghost').count());
  await page.mouse.move(sx + 10, sy - 10, { steps: 3 });
  await page.waitForTimeout(60);
  console.log('after slop, ghost count =', await page.getByTestId('drag-ghost').count());
  await page.mouse.move(tx, ty, { steps: 16 });
  await page.waitForTimeout(80);
  console.log('over drop, ghost count =', await page.getByTestId('drag-ghost').count(), 'bf drop-target =', await page.getByTestId('battlefield-me').getAttribute('data-drop-target'));
  await page.mouse.up();
  await page.waitForTimeout(1200);
  console.log('lands now =', await page.getByTestId('battlefield-me').locator('[data-card-name="Mountain"]').count());
  console.log('toasts:', (await page.locator('[data-kind]').allTextContents()).join(' | '));
  console.log('EVENTS', JSON.stringify(await page.evaluate(() => (window as unknown as { __log: string[] }).__log), null, 1));
});
