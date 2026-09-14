// src/cards/forge/compare.ts: an agreeing card yields no finding; the Breeches shape (a Forge `Pump | ValidTgts$
// Creature` mode against ours with a resolution-time `choose-objects` and no `TargetSpec`) yields `target-missing`;
// `TargetMin$ 0` against `optional: false` yields `target-optionality`; an unmapped mode never yields `trigger-kind`;
// `Charm` 3 against `choose-mode` 2 yields `mode-count`; alignment by description beats printed order; the
// count-based categories only when our side claims the whole card; the report builder and its markdown are
// deterministic. Shapes are built through the real `forgeShapes` / `ourShapes` from synthetic Forge text and defs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseForgeCard } from '../src/cards/forge/loader.js';
import { alignShapes, CATEGORIES, compareCard, textJaccard } from '../src/cards/forge/compare.js';
import { forgeShapes, ourShapes, type AbilityShape } from '../src/cards/forge/shape.js';
import { buildReport, markdown, totalsLine, type CardRow } from '../scripts/forge-diff.js';
import type { Ability, CardDef, Effect } from '../src/cards/types.js';

const forge = (lines: string[]) => forgeShapes(parseForgeCard(lines.join('\n') + '\n', 'cardsfolder/p/probe.txt').faces[0]);
function def(abilities: Ability[], over: Partial<CardDef> = {}): CardDef {
  return { name: 'Probe', oracleId: 'probe', manaCost: null, manaValue: 0, colors: [], colorIdentity: [], types: ['Creature'], supertypes: [], subtypes: [], typeLine: 'Creature', oracleText: '', power: '1', toughness: '1', loyalty: null, keywords: [], abilities, fullyParsed: true, unparsed: [], layout: 'normal', producesMana: [], ...over };
}
const cats = (r: { findings: { category: string }[] }) => r.findings.map(f => f.category).sort();

const BOLT_FORGE = ['Name:Probe Bolt', 'ManaCost:R', 'Types:Instant', 'A:SP$ DealDamage | ValidTgts$ Any | NumDmg$ 3 | SpellDescription$ CARDNAME deals 3 damage to any target.'];
const BOLT_OURS: Ability[] = [{ kind: 'spell', effects: [{ op: 'damage', amount: 3, target: { kind: 'any' } }], text: '~ deals 3 damage to any target.' }];

test('an agreeing card yields no finding (same target, magnitude, no may / unless, same keywords)', () => {
  const r = compareCard(ourShapes(def(BOLT_OURS, { keywords: ['flash'] })), forge([...BOLT_FORGE, 'K:Flash']));
  assert.equal(r.status, 'agree'); assert.deepEqual(r.findings, []);
  assert.deepEqual(r.alignment.pairs.map(p => p.by), ['text']);
});

test('the Breeches shape: a Forge mode that targets against a choose-objects with no TargetSpec is target-missing; the modes agree', () => {
  const f = forge([
    'Name:Probe Pillager', 'ManaCost:2 R', 'Types:Legendary Creature Goblin Pirate', 'PT:3/3', 'K:First Strike',
    'T:Mode$ Attacks | ValidCard$ Pirate.YouCtrl | TriggerZones$ Battlefield | Execute$ TrigCharm | TriggerDescription$ Whenever a Pirate you control attacks, ABILITY',
    'SVar:TrigCharm:DB$ Charm | Choices$ DBToken,DBUnblockable,DBExileTop | ChoiceRestriction$ ThisTurn',
    'SVar:DBToken:DB$ Token | TokenScript$ probe_treasure | SpellDescription$ Create a Treasure token.',
    'SVar:DBUnblockable:DB$ Pump | ValidTgts$ Creature | KW$ HIDDEN CARDNAME can\'t block. | IsCurse$ True | SpellDescription$ Target creature can\'t block this turn.',
    'SVar:DBExileTop:DB$ Dig | DigNum$ 1 | ChangeNum$ All | DestinationZone$ Exile | SpellDescription$ Exile the top card of your library. You may play it this turn.',
  ]);
  const trigger = (mode2: Effect[]): Ability => ({
    kind: 'triggered', event: { on: 'attacks', self: false, filter: { subtypes: ['Pirate'] } }, text: "Whenever a Pirate you control attacks, choose one that hasn't been chosen this turn — • Create a Treasure token. • Target creature can't block this turn. • Exile the top card of your library. You may play it this turn.",
    effects: [{ op: 'choose-mode', count: 1, modes: [
      [{ op: 'token', count: 1, power: 0, toughness: 0, colors: [], types: ['Artifact'], subtypes: ['Treasure'], keywords: [], treasure: true, name: 'Treasure' }],
      mode2,
      [{ op: 'impulse', count: 1, until: 'eot' }],
    ] }],
  });
  // the audited script: the target is chosen on resolution (`choose-objects`), no TargetSpec anywhere
  const r = compareCard(ourShapes(def([trigger([{ op: 'choose-objects', chooser: 'you', from: { filter: { types: ['Creature'] }, who: 'each-player' }, count: 1 } as never, { op: 'cant-block', target: 'that', duration: 'eot' }])], { keywords: ['first strike'] })), f);
  assert.equal(r.status, 'disagree');
  assert.deepEqual(cats(r), ['target-missing']);
  assert.equal(r.findings[0].ours, 'no target'); assert.equal(r.findings[0].forge, '1 target');
  // with a TargetSpec in the mode the card agrees
  assert.equal(compareCard(ourShapes(def([trigger([{ op: 'cant-block', target: { kind: 'creature' }, duration: 'eot' }])], { keywords: ['first strike'] })), f).status, 'agree');
});

