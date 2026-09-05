// Per-card scripts: line-claim accounting (replace/extend), stale detection by oracle hash, source precedence, the
// sharded store, back faces, the ignore whitelist, scriptHash stability and the CardDB hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CardDB } from '../src/cards/db.js';
import {
  abilityClaimProblem, applyScript, COVER_KINDS, COVER_LINE_RE, coverProblem, faceClaimProblems, IGNORE_REASONS,
  ignoreLineProblem, insubstantiveReasons, keywordLineClaimed, keywordPartProblem, MARKER_OPS, normalizeOracleLines,
  oracleHash, scriptableLines, scriptHash, secondFaceLines, secondFaceUnclaimed, shardOf, ScriptStore,
  substantiveCount, unmatchedAbilityTexts, useScriptStore, zeroMagnitudeReason,
  type CardScript, type CoverKind, type ScriptFace, type ScriptSource, type Verification,
} from '../src/cards/scripts.js';
import { CardScriptChecked } from '../src/cards/schema.js';
import { LIST_LIMIT, NESTING_LIMIT } from '../src/engine/legal.js';
import type { CardDef, Effect, Keyword, ManaCost } from '../src/cards/types.js';
import { db } from './helpers.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'scripts-'));

/** A minimal well-formed script for a card, plus whatever the test declares. */
const scriptFor = (name: string, rest: Partial<CardScript> = {}): CardScript => {
  const d = db.get(name)!;
  return { oracleId: d.oracleId, name: d.name, oracleHash: oracleHash(d.oracleText), source: 'hand', ...rest };
};

const ELVES = '{T}: Add {G}.';
const manaAbility = (text: string): CardScript['abilities'] => [
  { kind: 'activated', cost: { tap: true }, effects: [{ op: 'add-mana', mana: ['G'] }], text, manaAbility: true },
];

test('applyScript: a line is claimed by an ability whose text is that line — in replace mode only the script claims', () => {
  const elves = db.get('Llanowar Elves')!;
  assert.deepEqual(normalizeOracleLines(elves), [ELVES]);

  const claimed = applyScript(elves, scriptFor('Llanowar Elves', { keywords: ['flying'], abilities: manaAbility(ELVES) }));
  assert.deepEqual(claimed.keywords, ['flying']);
  assert.equal(claimed.abilities.length, 1);
  assert.deepEqual(claimed.unparsed, []);
  assert.equal(claimed.fullyParsed, true);
  assert.deepEqual(claimed.script, { applied: true, stale: false, source: 'hand', confidence: undefined });
  assert.equal(elves.abilities[0].text, ELVES, 'the input def is untouched');

  // the same ability with a text that is not the oracle line claims nothing: replace threw the parser's claim away
  const unclaimed = applyScript(elves, scriptFor('Llanowar Elves', { abilities: manaAbility('scripted') }));
  assert.deepEqual(unclaimed.unparsed, [ELVES]);
  assert.equal(unclaimed.fullyParsed, false, "mode 'replace' does not clear unparsed — it re-derives it from the claims");

  // extend keeps the parser's abilities, so the parser's own claim still stands
  const ext = applyScript(elves, scriptFor('Llanowar Elves', { mode: 'extend', keywords: ['haste'], abilities: manaAbility('scripted') }));
  assert.ok(ext.keywords.includes('haste'));
  assert.equal(ext.abilities.length, elves.abilities.length + 1);
  assert.deepEqual(ext.unparsed, []);
  assert.equal(ext.fullyParsed, true);

  const stale = applyScript(elves, scriptFor('Llanowar Elves', { oracleHash: 'deadbeef', abilities: manaAbility(ELVES) }));
  assert.deepEqual(stale.script, { applied: false, stale: true, source: 'hand', confidence: undefined });
});

test('applyScript: a spell ability claims every line of its text, and an unknown fails the face anyway', () => {
  const shock = db.get('Shock')!;
  const line = normalizeOracleLines(shock)[0];
  assert.equal(line, '~ deals 2 damage to any target.');
  // parse.ts gives a spell one ability whose text is the RAW face text ("Shock deals 2 damage…"): normalising it
  // against the card name is what makes it match the oracle line.
  assert.equal(shock.abilities[0].text, 'Shock deals 2 damage to any target.');
  const ok = applyScript(shock, scriptFor('Shock', { mode: 'extend' }));
  assert.deepEqual(ok.unparsed, []);
  assert.equal(ok.fullyParsed, true);

  // …an `unknown` anywhere in the ability makes it insubstantial: it claims nothing AND fails the face
  const unknown = applyScript(shock, scriptFor('Shock', {
    abilities: [{ kind: 'spell', effects: [{ op: 'unknown', text: line }], text: line }],
  }));
  assert.deepEqual(unknown.unparsed, [line], 'an ability whose effect is unknown claims no line');
  assert.equal(unknown.fullyParsed, false, 'a replace-mode script with an unknown op is never fully simulated');

  // nested just as deep: unknown inside conditional -> optional-then -> choose-mode
  const nested = applyScript(shock, scriptFor('Shock', {
    abilities: [{
      kind: 'spell', text: line,
      effects: [{ op: 'conditional', condition: { kind: 'your-turn' }, then: [{ op: 'optional-then', first: [{ op: 'choose-mode', count: 1, modes: [[{ op: 'unknown', text: 'deep' }]] }], then: [] }] }],
    }],
  }));
  assert.deepEqual(nested.unparsed, [line], 'the unknown walk descends through conditional / optional-then / choose-mode');
  assert.equal(nested.fullyParsed, false);
});

test('applyScript: an ability that declares no effect claims nothing, and the script schema rejects it', () => {
  const elves = db.get('Llanowar Elves')!;
  // THE BLOCKER: a script of empty abilities would otherwise carry the right oracle texts and no behaviour at all
  const empty = scriptFor('Llanowar Elves', { abilities: [{ kind: 'activated', cost: { tap: true }, effects: [], text: ELVES }] });
  const applied = applyScript(elves, empty);
  assert.deepEqual(applied.unparsed, [ELVES], 'an empty-effect ability claims no line');
  assert.equal(applied.fullyParsed, false);

  const res = CardScriptChecked.safeParse(empty);
  assert.ok(!res.success, 'and the script schema rejects the file outright');
  assert.ok(res.error!.issues.some(i => i.message === 'ability declares no effect'), JSON.stringify(res.error!.issues.map(i => i.message)));

  // every ability kind with an `effects` array is covered
  for (const ability of [
    { kind: 'spell', effects: [], text: ELVES },
    { kind: 'triggered', event: { on: 'etb', self: true }, effects: [], text: ELVES },
  ] as NonNullable<CardScript['abilities']>) {
    const s = scriptFor('Llanowar Elves', { abilities: [ability] });
    assert.deepEqual(applyScript(elves, s).unparsed, [ELVES], `${ability.kind}: an empty-effect ability claims nothing`);
    assert.ok(!CardScriptChecked.safeParse(s).success, `${ability.kind}: rejected by the script schema`);
  }

  // the PARSER's own schema stays lenient: 56 of its abilities over the 34,513-card pool have no effect
  assert.equal(applyScript(elves, scriptFor('Llanowar Elves', { abilities: manaAbility(ELVES) })).fullyParsed, true);
});

test('the script schema rejects composition containers nested past NESTING_LIMIT and container lists past LIST_LIMIT', () => {
  const dmg: Effect = { op: 'damage', amount: 1, target: { kind: 'creature' } };
  const nest = (depth: number, inner: Effect[]): Effect[] => depth === 0 ? inner : [{ op: 'scoped', who: 'you', do: nest(depth - 1, inner) }];
  const script = (effects: Effect[]) => scriptFor('Lightning Bolt', { mode: 'replace', abilities: [{ kind: 'spell', effects, text: 'x' }] });
  assert.ok(CardScriptChecked.safeParse(script(nest(NESTING_LIMIT, [dmg]))).success, `${NESTING_LIMIT} levels are allowed`);
  const deep = CardScriptChecked.safeParse(script(nest(NESTING_LIMIT + 1, [dmg])));
  assert.ok(!deep.success && deep.error!.issues.some(i => /nest at most 6 deep/.test(i.message)), 'one more level is rejected');
  assert.equal(deep.error!.issues[0].path.filter(p => p === 'do').length, NESTING_LIMIT + 1, 'the issue names the offending list');
  const list = (n: number): Effect[] => Array.from({ length: n }, () => dmg);
  assert.ok(CardScriptChecked.safeParse(script([{ op: 'scoped', who: 'you', do: list(LIST_LIMIT) }])).success, `${LIST_LIMIT} effects in a container list are allowed`);
  const wide = CardScriptChecked.safeParse(script([{ op: 'may', effects: list(LIST_LIMIT + 1) }]));
  assert.ok(!wide.success && wide.error!.issues.some(i => /a may list holds at most 63 effects/.test(i.message)), 'the 64th is rejected');
  assert.ok(CardScriptChecked.safeParse(script(list(LIST_LIMIT + 1))).success, 'a top-level list is not keyed by position: no limit');
  // the older containers share their targets with their children and do not spend a level
  assert.ok(CardScriptChecked.safeParse(script([{ op: 'conditional', condition: { kind: 'metalcraft' }, then: nest(NESTING_LIMIT, [dmg]) }])).success);
  assert.ok(!CardScriptChecked.safeParse(script([{ op: 'conditional', condition: { kind: 'metalcraft' }, then: nest(NESTING_LIMIT + 1, [dmg]) }])).success, 'but what is inside them is counted');
  // their children share ONE target list (they run under the container's index): a second targeting child would overwrite the first's picks
  const shared = CardScriptChecked.safeParse(script([{ op: 'conditional', condition: { kind: 'kicked' }, then: [dmg], else: [{ op: 'destroy', target: { kind: 'artifact' } }] }]));
  assert.ok(!shared.success && shared.error!.issues.some(i => /share one target list and 2 of them target/.test(i.message)), 'two targeting children of an older container are rejected');
  assert.ok(CardScriptChecked.safeParse(script([{ op: 'conditional', condition: { kind: 'kicked' }, then: [dmg], else: [{ op: 'may', effects: [dmg] }] }])).success, 'a composition container keys its children apart');
  assert.ok(CardScriptChecked.safeParse(script([{ op: 'optional-pay', mana: { generic: 1, x: 0, pips: [], hybrid: [], phyrexian: [], raw: '{1}' }, then: [{ op: 'damage', amount: 1, target: { kind: 'multi', specs: [{ kind: 'creature' }, { kind: 'player' }] } }] }])).success, 'one child with several requirements is one list');
});

