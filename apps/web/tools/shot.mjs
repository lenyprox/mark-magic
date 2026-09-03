import { chromium } from '@playwright/test';
const [url, out, w = '1400', h = '900', hoverX, hoverY] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
page.on('pageerror', e => console.log('PAGEERROR', e.message));
page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 300)); });
await page.goto(url, { waitUntil: 'networkidle', timeout: 120000 }).catch(e => console.log('goto', e.message));
await page.waitForTimeout(2500);
if (hoverX) { await page.mouse.move(Number(hoverX), Number(hoverY)); await page.waitForTimeout(900); }
await page.screenshot({ path: out, fullPage: false });
console.log('saved', out);
await browser.close();
