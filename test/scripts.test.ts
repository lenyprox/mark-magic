// Per-card scripts: line-claim accounting (replace/extend), stale detection by oracle hash, source precedence, the
// sharded store, back faces, the ignore whitelist, scriptHash stability and the CardDB hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CardDB } from '../src/cards/db.js';
import {
  applyScript, COVER_KINDS, coverProblem, IGNORE_REASONS, ignoreLineProblem, normalizeOracleLines, oracleHash, scriptableLines,
  scriptHash, secondFaceLines, secondFaceUnclaimed, shardOf, ScriptStore, unmatchedAbilityTexts, useScriptStore,
  type CardScript, type CoverKind, type ScriptFace, type ScriptSource, type Verification,
} from '../src/cards/scripts.js';
import { CardScriptChecked } from '../src/cards/schema.js';
import type { CardDef } from '../src/cards/types.js';
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

/** Copy the named declarations off the parser's own def, so a test face declares exactly what the card really has. */
const faceFrom = (def: CardDef, keys: (keyof ScriptFace)[]): ScriptFace => {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = (def as unknown as Record<string, unknown>)[k];
  return out as ScriptFace;
};

/** One real card per cover kind: the oracle line, the kind that covers it, and the declarations that back it. */
const COVER_CASES: [card: string, line: string, by: CoverKind, decls: (keyof ScriptFace)[]][] = [
  ['Serra Angel', 'Flying', 'keywords', ['keywords']],
  ['Faithless Looting', 'Flashback {2}{R}', 'altCosts', ['altCosts']],
  ['Steam Vents', "As ~ enters, you may pay 2 life. If you don't, it enters tapped.", 'asEnters', ['asEnters']],
  ['Treasure Cruise', 'Delve', 'costModifiers', ['costModifiers']],
  ['Rite of Replication', 'Kicker {5}', 'kicker', ['kicker']],
  ['Eternal Dragon', 'Plainscycling {2}', 'cycling', ['cycling', 'cyclingSearch']],
  ['Thornwood Falls', '~ enters tapped.', 'entersTapped', ['entersTapped']],
  ['Rattleclaw Mystic', 'Morph {2}', 'morph', ['morph']],
  ['Bloodbraid Elf', 'Cascade', 'cascade', ['cascade']],
  ['Grapeshot', 'Storm', 'storm', ['storm']],
  ['Distortion Strike', 'Rebound', 'rebound', ['rebound']],
  ['Stinkweed Imp', 'Dredge 5', 'dredge', ['dredge']],
  ['Progenitus', "If ~ would be put into a graveyard from anywhere, reveal ~ and shuffle it into its owner's library instead.", 'graveyardReplacement', ['graveyardReplacement']],
  ['Progenitus', 'Protection from everything', 'protection', ['protectionFrom']],
  ['Dreadlight Monstrosity', 'Ward {2}', 'ward', ['wardCost']],
  ['Bone Splinters', 'As an additional cost to cast ~, sacrifice a creature.', 'additionalCosts', ['additionalCosts']],
  ['Pestilent Syphoner', 'Toxic 1', 'toxic', ['toxic']],
  ['Devoted Retainer', 'Bushido 1', 'bushido', ['bushido']],
  ['Craw Giant', 'Rampage 2', 'rampage', ['rampage']],
  ['Street Wraith', 'Swampwalk', 'landwalk', ['landwalk']],
  ['Fire Sages', 'Firebending 1', 'firebending', ['firebending']],
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

  // a parameterised keyword line counts when the bare keyword is present ("Toxic 1" -> 'toxic', "Ward {2}" -> 'ward')
  const syphoner = db.get('Pestilent Syphoner')!;
  assert.deepEqual(normalizeOracleLines(syphoner), ['Flying', 'Toxic 1']);
  assert.equal(applyScript(syphoner, scriptFor('Pestilent Syphoner', { keywords: ['flying', 'toxic'] })).fullyParsed, true);
  const ward = db.get('Dreadlight Monstrosity')!;
  assert.ok(normalizeOracleLines(ward).includes('Ward {2}'));
  assert.ok(!applyScript(ward, scriptFor('Dreadlight Monstrosity', { mode: 'extend', keywords: ['ward'] })).unparsed.includes('Ward {2}'));
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