/** Copy the named declarations off the parser's own def, so a test face declares exactly what the card really has. */
const faceFrom = (def: CardDef, keys: (keyof ScriptFace)[]): ScriptFace => {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = (def as unknown as Record<string, unknown>)[k];
  return out as ScriptFace;
};

/** A ManaCost that only has to compare equal by `raw` — the only field the cover table reads. */
const mana = (raw: string): ManaCost => ({ generic: 0, x: 0, pips: [], hybrid: [], phyrexian: [], raw });

/**
 * One real card per cover kind: the oracle line, the kind that covers it, the declarations that back it, and a
 * MUTATION of those declarations that keeps the same kind but states a different value — a different mana cost,
 * number, counter or quality. `wrong` must be rejected: rule (iii) matches the declared value to the printed line,
 * not only the line's shape.
 */
const COVER_CASES: [card: string, line: string, by: CoverKind, decls: (keyof ScriptFace)[], wrong: Partial<ScriptFace>][] = [
  ['Serra Angel', 'Flying', 'keywords', ['keywords'], { keywords: ['vigilance'] }],
  ['Faithless Looting', 'Flashback {2}{R}', 'altCosts', ['altCosts'], { altCosts: [{ id: 'flashback', label: 'flashback {3}{R}', cost: { mana: mana('{3}{R}') }, from: 'graveyard', exileAfter: true }] }],
  ['Steam Vents', "As ~ enters, you may pay 2 life. If you don't, it enters tapped.", 'asEnters', ['asEnters'], { asEnters: [{ kind: 'pay-life-or-tapped', life: 3 }] }],
  ['Treasure Cruise', 'Delve', 'costModifiers', ['costModifiers'], { costModifiers: [{ kind: 'convoke' }] }],
  ['Rite of Replication', 'Kicker {5}', 'kicker', ['kicker'], { kicker: mana('{4}') }],
  ['Eternal Dragon', 'Plainscycling {2}', 'cycling', ['cycling', 'cyclingSearch'], { cycling: mana('{3}') }],
  ['Thornwood Falls', '~ enters tapped.', 'entersTapped', ['entersTapped'], { entersTapped: { unless: { kind: 'your-turn' } } }],
  ['Rattleclaw Mystic', 'Morph {2}', 'morph', ['morph'], { morph: { cost: mana('{3}') } }],
  ['Bloodbraid Elf', 'Cascade', 'cascade', ['cascade'], { cascade: false }],
  ['Grapeshot', 'Storm', 'storm', ['storm'], { storm: false }],
  ['Distortion Strike', 'Rebound', 'rebound', ['rebound'], { rebound: false }],
  ['Stinkweed Imp', 'Dredge 5', 'dredge', ['dredge'], { dredge: 4 }],
  ['Progenitus', "If ~ would be put into a graveyard from anywhere, reveal ~ and shuffle it into its owner's library instead.", 'graveyardReplacement', ['graveyardReplacement'], { graveyardReplacement: 'exile' }],
  ['Progenitus', 'Protection from everything', 'protection', ['protectionFrom'], { protectionFrom: ['red'] }],
  ['Dreadlight Monstrosity', 'Ward {2}', 'ward', ['wardCost'], { wardCost: 3 }],
  ['Bone Splinters', 'As an additional cost to cast ~, sacrifice a creature.', 'additionalCosts', ['additionalCosts'], { additionalCosts: [{ discard: 1 }] }],
  ['Pestilent Syphoner', 'Toxic 1', 'toxic', ['toxic'], { toxic: 2 }],
  ['Devoted Retainer', 'Bushido 1', 'bushido', ['bushido'], { bushido: 2 }],
  ['Craw Giant', 'Rampage 2', 'rampage', ['rampage'], { rampage: 3 }],
  ['Street Wraith', 'Swampwalk', 'landwalk', ['landwalk'], { landwalk: ['Island'] }],
  ['Fire Sages', 'Firebending 1', 'firebending', ['firebending'], { firebending: 2 }],
];

test('covers: every cover kind is backed by a real declaration on a real card, and claims that line', () => {
  assert.deepEqual([...new Set(COVER_CASES.map(c => c[2]))].sort(), [...COVER_KINDS].sort(), 'every cover kind needs a case');

  for (const [card, line, by, decls] of COVER_CASES) {
    const def = db.get(card)!;
    assert.ok(normalizeOracleLines(def).includes(line), `${card}: ${JSON.stringify(line)} is not an oracle line of the card`);
    const face = faceFrom(def, decls);
    assert.equal(coverProblem(face, { line, by }), null, `${card} / ${by}`);

    // the same line covered by any OTHER kind is rejected — either the declaration is missing or the shape is wrong
    for (const other of COVER_KINDS) {
      if (other === by) continue;
      assert.ok(coverProblem(face, { line, by: other }), `${card}: ${JSON.stringify(line)} must not be coverable by '${other}'`);
    }
    // and the declaration alone is not enough: drop it and the entry is rejected
    assert.ok(coverProblem({}, { line, by }), `${card} / ${by}: an undeclared ${by} must not cover anything`);
  }
});

test('covers: rule (iii) matches the declared VALUE to the line, not only its shape', () => {
  // THE ROUND-3 MAJOR: the cover table used to check the line's shape and never look at what was declared, so
  // `cycling: {3}` covered "Plainscycling {2}" and `dredge: 4` covered "Dredge 5".
  for (const [card, line, by, decls, wrong] of COVER_CASES) {
    const def = db.get(card)!;
    const face = { ...faceFrom(def, decls), ...wrong } as ScriptFace;
    const why = coverProblem(face, { line, by });
    assert.ok(why, `${card} / ${by}: ${JSON.stringify(wrong)} must not cover ${JSON.stringify(line)}`);
    assert.match(why!, new RegExp(`^names by '${by}' but `), `${card} / ${by}: ${why}`);
  }

  // a few more value mismatches the table has to catch, spelled out
  const eternal = faceFrom(db.get('Eternal Dragon')!, ['cycling', 'cyclingSearch']);
  assert.match(coverProblem({ ...eternal, cyclingSearch: undefined }, { line: 'Plainscycling {2}', by: 'cycling' })!, /typecycling/);
  const rattle = faceFrom(db.get('Rattleclaw Mystic')!, ['morph']);
  assert.match(coverProblem({ morph: { ...rattle.morph!, megamorph: true } }, { line: 'Morph {2}', by: 'morph' })!, /megamorph/);
  const steam = faceFrom(db.get('Steam Vents')!, ['asEnters']);
  assert.match(coverProblem({ ...steam, asEnters: [{ kind: 'tapped' }] }, { line: "As ~ enters, you may pay 2 life. If you don't, it enters tapped.", by: 'asEnters' })!, /pay-life-or-tapped/);
  assert.match(coverProblem({ asEnters: [{ kind: 'counters', counter: 'charge', amount: 3 }] }, { line: '~ enters with three +1/+1 counters on it.', by: 'asEnters' })!, /counter "\+1\/\+1"/);
  assert.equal(coverProblem({ asEnters: [{ kind: 'counters', counter: '+1/+1', amount: 3 }] }, { line: '~ enters with three +1/+1 counters on it.', by: 'asEnters' }), null);
  const bone = faceFrom(db.get('Bone Splinters')!, ['additionalCosts']);
  assert.equal(coverProblem(bone, { line: 'As an additional cost to cast ~, sacrifice a creature.', by: 'additionalCosts' }), null);
  assert.match(coverProblem(bone, { line: 'As an additional cost to cast ~, discard a card.', by: 'additionalCosts' })!, /discard/);

  // the schema carries `coverProblem`'s own reason, one issue per bad entry: it fires before every other check, so a
  // generic "a covers entry is invalid" would be the only thing the author ever saw
  const wrongCycling = scriptFor('Eternal Dragon', {
    ...faceFrom(db.get('Eternal Dragon')!, ['cyclingSearch']),
    cycling: mana('{3}'),
    covers: [{ line: 'Plainscycling {2}', by: 'cycling' }],
  });
  const res = CardScriptChecked.safeParse(wrongCycling);
  assert.ok(!res.success);
  assert.match(res.error!.issues.map(i => i.message).join('\n'), /names by 'cycling' but the line prints cycling \{2\} but this face declares "\{3\}"/);
});

