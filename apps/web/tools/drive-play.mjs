// Throwaway driver: deals mono-red-burn vs mono-green-stompy (seed 42), keeps the hand, casts Lightning Bolt at
// the opponent through targeting mode, passes to combat, declares an attack, and checks the analysis panel.
// Usage: node tools/drive-play.mjs [baseUrl] [outDir]
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:3123';
const out = process.argv[3] ?? '../../tmp';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
const errors = [];
page.on('pageerror', e => { errors.push(e.message); console.log('PAGEERROR', e.message); });
page.on('console', m => { if (m.type() === 'error') { errors.push(m.text()); console.log('CONSOLE', m.text().slice(0, 300)); } });
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const shot = (name) => page.screenshot({ path: `${out}/${name}.png` });
const tryClick = async (sel, opts) => { try { await page.locator(sel).first().click({ timeout: 4000, ...opts }); return true; } catch (e) { log('click failed', sel, e.message.split(String.fromCharCode(10))[0]); return false; } };

await page.goto(`${base}/play`, { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForSelector('[data-testid=play-my-deck] option[value="b.mono-red-burn"]', { timeout: 60000, state: 'attached' });
await page.selectOption('[data-testid=play-my-deck]', 'b.mono-red-burn');
await page.selectOption('[data-testid=play-opp-deck]', 'b.mono-green-stompy');
await page.fill('[data-testid=play-seed]', '42');
await page.click('[role=radio]:has-text("Quick")');
await shot('01-setup');
await page.click('button[name=Deal]');
log('dealt');
await page.waitForURL(/\/play\/.+/, { timeout: 60000 });
// Page-side timing: when priority becomes mine and when the analysis phases change.
await page.evaluate(() => {
  window.__timing = [];
  const mo = new MutationObserver(muts => { for (const m of muts) { const el = m.target; if (el.dataset?.testid === 'priority-bar' && m.attributeName === 'data-state') window.__timing.push({ t: performance.now(), what: 'priority', v: el.dataset.state }); if (el.dataset?.testid === 'analysis-panel' && m.attributeName === 'data-phase') window.__timing.push({ t: performance.now(), what: 'analysis', v: el.dataset.phase }); } });
  mo.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['data-state', 'data-phase'] });
});

const state = async () => ({
  sheet: await page.$('[data-testid=decision-sheet]'),
  sheetKind: await page.$eval('[data-testid=decision-sheet]', e => e.dataset.kind).catch(() => null),
  prio: await page.$eval('[data-testid=priority-bar]', e => e.dataset.state).catch(() => null),
  attack: await page.$('[data-testid=attack-bar]'),
  block: await page.$('[data-testid=block-bar]'),
  targeting: await page.$('[data-testid=targeting-bar]'),
  over: await page.$('[data-testid=game-over]'),
});

// Mulligan prompt first (yes-no), then priority.
await page.waitForSelector('[data-testid=decision-sheet], [data-testid=priority-bar][data-state=mine]', { timeout: 120000 });
log('first decision visible');
if (await page.$('[data-testid=decision-sheet][data-kind=yes-no]')) { await shot('02-mulligan'); await page.click('[data-testid=keep-hand]'); log('kept hand'); }
await page.waitForSelector('[data-testid=priority-bar]', { timeout: 60000 });
log('priority bar present');

