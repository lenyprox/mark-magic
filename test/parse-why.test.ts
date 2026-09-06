// scripts/parse-why.ts, the failure-cause histogram: the two keys, the per-line cause selection (bucket order, the
// registry-pass preference, the cost-noise filter), the one-cause-per-card accounting a "finish" rests on, and that
// `analyze` is a pure function of its rows (two runs, identical JSON). The queue's selection helpers it shares with
// scripts-queue.ts (`selectionIndex` / `selected`) are pinned against master.db when it is present.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { beginParseTrace, drainParseTrace, endParseTrace, parseCard, type OracleRow, type ParseTraceRecord } from '../src/cards/parse.js';
import { CardDB } from '../src/cards/db.js';
import { tierOf } from '../src/cards/pool.js';
import { MASTER_DB } from '../src/config/paths.js';
import { analyze, causesOf, chooseCause, lineCauses, norm1, prefixOf, shape, type Report } from '../scripts/parse-why.js';
import { parseSelection, selected, selectionIndex } from '../scripts/scripts-queue.js';

const hasDb = fs.existsSync(MASTER_DB());

const row = (name: string, oracle_text: string, extra: Partial<OracleRow> = {}): OracleRow => ({
  name, oracle_id: `probe-${name.toLowerCase().replace(/\W+/g, '-')}`, mana_cost: '{1}{B}', mana_value: 2, colors: ['B'], color_identity: ['B'],
  types: ['Creature'], supertypes: [], subtypes: ['Zombie'], type_line: 'Creature — Zombie', oracle_text, power: '2', toughness: '2', loyalty: null, keywords: [], layout: 'normal', ...extra,
});
const spell = (name: string, text: string): OracleRow => row(name, text, { types: ['Instant'], subtypes: [], type_line: 'Instant', power: null, toughness: null });
const rec = (o: Partial<ParseTraceRecord>): ParseTraceRecord => ({ oracleId: 'x', face: 'front', line: 'L', sentence: null, fragment: 'f', stage: 'sentence', pass: 'registry', depth: 0, nested: 0, partial: false, ...o });

/** A parsed row with the records its parse produced (tracing on for that parse only). */
function traced(r: OracleRow) {
  beginParseTrace();
  try { const def = parseCard(r); return { row: { raw: r as unknown as Record<string, unknown>, def }, recs: drainParseTrace() }; } finally { endParseTrace(); }
}

test('norm1 is coverage:pool\'s normalisation without the cut; shape replaces the vocabulary with placeholders', () => {
  assert.equal(norm1('Add {G}{G}{G}{G}. '), 'Add {}{}{}{}');
  assert.equal(norm1('Destroy target creature with mana value 3 or less.'), 'Destroy target creature with mana value # or less');
  assert.equal(shape('Put two +1/+1 counters on target Elf creature.'), 'put # <counter> counters on target <subtype> <obj>');
  assert.equal(shape('Whenever three or more Goblins you control attack'), 'whenever # or more <subtype> you control attack');
  assert.equal(shape('Return target red creature card from exile to the battlefield'), 'return target <color> <obj> <obj> from <zone> to the <zone>');
  assert.equal(shape('Exile all graveyards'), 'exile all <zone>');   // the verb is not the zone
  assert.equal(shape('Creatures you control gain lifelink and first strike until end of turn'), '<obj> you control gain <kw> and <kw> until end of turn');
  assert.equal(shape('Each opponent loses X life'), 'each <player> loses # life');
  assert.equal(prefixOf(shape('Whenever equipped creature deals combat damage to a player'), 4), 'whenever equipped <obj> deals');
});