test('covers: every line shape in the table is anchored at both ends', () => {
  // an unanchored shape ("cycling " was one) lets a covers entry claim any line that merely CONTAINS the keyword
  for (const kind of COVER_KINDS) {
    const shapes = COVER_LINE_RE[kind];
    assert.ok(shapes.length, `${kind}: no line shape at all`);
    for (const re of shapes) {
      assert.ok(re.source.startsWith('^'), `${kind}: /${re.source}/ is not anchored at the start`);
      assert.ok(re.source.endsWith('$'), `${kind}: /${re.source}/ is not anchored at the end`);
    }
  }
  // the concrete regression: "cycling " used to match anywhere in the line
  const eternal = faceFrom(db.get('Eternal Dragon')!, ['cycling', 'cyclingSearch']);
  assert.ok(coverProblem(eternal, { line: 'When ~ enters, you may pay {2} to start cycling {2} early.', by: 'cycling' }));
});

const DRAW: Effect = { op: 'draw', amount: 1, who: 'you' };
const UNTAP: Effect = { op: 'untap', target: { kind: 'creature' } };

test('substantiveCount: parser-internal fold markers are not behaviour, and a container counts what it holds', () => {
  // THE ROUND-3 BLOCKER: these ops are folded into the effect before them and never reach the engine, so an
  // ability made of them alone does nothing at all — yet it used to pass as "declares at least one effect".
  assert.deepEqual([...MARKER_OPS].sort(), [
    'alt-if-target', 'alt-kicked-amount', 'alt-take', 'fold-alt-mana', 'fold-counter-if-yours', 'fold-new-targets',
    'fold-restriction', 'unknown',
  ]);
  for (const op of MARKER_OPS) assert.equal(substantiveCount([{ op } as unknown as Effect]), 0, op);
  assert.equal(substantiveCount([DRAW]), 1);
  assert.equal(substantiveCount([DRAW, { op: 'fold-new-targets' }, UNTAP]), 2, 'markers are skipped, not counted');
  assert.equal(substantiveCount([]), 0);
  assert.equal(substantiveCount(undefined), 0);

  // an activated mana ability is substantive on its `add-mana` alone
  assert.equal(substantiveCount([{ op: 'add-mana', mana: ['G'] }]), 1);

  // containers count 1 only when something inside them does something — walked generically, at any depth
  const cond = (then: Effect[]): Effect => ({ op: 'conditional', condition: { kind: 'your-turn' }, then });
  assert.equal(substantiveCount([cond([])]), 0);
  assert.equal(substantiveCount([cond([{ op: 'fold-new-targets' }])]), 0);
  assert.equal(substantiveCount([cond([DRAW])]), 1);
  assert.equal(substantiveCount([cond([cond([cond([DRAW])])])]), 1, 'and the whole nest still counts once');
  assert.equal(substantiveCount([{ op: 'optional-then', first: [{ op: 'unknown', text: 'x' }], then: [] }]), 0);
  assert.equal(substantiveCount([{ op: 'delayed-trigger', at: 'next-end-step', effects: [DRAW] }]), 1);

  // choose-mode counts once per SUBSTANTIVE mode: a two-mode spell printed as two lines needs both
  assert.equal(substantiveCount([{ op: 'choose-mode', count: 1, modes: [[DRAW], [UNTAP]] }]), 2);
  assert.equal(substantiveCount([{ op: 'choose-mode', count: 1, modes: [[DRAW], [{ op: 'fold-new-targets' }]] }]), 1);
  assert.equal(substantiveCount([{ op: 'choose-mode', count: 1, modes: [] }]), 0);

  // gain-ability follows the ability it grants
  assert.equal(substantiveCount([{ op: 'gain-ability', ability: { kind: 'spell', effects: [DRAW], text: 'x' } }]), 1);
  assert.equal(substantiveCount([{ op: 'gain-ability', ability: { kind: 'spell', effects: [], text: 'x' } }]), 0);
  assert.equal(substantiveCount([{ op: 'gain-ability', ability: { kind: 'static', effect: { kind: 'self-keywords', keywords: ['flying'] }, text: 'x' } }]), 1);
});

test('applyScript: an ability of nothing but fold markers claims no line', () => {
  const elves = db.get('Llanowar Elves')!;
  const markerOnly = scriptFor('Llanowar Elves', {
    abilities: [{ kind: 'activated', cost: { tap: true }, effects: [{ op: 'fold-new-targets' }], text: ELVES }],
  });
  assert.deepEqual(applyScript(elves, markerOnly).unparsed, [ELVES]);
  assert.equal(applyScript(elves, markerOnly).fullyParsed, false);
  assert.match(faceClaimProblems(markerOnly, 'Llanowar Elves')[0], /every effect it declares is a parser-internal fold marker/);
  // the file-level schema cannot see it (the array is not empty), so scripts:check is the one that reports it
  assert.ok(CardScriptChecked.safeParse(markerOnly).success);

  // the same ability with a real effect claims its line again
  const real = scriptFor('Llanowar Elves', {
    abilities: [{ kind: 'activated', cost: { tap: true }, effects: [{ op: 'add-mana', mana: ['G'] }, { op: 'fold-new-targets' }], text: ELVES, manaAbility: true }],
  });
  assert.deepEqual(applyScript(elves, real).unparsed, []);
  assert.deepEqual(faceClaimProblems(real, 'Llanowar Elves'), []);
});

/** One `Ability` of the shape a script declares — typed, so the test never casts an object literal. */
type ScriptAbility = NonNullable<CardScript['abilities']>[number];

/**
 * One effect per op that carries a magnitude, written with that magnitude set to a literal 0. Every one of these is
 * a legal `Effect` that changes nothing at all when it resolves.
 */
const ZERO_EFFECTS: [label: string, effect: Effect, reason: string][] = [
  ['draw', { op: 'draw', amount: 0, who: 'you' }, 'draw 0'],
  ['scry', { op: 'scry', amount: 0 }, 'scry 0'],
  ['damage', { op: 'damage', amount: 0, target: { kind: 'any' } }, 'damage 0'],
  ['gain-life', { op: 'gain-life', amount: 0, who: 'you' }, 'gain-life 0'],
  ['pump', { op: 'pump', target: 'self', power: 0, toughness: 0, duration: 'eot' }, 'pump 0/0 and grants no keyword'],
  ['token', { op: 'token', count: 0, power: 2, toughness: 2, colors: ['G'], types: ['Creature'], subtypes: ['Wolf'], keywords: [] }, 'token count 0'],
  ['mill', { op: 'mill', amount: 0, who: 'target-player' }, 'mill 0'],
  ['counters', { op: 'counters', target: 'self', counter: '+1/+1', amount: 0 }, 'counters 0'],
  ['lose-life', { op: 'lose-life', amount: 0, who: 'each-opponent' }, 'lose-life 0'],
  ['discard', { op: 'discard', amount: 0, who: 'target-player' }, 'discard 0'],
  ['energy', { op: 'energy', amount: 0 }, 'energy 0'],
  ['poison', { op: 'poison', amount: 0, who: 'each-opponent' }, 'poison 0'],
  ['prevent-damage', { op: 'prevent-damage', target: 'self', amount: 0, duration: 'eot' }, 'prevent-damage 0'],
  ['search', { op: 'search', filter: { types: ['Creature'] }, to: 'hand', count: 0 }, 'search count 0'],
  ['dig', { op: 'dig', look: 0, take: 0, rest: 'bottom', order: 'any' }, 'dig look 0'],
  ['loot', { op: 'loot', draw: 0, discard: 0 }, 'loot draw 0, discard 0'],
  ['grant-keyword', { op: 'grant-keyword', target: 'self', keywords: [], duration: 'eot' }, 'grant-keyword grants no keyword'],
];

