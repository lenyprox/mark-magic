// Download the Magic Comprehensive Rules text, parse it into { number: text } and write:
//   data/rules/cr.json                    every rule paragraph (gitignored data)
//   apps/web/lib/rules/cr-excerpts.json   the numbers listed in src/rules/cited.ts (checked in, bundled in the app)
// Usage: node scripts/build-cr.mjs [--from path/to/MagicCompRules.txt]
// The rules text is © Wizards of the Coast LLC and is used under the Wizards of the Coast Fan Content Policy.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRIMARY_URL = 'https://media.wizards.com/2026/downloads/MagicCompRules%2020260819.txt';
const RULES_PAGE = 'https://magic.wizards.com/en/rules';
const OUT_FULL = path.join(root, 'data', 'rules', 'cr.json');
const OUT_EXCERPT = path.join(root, 'apps', 'web', 'lib', 'rules', 'cr-excerpts.json');
const CITED_TS = path.join(root, 'src', 'rules', 'cited.ts');
const EXCERPT_BUDGET = 40 * 1024;

const argFrom = process.argv.indexOf('--from');
const fromFile = argFrom >= 0 ? process.argv[argFrom + 1] : null;

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'mtg-vault/0.1 (build-cr)' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

async function download() {
  try { return { text: await fetchText(PRIMARY_URL), url: PRIMARY_URL }; }
  catch (e) { console.warn(`primary URL failed (${e.message}); looking for the current .txt on ${RULES_PAGE}`); }
  const page = await fetchText(RULES_PAGE);
  const m = /https?:\/\/media\.wizards\.com\/[^"'\s]+?MagicCompRules[^"'\s]*?\.txt/i.exec(page);
  if (!m) throw new Error('could not find a MagicCompRules .txt link on the rules page');
  const url = m[0].replace(/ /g, '%20');
  return { text: await fetchText(url), url };
}

/** Parse "601.2. text" / "704.5g text" paragraphs from the rules body (stops at the glossary). */
export function parseRules(raw) {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const rules = {};
  const versionMatch = /effective as of ([A-Za-z]+ \d{1,2}, \d{4})/.exec(text);
  const version = versionMatch ? versionMatch[1] : 'unknown';
  let inBody = false; let glossaryHeadings = 0;
  for (const line of lines) {
    const t = line.trim();
    if (t === 'Glossary') { glossaryHeadings++; if (glossaryHeadings >= 2) break; continue; }
    if (!inBody) { if (/^1\. Game Concepts$/.test(t) && glossaryHeadings >= 1) inBody = true; else if (glossaryHeadings >= 1 && /^100\.1\.?\s/.test(t)) inBody = true; else continue; }
    const m = /^(\d{3}\.\d+[a-z]?)\.?\s+(.*)$/.exec(t);
    if (!m) continue;
    const [, num, body] = m;
    if (!(num in rules)) rules[num] = body.trim();
  }
  return { version, rules };
}

function citedNumbers() {
  const src = fs.readFileSync(CITED_TS, 'utf8');
  const out = new Set();
  for (const m of src.matchAll(/'(\d{3}\.\d+[a-z]?)'/g)) out.add(m[1]);
  return [...out].sort((a, b) => { const pa = a.split('.'), pb = b.split('.'); return Number(pa[0]) - Number(pb[0]) || parseInt(pa[1]) - parseInt(pb[1]) || pa[1].localeCompare(pb[1]); });
}

async function main() {
  const { text, url } = fromFile ? { text: fs.readFileSync(fromFile, 'utf8'), url: fromFile } : await download();
  const { version, rules } = parseRules(text);
  const count = Object.keys(rules).length;
  if (count < 2000) throw new Error(`parsed only ${count} rules from ${url}; the format may have changed`);
  fs.mkdirSync(path.dirname(OUT_FULL), { recursive: true });
  fs.writeFileSync(OUT_FULL, JSON.stringify({ version, source: url, fetchedAt: new Date().toISOString(), rules }, null, 0) + '\n');
  const cited = citedNumbers();
  const excerpt = {}; const missing = [];
  for (const n of cited) { if (rules[n]) excerpt[n] = rules[n]; else missing.push(n); }
  const excerptJson = JSON.stringify({ version, rules: excerpt }, null, 0) + '\n';
  if (Buffer.byteLength(excerptJson) > EXCERPT_BUDGET) throw new Error(`excerpt is ${Buffer.byteLength(excerptJson)} bytes, over the ${EXCERPT_BUDGET} byte budget`);
  fs.mkdirSync(path.dirname(OUT_EXCERPT), { recursive: true });
  fs.writeFileSync(OUT_EXCERPT, excerptJson);
  console.log(`CR ${version}: ${count} rules → ${path.relative(root, OUT_FULL)} (${(fs.statSync(OUT_FULL).size / 1024).toFixed(0)} kB)`);
  console.log(`excerpt: ${Object.keys(excerpt).length}/${cited.length} cited numbers → ${path.relative(root, OUT_EXCERPT)} (${(Buffer.byteLength(excerptJson) / 1024).toFixed(1)} kB)`);
  if (missing.length) console.warn(`not found in this CR version: ${missing.join(', ')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e); process.exit(1); });