test('chooseCause: bucket order, the registry-pass preference, the deepest partial sentence, the cost-noise filter', () => {
  const head = rec({ stage: 'trigger-head', fragment: 'h' }), cost = rec({ stage: 'cost', fragment: 'Sacrifice a Wug', partial: true });
  const condP = rec({ stage: 'condition', partial: true, fragment: 'c' }), cond = rec({ stage: 'condition', fragment: 'c0' });
  const s0 = rec({ stage: 'sentence', depth: 0, fragment: 'whole' }), s1 = rec({ stage: 'sentence', depth: 1, partial: true, fragment: 'p1' }), s2 = rec({ stage: 'sentence', depth: 2, partial: true, fragment: 'p2' });
  const st = rec({ stage: 'static', fragment: 'line' }), kw = rec({ stage: 'keyword', fragment: 'Bestow {W}' });
  assert.equal(chooseCause([st, s0, s2, s1, cond, condP, cost, head], false)!.fragment, 'h');
  assert.equal(chooseCause([st, s0, s2, s1, cond, condP, cost], false)!.fragment, 'Sacrifice a Wug');
  assert.equal(chooseCause([st, s0, s2, s1, cond, condP], false)!.fragment, 'c');
  assert.equal(chooseCause([st, s0, s1, s2, cond], false)!.fragment, 'p2');   // deepest partial, whatever the order
  assert.equal(chooseCause([st, s0, cond], false)!.fragment, 'c0');
  assert.equal(chooseCause([st, s0], false)!.fragment, 'whole');
  assert.equal(chooseCause([kw, st], false)!.fragment, 'line');
  assert.equal(chooseCause([kw], false)!.fragment, 'Bestow {W}');
  assert.equal(chooseCause([], false), null);
  // a registry-pass record beats a built-in one of a higher bucket: that pass tried strictly more
  assert.equal(chooseCause([rec({ stage: 'trigger-head', pass: 'builtin', fragment: 'hb' }), rec({ stage: 'sentence', depth: 0, fragment: 'sr' })], false)!.fragment, 'sr');
  // nested records count only with --nested
  const n = rec({ stage: 'sentence', depth: 0, nested: 1, partial: true, fragment: 'inner' });
  assert.equal(chooseCause([s0, n], false)!.fragment, 'whole');
  assert.equal(chooseCause([s0, n], true)!.fragment, 'inner');
  // parseActivatedLine's cost/effect split of a granted-ability line is not a cost construct
  const noise = rec({ stage: 'cost', fragment: 'Enchanted creature has "{T}', partial: false });
  assert.equal(chooseCause([noise, st], false)!.fragment, 'line');
  assert.equal(chooseCause([rec({ stage: 'cost', fragment: 'Exile ~ from your graveyard' }), st], false)!.stage, 'cost');
});