test('substantiveCount: an effect with a zero MAGNITUDE is not behaviour', () => {
  // THE ROUND-5 BLOCKER: substantiveCount judged an effect by its op alone, so `{ op: 'draw', amount: 0 }` counted
  // as behaviour and one zero-magnitude effect per line satisfied the whole budget.
  for (const [label, effect, reason] of ZERO_EFFECTS) {
    assert.equal(zeroMagnitudeReason(effect), reason, label);
    assert.equal(substantiveCount([effect]), 0, `${label}: a zero magnitude does nothing`);
    assert.deepEqual(insubstantiveReasons([effect]), [`effect has zero magnitude: ${reason}`], label);
  }

  // a numeric STRING zero is the same zero
  assert.equal(substantiveCount([{ op: 'draw', amount: '0' as unknown as number, who: 'you' }]), 0);

  // …and every magnitude the game resolves later is real behaviour: 'X', a count expression, a plain number
  const amounts: Extract<Effect, { op: 'draw' }>['amount'][] = ['X', { count: 'creatures-you-control' }, 1];
  for (const amount of amounts) {
    assert.equal(zeroMagnitudeReason({ op: 'draw', amount, who: 'you' }), null, JSON.stringify(amount));
    assert.equal(substantiveCount([{ op: 'draw', amount, who: 'you' }]), 1, JSON.stringify(amount));
  }
  assert.equal(substantiveCount([{ op: 'damage', amount: 'X', target: { kind: 'any' } }]), 1);
  assert.equal(substantiveCount([{ op: 'token', count: { count: 'creatures-you-control' }, power: 1, toughness: 1, colors: [], types: ['Creature'], subtypes: ['Rat'], keywords: [] }]), 1);

  // the numbers that are NOT gates, because a zero there still does something
  assert.equal(substantiveCount([{ op: 'pump', target: 'self', power: 0, toughness: 0, keywords: ['flying'], duration: 'eot' }]), 1,
    'a +0/+0 pump that grants a keyword is alive on the keyword alone');
  assert.equal(substantiveCount([{ op: 'dig', look: 3, take: 0, rest: 'top', order: 'any' }]), 1,
    'a dig that takes nothing still looks at the top of the library and reorders it (parse.ts:520)');
  assert.equal(substantiveCount([{ op: 'loot', draw: 1, discard: 0 }]), 1);
  assert.equal(substantiveCount([{ op: 'set-life', amount: 0, who: 'each-player' }]), 1, 'set-life 0 is lethal, not empty');
  assert.equal(substantiveCount([{ op: 'destroy', target: { kind: 'creature' } }]), 1, 'an op with no magnitude is substantive by nature');
  assert.equal(substantiveCount([{ op: 'token', count: 1, power: 0, toughness: 0, colors: [], types: ['Creature'], subtypes: ['Ballista'], keywords: [] }]), 1,
    'a 0/0 token still enters the battlefield');

  // a container is dead when everything inside it is, however deep
  assert.equal(substantiveCount([{ op: 'conditional', condition: { kind: 'your-turn' }, then: [{ op: 'draw', amount: 0, who: 'you' }] }]), 0);
  assert.equal(substantiveCount([{ op: 'choose-mode', count: 1, modes: [[{ op: 'draw', amount: 0, who: 'you' }], [DRAW]] }]), 1);

  // a static ability's own magnitude counts the same way
  const anthem = (rest: { power?: number; keywords?: Keyword[] }): ScriptAbility => ({
    kind: 'static', text: 'x',
    effect: { kind: 'anthem', power: rest.power ?? 0, toughness: 0, filter: {}, scope: 'you-control', keywords: rest.keywords },
  });
  assert.match(abilityClaimProblem(anthem({}), 'x')!, /static effect has zero magnitude: anthem \+0\/\+0 and grants nothing/);
  assert.equal(abilityClaimProblem(anthem({ keywords: ['flying'] }), 'x'), null);
  assert.equal(abilityClaimProblem(anthem({ power: 1 }), 'x'), null);
  const noKeywords: ScriptAbility = { kind: 'static', effect: { kind: 'self-keywords', keywords: [] }, text: 'x' };
  assert.match(abilityClaimProblem(noKeywords, 'x')!, /self-keywords grants no keyword/);
});

test('applyScript: a zero-magnitude effect claims no line — one "draw 0" per line finishes nothing', () => {
  const refocus = db.get('Refocus')!;
  const lines = normalizeOracleLines(refocus);
  assert.deepEqual(lines, ['Untap target creature.', 'Draw a card.']);

  // the recipe the review found: one zero-magnitude effect per line, one line per ability, budget satisfied
  const dead = (text: string): ScriptAbility => ({ kind: 'spell', effects: [{ op: 'draw', amount: 0, who: 'you' }], text });
  const script = scriptFor('Refocus', { abilities: lines.map(dead) });
  const applied = applyScript(refocus, script);
  assert.deepEqual(applied.unparsed, lines, 'neither line is claimed');
  assert.equal(applied.fullyParsed, false);
  const problems = faceClaimProblems(script, 'Refocus');
  assert.equal(problems.length, 2);
  for (const why of problems) assert.match(why, /ability has no substantive effect: effect has zero magnitude: draw 0/);
  assert.ok(CardScriptChecked.safeParse(script).success, 'the file-level schema cannot see it — the effects array is not empty');

  // one real effect per line finishes the card
  const alive = scriptFor('Refocus', { abilities: [{ kind: 'spell', effects: [UNTAP], text: lines[0] }, { kind: 'spell', effects: [DRAW], text: lines[1] }] });
  assert.deepEqual(applyScript(refocus, alive).unparsed, []);
  assert.equal(applyScript(refocus, alive).fullyParsed, true);

  // …and a zero magnitude does not top up a BUDGET either: two lines, one real effect and one dead one
  const padded = scriptFor('Refocus', { abilities: [{ kind: 'spell', effects: [UNTAP, { op: 'draw', amount: 0, who: 'you' }], text: lines.join('\n') }] });
  assert.match(abilityClaimProblem(padded.abilities![0], 'Refocus')!, /^ability names 2 lines but declares only 1 substantive effect$/);
  assert.deepEqual(applyScript(refocus, padded).unparsed, lines);
});

test('applyScript: an ability may claim at most one line per substantive effect', () => {
  // THE ROUND-3 BLOCKER: an instant/sorcery's single `spell` ability carries the WHOLE face text (parse.ts:1358),
  // so without a budget one `draw` would finish every line of a card.
  const refocus = db.get('Refocus')!;
  const lines = normalizeOracleLines(refocus);
  assert.deepEqual(lines, ['Untap target creature.', 'Draw a card.']);
  const text = lines.join('\n');
  const spell = (effects: Effect[], t = text): CardScript['abilities'] => [{ kind: 'spell', effects, text: t }];

  const thin = scriptFor('Refocus', { abilities: spell([UNTAP]) });
  assert.match(abilityClaimProblem(thin.abilities![0], 'Refocus')!, /^ability names 2 lines but declares only 1 substantive effect$/);
  assert.deepEqual(applyScript(refocus, thin).unparsed, lines, 'one effect claims neither line');
  assert.equal(applyScript(refocus, thin).fullyParsed, false);

  // a fold marker does not top the budget up either
  const padded = scriptFor('Refocus', { abilities: spell([UNTAP, { op: 'fold-new-targets' }]) });
  assert.deepEqual(applyScript(refocus, padded).unparsed, lines);

  // two substantive effects for two lines: accepted
  const full = scriptFor('Refocus', { abilities: spell([UNTAP, DRAW]) });
  assert.deepEqual(abilityClaimProblem(full.abilities![0], 'Refocus'), null);
  assert.deepEqual(applyScript(refocus, full).unparsed, []);
  assert.equal(applyScript(refocus, full).fullyParsed, true);
  assert.ok(CardScriptChecked.safeParse(full).success);

  // …and so is one ability per line, which is the form to prefer
  const perLine = scriptFor('Refocus', { abilities: [...spell([UNTAP], lines[0])!, ...spell([DRAW], lines[1])!] });
  assert.equal(applyScript(refocus, perLine).fullyParsed, true);
  assert.deepEqual(faceClaimProblems(perLine, 'Refocus'), []);

  // a static / triggered / activated ability is printed as ONE line and may name only one, however many effects it has
  const triggered = { kind: 'triggered', event: { on: 'etb', self: true }, effects: [UNTAP, DRAW], text } as NonNullable<CardScript['abilities']>[number];
  assert.match(abilityClaimProblem(triggered, 'Refocus')!, /a 'triggered' ability is printed as one line/);

  // …unless Scryfall split ONE sentence across two lines, which a lower-case continuation marks
  const joined = { kind: 'triggered', event: { on: 'etb', self: true }, effects: [DRAW], text: 'When ~ enters, draw a card,\nthen untap it.' } as NonNullable<CardScript['abilities']>[number];
  assert.equal(abilityClaimProblem(joined, 'Refocus'), null);
  const split = { ...joined, text: 'When ~ enters, draw a card.\nUntap it.' } as NonNullable<CardScript['abilities']>[number];
  assert.ok(abilityClaimProblem(split, 'Refocus'));
});

test('claims: no line may be claimed twice', () => {
  const refocus = db.get('Refocus')!;
  const line = 'Draw a card.';
  const twice = scriptFor('Refocus', {
    abilities: [
      { kind: 'spell', effects: [DRAW], text: line },
      { kind: 'spell', effects: [DRAW], text: line },
    ],
  });
  assert.deepEqual(faceClaimProblems(twice, 'Refocus'), [`line claimed twice: ${JSON.stringify(line)}`]);

  // an ability and a covers entry claiming the same line count as two claims as well
  const angel = db.get('Serra Angel')!;
  const both = scriptFor('Serra Angel', {
    keywords: ['flying', 'vigilance'],
    abilities: [{ kind: 'static', effect: { kind: 'self-keywords', keywords: ['flying'] }, text: 'Flying' }],
    covers: [{ line: 'Flying', by: 'keywords' }],
  });
  assert.deepEqual(faceClaimProblems(both, 'Serra Angel'), ['line claimed twice: "Flying"']);
  assert.equal(applyScript(angel, both).fullyParsed, true, 'the card is still finished — the duplicate is a scripts:check problem');
  assert.deepEqual(faceClaimProblems({ ...both, covers: undefined }, 'Serra Angel'), []);
});

