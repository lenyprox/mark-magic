// The parser's failure trace (src/cards/parse.ts `beginParseTrace` / `drainParseTrace` / `endParseTrace`; read by
// scripts/parse-why.ts): what it records for each failure stage on synthetic wordings, that it records nothing when
// off, and — the property everything else rests on — that tracing changes no parse. The trace lives beside the
// CardDef, never on it (the parse snapshot hashes every CardDef key), and its one probe runs only under the flag.
//
// Wordings are written the way parseCard sees them (the card's own name is `~`). The verbs "frobnicate" / "wugnicate"
// and the noun "wug" are in no template, so each pin fails exactly where it says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { beginParseTrace, drainParseTrace, endParseTrace, parseCard, type OracleRow, type ParseTraceRecord } from '../src/cards/parse.js';
import { poolRows } from '../src/cards/scriptState.js';
import { MASTER_DB } from '../src/config/paths.js';

const hasDb = fs.existsSync(MASTER_DB());

const row = (name: string, oracle_text: string, extra: Partial<OracleRow> = {}): OracleRow => ({
  name, oracle_id: `probe-${name.toLowerCase().replace(/\W+/g, '-')}`, mana_cost: '{1}{B}', mana_value: 2, colors: ['B'], color_identity: ['B'],
  types: ['Creature'], supertypes: [], subtypes: ['Zombie'], type_line: 'Creature — Zombie', oracle_text, power: '2', toughness: '2', loyalty: null, keywords: [], layout: 'normal', ...extra,
});
/** An instant: effect text on a permanent never reaches the sentence ladder (it is a static line), spell text does. */
const spell = (name: string, text: string): OracleRow => row(name, text, { types: ['Instant'], subtypes: [], type_line: 'Instant', power: null, toughness: null });

/** The records of one parse, tracing on for that parse only. */
function traced(r: OracleRow): ParseTraceRecord[] {
  beginParseTrace();
  try { parseCard(r); return drainParseTrace(); } finally { endParseTrace(); }
}
const pick = (recs: ParseTraceRecord[], stage: ParseTraceRecord['stage'], pass: ParseTraceRecord['pass'] = 'registry') => recs.filter(r => r.stage === stage && r.pass === pass && r.nested === 0);

test('tracing off: drainParseTrace() is empty and stays empty across parses', () => {
  endParseTrace();
  assert.deepEqual(drainParseTrace(), []);
  parseCard(spell('Probe Off', 'Draw a card, then frobnicate the wug.'));
  assert.deepEqual(drainParseTrace(), []);
});

test('sentence stage: the innermost part the ladder threw away, partial when a sibling parsed; the whole sentence once at depth 0', () => {
  const recs = traced(spell('Probe Then', 'Draw a card, then frobnicate the wug.'));
  const inner = pick(recs, 'sentence').find(r => r.fragment === 'frobnicate the wug');
  assert.ok(inner, 'the failing ", then" part is on record');
  assert.equal(inner!.partial, true);   // "Draw a card" parsed
  assert.equal(inner!.depth, 1);
  assert.equal(inner!.sentence, 'Draw a card, then frobnicate the wug.');
  assert.equal(inner!.line, 'Draw a card, then frobnicate the wug.');
  const whole = pick(recs, 'sentence').filter(r => r.depth === 0);
  assert.deepEqual(whole.map(r => [r.fragment, r.partial]), [['Draw a card, then frobnicate the wug.', false]]);
  // nothing parsed on either side: both parts are on record, neither partial
  const none = pick(traced(spell('Probe None', 'Frobnicate the wug, then wugnicate the frob.')), 'sentence');
  assert.deepEqual(none.filter(r => r.depth === 1).map(r => [r.fragment, r.partial]), [['Frobnicate the wug', false], ['wugnicate the frob', false]]);
  // both passes record; the registry pass is the one a reader prefers
  assert.ok(recs.some(r => r.pass === 'builtin') && recs.some(r => r.pass === 'registry'));
  for (const r of recs) { assert.equal(r.oracleId, 'probe-probe-then'); assert.equal(r.face, 'front'); }
});

test('condition stage: the condition clause, partial when the effect half would parse (the trace-only probe)', () => {
  const lead = pick(traced(spell('Probe If', 'If you frobnicated this turn, draw a card.')), 'condition');
  assert.deepEqual(lead.map(r => [r.fragment, r.partial, r.depth]), [['you frobnicated this turn', true, 0]]);
  const trail = pick(traced(spell('Probe Trail', 'Draw a card if you frobnicated this turn.')), 'condition');
  assert.deepEqual(trail.map(r => [r.fragment, r.partial]), [['you frobnicated this turn', true]]);
  const both = pick(traced(spell('Probe Both', 'If you frobnicated this turn, wugnicate the frob.')), 'condition');
  assert.deepEqual(both.map(r => [r.fragment, r.partial]), [['you frobnicated this turn', false]]);
  // "activate only if": the cost parsed, so the condition is partial
  const only = pick(traced(row('Probe Only', '{T}: Draw a card. Activate only if you frobnicated this turn.')), 'condition');
  assert.deepEqual(only.map(r => [r.fragment, r.partial]), [['you frobnicated this turn', true]]);
});