test('lineCauses: every independent failure of a line, the primary first; the count includes what the trace proves but did not record', () => {
  const head = rec({ stage: 'trigger-head', fragment: 'h', partial: false }), headOk = rec({ stage: 'trigger-head', fragment: 'h', partial: true });
  const s0 = rec({ stage: 'sentence', depth: 0, fragment: 'whole.', sentence: 'whole.' }), st = rec({ stage: 'static', fragment: 'line' });
  const units = (recs: ParseTraceRecord[], nested = false) => { const r = lineCauses(recs, nested); return [r.units.map(u => u.fragment), r.count] as const; };
  // a head that is not partial beside the body's own record: two constructs, the head first (chooseCause's choice)
  assert.deepEqual(units([s0, head]), [['h', 'whole.'], 2]);
  assert.deepEqual(units([head]), [['h'], 2]);                    // the body failed and left no record: counted, not keyed
  assert.deepEqual(units([headOk]), [['h'], 1]);
  // a condition that is not partial proves its effect half failed too (the probe); the whole-sentence give-up is the same sentence, not another unit
  const cond = rec({ stage: 'condition', fragment: 'you do', partial: false, sentence: 'If you do, whole.' }), sIf = rec({ stage: 'sentence', depth: 0, fragment: 'If you do, whole.', sentence: 'If you do, whole.' });
  assert.deepEqual(units([cond, sIf]), [['you do'], 2]);
  assert.deepEqual(units([rec({ ...cond, partial: true }), sIf]), [['you do'], 1]);
  // two sentences of one line are two units; a failing sibling part beside a part that parsed is one each, the part an inner part sits in is not
  assert.deepEqual(units([s0, cond, sIf]), [['you do', 'whole.'], 3]);
  const p1 = rec({ stage: 'sentence', depth: 1, partial: true, fragment: 'b and c', sentence: 'a, then b and c, then d.' }), p1b = rec({ stage: 'sentence', depth: 1, partial: true, fragment: 'd', sentence: 'a, then b and c, then d.' }), p2 = rec({ stage: 'sentence', depth: 2, partial: true, fragment: 'c', sentence: 'a, then b and c, then d.' });
  assert.deepEqual(units([p2, p1, p1b, rec({ stage: 'sentence', depth: 0, fragment: 'a, then b and c, then d.', sentence: 'a, then b and c, then d.' })]), [['c', 'd'], 2]);
  // the cost is the unit of an activated line the ladder never reached; the whole-line static record is the unit only when nothing inner is on record
  assert.deepEqual(units([rec({ stage: 'cost', fragment: 'Sacrifice a Wug' }), st]), [['Sacrifice a Wug'], 1]);
  assert.deepEqual(units([rec({ stage: 'cost', fragment: 'Enchanted creature has "{T}' }), st]), [['line'], 1]);
  assert.deepEqual(units([st]), [['line'], 1]);
  assert.deepEqual(units([]), [[], 0]);
  // the registry pass supersedes the built-in one's records; a nested record is the primary under --nested and replaces the unit it sits in
  assert.deepEqual(units([rec({ ...s0, pass: 'builtin' }), rec({ ...head, pass: 'builtin' }), s0]), [['whole.'], 1]);
  const n = rec({ stage: 'sentence', depth: 0, nested: 1, partial: true, fragment: 'inner' });
  assert.deepEqual(units([s0, n], true), [['inner'], 1]);
  assert.deepEqual(units([s0, n]), [['whole.'], 1]);
});