test('covers: a throwaway declaration buys nothing, and the schema rejects an invalid entry', () => {
  const elves = db.get('Llanowar Elves')!;
  // THE OLD BLOCKER: covers with no declaration behind it must not finish a card
  const bare = scriptFor('Llanowar Elves', { covers: [{ line: ELVES, by: 'keywords' }] });
  const applied = applyScript(elves, bare);
  assert.deepEqual(applied.unparsed, [ELVES], 'an invalid covers entry claims nothing');
  assert.equal(applied.fullyParsed, false);
  assert.ok(!CardScriptChecked.safeParse(bare).success, 'and the schema rejects the file outright');

  // THE ROUND-2 BLOCKER: N throwaway keywords used to buy N arbitrary lines. Now each entry must match its kind.
  const throwaway = scriptFor('Llanowar Elves', { keywords: ['flying', 'haste', 'trample'], covers: [{ line: ELVES, by: 'keywords' }] });
  assert.ok(!CardScriptChecked.safeParse(throwaway).success, 'three keywords do not buy an unrelated line');
  assert.deepEqual(applyScript(elves, throwaway).unparsed, [ELVES]);

  // a keyword line IS claimed by the keywords it names — with or without a covers entry
  const angel = db.get('Serra Angel')!;
  const kw = scriptFor('Serra Angel', { keywords: ['flying', 'vigilance'], covers: [{ line: 'Flying', by: 'keywords' }, { line: 'Vigilance', by: 'keywords' }] });
  assert.ok(CardScriptChecked.safeParse(kw).success);
  assert.equal(applyScript(angel, kw).fullyParsed, true);

  // a declaration of the wrong kind for the line
  const looting = db.get('Faithless Looting')!;
  const wrongKind = scriptFor('Faithless Looting', {
    abilities: looting.abilities, altCosts: looting.altCosts,
    cycling: { generic: 2, x: 0, pips: [], hybrid: [], phyrexian: [], raw: '{2}' },
    covers: [{ line: 'Flashback {2}{R}', by: 'cycling' }],
  });
  assert.ok(!CardScriptChecked.safeParse(wrongKind).success, "a flashback line is not covered by 'cycling'");

  // the '*' wildcard is gone from the format, in covers and in ignore
  assert.ok(!CardScriptChecked.safeParse(scriptFor('Llanowar Elves', { mode: 'extend', covers: [{ line: '*', by: 'keywords' }] })).success);
  assert.ok(!CardScriptChecked.safeParse(scriptFor('Llanowar Elves', { mode: 'extend', backFace: { covers: [{ line: '*', by: 'keywords' }] } })).success);
  assert.ok(!CardScriptChecked.safeParse(scriptFor('Llanowar Elves', { ignore: [{ line: '*', reason: 'ante' }] })).success);
  // a plain-string covers entry is not the format: there is no legacy form to accept
  assert.ok(!CardScriptChecked.safeParse({ ...scriptFor('Llanowar Elves'), covers: [ELVES] }).success);
});

test('applyScript: a line made only of keywords the face has is claimed by them', () => {
  const angel = db.get('Serra Angel')!;
  assert.deepEqual(normalizeOracleLines(angel), ['Flying', 'Vigilance']);
  assert.equal(applyScript(angel, scriptFor('Serra Angel', { keywords: ['flying', 'vigilance'] })).fullyParsed, true);
  const half = applyScript(angel, scriptFor('Serra Angel', { keywords: ['flying'] }));
  assert.deepEqual(half.unparsed, ['Vigilance']);
  assert.equal(half.fullyParsed, false);

  // a PARAMETERISED keyword line needs the parameter as well as the keyword: "Toxic 1" is not implemented by a bare
  // `toxic`, because the engine poisons for the number, and "Ward {2}" is not implemented by a bare `ward`.
  const syphoner = db.get('Pestilent Syphoner')!;
  assert.deepEqual(normalizeOracleLines(syphoner), ['Flying', 'Toxic 1']);
  assert.equal(applyScript(syphoner, scriptFor('Pestilent Syphoner', { keywords: ['flying', 'toxic'], toxic: 1 })).fullyParsed, true);
  const bareToxic = applyScript(syphoner, scriptFor('Pestilent Syphoner', { keywords: ['flying', 'toxic'] }));
  assert.deepEqual(bareToxic.unparsed, ['Toxic 1'], 'the bare keyword does not implement the number');
  const wrongToxic = applyScript(syphoner, scriptFor('Pestilent Syphoner', { keywords: ['flying', 'toxic'], toxic: 2 }));
  assert.deepEqual(wrongToxic.unparsed, ['Toxic 1'], 'and the wrong number does not either');

  const ward = db.get('Dreadlight Monstrosity')!;
  assert.ok(normalizeOracleLines(ward).includes('Ward {2}'));
  assert.equal(keywordLineClaimed('Ward {2}', { keywords: ['ward'], wardCost: 2 }), true);
  assert.equal(keywordLineClaimed('Ward {2}', { keywords: ['ward'], wardCost: 3 }), false);
  assert.equal(keywordLineClaimed('Ward {2}', { keywords: ['ward'] }), false);
  assert.ok(!applyScript(ward, scriptFor('Dreadlight Monstrosity', { mode: 'extend', keywords: ['ward'], wardCost: 2 })).unparsed.includes('Ward {2}'));

  // …and so do the other parameterised keyword lines
  assert.equal(keywordLineClaimed('Protection from red', { keywords: ['protection'], protectionFrom: ['red'] }), true);
  assert.equal(keywordLineClaimed('Protection from red', { keywords: ['protection'], protectionFrom: ['blue'] }), false);
  assert.equal(keywordLineClaimed('Swampwalk', { keywords: ['landwalk'], landwalk: ['Swamp'] }), true);
  assert.equal(keywordLineClaimed('Swampwalk', { keywords: ['landwalk'], landwalk: ['Island'] }), false);
  assert.equal(keywordLineClaimed('Flying, first strike', { keywords: ['flying', 'first strike'] }), true);
  assert.equal(keywordLineClaimed('Flying, first strike', { keywords: ['flying'] }), false);
  assert.match(keywordPartProblem('Bushido 1', { keywords: ['bushido'], bushido: 2 })!, /needs bushido 1/);
});

test('keywords: a "Ward — <non-mana cost>" line is not claimable by a ward declaration at all', () => {
  // THE ROUND-5 MINOR: the non-mana branch returned null from both checks, so any `wardCost` claimed
  // "Ward—Pay 3 life." — a cost `wardCost: number` cannot express, and one the engine would never charge.
  const witch = db.get('Sedgemoor Witch')!;
  const ward = 'Ward—Pay 3 life.';
  assert.ok(normalizeOracleLines(witch).includes(ward));

  const declared: ScriptFace = { keywords: ['ward'], wardCost: 3 };
  assert.match(keywordPartProblem(ward, declared)!, /prints the non-mana ward cost "Pay 3 life".*script the line as a triggered ability instead/);
  assert.equal(keywordLineClaimed(ward, declared), false);
  assert.match(coverProblem(declared, { line: ward, by: 'ward' })!, /^names by 'ward' but the line prints the non-mana ward cost/);
  for (const wardCost of [0, 3, 99]) assert.ok(coverProblem({ wardCost }, { line: ward, by: 'ward' }), `wardCost ${wardCost} must not claim it either`);

  const kept = applyScript(witch, scriptFor('Sedgemoor Witch', { mode: 'extend', keywords: ['menace', 'ward'], wardCost: 3 }));
  assert.ok(kept.unparsed.includes(ward), 'the line stays unclaimed');

  // scripted as an ability of its own, it is claimed like any other line
  const scripted = applyScript(witch, scriptFor('Sedgemoor Witch', {
    mode: 'extend',
    abilities: [{ kind: 'triggered', event: { on: 'targeted', self: true }, effects: [{ op: 'counter', target: { kind: 'spell' }, unlessPay: 3 }], text: ward }],
  }));
  assert.ok(!scripted.unparsed.includes(ward), 'an ability whose text is the line claims it');

  // the mana form is untouched: "Ward {2}" still needs wardCost 2
  assert.equal(keywordLineClaimed('Ward {2}', { keywords: ['ward'], wardCost: 2 }), true);
  assert.equal(keywordLineClaimed('Ward {2}', { keywords: ['ward'], wardCost: 3 }), false);
  assert.equal(coverProblem({ wardCost: 2 }, { line: 'Ward {2}', by: 'ward' }), null);
});