test('target-optionality: TargetMin$ 0 (up to) against optional: false, and a printed maximum that differs', () => {
  const f = forge(['Name:Probe', 'Types:Instant', 'A:SP$ Destroy | ValidTgts$ Creature | TargetMin$ 0 | TargetMax$ 1 | SpellDescription$ Destroy up to one target creature.']);
  const r = compareCard(ourShapes(def([{ kind: 'spell', effects: [{ op: 'destroy', target: { kind: 'creature' } }], text: 'Destroy up to one target creature.' }])), f);
  assert.deepEqual(cats(r), ['target-optionality']);
  assert.equal(r.findings[0].ours, '1 target'); assert.equal(r.findings[0].forge, 'up to 1 target');
  const two = forge(['Name:Probe', 'Types:Instant', 'A:SP$ Destroy | ValidTgts$ Creature | TargetMin$ 2 | TargetMax$ 2 | SpellDescription$ Destroy two target creatures.']);
  assert.deepEqual(cats(compareCard(ourShapes(def([{ kind: 'spell', effects: [{ op: 'destroy', target: { kind: 'creature', count: 2 } }], text: 'Destroy two target creatures.' }])), two)), []);
  assert.deepEqual(cats(compareCard(ourShapes(def([{ kind: 'spell', effects: [{ op: 'destroy', target: { kind: 'creature', count: 3 } }], text: 'Destroy two target creatures.' }])), two)), ['target-optionality']);
});

test('trigger-kind: mapped kinds with no overlap; an unmapped Forge mode never yields one', () => {
  const dies = forge(['Name:Probe', 'Types:Creature', 'PT:1/1', 'T:Mode$ ChangesZone | Origin$ Battlefield | Destination$ Graveyard | ValidCard$ Card.Self | Execute$ TrigDraw | TriggerDescription$ When CARDNAME dies, draw a card.', 'SVar:TrigDraw:DB$ Draw | NumCards$ 1']);
  const asEtb = ourShapes(def([{ kind: 'triggered', event: { on: 'etb', self: true }, effects: [{ op: 'draw', amount: 1, who: 'you' }], text: 'When ~ dies, draw a card.' }]));
  const r = compareCard(asEtb, dies);
  assert.deepEqual(cats(r), ['trigger-kind']); assert.equal(r.findings[0].ours, 'etb'); assert.equal(r.findings[0].forge, 'dies');
  const cycled = forge(['Name:Probe', 'Types:Creature', 'PT:1/1', 'T:Mode$ Cycled | ValidCard$ Card.Self | Execute$ TrigDraw | TriggerDescription$ When CARDNAME dies, draw a card.', 'SVar:TrigDraw:DB$ Draw | NumCards$ 1']);
  assert.deepEqual(cats(compareCard(asEtb, cycled)), []);
});

