import { chromium } from '@playwright/test';
const out = process.argv[2];
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
page.on('pageerror', e => console.log('PAGEERROR', e.message));
await page.goto('http://localhost:3123/play', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForSelector('[data-testid=play-my-deck] option[value="b.mono-red-burn"]', { state: 'attached', timeout: 60000 });
await page.selectOption('[data-testid=play-my-deck]', 'b.mono-red-burn');
await page.selectOption('[data-testid=play-opp-deck]', 'b.mono-green-stompy');
await page.fill('[data-testid=play-seed]', '7');
await page.screenshot({ path: out.replace('.png', '-setup.png') });
await page.click('button[name=Deal]');
await page.waitForSelector('[data-testid=decision-sheet], [data-testid=priority-bar][data-state=mine]', { timeout: 120000 });
const keep = page.getByRole('button', { name: /keep/i }).first();
if (await keep.isVisible().catch(() => false)) await keep.click();
await page.waitForSelector('[data-testid=priority-bar]', { timeout: 60000 });
// advance until a priority decision with a populated analysis
for (let i = 0; i < 24; i++) {
  await page.waitForSelector('[data-testid=priority-bar][data-state=mine], [data-testid=decision-sheet]', { timeout: 15000 }).catch(() => {});
  const sheet = await page.$('[data-testid=decision-sheet]');
  if (sheet) {
    const first = await sheet.$('[role=option], [data-card], button[data-id], li button, .card');
    if (first) await first.click().catch(() => {});
    const confirm = page.getByRole('button', { name: /confirm|keep|yes|ok/i }).first();
    if (await confirm.isVisible().catch(() => false)) await confirm.click().catch(() => {});
    await page.waitForTimeout(800); continue;
  }
  await page.waitForTimeout(1200);
  const phase = await page.$eval('[data-testid=analysis-panel]', e => e.dataset.phase).catch(() => null);
  const cands = await page.$eval('[data-testid=analysis-panel] [data-testid=candidate-play]', els => els.length).catch(() => 0);
  const legal = await page.$eval('[data-castable], [data-playable="true"]', els => els.length).catch(() => 0);
  console.log('step', i, 'phase', phase, 'cands', cands, 'legal', legal);
  if (phase === 'done' && cands > 1) break;
  await page.keyboard.press('Space');
}
await page.waitForTimeout(800);
await page.screenshot({ path: out });
const why = page.getByRole('button', { name: /why/i }).first();
if (await why.isVisible().catch(() => false)) { await why.click(); await page.waitForTimeout(600); await page.screenshot({ path: out.replace('.png', '-why.png') }); }
console.log('saved');
await browser.close();