test('covers: costModifiers compare the printed reduction, and affinity its subject', () => {
  // THE ROUND-5 MINOR: the rule asked only for a costModifier of kind 'reduce' and never looked at the amount.
  const frogmite = db.get('Frogmite')!;
  const line = 'Affinity for artifacts';
  assert.deepEqual(normalizeOracleLines(frogmite), [line]);
  assert.deepEqual(frogmite.costModifiers, [{ kind: 'reduce', amount: { count: 'permanents-you-control', filter: { types: ['Artifact'] } } }]);
  assert.equal(coverProblem({ costModifiers: frogmite.costModifiers }, { line, by: 'costModifiers' }), null);

  // a reduce that counts something else, a fixed number, or another kind entirely is not affinity for artifacts
  assert.match(coverProblem({ costModifiers: [{ kind: 'reduce', amount: { count: 'permanents-you-control', filter: { subtypes: ['Sliver'] } } }] }, { line, by: 'costModifiers' })!,
    /the line is affinity for "artifacts", so its reduce must count that subject/);
  assert.ok(coverProblem({ costModifiers: [{ kind: 'reduce', amount: 2 }] }, { line, by: 'costModifiers' }));
  assert.ok(coverProblem({ costModifiers: [{ kind: 'delve' }] }, { line, by: 'costModifiers' }));
  // …and the named type is matched singular or plural (parse.ts:1285 writes the subtype)
  assert.equal(coverProblem({ costModifiers: [{ kind: 'reduce', amount: { count: 'permanents-you-control', filter: { subtypes: ['Sliver'] } } }] }, { line: 'Affinity for Slivers', by: 'costModifiers' }), null);

  // "~ costs {N} less to cast …": a literal reduction must equal the printed symbols
  const flat = "~ costs {3} less to cast if you've gained 3 or more life this turn.";
  assert.equal(coverProblem({ costModifiers: [{ kind: 'reduce', amount: 3 }] }, { line: flat, by: 'costModifiers' }), null);
  assert.match(coverProblem({ costModifiers: [{ kind: 'reduce', amount: 2 }] }, { line: flat, by: 'costModifiers' })!, /the line prints a reduction of \{3\}/);
  // …and an EXPRESSION amount is only ever printed by a "for each …" line, scaled by the printed number
  assert.match(coverProblem({ costModifiers: [{ kind: 'reduce', amount: { count: 'cards-in-graveyard' } }] }, { line: flat, by: 'costModifiers' })!,
    /a count-expression amount is only printed by a 'for each …' line/);
  const reveler = db.get('Bedlam Reveler')!;
  const perEach = normalizeOracleLines(reveler).find(l => l.startsWith('~ costs'))!;
  assert.equal(perEach, '~ costs {1} less to cast for each instant and sorcery card in your graveyard.');
  assert.equal(coverProblem({ costModifiers: reveler.costModifiers }, { line: perEach, by: 'costModifiers' }), null);
  const domain = '~ costs {2} less to cast for each basic land type among lands you control.';
  assert.equal(coverProblem({ costModifiers: [{ kind: 'reduce', amount: { count: 'domain', times: 2 } }] }, { line: domain, by: 'costModifiers' }), null);
  assert.match(coverProblem({ costModifiers: [{ kind: 'reduce', amount: { count: 'domain', times: 3 } }] }, { line: domain, by: 'costModifiers' })!,
    /the line prints a reduction of \{2\} for each basic land type/);

  // delve / convoke / improvise stay exact-keyword
  assert.equal(coverProblem({ costModifiers: [{ kind: 'delve' }] }, { line: 'Delve', by: 'costModifiers' }), null);
  assert.match(coverProblem({ costModifiers: [{ kind: 'reduce', amount: 1 }] }, { line: 'Delve', by: 'costModifiers' })!, /needs a costModifier of kind 'delve'/);
});

test('applyScript: an ignored line counts as claimed and stops blocking fullyParsed', () => {
  const contract = db.get('Contract from Below')!;
  const [remove, discard] = normalizeOracleLines(contract);
  assert.match(remove, /playing for ante/);

  const both = applyScript(contract, scriptFor('Contract from Below', {
    ignore: [{ line: remove, reason: 'ante' }, { line: discard, reason: 'ante' }],
  }));
  assert.deepEqual(both.unparsed, []);
  assert.equal(both.fullyParsed, true, 'an ignore-only replace script finishes a card whose every line is ignorable');

  // the same script in mode 'extend' keeps the parser's own abilities — and the parser choked on this card, so its
  // `unknown` effects are still there and still fail the face. Ignoring lines never hides an unknown.
  const extended = applyScript(contract, scriptFor('Contract from Below', {
    mode: 'extend', ignore: [{ line: remove, reason: 'ante' }, { line: discard, reason: 'ante' }],
  }));
  assert.deepEqual(extended.unparsed, []);
  assert.equal(extended.fullyParsed, false);

  const partly = applyScript(contract, scriptFor('Contract from Below', { ignore: [{ line: remove, reason: 'ante' }] }));
  assert.deepEqual(partly.unparsed, [discard]);
  assert.equal(partly.fullyParsed, false);
});

test('applyScript: a vanilla card is fully simulated by an empty script; a card with lines never is', () => {
  const bears = db.get('Grizzly Bears')!;
  assert.deepEqual(normalizeOracleLines(bears), [], 'Grizzly Bears has no oracle text at all');
  const elves = db.get('Llanowar Elves')!;
  for (const source of ['generated', 'llm', 'reviewed', 'hand'] as ScriptSource[]) {
    for (const mode of ['replace', 'extend'] as const) {
      assert.equal(applyScript(bears, scriptFor('Grizzly Bears', { source, mode })).fullyParsed, true,
        `${source}/${mode}: there is nothing to claim on a vanilla card`);
    }
    assert.equal(applyScript(elves, scriptFor('Llanowar Elves', { source, mode: 'replace' })).fullyParsed, false,
      `${source}: an empty replace script claims nothing`);
  }
});

test('applyScript: backFace is applied to def.backFace and a card is finished only when BOTH faces are', () => {
  const hunt = db.get('Huntmaster of the Fells')!;
  assert.ok(hunt.backFace && !hunt.backFace.fullyParsed, "Huntmaster's back face must start unfinished");
  const [front1, front2] = normalizeOracleLines(hunt);
  const backLines = normalizeOracleLines(hunt.backFace!);
  const trigger = (text: string): CardScript['abilities'] => [{ kind: 'triggered', event: { on: 'etb', self: true }, effects: [{ op: 'gain-life', amount: 2, who: 'you' }], text }];

  const frontOnly = applyScript(hunt, scriptFor('Huntmaster of the Fells', { abilities: [...trigger(front1)!, ...trigger(front2)!] }));
  assert.equal(frontOnly.fullyParsed, false, 'a card is fully simulated only when BOTH faces are');
  assert.deepEqual(frontOnly.unparsed, [], 'the front face itself is finished');
  assert.equal(frontOnly.backFace!.fullyParsed, false);
  assert.deepEqual(frontOnly.backFace!.unparsed, backLines, "mode 'replace' dropped the parser's back face too, so every back line is unclaimed");

  const both = applyScript(hunt, scriptFor('Huntmaster of the Fells', {
    abilities: [...trigger(front1)!, ...trigger(front2)!],
    backFace: { keywords: ['trample'], abilities: backLines.slice(1).flatMap(t => trigger(t)!) },
  }));
  assert.equal(both.fullyParsed, true);
  assert.deepEqual(both.unparsed, []);
  assert.deepEqual(both.backFace!.unparsed, []);
  assert.deepEqual(both.backFace!.keywords, ['trample']);
  assert.notEqual(hunt.backFace!.abilities[0], both.backFace!.abilities[0], 'the input def is untouched');
});

test('applyScript: split / adventure / flip cards must claim their SECOND face too', () => {
  // parse.ts parses faces[0] only (parse.ts:1146) and builds a `backFace` for transform / modal_dfc alone
  // (parse.ts:1362), so the second half of these three layouts is text no CardDef ever holds. A script must claim it.
  const spell = (text: string): CardScript['abilities'] => [{ kind: 'spell', effects: [{ op: 'gain-life', amount: 1, who: 'you' }], text }];

  for (const [name, expected] of [
    ['Fire // Ice', ['Tap target permanent.', 'Draw a card.']],
    ['Bonecrusher Giant', ["Damage can't be prevented this turn. ~ deals 2 damage to any target."]],
    ['Akki Lavarunner', ['Protection from red', 'If a red source would deal damage to a player, it deals that much damage plus 1 to that player instead.']],
  ] as [string, string[]][]) {
    const def = db.get(name)!;
    assert.deepEqual(secondFaceLines(def), expected, `${name}: second-face lines`);
    for (const l of expected) assert.ok(scriptableLines(def).includes(l), `${name}: a script must be able to name ${JSON.stringify(l)}`);

    // a script that finishes only the first half is NOT fully simulated
    const frontOnly = scriptFor(name, {
      keywords: def.keywords,
      abilities: normalizeOracleLines(def).filter(l => !l.startsWith('// ')).flatMap(l => spell(l)!),
    });
    assert.deepEqual(secondFaceUnclaimed(def, frontOnly), expected, `${name}: the second face is unclaimed`);
    const half = applyScript(def, frontOnly);
    assert.deepEqual(half.unparsed, [], `${name}: the first half itself is finished`);
    assert.equal(half.fullyParsed, false, `${name}: a half-declared split card is not fully simulated`);

    // …and declaring the second face finishes it
    const both = applyScript(def, { ...frontOnly, secondFace: { keywords: ['protection'], abilities: expected.flatMap(l => spell(l)!) } });
    assert.deepEqual(secondFaceUnclaimed(def, { ...frontOnly, secondFace: { abilities: expected.flatMap(l => spell(l)!) } }), []);
    assert.equal(both.fullyParsed, true, `${name}: both halves declared`);
  }

  // nothing changes for every other layout: there is no second face to claim
  for (const name of ['Llanowar Elves', 'Serra Angel', 'Huntmaster of the Fells']) {
    assert.deepEqual(secondFaceLines(db.get(name)!), [], `${name} has no second face`);
  }
});