test('mode-count: Charm with three choices against a two-mode choose-mode; may / unless / magnitude / keyword-set each on their own', () => {
  const charm = forge(['Name:Probe', 'Types:Instant', 'A:SP$ Charm | Choices$ DBA,DBB,DBC | SpellDescription$ Choose one — ABILITY',
    'SVar:DBA:DB$ Draw | NumCards$ 2 | SpellDescription$ Draw two cards.', 'SVar:DBB:DB$ GainLife | LifeAmount$ 4 | SpellDescription$ You gain 4 life.', 'SVar:DBC:DB$ Mill | NumCards$ 3 | SpellDescription$ Mill three cards.']);
  const two = ourShapes(def([{ kind: 'spell', effects: [{ op: 'choose-mode', count: 1, modes: [[{ op: 'draw', amount: 2, who: 'you' }], [{ op: 'gain-life', amount: 4, who: 'you' }]] }], text: 'Choose one — • Draw two cards. • You gain 4 life.' }]));
  const r = compareCard(two, charm);
  assert.deepEqual(cats(r), ['magnitude', 'mode-count']);   // the third mode's 3 is missing too
  assert.equal(r.findings.find(f => f.category === 'mode-count')!.ours, '2 modes'); assert.equal(r.findings.find(f => f.category === 'mode-count')!.forge, '3 modes');
  const rhystic = forge(['Name:Probe', 'Types:Enchantment', 'T:Mode$ SpellCast | ValidCard$ Card | ValidActivatingPlayer$ Opponent | Execute$ TrigDraw | TriggerDescription$ Whenever an opponent casts a spell, you may draw a card unless that player pays {1}.', 'SVar:TrigDraw:DB$ Draw | Defined$ You | UnlessCost$ 1 | UnlessPayer$ TriggeredActivator | NumCards$ 1 | OptionalDecider$ You']);
  const mandatory = ourShapes(def([{ kind: 'triggered', event: { on: 'cast', filter: {}, who: 'opponent' }, effects: [{ op: 'draw', amount: 1, who: 'you' }], text: 'Whenever an opponent casts a spell, you may draw a card unless that player pays {1}.' }]));
  assert.deepEqual(cats(compareCard(mandatory, rhystic)), ['may-missing', 'unless-cost']);
  const faithful = ourShapes(def([{ kind: 'triggered', event: { on: 'cast', filter: {}, who: 'opponent' }, effects: [{ op: 'unless-pays', who: 'that-player', cost: { mana: { generic: 1, x: 0, pips: [], hybrid: [], phyrexian: [], raw: '{1}' } }, otherwise: [{ op: 'may', effects: [{ op: 'draw', amount: 1, who: 'you' }] }], otherwiseAs: 'controller' }], optional: true, text: 'Whenever an opponent casts a spell, you may draw a card unless that player pays {1}.' }]));
  assert.deepEqual(cats(compareCard(faithful, rhystic)), []);
  assert.deepEqual(cats(compareCard(ourShapes(def(BOLT_OURS, { keywords: ['flying'] })), forge(BOLT_FORGE))), ['keyword-set']);
  // an unmapped Forge keyword spelling is never a keyword-set finding; a mapped one is
  assert.deepEqual(cats(compareCard(ourShapes(def(BOLT_OURS)), forge([...BOLT_FORGE, 'K:Split second']))), []);
  assert.deepEqual(cats(compareCard(ourShapes(def(BOLT_OURS)), forge([...BOLT_FORGE, 'K:Flying']))), ['keyword-set']);
});