test('causesOf: every cause of every unparsed line; a spell\'s sentence entry beside its line is the same failure', () => {
  const t = traced(spell('Probe Two', 'Destroy target creature. Its controller frobnicates.'));
  assert.deepEqual(t.row.def.unparsed, ['Destroy target creature. Its controller frobnicates.', 'Its controller frobnicates.']);
  const causes = causesOf(t.row.def, t.recs, false);
  assert.equal(causes.length, 1);
  assert.equal(causes[0].stage, 'sentence');
  assert.equal(causes[0].fragment, 'Its controller frobnicates.');
  assert.equal(causes[0].key, 'sentence|Its controller frobnicates');
  assert.equal(causes[0].line, 'Its controller frobnicates.');   // the sentence entry carries the cause, the whole line is dropped
  assert.equal(causes[0].family, 'other');                        // the family of the failing sentence, not of the line's "Destroy"
  assert.equal(causes[0].causes, 1);
  // two failing sentences on one spell line are two causes: the card does not finish on either alone; "you do" is not
  // partial (the probe found "wugnicate the frob" failing too), so its line carries two failures with one on record
  const two = traced(spell('Probe Three', 'Frobnicate the wug. Sacrifice a creature. If you do, wugnicate the frob.'));
  assert.deepEqual(causesOf(two.row.def, two.recs, false).map(c => [c.stage, c.fragment, c.causes]), [['sentence', 'Frobnicate the wug.', 1], ['condition', 'you do', 2]]);
  // a permanent's two lines: the trigger head and the cost, one cause each
  const p = traced(row('Probe Lines', 'Whenever a Goblin frobnicates, draw a card.\n{T}, Frobnicate a wug: Draw a card.'));
  assert.deepEqual(causesOf(p.row.def, p.recs, false).map(c => [c.stage, c.fragment, c.causes]), [['trigger-head', 'Whenever a Goblin frobnicates', 1], ['cost', 'Frobnicate a wug', 1]]);
  // a head AND its body failing on one line: two causes on that line (Manabarbs' shape) — the head first, the body's sentence beside it
  const hb = traced(row('Probe HB', 'Whenever a Goblin frobnicates, wugnicate the frob.'));
  assert.deepEqual(causesOf(hb.row.def, hb.recs, false).map(c => [c.stage, c.fragment, c.line === hb.row.def.unparsed[0], c.causes]), [['trigger-head', 'Whenever a Goblin frobnicates', true, 2], ['sentence', 'wugnicate the frob.', true, 2]]);
  // two sibling parts failing beside one that parsed: two causes, each the innermost of its own
  const sibs = traced(spell('Probe Sibs', 'Draw a card, then frobnicate the wug, then wugnicate the frob.'));
  assert.deepEqual(causesOf(sibs.row.def, sibs.recs, false).map(c => [c.key, c.causes]), [['sentence|frobnicate the wug', 2], ['sentence|wugnicate the frob', 2]]);
  // a modal spell: each failing mode is its own entry and is matched to ITS sentence's records, not the whole modal line's
  const modal = traced(spell('Probe Modal', 'Choose one —\n• Frobnicate the wug.\n• Draw a card. If you frobnicated this turn, draw two cards instead.\n• Wugnicate the frob, then draw a card.'));
  assert.deepEqual(causesOf(modal.row.def, modal.recs, false).map(c => [c.stage, c.fragment]), [['sentence', 'Frobnicate the wug.'], ['condition', 'you frobnicated this turn'], ['sentence', 'Wugnicate the frob']]);
  // the second half of a split card is accounted as second-face, never as a construct
  const split = row('Fire // Ice', 'Fire deals 2 damage divided as you choose among one or two targets.', {
    layout: 'split', types: ['Instant'], subtypes: [], type_line: 'Instant // Instant', power: null, toughness: null,
    faces: [{ name: 'Fire', type_line: 'Instant', oracle_text: 'Fire deals 2 damage divided as you choose among one or two targets.', power: null, toughness: null, mana_cost: '{1}{R}' }, { name: 'Ice', type_line: 'Instant', oracle_text: 'Tap target permanent.\nDraw a card.', power: null, toughness: null, mana_cost: '{1}{U}' }],
  });
  const s = traced(split);
  const second = causesOf(s.row.def, s.recs, false).filter(c => c.stage === 'second-face');
  assert.deepEqual(second.map(c => c.line), ['Tap target permanent.', 'Draw a card.']);
});