test('unmatchedAbilityTexts: an ability whose text names no oracle line claims nothing (scripts:check warns)', () => {
  const elves = db.get('Llanowar Elves')!;
  assert.deepEqual(unmatchedAbilityTexts(elves, scriptFor('Llanowar Elves', { abilities: manaAbility(ELVES) })), []);
  assert.deepEqual(unmatchedAbilityTexts(elves, scriptFor('Llanowar Elves', { abilities: manaAbility('{T}: Add {U}.') })), ['{T}: Add {U}.']);
  const hunt = db.get('Huntmaster of the Fells')!;
  assert.deepEqual(unmatchedAbilityTexts(hunt, scriptFor('Huntmaster of the Fells', {
    backFace: { abilities: [{ kind: 'static', effect: { kind: 'self-keywords', keywords: ['trample'] }, text: 'Not a line of this card.' }] },
  })), ['// Not a line of this card.']);
});

test('ignoreLineProblem: a line must match the whitelist regex of the reason it claims', () => {
  const line = (name: string, i = 0) => normalizeOracleLines(db.get(name)!)[i];

  // the reasons on the cards they exist for
  assert.equal(ignoreLineProblem(line('Cogwork Librarian', 0), 'draft-matters'), null);   // "Draft ~ face up."
  assert.equal(ignoreLineProblem(line('Cogwork Librarian', 1), 'draft-matters'), null);   // "As you draft a card, …"
  assert.equal(ignoreLineProblem(line('Contract from Below', 0), 'ante'), null);
  assert.equal(ignoreLineProblem(line('Contract from Below', 1), 'ante'), null);
  assert.equal(ignoreLineProblem(line('Cunning Wish', 0), 'outside-the-game'), null);
  assert.equal(ignoreLineProblem('A deck can have any number of cards named ~.', 'deck-construction'), null);
  assert.equal(ignoreLineProblem('Partner', 'deck-construction'), null);

  // an ante card is not a deck-construction card, and ordinary game text is no reason's business
  assert.ok(ignoreLineProblem(line('Contract from Below', 0), 'deck-construction'));
  assert.ok(ignoreLineProblem('Destroy target creature.', 'draft-matters'));
  assert.ok(ignoreLineProblem('Draw a card.', 'ante'));
  assert.ok(ignoreLineProblem('Search your library for any number of cards named ~.', 'deck-construction'));
  assert.ok(ignoreLineProblem('You may reveal a card you own from your sideboard.', 'outside-the-game'));

  // 'reminder-only' is gone: the parser strips parentheses, so no such line ever reaches a script
  assert.ok(!(IGNORE_REASONS as readonly string[]).includes('reminder-only'));

  // the two tier-gated reasons: the tier is necessary but NOT sufficient — the line needs a marker too
  assert.equal(ignoreLineProblem('Assemble a Contraption.', 'un-physical', 'un'), null);
  assert.equal(ignoreLineProblem('Roll a six-sided die. Physically flip ~ onto the table.', 'un-physical', 'un'), null);
  assert.ok(ignoreLineProblem('Draw a card.', 'un-physical', 'un'), 'an un-card may not ignore ordinary game text');
  assert.ok(ignoreLineProblem('Destroy target creature.', 'un-physical', 'un'));
  assert.ok(ignoreLineProblem('Assemble a Contraption.', 'un-physical', 'paper')?.includes("'un'"));
  assert.ok(ignoreLineProblem('Assemble a Contraption.', 'un-physical')?.includes('unknown tier'));
  assert.equal(ignoreLineProblem('Conjure a card named Mox Jet into your hand.', 'digital-only', 'digital'), null);
  assert.ok(ignoreLineProblem('Conjure a card named Mox Jet into your hand.', 'digital-only', 'paper'));
  assert.ok(ignoreLineProblem('Draw a card.', 'digital-only', 'digital'), 'a digital card may not ignore ordinary text');
});

test('applyScript enforces the ignore whitelist at RUNTIME, not only in scripts:check', () => {
  const contract = db.get('Contract from Below')!;
  const [remove, discard] = normalizeOracleLines(contract);

  // the right reason on the right card, with the card's tier: honoured
  const ok = applyScript(contract, scriptFor('Contract from Below', {
    ignore: [{ line: remove, reason: 'ante' }, { line: discard, reason: 'ante' }],
  }), 'paper');
  assert.deepEqual(ok.unparsed, []);

  // the wrong reason: applyScript ignores the ignore, so the lines stay unparsed instead of quietly finishing the card
  const wrong = applyScript(contract, scriptFor('Contract from Below', {
    ignore: [{ line: remove, reason: 'draft-matters' }, { line: discard, reason: 'outside-the-game' }],
  }), 'paper');
  assert.deepEqual(wrong.unparsed, [remove, discard], 'an ignore the whitelist rejects claims nothing at runtime');
  assert.equal(wrong.fullyParsed, false);

  // a tier-gated reason on a paper card: rejected, and `paper` is also the default when no tier is passed
  const tiered = scriptFor('Contract from Below', { ignore: [{ line: remove, reason: 'un-physical' }, { line: discard, reason: 'un-physical' }] });
  assert.deepEqual(applyScript(contract, tiered, 'paper').unparsed, [remove, discard]);
  assert.deepEqual(applyScript(contract, tiered).unparsed, [remove, discard], "applyScript defaults to the 'paper' tier");
});

test('normalizeOracleLines: whole lines, back-face lines as "// …", no duplicate entries anywhere in the pool', () => {
  for (const name of ['Delver of Secrets', 'Huntmaster of the Fells', 'Thing in the Ice']) {
    const d = db.get(name)!;
    const lines = new Set(normalizeOracleLines(d));
    for (const u of d.unparsed) assert.ok(lines.has(u.trim()), `${name}: unparsed line not produced by normalizeOracleLines: ${u}`);
    assert.ok(normalizeOracleLines(d).some(l => l.startsWith('// ')), `${name}: the back face's lines must be listed as "// …"`);
  }
  // a modal bullet used to be emitted twice (pushed as a line, then re-pushed by the bullet split)
  const all = new CardDB();
  let cards = 0, entries = 0;
  try {
    for (const d of all.all()) {
      if (cards++ % 7) continue;
      const lines = normalizeOracleLines(d);
      entries += lines.length;
      assert.equal(new Set(lines).size, lines.length, `${d.name}: normalizeOracleLines emitted a duplicate: ${JSON.stringify(lines)}`);
    }
  } finally { all.close(); }
  assert.ok(entries > 5000, `expected thousands of normalised lines, got ${entries}`);
});

test('scriptableLines names every entry the parser reports as unparsed — which normalizeOracleLines alone does not', () => {
  // parse.ts reports some clauses as sentence FRAGMENTS (parse.ts:1357 / :1401), so covers/ignore are validated
  // against scriptableLines = normalised lines ∪ def.unparsed ∪ the back face's own unparsed as "// …".
  const veil = db.get('Veil of Summer')!;
  const fragment = veil.unparsed.find(u => !normalizeOracleLines(veil).includes(u.trim()));
  assert.ok(fragment, 'Veil of Summer must still show the fragment normalizeOracleLines cannot reproduce');
  assert.ok(scriptableLines(veil).includes(fragment!.trim()), 'scriptableLines must name it');

  const all = new CardDB();
  let cards = 0, missing = 0, checked = 0;
  try {
    for (const d of all.all()) {
      if (cards++ % 7) continue;
      const lines = new Set(scriptableLines(d));
      for (const u of d.unparsed) { checked++; if (!lines.has(u.trim())) missing++; }
      for (const u of d.backFace?.unparsed ?? []) { checked++; if (!lines.has('// ' + u.trim())) missing++; }
    }
  } finally { all.close(); }
  assert.ok(checked > 2000, `expected thousands of unparsed entries, got ${checked}`);
  assert.equal(missing, 0, `${missing} of ${checked} unparsed entries are unnameable by a script`);
});