let bolted = false, attacked = false, analysisChecked = false, firstAnalysis = null, landsPlayed = 0;
let firstDecisionAt = null;
for (let i = 0; i < 160 && !(bolted && attacked && analysisChecked); i++) {
  const s = await state();
  if (s.over) { log('game over'); break; }
  if (s.sheet) {
    if (s.sheetKind === 'yes-no') { await page.click('[data-testid=keep-hand], [data-testid=yes]'); }
    else { const b = await page.$('[data-testid=decision-sheet] button:has-text("Confirm")'); if (b) await b.click(); }
    await page.waitForTimeout(300); continue;
  }
  if (s.attack) {
    const cands = await page.$$('[data-testid=attack-bar] [aria-pressed]');
    const wasCastable = await page.$$('[data-testid=attack-bar] [aria-pressed]:not([disabled])');
    log(`attack decision: ${cands.length} candidates`);
    if (wasCastable.length) {
      // click the creature on the table to toggle it
      await wasCastable[0].click(); await page.waitForTimeout(200);
    }
    await shot('06-attack');
    await page.click('[data-testid=attack-confirm]');
    attacked = attacked || cands.length > 0;
    log('attack confirmed');
    await page.waitForTimeout(400); continue;
  }
  if (s.block) { await page.click('[data-testid=block-confirm]'); log('no blocks'); await page.waitForTimeout(300); continue; }
  if (s.targeting) {
    await shot('04-targeting');
    const opp = await page.$('[data-player-id="1"][data-legal-target]');
    if (opp) { await opp.click(); log('targeted opponent'); } else { await page.keyboard.press('Escape'); }
    await page.waitForTimeout(400); continue;
  }
  if (s.prio === 'mine') {
    if (!firstDecisionAt) { firstDecisionAt = Date.now(); log('first priority'); await shot('03-table'); log('hand:', await page.$$eval('[aria-label^="Your hand"] [data-card-name]', els => els.map(e => e.dataset.cardName))); }
    // analysis timing / verification once
    if (!analysisChecked) {
      const phase = await page.$eval('[data-testid=analysis-panel]', e => e.dataset.phase).catch(() => null);
      const plays = await page.$$('[data-testid=candidate-play]');
      if (plays.length && !firstAnalysis) { firstAnalysis = { quickAt: Date.now(), phase }; log('first analysis report, phase', phase); }
      if (plays.length && (phase === 'done' || phase === 'update')) {
        if (phase === 'done') {
          firstAnalysis.doneAt = Date.now();
          const labels = await page.$$eval('[data-testid=candidate-play]', els => els.map(e => e.innerText.split('\n').slice(0, 3).join(' | ')));
          log('candidate plays:', labels);
          // open Why on the first play, expect derivations and try a re-run
          await plays[0].$('button[aria-expanded]').then(b => b.click());
          await page.waitForSelector('[data-testid=derivation]', { timeout: 10000 });
          const nDer = (await page.$$('[data-testid=derivation]')).length;
          const methods = await page.$$eval('[data-testid=derivation]', els => els.map(e => e.dataset.method));
          log(`derivations on top play: ${nDer}`, methods);
          const rerun = await page.$('[data-testid=rerun-seed]');
          if (rerun) {
            await rerun.click();
            await page.waitForSelector('[data-testid=rerun-result]', { timeout: 60000 });
            log('rerun result:', await page.textContent('[data-testid=rerun-result]'));
          } else {
            // open the montecarlo derivation explicitly
            const mcHead = await page.$('[data-testid=derivation][data-method=montecarlo] button');
            if (mcHead) { await mcHead.click(); const r2 = await page.$('[data-testid=rerun-seed]'); if (r2) { await r2.click(); await page.waitForSelector('[data-testid=rerun-result]', { timeout: 60000 }); log('rerun result:', await page.textContent('[data-testid=rerun-result]')); } }
            else log('no montecarlo derivation on the top play');
          }
          log('opponent model:', (await page.textContent('[data-testid=opponent-model]')).replace(/\s+/g, ' ').slice(0, 300));
          log('draw odds:', (await page.textContent('[data-testid=draw-odds]')).replace(/\s+/g, ' ').slice(0, 200));
          await shot('05-analysis');
          analysisChecked = true;
        }
      }
      if (!analysisChecked) { await page.waitForTimeout(500); continue; }
    }
    const land = await page.$('[data-castable][data-card-name="Mountain"]');
    if (land && landsPlayed < 6) { await land.hover().catch(() => {}); if (!(await tryClick('[data-castable][data-card-name="Mountain"]'))) { await page.waitForTimeout(300); continue; } landsPlayed++; log('played a land'); await page.waitForTimeout(500); continue; }
    const BURN = '[data-castable][data-card-name="Lightning Bolt"], [data-castable][data-card-name="Lightning Strike"], [data-castable][data-card-name="Shock"], [data-castable][data-card-name="Lava Spike"], [data-castable][data-card-name="Searing Spear"]';
    const bolt = await page.$(BURN);
    if (bolt && !bolted) { const nm = await bolt.getAttribute('data-card-name'); await bolt.hover().catch(() => {}); if (!(await tryClick(BURN))) { await page.waitForTimeout(300); continue; } log('clicked', nm); await page.waitForSelector('[data-testid=targeting-bar]', { timeout: 5000 }).catch(() => log('no targeting bar!')); bolted = true; await page.waitForTimeout(200); continue; }
    const creature = await page.$('[data-castable][data-card-name="Monastery Swiftspear"], [data-castable][data-card-name="Raging Goblin"], [data-castable][data-card-name="Goblin Piker"], [data-castable][data-card-name="Viashino Pyromancer"], [data-castable][data-card-name="Firebrand Archer"]');
    if (creature && !attacked) { await creature.hover().catch(() => {}); const nm = await creature.getAttribute('data-card-name'); if (!(await tryClick(`[data-castable][data-card-name="${nm}"]`))) { await page.waitForTimeout(300); continue; } log('cast', nm); await page.waitForTimeout(600); continue; }
    await page.keyboard.press('Space');
    await page.waitForTimeout(250);
    continue;
  }
  await page.waitForTimeout(400);
}
log({ bolted, attacked, analysisChecked, firstAnalysisQuickMs: firstAnalysis?.quickAt && firstDecisionAt ? firstAnalysis.quickAt - firstDecisionAt : null, firstPhase: firstAnalysis?.phase, firstAnalysisDoneMs: firstAnalysis?.doneAt && firstDecisionAt ? firstAnalysis.doneAt - firstDecisionAt : null });
const timing = await page.evaluate(() => window.__timing);
const firstMine = timing.find(t => t.what === 'priority' && t.v === 'mine');
if (firstMine) { const after = timing.filter(t => t.t >= firstMine.t && t.what === 'analysis'); log('first decision → analysis phases (ms):', after.slice(0, 4).map(a => `${a.v}@${Math.round(a.t - firstMine.t)}`)); }
log('life:', await page.$$eval('[data-player-id]', els => els.map(e => e.getAttribute('aria-label') ?? e.innerText.split('\n').slice(0, 3).join(' '))));
await shot('07-final');
await page.keyboard.press('l'); await page.waitForTimeout(500); await shot('07b-log'); await page.keyboard.press('l');
// mobile: bottom sheets
await page.setViewportSize({ width: 420, height: 860 });
await page.waitForTimeout(800);
await shot('09-mobile');
await page.click('button[aria-label="Analysis"]');
await page.waitForTimeout(600);
await shot('10-mobile-analysis');
await page.keyboard.press('Escape');
await page.setViewportSize({ width: 1500, height: 940 });
await page.waitForTimeout(500);
// concede → game over → save
await page.click('button:has-text("Concede")');
await page.waitForSelector('[data-testid=game-over]', { timeout: 30000 });
log('game over:', (await page.textContent('[data-testid=game-over] h2')));
await page.click('[data-testid=game-over] button:has-text("Save game")');
await page.waitForSelector('[data-testid=game-over] button:has-text("Saved")', { timeout: 30000 });
log('saved game');
await shot('08-gameover');
console.log('ERRORS', errors.length, errors.slice(0, 5));
await browser.close();