test('trigger-head and intervening stages: the head / the intervening clause of the triggered branch', () => {
  const head = traced(row('Probe Head', 'Whenever a Goblin frobnicates, draw a card.')).filter(r => r.stage === 'trigger-head');
  assert.deepEqual(head.map(r => [r.fragment, r.partial, r.sentence]), [['Whenever a Goblin frobnicates', true, null]]);
  const iv = traced(row('Probe Iv', 'Whenever ~ attacks, if you frobnicated this turn, draw a card.')).filter(r => r.stage === 'intervening');
  assert.deepEqual(iv.map(r => [r.fragment, r.partial]), [['you frobnicated this turn', true]]);
  // a body that fails too is not partial for either
  const headBody = traced(row('Probe HB', 'Whenever a Goblin frobnicates, wugnicate the frob.')).filter(r => r.stage === 'trigger-head');
  assert.deepEqual(headBody.map(r => r.partial), [false]);
});

test('cost stage: the failing comma-part, partial when another part is a known cost phrase', () => {
  const recs = traced(row('Probe Cost', '{T}, Frobnicate a wug: Draw a card.'));
  assert.deepEqual(pick(recs, 'cost').map(r => [r.fragment, r.partial]), [['Frobnicate a wug', true]]);
  assert.deepEqual(pick(recs, 'cost', 'builtin').map(r => r.fragment), ['Frobnicate a wug']);   // the line loop's built-in pass first
  const alone = pick(traced(row('Probe Cost1', 'Frobnicate a wug: Draw a card.')), 'cost');
  assert.deepEqual(alone.map(r => [r.fragment, r.partial]), [['Frobnicate a wug', false]]);
});

test('static and keyword stages: the whole line, once, at the line loop\'s give-up / the keyword bail-out', () => {
  const st = traced(row('Probe Static', 'Wugs you control have frobnication.'));
  assert.deepEqual(st.map(r => [r.stage, r.fragment, r.sentence, r.depth, r.nested]), [['static', 'Wugs you control have frobnication.', null, 0, 0]]);
  const kw = traced(row('Probe Kw', 'Bestow {3}{W}'));
  assert.deepEqual(kw.map(r => [r.stage, r.fragment]), [['keyword', 'Bestow {3}{W}']]);
});

test('back face: records say face "back" and the front context is restored', () => {
  const dfc = row('Probe Front', 'Flying', {
    layout: 'transform',
    faces: [
      { name: 'Probe Front', type_line: 'Creature — Zombie', oracle_text: 'Flying', power: '2', toughness: '2', mana_cost: '{1}{B}' },
      { name: 'Probe Back', type_line: 'Creature — Zombie Horror', oracle_text: 'Whenever a Goblin frobnicates, draw a card.', power: '4', toughness: '4', mana_cost: null },
    ],
  });
  const recs = traced(dfc);
  assert.deepEqual(recs.map(r => [r.face, r.stage, r.oracleId]), [['back', 'trigger-head', 'probe-probe-front']]);
  const next = traced(row('Probe Next', 'Wugs you control have frobnication.'));
  assert.deepEqual(next.map(r => r.face), ['front']);
});

test('identity: JSON.stringify(parseCard(row)) is the same with tracing on and off (synthetic rows and every 50th pool row)', () => {
  const rows: OracleRow[] = [
    spell('Id Then', 'Draw a card, then frobnicate the wug and exile target creature.'),
    spell('Id If', 'If you frobnicated this turn, draw a card. Destroy target creature. Its controller frobnicates.'),
    row('Id Head', 'Whenever a Goblin frobnicates, draw a card.\n{T}, Frobnicate a wug: Draw a card.\nWugs you control have frobnication.\nBestow {3}{W}'),
    row('Id Only', 'Whenever ~ attacks, if you frobnicated this turn, draw a card.\n{T}: Draw a card. Activate only if you frobnicated this turn.'),
  ];
  let n = 0;
  const check = (r: OracleRow) => {
    endParseTrace();
    const off = JSON.stringify(parseCard(r));
    beginParseTrace();
    const on = JSON.stringify(parseCard(r));
    endParseTrace();
    assert.equal(on, off, `tracing changed the parse of ${r.name}`);
    n++;
  };
  for (const r of rows) check(r);
  if (hasDb) {
    let i = 0;
    for (const p of poolRows()) { if (i++ % 50 === 0) check(p.raw as unknown as OracleRow); }
    assert.ok(n > 600, `${n} rows compared`);
  }
});