test('ScriptStore: sharded layout, flat fallback, pathFor and the CardDB hook', () => {
  const dir = tmp();
  const store = new ScriptStore(dir);
  assert.equal(store.size(), 0);
  const bears = db.get('Grizzly Bears')!;
  const id = bears.oracleId;
  assert.equal(store.pathFor(id), path.join(dir, shardOf(id), `${id}.json`));
  assert.equal(shardOf(id), id.slice(0, 2).toLowerCase());

  const gen: CardScript = { oracleId: id, name: bears.name, oracleHash: oracleHash(bears.oracleText), source: 'generated', confidence: 0.5, keywords: ['trample'] };
  assert.ok(store.put(gen));
  assert.ok(fs.existsSync(store.pathFor(id)), 'put() writes into the shard');
  assert.equal(store.size(), 1);
  assert.deepEqual(store.ids(), [id]);

  // a flat file is still indexed
  const other = '9f3c0000-0000-0000-0000-000000000001';
  fs.writeFileSync(path.join(dir, `${other}.json`), JSON.stringify({ ...gen, oracleId: other, name: 'Flat Card' }, null, 2) + '\n');
  const reread = new ScriptStore(dir);
  assert.equal(reread.size(), 2);
  assert.equal(reread.get(other)!.name, 'Flat Card');
  assert.equal(reread.fileOf(other), path.join(dir, `${other}.json`));
  // …and put() migrates it into the shard
  assert.ok(reread.put({ ...gen, oracleId: other, name: 'Flat Card', source: 'hand' }));
  assert.ok(!fs.existsSync(path.join(dir, `${other}.json`)), 'the flat copy is removed');
  assert.equal(reread.fileOf(other), reread.pathFor(other));

  // CardDB applies the shared store
  useScriptStore(store);
  const fresh = new CardDB();
  try {
    const d = fresh.get('Grizzly Bears')!;
    assert.deepEqual(d.keywords, ['trample']); assert.ok(d.script?.applied);
    assert.equal(fresh.getByOracleId(id)!.keywords[0], 'trample');
  } finally { useScriptStore(null); fresh.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ScriptStore.put: precedence matrix hand > reviewed > llm > generated', () => {
  const dir = tmp();
  const store = new ScriptStore(dir);
  const id = '11110000-0000-0000-0000-000000000001';
  const of = (source: ScriptSource, verified = false): CardScript => ({
    oracleId: id, name: source, oracleHash: 'deadbeef', source,
    ...(verified ? { verification: verifiedBlock() } : {}),
  });
  const SOURCES: ScriptSource[] = ['generated', 'llm', 'reviewed', 'hand'];
  const rank = (s: ScriptSource) => SOURCES.indexOf(s);

  for (const existing of SOURCES) for (const next of SOURCES) for (const verified of [false, true]) {
    fs.rmSync(dir, { recursive: true, force: true });
    const s = new ScriptStore(dir);
    assert.ok(s.put(of(existing, verified)), 'the first write always lands');
    const expected = rank(next) > rank(existing) ? true
      : rank(next) < rank(existing) ? false
      : next !== 'llm' ? true
      : !verified;
    assert.equal(s.put(of(next)), expected, `${next} over ${existing}${verified ? ' (verified)' : ''}`);
    assert.equal(s.get(id)!.source, expected ? next : existing);
    assert.ok(s.put(of(next), { force: true }), 'force always wins');
  }

  // an llm script may overwrite an unverified llm script but not a verified one
  fs.rmSync(dir, { recursive: true, force: true });
  const s2 = new ScriptStore(dir);
  assert.ok(s2.put({ ...of('llm'), name: 'first' }));
  assert.ok(s2.put({ ...of('llm'), name: 'second' }));
  assert.equal(s2.get(id)!.name, 'second');
  assert.ok(s2.put({ ...of('llm', true), name: 'verified', verification: verifiedBlock() }, { force: true }));
  assert.ok(!s2.put({ ...of('llm'), name: 'third' }), 'a verified llm script is not overwritten by another llm script');
  assert.equal(s2.get(id)!.name, 'verified');
  store.reset();
  fs.rmSync(dir, { recursive: true, force: true });
});

function verifiedBlock(status: Verification['status'] = 'verified'): Verification {
  return {
    at: '2026-09-04T00:00:00.000Z', parserVersion: 1, registryHash: 'r', oracleHash: 'deadbeef', scriptHash: 'h',
    schema: 'ok', lint: 'ok',
    sandbox: { seats2: 'ok', seats4: 'ok', abilities: [{ index: 0, reached: true }] },
    roundTrip: { score: 0.9, lowest: [] },
    scenarios: { file: 'x.json', passed: 1, failed: 0, names: ['x'] },
    status, problems: [],
  };
}

test('scriptHash: stable across key order, and unchanged by the verification block', () => {
  const a: CardScript = { oracleId: 'a', name: 'A', oracleHash: 'h', source: 'llm', mode: 'extend', covers: [{ line: 'one', by: 'keywords' }, { line: 'two', by: 'keywords' }], keywords: ['flying'] };
  const reordered = JSON.parse(JSON.stringify({ keywords: a.keywords, covers: a.covers, mode: a.mode, source: a.source, oracleHash: a.oracleHash, name: a.name, oracleId: a.oracleId })) as CardScript;
  assert.equal(scriptHash(reordered), scriptHash(a), 'key order must not change the hash');

  assert.equal(scriptHash({ ...a, verification: verifiedBlock() }), scriptHash(a), 'the verification block is excluded');
  assert.equal(scriptHash({ ...a, verification: verifiedBlock('judged') }), scriptHash(a));

  assert.notEqual(scriptHash({ ...a, covers: [{ line: 'one', by: 'keywords' }] }), scriptHash(a), 'a real change moves the hash');
  assert.notEqual(scriptHash({ ...a, notes: 'x' }), scriptHash(a));
  assert.equal(scriptHash({ ...a, confidence: undefined }), scriptHash(a), 'explicit undefined is not a change');
});

// ---------------------------------------------------------------------------
// Composition core (Phase 9.0): the structural gate on the new ops
// ---------------------------------------------------------------------------

test('composition core: a content-free script made only of the new container ops is rejected; a real one is accepted', () => {
  const bears = db.get('Grizzly Bears')!;
  const line = normalizeOracleLines(db.get('Shock')!)[0];
  // every container with nothing inside, a `bind` on its own, a `move` of nothing and a `lose-abilities` of nothing
  const hollow: Effect[] = [
    { op: 'for-each', over: { types: ['Creature'] }, do: [] },
    { op: 'bind', as: 'that', from: 'targets' },
    { op: 'reflexive', when: 'you-do', effects: [] },
    { op: 'scoped', who: 'each-opponent', do: [] },
    { op: 'may', effects: [] },
    { op: 'unless-pays', who: 'you', cost: { mana: { generic: 2, x: 0, pips: [], hybrid: [], phyrexian: [], raw: '{2}' } }, otherwise: [] },
    { op: 'move', what: { filter: { types: ['Creature'] }, zone: 'graveyard', who: 'you', count: 0 }, to: 'battlefield' },
    { op: 'lose-abilities', target: { kind: 'creature' }, keywords: [], duration: 'eot' },
    // nested: a container whose only child is another empty container is still nothing
    { op: 'for-each', over: 'those', do: [{ op: 'may', effects: [{ op: 'scoped', who: 'you', do: [] }] }] },
  ];
  assert.equal(substantiveCount(hollow), 0);
  assert.deepEqual(insubstantiveReasons(hollow.slice(6, 8)), ['effect has zero magnitude: move count 0', 'effect has zero magnitude: lose-abilities loses no ability']);
  for (const e of hollow) assert.equal(substantiveCount([e]), 0, `${e.op} counted as behaviour`);
  const shock = db.get('Shock')!;
  const hollowScript = applyScript(shock, scriptFor('Shock', { abilities: [{ kind: 'spell', effects: hollow, text: line }] }));
  assert.deepEqual(hollowScript.unparsed, [line], 'a script of empty containers claims no line');
  assert.equal(hollowScript.fullyParsed, false);
  // the CardScriptChecked schema refuses the shapes the type system alone would let through
  for (const e of [{ op: 'set-pt', target: 'self', duration: 'eot' }, { op: 'move', what: 'that' }, { op: 'for-each', do: [] }])
    assert.equal(CardScriptChecked.safeParse(scriptFor('Shock', { abilities: [{ kind: 'spell', effects: [e as unknown as Effect], text: line }] })).success, false, `schema accepted ${JSON.stringify(e)}`);

  // the real thing: the same ops with behaviour inside them count once each, and claim the line
  const real: Effect[] = [
    { op: 'for-each', over: { types: ['Creature'], who: 'you' }, do: [{ op: 'counters', target: 'that', counter: '+1/+1', amount: 1 }] },
    { op: 'may', effects: [{ op: 'sacrifice', who: 'you', what: { types: ['Creature'] }, amount: 1 }] },
    { op: 'reflexive', when: 'you-do', effects: [{ op: 'draw', amount: 1, who: 'you' }] },
    { op: 'scoped', who: 'each-opponent', do: [{ op: 'discard', amount: 1, who: 'you' }] },
    { op: 'unless-pays', who: 'target-player', cost: { mana: { generic: 2, x: 0, pips: [], hybrid: [], phyrexian: [], raw: '{2}' } }, otherwise: [{ op: 'lose-life', amount: 2, who: 'you' }] },
    { op: 'move', what: 'that', to: 'exile', until: 'eot' },
    { op: 'move', what: { filter: { types: ['Creature'] }, zone: 'graveyard', who: 'you', count: 1 }, to: 'battlefield', controller: 'you' },
    { op: 'set-pt', target: 'self', power: 0, toughness: 0, duration: 'eot' },                       // 0/0 is lethal, not empty
    { op: 'lose-abilities', target: 'all-creatures', duration: 'eot' },                             // no list = every ability
    { op: 'lose-abilities', target: 'all-creatures', keywords: ['flying'], duration: 'eot' },
    { op: 'exchange', what: 'life', a: 'you', b: 'target-player' },
  ];
  assert.equal(substantiveCount(real), real.length);
  const realScript = applyScript(shock, scriptFor('Shock', { abilities: [{ kind: 'spell', effects: real, text: line }] }));
  assert.deepEqual(realScript.unparsed, []);
  assert.equal(realScript.fullyParsed, true);
  assert.equal(CardScriptChecked.safeParse(scriptFor('Shock', { abilities: [{ kind: 'spell', effects: real, text: line }] })).success, true);
  void bears;
});