test('analyze: constructs, finishes, weight, stage totals — and identical JSON on a second run', () => {
  const rows = [
    traced(spell('A', 'Draw a card, then frobnicate the wug.')),                 // one line, one cause: finishes
    traced(spell('B', 'Frobnicate the wug.\nDestroy target creature.')),        // one unparsed line: finishes on the whole sentence
    traced(row('C', 'Whenever a Goblin frobnicates, draw a card.\nSacrifice a wug: Draw a card.')),   // two lines: finishes nothing
    traced(spell('D', 'Frobnicate the wug.')),
    traced(row('E', 'Flying')),                                                  // fully parsed
    traced(row('F', 'Whenever a Goblin frobnicates, wugnicate the frob.')),      // one line, TWO causes (head and body): finishes nothing, counts for both
    traced(spell('G', 'If you do, wugnicate the frob.')),                        // one line, one keyed cause, but the probe proved the effect half fails too: no finish
  ];
  const opts = { tier: 'paper' as const, selection: parseSelection('pool:paper'), nested: false, excludeStages: ['keyword' as const], minCards: 1, top: 60, scripted: new Set(['probe-d']), edhrec: new Map([['probe-a', 10], ['probe-d', 5]]) };
  const r = analyze(rows, opts);
  assert.equal(r.totals.cards, 7);
  assert.equal(r.totals.unparsedCards, 6);
  assert.equal(r.totals.oneLineCards, 5);
  assert.equal(r.totals.finishCards, 3);
  assert.equal(r.totals.lines, 7);
  assert.equal(r.totals.lineCauses, 8);
  assert.deepEqual(r.totals.byStage, { sentence: { lines: 4, cards: 4, finishes: 3 }, 'trigger-head': { lines: 2, cards: 2, finishes: 0 }, cost: { lines: 1, cards: 1, finishes: 0 }, condition: { lines: 1, cards: 1, finishes: 0 } });
  const top = r.constructs[0];
  assert.equal(top.key, 'sentence|Frobnicate the wug');
  assert.deepEqual([top.cards, top.finishes, top.lines, top.weight, top.scripted], [2, 2, 2, 2, 1]);
  assert.deepEqual(top.examples.map(e => e.name), ['D', 'B']);   // by EDHREC rank, unranked last
  assert.deepEqual(top.families, [{ family: 'other', lines: 2 }]);
  const partial = r.constructs.find(c => c.key === 'sentence|frobnicate the wug')!;
  assert.deepEqual([partial.cards, partial.finishes, partial.weight], [1, 1, 1]);
  const cost = r.constructs.find(c => c.stage === 'cost')!;
  assert.deepEqual([cost.norm, cost.cards, cost.finishes, cost.weight], ['Sacrifice a wug', 1, 0, 0.5]);
  // F's head is shared with C (two cards, neither finishing: C has another line, F's line has another cause); F's body and G's condition are one card each, no finish
  const head = r.constructs.find(c => c.key === 'trigger-head|Whenever a Goblin frobnicates')!;
  assert.deepEqual([head.cards, head.finishes, head.lines, head.weight, head.examples.map(e => [e.name, e.finishes])], [2, 0, 2, 1, [['C', false], ['F', false]]]);
  assert.deepEqual(r.constructs.filter(c => c.key === 'sentence|wugnicate the frob' || c.key === 'condition|you do').map(c => [c.key, c.cards, c.finishes, c.weight]), [['condition|you do', 1, 0, 0.5], ['sentence|wugnicate the frob', 1, 0, 0.5]]);
  assert.ok(r.shapes.some(s => s.shape === 'frobnicate the wug' && s.stage === 'sentence' && s.keys === 2 && s.cards === 3));
  assert.ok(r.prefixes.some(p => p.prefix === 'whenever a <subtype> frobnicates' && p.stage === 'trigger-head'));
  const again = analyze(rows, opts);
  assert.equal(JSON.stringify(again), JSON.stringify(r));
  // --exclude-stage and --min-cards shape the construct list only; totals are untouched
  const few = analyze(rows, { ...opts, excludeStages: ['cost'], minCards: 2 });
  assert.deepEqual(few.constructs.map(c => c.key), ['sentence|Frobnicate the wug', 'trigger-head|Whenever a Goblin frobnicates']);
  assert.deepEqual(few.totals, r.totals);
});

test('selectionIndex / selected: the queue\'s selection, decided per card without a parse', { skip: !hasDb && 'no master.db' }, () => {
  const db = CardDB.shared();
  const idx = selectionIndex(db);
  const sol = db.get('Sol Ring')!, ante = db.get('Contract from Below')!;
  const tier = (id: string) => tierOf(JSON.parse((db.db.prepare('SELECT json FROM oracle_cards WHERE oracle_id = ?').get(id) as { json: string }).json) as Parameters<typeof tierOf>[0]);
  assert.equal(selected(parseSelection('edhrec<=5000 commander:legal pool:paper'), idx, sol.oracleId, tier(sol.oracleId)), true);
  assert.equal(selected(parseSelection('edhrec>=5001 pool:paper'), idx, sol.oracleId, tier(sol.oracleId)), false);
  assert.equal(selected(parseSelection('pool:paper'), idx, ante.oracleId, tier(ante.oracleId)), false);   // ante tier
  assert.equal(selected(parseSelection('pool:all'), idx, ante.oracleId, tier(ante.oracleId)), true);
  assert.equal(selected(parseSelection('commander:legal pool:all'), idx, ante.oracleId, tier(ante.oracleId)), false);
  assert.ok(idx.edhrec.get(sol.oracleId)! < 100);
});
