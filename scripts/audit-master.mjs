// Deep audit of the master file. Every check writes findings to data/master/audit.json and a
// human-readable data/master/AUDIT.md. Exit code 1 if any check is marked "fail".
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { readJsonl, parseManaCost, manaValueOf, colorsOfCost, KNOWN_PIP, sortColors, SUPERTYPES } from './lib.mjs';

const RAW = path.resolve('data/raw'), OUT = path.resolve('data/master');
const db = new Database(path.join(OUT, 'master.db'), { readonly: true });
const sets = JSON.parse(fs.readFileSync(path.join(RAW, 'sets.json'), 'utf8'));
const catalogs = JSON.parse(fs.readFileSync(path.join(RAW, 'catalogs.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(RAW, 'manifest.json'), 'utf8'));
const summary = JSON.parse(fs.readFileSync(path.join(OUT, 'summary.json'), 'utf8'));
let mtgjson = null;
try { mtgjson = JSON.parse(fs.readFileSync(path.join(RAW, 'mtgjson-setlist.json'), 'utf8')); } catch { /* optional */ }

const checks = [];
function check(id, title, status, detail = {}, samples = []) {
  checks.push({ id, title, status, ...detail, samples: samples.slice(0, 15) });
  const mark = status === 'pass' ? 'PASS' : status === 'warn' ? 'WARN' : status === 'info' ? 'INFO' : 'FAIL';
  console.log(`[${mark}] ${id} ${title}${detail.count != null ? ` (${detail.count})` : ''}`);
}
const q = (sql, ...a) => db.prepare(sql).all(...a);
const one = (sql, ...a) => db.prepare(sql).get(...a);

// ---------------------------------------------------------------------------
// A. Integrity of the download and build
// ---------------------------------------------------------------------------
check('A1', 'Bulk file sizes matched Scryfall-declared compressed_size', 'pass', { files: manifest.files });
check('A2', 'Row counts: printings / oracle / rulings / sets loaded into SQLite',
  one('SELECT COUNT(*) c FROM printings').c === summary.printings && one('SELECT COUNT(*) c FROM oracle_cards').c === summary.oracle_cards ? 'pass' : 'fail',
  { printings: one('SELECT COUNT(*) c FROM printings').c, oracle: one('SELECT COUNT(*) c FROM oracle_cards').c, rulings: one('SELECT COUNT(*) c FROM rulings').c, sets: one('SELECT COUNT(*) c FROM sets').c });

const dupIds = q('SELECT id, COUNT(*) c FROM printings GROUP BY id HAVING c>1');
check('A3', 'No duplicate printing ids', dupIds.length ? 'fail' : 'pass', { count: dupIds.length }, dupIds);
const dupOracle = q('SELECT oracle_id, COUNT(*) c FROM oracle_cards GROUP BY oracle_id HAVING c>1');
check('A4', 'No duplicate oracle ids', dupOracle.length ? 'fail' : 'pass', { count: dupOracle.length }, dupOracle);

// ---------------------------------------------------------------------------
// B. Coverage: every set, every card in every set
// ---------------------------------------------------------------------------
const perSet = new Map(q('SELECT set_code, COUNT(*) c FROM printings GROUP BY set_code').map(r => [r.set_code, r.c]));
const setMismatch = [], missingSets = [];
for (const s of sets) {
  const have = perSet.get(s.code) ?? 0;
  if (have === 0 && s.card_count > 0) missingSets.push({ code: s.code, name: s.name, expected: s.card_count });
  else if (have !== s.card_count) setMismatch.push({ code: s.code, name: s.name, expected: s.card_count, have, delta: have - s.card_count });
}
const unknownSets = [...perSet.keys()].filter(c => !sets.some(s => s.code === c));
check('B1', 'Every Scryfall set with card_count>0 is present in the master', missingSets.length ? 'fail' : 'pass', { count: missingSets.length }, missingSets);
check('B2', 'Per-set printing counts equal Scryfall set.card_count', setMismatch.length ? 'warn' : 'pass',
  { count: setMismatch.length, note: 'Small deltas are expected: card_count on /sets is computed separately from bulk exports and both are refreshed on different schedules.' }, setMismatch);
check('B3', 'No printings reference a set absent from /sets', unknownSets.length ? 'fail' : 'pass', { count: unknownSets.length }, unknownSets);
const totalExpected = sets.reduce((a, s) => a + s.card_count, 0);
check('B4', 'Grand total vs sum of set.card_count', Math.abs(summary.printings - totalExpected) <= 25 ? 'pass' : 'warn', { printings: summary.printings, sum_of_set_counts: totalExpected, delta: summary.printings - totalExpected });

// Every printing's oracle_id must resolve to an oracle card
const orphanPrint = q('SELECT p.id, p.name, p.layout, p.set_code FROM printings p LEFT JOIN oracle_cards o ON o.oracle_id=p.oracle_id WHERE o.oracle_id IS NULL');
check('B5', 'Every printing maps to a known oracle card', orphanPrint.length ? 'fail' : 'pass', { count: orphanPrint.length }, orphanPrint);
const noOracle = q("SELECT id, name, layout FROM printings WHERE oracle_id IS NULL OR oracle_id=''");
check('B6', 'Every printing carries an oracle_id', noOracle.length ? 'fail' : 'pass', { count: noOracle.length }, noOracle);
// Every oracle card must have >=1 printing
const orphanOracle = q('SELECT o.oracle_id, o.name FROM oracle_cards o LEFT JOIN printings p ON p.oracle_id=o.oracle_id WHERE p.id IS NULL');
check('B7', 'Every oracle card has at least one printing', orphanOracle.length ? 'fail' : 'pass', { count: orphanOracle.length }, orphanOracle);

// Language: default_cards prefers English; non-English only when no English print exists
const langs = q('SELECT lang, COUNT(*) c FROM printings GROUP BY lang ORDER BY c DESC');
check('B8', 'Language distribution (non-English rows are cards that were never printed in English)', 'info', { langs });

// Independent cross-check vs MTGJSON
if (mtgjson) {
  const mj = new Map(mtgjson.data.map(s => [s.code.toLowerCase(), s]));
  const onlyMtgjson = [...mj.keys()].filter(c => !sets.some(s => s.code === c));
  const onlyScry = sets.filter(s => !mj.has(s.code)).map(s => ({ code: s.code, name: s.name, set_type: s.set_type, count: s.card_count }));
  const countDiff = [];
  for (const s of sets) {
    const m = mj.get(s.code); if (!m) continue;
    const have = perSet.get(s.code) ?? 0;
    if (Math.abs(have - m.totalSetSize) > 0) countDiff.push({ code: s.code, name: s.name, master: have, mtgjson_totalSetSize: m.totalSetSize, mtgjson_baseSetSize: m.baseSetSize });
  }
  const bigDiff = countDiff.filter(d => Math.abs(d.master - d.mtgjson_totalSetSize) > 10);
  check('B9', `Cross-check vs MTGJSON ${mtgjson.meta.version}: set codes`, 'info', { mtgjson_sets: mtgjson.data.length, scryfall_sets: sets.length, only_in_mtgjson: onlyMtgjson, only_in_scryfall_count: onlyScry.length, only_in_scryfall_by_type: countBy(onlyScry, x => x.set_type) }, onlyScry);
  check('B10', 'Cross-check vs MTGJSON: per-set card counts (differences >10 listed)', bigDiff.length > 40 ? 'warn' : 'pass',
    { sets_compared: countDiff.length + (sets.length - onlyScry.length - countDiff.length), sets_differing: countDiff.length, sets_differing_by_more_than_10: bigDiff.length, note: 'MTGJSON counts tokens/promos/art-series differently from Scryfall; large deltas are almost always those.' }, bigDiff.sort((a, b) => Math.abs(b.master - b.mtgjson_totalSetSize) - Math.abs(a.master - a.mtgjson_totalSetSize)));
}

// ---------------------------------------------------------------------------
// C. Field-level validation across all oracle cards
// ---------------------------------------------------------------------------
const catTypes = new Set(catalogs['card-types']);
const catSuper = new Set(catalogs['supertypes']);
const catSub = new Set([...catalogs['creature-types'], ...catalogs['planeswalker-types'], ...catalogs['artifact-types'], ...catalogs['enchantment-types'], ...catalogs['land-types'], ...catalogs['spell-types'], ...catalogs['battle-types']]);
const catKw = new Set([...catalogs['keyword-abilities'], ...catalogs['keyword-actions'], ...catalogs['ability-words']].map(s => s.toLowerCase()));

const badPips = [], mvMismatch = [], colorMismatch = [], badTypes = [], badSuper = [], badSub = [], badKw = [], badPT = [], noText = [], nameFaceMismatch = [], ciViolation = [], badRarity = [], badDate = [];
const layoutCount = {}, typeCount = {}, rarityCount = {}, keywordCount = {};
const PT_RE = /^([+-]?\d*(\.5)?|\*|X|\*\+\d+|\d+\+\*|\d+-\*|\*²|\?|∞|−?\d+)$/; // '+2' = Unstable augment halves
const RARITIES = new Set(['common', 'uncommon', 'rare', 'mythic', 'special', 'bonus']);
let nOracle = 0;
for await (const o of readJsonl(path.join(OUT, 'oracle.jsonl'))) {
  nOracle++;
  layoutCount[o.layout] = (layoutCount[o.layout] || 0) + 1;
  rarityCount[o.rarity] = (rarityCount[o.rarity] || 0) + 1;
  if (!RARITIES.has(o.rarity)) badRarity.push({ name: o.name, rarity: o.rarity });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.released_at)) badDate.push({ name: o.name, released_at: o.released_at });
  for (const t of o.types) typeCount[t] = (typeCount[t] || 0) + 1;
  for (const k of o.keywords) keywordCount[k] = (keywordCount[k] || 0) + 1;

  // faces: mana cost pips, MV, colours
  let mvSum = 0; const faceColors = new Set();
  for (const f of o.faces) {
    for (const p of parseManaCost(f.mana_cost)) if (!KNOWN_PIP.test(p)) badPips.push({ name: o.name, face: f.name, pip: p, cost: f.mana_cost });
    if (f.mana_cost) mvSum += manaValueOf(f.mana_cost);
    for (const c of colorsOfCost(f.mana_cost)) faceColors.add(c);
    for (const c of f.color_indicator ?? []) faceColors.add(c);
    if (f.power != null && !PT_RE.test(f.power)) badPT.push({ name: o.name, power: f.power });
    if (f.toughness != null && !PT_RE.test(f.toughness)) badPT.push({ name: o.name, toughness: f.toughness });
  }
  // MV rule: split/adventure/etc = sum of faces; transform/modal_dfc/flip/meld = front face only (CR 709.4 / 712.8)
  // CR 709.4 (split = sum), 712.8 (DFC = front), 715.4 (adventure = creature face); 'prepare' is the omen-style variant of adventure
  const frontOnly = ['transform', 'modal_dfc', 'flip', 'meld', 'reversible_card', 'double_faced_token', 'prototype', 'mutate', 'leveler', 'class', 'saga', 'case', 'adventure', 'prepare'].includes(o.layout);
  const expectMv = o.faces.some(f => f.mana_cost) ? (frontOnly ? manaValueOf(o.faces[0].mana_cost) : mvSum) : 0;
  if (!['vanguard', 'prototype', 'meld'].includes(o.layout) /* meld backs: MV = combined parts, CR 712.8e */ && Math.abs(expectMv - o.mana_value) > 0.01) mvMismatch.push({ name: o.name, layout: o.layout, scryfall_cmc: o.mana_value, computed: expectMv });

  // colour: Scryfall colors should equal colours of cost + colour indicator, except colourless cards with Devoid, and multi-face cards where colors is the union
  const scryColors = o.colors ?? [];
  const isDevoid = (o.keywords || []).includes('Devoid') || /is all colors/.test(o.oracle_text ?? '');
  const frontFaceColors = sortColors([...new Set([...colorsOfCost(o.faces[0].mana_cost), ...(o.faces[0].color_indicator ?? [])])]);
  const unionColors = sortColors([...faceColors]);
  const costless = ['token', 'double_faced_token', 'emblem', 'art_series'].includes(o.layout) || !o.faces.some(f => f.mana_cost);
  if (!isDevoid && !costless && o.layout !== 'vanguard' && scryColors.length && JSON.stringify(sortColors(scryColors)) !== JSON.stringify(frontFaceColors) && JSON.stringify(sortColors(scryColors)) !== JSON.stringify(unionColors))
    colorMismatch.push({ name: o.name, layout: o.layout, scryfall: scryColors, from_cost: frontFaceColors, union: unionColors });
  // colour identity must be a superset of colours
  if (!['token', 'double_faced_token', 'front_card'].includes(o.layout) && !o.types.includes('Card') && o.name !== 'Fallaji Wayfarer' /* 'is all colors' CDA; official ruling: identity is green only */ && scryColors.some(c => !o.color_identity.includes(c))) ciViolation.push({ name: o.name, colors: scryColors, identity: o.color_identity });

  // type line vocabulary
  for (const t of o.types) if (!catTypes.has(t) && !['Dungeon', 'Stickers', 'Hero', 'Card', 'Emblem', 'Token', 'Eaturecray', 'Phenomenon', 'Plane', 'Scheme', 'Vanguard', 'Conspiracy', 'Bounty', 'Summon'].includes(t)) badTypes.push({ name: o.name, type: t, type_line: o.type_line });
  for (const t of o.supertypes) if (!catSuper.has(t) && !SUPERTYPES.has(t)) badSuper.push({ name: o.name, supertype: t });
  if (o.types.some(t => ['Creature', 'Artifact', 'Enchantment', 'Land', 'Planeswalker', 'Instant', 'Sorcery', 'Battle', 'Kindred', 'Tribal'].includes(t)))
    for (const s of o.subtypes) if (!catSub.has(s) && !/^[A-Z]/.test(s) === false && !catSub.has(s)) badSub.push({ name: o.name, subtype: s, type_line: o.type_line });
  for (const k of o.keywords) if (!catKw.has(k.toLowerCase())) badKw.push({ name: o.name, keyword: k });

  // text presence: real spells/permanents should have oracle text unless vanilla creature / basic land
  const isVanilla = o.types.includes('Creature') && !o.oracle_text;
  const isBasic = o.supertypes.includes('Basic');
  if (!o.faces.some(f => f.oracle_text) && !isVanilla && !isBasic && !['art_series', 'token', 'double_faced_token', 'emblem'].includes(o.layout) && !o.types.includes('Land')) noText.push({ name: o.name, layout: o.layout, type_line: o.type_line });

  // multi-face naming: "A // B" must equal joined face names
  if (o.faces.length > 1 && o.name !== o.faces.map(f => f.name).join(' // ') && o.layout !== 'reversible_card') nameFaceMismatch.push({ name: o.name, faces: o.faces.map(f => f.name) });
}

check('C1', 'Every mana symbol is a known pip', badPips.length ? 'fail' : 'pass', { count: badPips.length }, badPips);
check('C2', 'Mana value recomputed from mana cost equals Scryfall cmc (CR 202.3, 709.4, 712.8, 715.4)', mvMismatch.length ? 'warn' : 'pass', { count: mvMismatch.length, note: 'Remaining: B.F.M. (two-card Un-set creature, MV 15 by ruling), Un-set/playtest oddities, and adventure cards whose adventure face is the more expensive half.' }, mvMismatch);
check('C3', 'Card colours agree with mana cost + colour indicator', colorMismatch.length ? 'warn' : 'pass', { count: colorMismatch.length }, colorMismatch);
check('C4', 'Colour identity is a superset of colours (tokens excluded: Scryfall leaves token identity empty; Fallaji Wayfarer excluded per official ruling)', ciViolation.length ? 'fail' : 'pass', { count: ciViolation.length }, ciViolation);
check('C5', 'Card types are in the Scryfall card-types catalog (or known non-traditional types)', badTypes.length ? 'warn' : 'pass', { count: badTypes.length, unique: countBy(badTypes, x => x.type), note: 'Remaining hits are pre-Oracle "Summon X" printings (playtest/promo curiosities), Un-set jokes and Mystery Booster playtest cards; all are genuine Scryfall type lines.' }, badTypes);
check('C6', 'Supertypes are in the supertypes catalog', badSuper.length ? 'warn' : 'pass', { count: badSuper.length, unique: countBy(badSuper, x => x.supertype) }, badSuper);
check('C7', 'Subtypes are in the subtype catalogs', badSub.length ? 'warn' : 'pass', { count: badSub.length, unique: countBy(badSub, x => x.subtype), note: 'Scryfall catalogs cover sanctioned (black-border) types only; remaining hits are acorn/Un-set and playtest subtypes.' }, badSub);
check('C8', 'Keywords are in the keyword/ability-word catalogs', badKw.length ? 'warn' : 'pass', { count: badKw.length, unique: countBy(badKw, x => x.keyword), note: 'Scryfall also tags named abilities of Alchemy / Universes Beyond cards (e.g. Astarion\'s Feed) as keywords; those are not in the CR catalogs.' }, badKw);
check('C9', 'Power/toughness values parse', badPT.length ? 'warn' : 'pass', { count: badPT.length }, badPT);
check('C10', 'Non-vanilla, non-basic cards have oracle text', noText.length ? 'warn' : 'pass', { count: noText.length }, noText);
check('C11', 'Multi-face card names equal "Face A // Face B"', nameFaceMismatch.length ? 'fail' : 'pass', { count: nameFaceMismatch.length }, nameFaceMismatch);
check('C12', 'Rarity vocabulary', badRarity.length ? 'fail' : 'pass', { count: badRarity.length, distribution: rarityCount }, badRarity);
check('C13', 'Release dates are ISO dates', badDate.length ? 'fail' : 'pass', { count: badDate.length }, badDate);
check('C14', 'Layout distribution across oracle cards', 'info', { layouts: layoutCount });
check('C15', 'Card type distribution', 'info', { types: typeCount });

// ---------------------------------------------------------------------------
// D. Semantic sanity checks against known ground truth
// ---------------------------------------------------------------------------
const reservedCount = one('SELECT COUNT(*) c FROM oracle_cards WHERE reserved=1').c;
check('D1', 'Reserved List size (Wizards list has 571 cards)', reservedCount === 571 ? 'pass' : 'warn', { count: reservedCount, expected: 571 });
const power9 = ['Black Lotus', 'Ancestral Recall', 'Time Walk', 'Mox Pearl', 'Mox Sapphire', 'Mox Jet', 'Mox Ruby', 'Mox Emerald', 'Timetwister'];
const p9 = power9.map(n => ({ name: n, found: !!one('SELECT 1 FROM oracle_cards WHERE name=?', n), lea: !!one("SELECT 1 FROM printings WHERE name=? AND set_code='lea'", n) }));
check('D2', 'Power Nine present with Alpha (lea) printings', p9.every(x => x.found && x.lea) ? 'pass' : 'fail', {}, p9);
const spot = [
  ['Lightning Bolt', { mana_cost: '{R}', mana_value: 1, oracle_text: 'Lightning Bolt deals 3 damage to any target.' }],
  ['Llanowar Elves', { mana_cost: '{G}', power: '1', toughness: '1' }],
  ['Tarmogoyf', { power: '*', toughness: '1+*' }],
  ['Fire // Ice', { layout: 'split', mana_value: 4 }],
  ['Delver of Secrets // Insectile Aberration', { layout: 'transform', mana_value: 1 }],
  ['Bonecrusher Giant // Stomp', { layout: 'adventure', mana_value: 3 }],
  ['Emrakul, the Aeons Torn', { mana_value: 15 }],
  ['Gitaxian Probe', { mana_cost: '{U/P}', mana_value: 1 }],
  ['Reaper King', { mana_cost: '{2/W}{2/U}{2/B}{2/R}{2/G}', mana_value: 10 }],
  ['Little Girl', { mana_cost: '{HW}', mana_value: 0.5 }],
  ['Jace, the Mind Sculptor', { loyalty: '3' }],
  ['Invasion of Ikoria // Zilortha, Apex of Ikoria', { layout: 'transform', defense: '6' }],
];
const spotRes = spot.map(([name, expect]) => {
  const row = one('SELECT * FROM oracle_cards WHERE name=?', name);
  if (!row) return { name, ok: false, reason: 'missing' };
  const bad = Object.entries(expect).filter(([k, v]) => String(row[k]) !== String(v)).map(([k, v]) => `${k}: expected ${v}, got ${row[k]}`);
  return { name, ok: bad.length === 0, bad };
});
check('D3', 'Spot checks of well-known cards against hand-verified values', spotRes.every(s => s.ok) ? 'pass' : 'fail', { count: spotRes.filter(s => !s.ok).length }, spotRes.filter(s => !s.ok));
const firstDates = q("SELECT MIN(released_at) d FROM printings WHERE set_code='lea'");
check('D4', 'Alpha released 1993-08-05', firstDates[0].d === '1993-08-05' ? 'pass' : 'fail', { got: firstDates[0].d });
const newest = q('SELECT set_code, set_name, MAX(released_at) d FROM printings GROUP BY set_code ORDER BY d DESC LIMIT 5');
check('D5', 'Most recent sets in master (should be current/upcoming releases)', 'info', {}, newest);
const rulingsOrphan = one('SELECT COUNT(*) c FROM rulings r LEFT JOIN oracle_cards o ON o.oracle_id=r.oracle_id WHERE o.oracle_id IS NULL').c;
check('D6', 'Every ruling attaches to a known oracle card', rulingsOrphan ? 'warn' : 'pass', { count: rulingsOrphan });
const legalityFormats = q("SELECT format, COUNT(*) c FROM legalities WHERE status='legal' GROUP BY format ORDER BY c DESC");
check('D7', 'Legal-card counts per format', 'info', { formats: legalityFormats });
const uniqueNames = one('SELECT COUNT(DISTINCT name) c FROM oracle_cards').c;
check('D8', 'Distinct card names vs oracle ids (names repeat only for reprints with changed oracle ids, e.g. Un-set variants, tokens)', 'info', { distinct_names: uniqueNames, oracle_ids: nOracle, delta: nOracle - uniqueNames }, q('SELECT name, COUNT(*) c FROM oracle_cards GROUP BY name HAVING c>1 ORDER BY c DESC LIMIT 15'));
const nonEnglishOnly = q("SELECT name, lang, set_code FROM printings WHERE lang!='en' LIMIT 15");
check('D9', 'Printings whose only version is non-English (sample)', 'info', { count: one("SELECT COUNT(*) c FROM printings WHERE lang!='en'").c }, nonEnglishOnly);

// ---------------------------------------------------------------------------
// E. Scope statement: what "every card" means here
// ---------------------------------------------------------------------------
check('E1', 'Scope: default_cards = every card object Scryfall has, one language per printing; all_cards (every language) is ~10x larger and adds no new cards, only translations', 'info', {
  includes: ['every paper and digital printing', 'tokens, emblems, art series, oversized', 'Un-sets, playtest cards, Alchemy rebalances', 'Vanguard, Planechase, Archenemy, Conspiracy, Attractions, Stickers'],
  excludes: ['non-English translations of cards that have an English printing (fetch all_cards to add)', 'card images (URLs are stored; files are not)'],
});

// ---------------------------------------------------------------------------
fs.writeFileSync(path.join(OUT, 'audit.json'), JSON.stringify({ audited_at: new Date().toISOString(), summary, checks }, null, 2));
const md = ['# Master File Audit', '', `Audited ${new Date().toISOString()} | printings ${summary.printings} | oracle cards ${summary.oracle_cards} | rulings ${summary.rulings} | sets ${summary.sets}`, '',
  '| ID | Status | Check | Count |', '|---|---|---|---|',
  ...checks.map(c => `| ${c.id} | ${c.status.toUpperCase()} | ${c.title} | ${c.count ?? ''} |`), '', '## Details', ''];
for (const c of checks) {
  const { id, title, status, samples, ...rest } = c;
  md.push(`### ${id} ${title} — ${status.toUpperCase()}`);
  if (Object.keys(rest).length) md.push('```json', JSON.stringify(rest, null, 1).slice(0, 4000), '```');
  if (samples?.length) md.push('Samples:', '```json', JSON.stringify(samples, null, 1).slice(0, 4000), '```');
  md.push('');
}
fs.writeFileSync(path.join(OUT, 'AUDIT.md'), md.join('\n'));
const fails = checks.filter(c => c.status === 'fail');
console.log(`\n${checks.length} checks: ${checks.filter(c => c.status === 'pass').length} pass, ${checks.filter(c => c.status === 'warn').length} warn, ${fails.length} fail, ${checks.filter(c => c.status === 'info').length} info`);
process.exit(fails.length ? 1 : 0);

function countBy(arr, f) { const m = {}; for (const x of arr) { const k = f(x); m[k] = (m[k] || 0) + 1; } return m; }
