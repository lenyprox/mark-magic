// Long-task measurement for the 4-seat table: deals a four-player AI-vs-AI pod (bundled decks, Quick AI) at 4×
// playback, spectates for a window and reports the main-thread long tasks (PerformanceObserver 'longtask') seen
// meanwhile, plus frame timing. Usage: node tools/longtasks.mjs [baseUrl] [seconds] [label]
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'http://localhost:3792';
const seconds = Number(process.argv[3] ?? 10);
const label = process.argv[4] ?? 'run';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.addInitScript(() => { try { localStorage.setItem('vault.play.speed', '4'); localStorage.removeItem('vault.play.lastSetup'); } catch { /* ignore */ } });

await page.goto(`${base}/play`, { waitUntil: 'networkidle', timeout: 120_000 });
await page.waitForSelector('[data-testid=play-my-deck] option[value="b.mono-red-burn"]', { timeout: 60_000, state: 'attached' });
await page.getByText('Pod · 4').click();
await page.waitForSelector('[data-testid=play-seat-deck-3]', { state: 'attached' });
const bundled = await page.$$eval('[data-testid=play-opp-deck] option[value^="b."]', els => els.map(e => e.value));
await page.selectOption('[data-testid=play-my-deck]', 'b.mono-red-burn');
await page.selectOption('[data-testid=play-opp-deck]', 'b.mono-green-stompy');
await page.selectOption('[data-testid=play-seat-deck-2]', bundled[2 % bundled.length] ?? 'b.mono-red-burn');
await page.selectOption('[data-testid=play-seat-deck-3]', bundled[3 % bundled.length] ?? 'b.mono-green-stompy');
await page.getByText('Quick · 100').click();
await page.check('[data-testid=play-spectate]');
await page.fill('[data-testid=play-seed]', '7');
await page.click('button[name=Deal]');
await page.waitForSelector('[data-testid=play-table][data-status=running]', { timeout: 120_000 });
// let the opening (mulligans, first draws) pass so the window measures steady-state play
await page.waitForTimeout(3000);

const result = await page.evaluate(async (ms) => {
  const tasks = [];
  const po = new PerformanceObserver(list => { for (const e of list.getEntries()) tasks.push(e.duration); });
  po.observe({ type: 'longtask', buffered: false });
  let frames = 0; let worst = 0; let last = performance.now();
  const t0 = performance.now();
  await new Promise(resolve => {
    const tick = () => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; frames++; if (now - t0 < ms) requestAnimationFrame(tick); else resolve(); };
    requestAnimationFrame(tick);
  });
  po.disconnect();
  const total = tasks.reduce((a, b) => a + b, 0);
  const cursor = Number(document.querySelector('[data-testid=play-table]')?.getAttribute('data-cursor') ?? 0);
  return { longTasks: tasks.length, longTaskMs: Math.round(total), worstTaskMs: Math.round(Math.max(0, ...tasks)), frames, fps: Math.round(frames / (ms / 1000)), worstFrameGapMs: Math.round(worst), eventsShown: cursor, seats: document.querySelector('[data-testid=play-table]')?.getAttribute('data-seats') };
}, seconds * 1000);
console.log(JSON.stringify({ label, seconds, ...result, pageErrors: errors.length }));
await browser.close();