test('alignment by description beats printed order; leftovers pair by class in order; a partner-less Forge ability is a finding only on a fully parsed card', () => {
  const f = forge(['Name:Probe', 'Types:Creature', 'PT:2/2',
    'A:AB$ Draw | Cost$ 2 T | NumCards$ 1 | SpellDescription$ Draw a card.',
    'A:AB$ DealDamage | Cost$ T | ValidTgts$ Any | NumDmg$ 2 | SpellDescription$ CARDNAME deals 2 damage to any target.',
    'T:Mode$ Phase | Phase$ Upkeep | ValidPlayer$ You | Execute$ TrigLife | TriggerDescription$ At the beginning of your upkeep, you gain 1 life.', 'SVar:TrigLife:DB$ GainLife | LifeAmount$ 1']);
  // ours prints the damage ability first: text alignment still pairs each with its twin, so no target finding either way
  const ours = ourShapes(def([
    { kind: 'activated', cost: { tap: true }, effects: [{ op: 'damage', amount: 2, target: { kind: 'any' } }], text: '{T}: ~ deals 2 damage to any target.' },
    { kind: 'activated', cost: { tap: true, mana: { generic: 2, x: 0, pips: [], hybrid: [], phyrexian: [], raw: '{2}' } }, effects: [{ op: 'draw', amount: 1, who: 'you' }], text: '{2}, {T}: Draw a card.' },
  ]));
  const a = alignShapes(ours, f);
  assert.deepEqual(a.pairs.map(p => [p.ours, p.forge, p.by]), [[1, 0, 'text'], [0, 1, 'text']]);
  assert.deepEqual(a.unmatchedForge, [2]); assert.deepEqual(a.unmatchedOurs, []);
  const r = compareCard(ours, f);
  assert.deepEqual(cats(r), ['ability-count', 'unmatched-forge-ability']);
  assert.equal(r.findings.find(x => x.category === 'unmatched-forge-ability')!.forge, 'triggered: GainLife');
  // the same card not fully parsed: the count-based categories stay quiet, the pairwise ones do not
  assert.deepEqual(cats(compareCard(ours, f, { fullyParsed: false })), []);
  // no description on either side: class + printed order pairs them, and a shape mismatch shows through
  const blind: AbilityShape[] = [{ cls: 'spell', text: '', effects: ['damage'], targets: [{ optional: false, max: null }], optional: false, unless: false, tokens: [], magnitudes: [3], modes: null, keywords: [] }];
  const blindForge: AbilityShape[] = [{ cls: 'spell', text: '', effects: ['DealDamage'], targets: [], optional: false, unless: false, tokens: [], magnitudes: [3], modes: null, keywords: [] }];
  const b = compareCard(blind, blindForge);
  assert.deepEqual(b.alignment.pairs.map(p => p.by), ['order']); assert.deepEqual(cats(b), ['target-extra']);
  assert.equal(textJaccard('a b c', 'b c d'), 0.5); assert.equal(textJaccard('', 'a'), 0);
});

test('buildReport / markdown: cards sorted by oracle id, per-category rates over the cards with a Forge file, no timestamp, byte-identical twice', () => {
  const rows: CardRow[] = [
    { oracleId: 'b', name: 'B', status: 'disagree', findings: [{ category: 'target-missing', ours: 'no target', forge: '1 target', ability: 'x' }, { category: 'magnitude', ours: '2', forge: '3', ability: 'x' }] },
    { oracleId: 'a', name: 'A', status: 'agree', findings: [] },
    { oracleId: 'c', name: 'C', status: 'no-forge-file', findings: [] },
  ];
  const idx = { head: 'abcdef0123456789', files: 3, cards: [], byName: new Map() };
  const r = buildReport(idx, 'claimed', rows, 1, null);
  assert.deepEqual(r.cards.map(c => c.oracleId), ['a', 'b', 'c']);
  assert.deepEqual(r.totals, { cards: 3, withForgeFile: 2, agree: 1, disagree: 1, skippedSecondFace: 1 });
  assert.deepEqual(Object.keys(r.byCategory), [...CATEGORIES]);
  assert.deepEqual(r.byCategory['target-missing'], { cards: 1, findings: 1, rate: 0.5 });
  assert.equal(totalsLine(r), 'forge:diff — 3 cards (claimed), 2 with a Forge file, 1 agree / 1 disagree, 1 second face skipped; Forge abcdef01 (3 files)');
  const md = markdown(r, null, 5);
  assert.equal(md, markdown(buildReport(idx, 'claimed', [...rows].reverse(), 1, null), null, 5));
  assert.match(md, /\| target-missing \| 1 \| 1 \| 50\.0% \|/); assert.match(md, /- B — ours: no target \/ forge: 1 target \(x\)/);
  assert.doesNotMatch(JSON.stringify(r) + md, /20\d\d-\d\d-\d\d|C:\\|\/Users\//);
  // --category narrows the findings and the status
  const only = buildReport(idx, 'claimed', rows, 0, new Set(['magnitude'] as const));
  assert.deepEqual(Object.keys(only.byCategory), ['magnitude']); assert.equal(only.cards[1].findings.length, 1);
  assert.equal(buildReport(idx, 'claimed', rows, 0, new Set(['may-missing'] as const)).cards[1].status, 'agree');
  // the labelled precision column appears only with a calibration file
  const cal = { forgeHead: 'abcdef0123456789', sample: [], precision: { 'target-missing': { n: 4, parserWrong: 1 } } };
  assert.match(markdown(r, cal, 5), /\| target-missing \| 1 \| 1 \| 50\.0% \| 1\/4 parser-wrong \|/);
});
