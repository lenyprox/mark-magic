// src/cards/forge/shape.ts: the same `AbilityShape` read off a synthetic Forge face (trigger modes mapped to this
// engine's kinds, `TargetMin$ 0` → up to, `OptionalDecider$` → you may, `UnlessCost$`, a resolved token) and off a
// `CardDef` (a `may`-wrapped trigger, a `TargetSpec` nested in a `conditional`, `choose-mode`, `token`, `altCosts` /
// `kicker` / `cycling` as keyword shapes). Unmapped Forge modes and keyword spellings yield nothing comparable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseForgeCard, type ForgeFace } from '../src/cards/forge/loader.js';
import { faceShapes, forgeKeywordId, forgeShapes, forgeTriggerKinds, KNOWN_KEYWORD_IDS, normalizeShapeText, ourMagnitudes, ourShapes } from '../src/cards/forge/shape.js';
import type { Ability, CardDef, Effect } from '../src/cards/types.js';

const face = (lines: string[]): ForgeFace => parseForgeCard(lines.join('\n') + '\n', 'cardsfolder/p/probe.txt').faces[0];
const mana = { generic: 2, x: 0, pips: [] as never[], hybrid: [], phyrexian: [], raw: '{2}' };

/** A minimal CardDef for the shape tests (only the fields `ourShapes` reads). */
function def(over: Partial<CardDef>): CardDef {
  return { name: 'Probe', oracleId: 'probe', manaCost: null, manaValue: 0, colors: [], colorIdentity: [], types: ['Creature'], supertypes: [], subtypes: [], typeLine: 'Creature', oracleText: '', power: '1', toughness: '1', loyalty: null, keywords: [], abilities: [], fullyParsed: true, unparsed: [], layout: 'normal', producesMana: [], ...over };
}

test('normalizeShapeText: lowercase, CARDNAME → ~, reminder text and punctuation gone', () => {
  assert.equal(normalizeShapeText('When CARDNAME enters, draw two cards. (Then shuffle.)'), 'when ~ enters draw two cards');
  assert.equal(normalizeShapeText("Target creature can't block this turn."), 'target creature can t block this turn');
  assert.equal(normalizeShapeText(null), '');
});

test('forgeTriggerKinds: the seeded modes map to registered kinds; an unmapped mode yields []', () => {
  assert.deepEqual(forgeTriggerKinds({ Mode: 'ChangesZone', Origin: 'Any', Destination: 'Battlefield', ValidCard: 'Card.Self' }), ['etb']);
  assert.deepEqual(forgeTriggerKinds({ Mode: 'ChangesZone', Origin: 'Battlefield', Destination: 'Graveyard', ValidCard: 'Creature.Other' }), ['dies']);
  assert.deepEqual(forgeTriggerKinds({ Mode: 'ChangesZone', Origin: 'Battlefield', Destination: 'Any', ValidCard: 'Card.Self' }), ['ltb']);
  assert.deepEqual(forgeTriggerKinds({ Mode: 'ChangesZone', Origin: 'Any', Destination: 'Battlefield', ValidCard: 'Land.YouCtrl' }), ['landfall']);
  assert.deepEqual(forgeTriggerKinds({ Mode: 'Phase', Phase: 'Upkeep', ValidPlayer: 'You' }), ['upkeep']);
  assert.deepEqual(forgeTriggerKinds({ Mode: 'Phase', Phase: 'End of Turn' }), ['end-step']);
  assert.deepEqual(forgeTriggerKinds({ Mode: 'Attacks', ValidCard: 'Card.Self' }), ['attacks']);
  assert.deepEqual(forgeTriggerKinds({ Mode: 'DamageDone', ValidSource: 'Card.Self', ValidTarget: 'Player', CombatDamage: 'True' }), ['combat-damage-player']);
  assert.deepEqual(forgeTriggerKinds({ Mode: 'DamageDone', ValidSource: 'Card.Self', ValidTarget: 'Opponent' }), ['deals-damage']);
  assert.deepEqual(forgeTriggerKinds({ Mode: 'DamageDone', ValidSource: 'Creature', ValidTarget: 'Card.Self' }), []);   // "is dealt damage": no kind here
  assert.deepEqual(forgeTriggerKinds({ Mode: 'SpellCast', ValidCard: 'Card', TargetsValid: 'Card.Self' }), ['cast', 'targeted']);
  assert.deepEqual(forgeTriggerKinds({ Mode: 'Cycled' }), []);
  assert.deepEqual(forgeTriggerKinds({ Mode: 'ChaosEnsues' }), []);
  assert.deepEqual(forgeTriggerKinds({ Mode: 'CounterAdded', CounterType: 'LORE' }), ['lore-counter-put']);
});

test('forgeKeywordId: aliases, parameterised spellings, an unmapped spelling kept verbatim and outside the comparable set', () => {
  assert.equal(forgeKeywordId('First Strike'), 'first strike');
  assert.equal(forgeKeywordId('Cycling:2 G'), 'cycling'); assert.equal(forgeKeywordId('TypeCycling:Basic:2'), 'cycling');
  assert.equal(forgeKeywordId('Protection from red'), 'protection'); assert.equal(forgeKeywordId('Protection:Card.MultiColor:multicolored'), 'protection');
  assert.equal(forgeKeywordId('Landwalk:Island'), 'landwalk'); assert.equal(forgeKeywordId('etbCounter:P1P1:2'), 'as-enters');
  assert.equal(forgeKeywordId("CARDNAME can't be blocked."), 'unblockable');
  assert.equal(forgeKeywordId('Cumulative upkeep:1'), 'cumulative upkeep');
  assert.ok(!KNOWN_KEYWORD_IDS.has('cumulative upkeep')); assert.ok(KNOWN_KEYWORD_IDS.has('kicker') && KNOWN_KEYWORD_IDS.has('flying'));
});

test('forgeShapes: a face → keyword shapes and one shape per ability with targets, may, unless, magnitudes, modes and tokens', () => {
  const f = face([
    'Name:Probe', 'ManaCost:1 U', 'Types:Creature Merfolk', 'PT:1/1', 'K:Flying', 'K:Kicker:2',
    'T:Mode$ ChangesZone | Origin$ Any | Destination$ Battlefield | ValidCard$ Card.Self | Execute$ TrigDraw | OptionalDecider$ You | TriggerDescription$ When CARDNAME enters, you may draw a card unless an opponent pays {2}.',
    'SVar:TrigDraw:DB$ Draw | Defined$ You | NumCards$ 1 | UnlessCost$ 2 | UnlessPayer$ Opponent',
    'A:SP$ ChangeZone | Origin$ Graveyard | Destination$ Hand | TargetMin$ 0 | TargetMax$ 2 | ValidTgts$ Card.YouCtrl | SpellDescription$ Return up to two target cards from your graveyard to your hand.',
    'A:AB$ Charm | Cost$ T | Choices$ DBTok,DBDmg | SpellDescription$ Choose one — ABILITY',
    'SVar:DBTok:DB$ Token | TokenAmount$ 2 | TokenScript$ nothing_here | SpellDescription$ Create two 1/1 white Soldier creature tokens.',
    'SVar:DBDmg:DB$ DealDamage | ValidTgts$ Any | NumDmg$ 3 | SpellDescription$ CARDNAME deals 3 damage to any target.',
    'T:Mode$ Attacks | ValidCard$ Card.Self | Execute$ TrigPump | TriggerDescription$ Whenever CARDNAME attacks or blocks, it gets +2/+0 until end of turn.',
    'T:Mode$ Blocks | ValidCard$ Card.Self | Execute$ TrigPump | Secondary$ True | TriggerDescription$ Whenever CARDNAME attacks or blocks, it gets +2/+0 until end of turn.',
    'SVar:TrigPump:DB$ Pump | Defined$ Self | NumAtt$ +2 | NumDef$ +0',
    'S:Mode$ CantBlock | ValidCard$ Card.Self | Description$ CARDNAME can\'t block.',
    'R:Event$ Moved | Destination$ Battlefield | ValidCard$ Card.Self | ReplaceWith$ ETBTapped | Description$ CARDNAME enters tapped.',
    'SVar:ETBTapped:DB$ Tap | Defined$ Self | ETB$ True',
  ]);
  const shapes = forgeShapes(f);
  const kws = shapes.filter(s => s.cls === 'keyword').flatMap(s => s.keywords).sort();
  assert.deepEqual(kws, ['as-enters', 'cant block', 'flying', 'kicker']);   // the CantBlock static and the ETB replacement are keywords in print
  const etb = shapes.find(s => s.cls === 'triggered' && s.text.startsWith('when ~ enters'))!;
  assert.deepEqual(etb.trigger, { kinds: ['etb'] });
  assert.equal(etb.optional, true); assert.equal(etb.unless, true); assert.deepEqual(etb.targets, []); assert.deepEqual(etb.magnitudes, []);   // NumCards 1 is the implicit default
  const ret = shapes.find(s => s.cls === 'spell')!;
  assert.deepEqual(ret.targets, [{ optional: true, max: 2 }]); assert.equal(ret.optional, false);
  const charm = shapes.find(s => s.cls === 'activated')!;
  assert.equal(charm.modes, 2); assert.deepEqual(charm.targets, [{ optional: false, max: null }]); assert.deepEqual(charm.magnitudes, [2, 3]);
  assert.equal(charm.text, 'choose one create two 1 1 white soldier creature tokens ~ deals 3 damage to any target');   // ABILITY → the modes' text
  assert.deepEqual(charm.tokens, []);   // an unresolved TokenScript$ yields no token shape
  // the Secondary$ True line merged into the attacks trigger: one printed ability, both kinds
  const combat = shapes.filter(s => s.cls === 'triggered' && s.text.includes('attacks or blocks'));
  assert.equal(combat.length, 1); assert.deepEqual(combat[0].trigger, { kinds: ['attacks', 'blocks'] }); assert.deepEqual(combat[0].magnitudes, [2]);
  assert.equal(shapes.filter(s => s.cls === 'static').length, 0); assert.equal(shapes.filter(s => s.cls === 'replacement').length, 0);
});

test('forgeShapes: a resolved token carries P/T, colours, types, subtypes and aliased keywords; an unmapped mode yields kinds []', () => {
  const card = parseForgeCard(['Name:Probe', 'Types:Sorcery', 'A:SP$ Token | TokenAmount$ 1 | TokenScript$ w_1_1_soldier | SpellDescription$ Create a 1/1 white Soldier creature token with vigilance.', 'T:Mode$ Cycled | ValidCard$ Card.Self | Execute$ TrigX | TriggerDescription$ When you cycle CARDNAME, draw a card.', 'SVar:TrigX:DB$ Draw | NumCards$ 1'].join('\n'), 'cardsfolder/p/probe.txt',
    { read: (id: string) => id === 'w_1_1_soldier' ? { id, name: 'Soldier Token', colors: ['W'], types: ['Creature'], subtypes: ['Soldier'], pt: '1/1', keywords: ['Vigilance'] } : null } as never);
  const shapes = forgeShapes(card.faces[0]);
  assert.deepEqual(shapes[0].tokens, [{ name: 'Soldier Token', pt: '1/1', colors: ['W'], types: ['Creature'], subtypes: ['Soldier'], keywords: ['vigilance'] }]);
  assert.deepEqual(shapes[1].trigger, { kinds: [] });
});

test('ourShapes: a may-wrapped trigger, a TargetSpec nested in a conditional, choose-mode, token, and the cost fields as keyword shapes', () => {
  const abilities: Ability[] = [
    { kind: 'triggered', event: { on: 'etb', self: true }, effects: [{ op: 'may', effects: [{ op: 'conditional', condition: { kind: 'threshold' }, then: [{ op: 'destroy', target: { kind: 'creature', optional: true, count: 2 } }], else: [{ op: 'draw', amount: 2, who: 'you' }] }] }], text: 'When ~ enters, you may destroy up to two target creatures if you have threshold. Otherwise draw two cards.' },
    { kind: 'triggered', event: { on: 'or', events: [{ on: 'attacks', self: true }, { on: 'blocks', self: true }] }, effects: [{ op: 'pump', target: 'self', power: 2, toughness: 0, duration: 'eot' }], optional: true, text: 'Whenever ~ attacks or blocks, you may have it get +2/+0 until end of turn.' },
    { kind: 'spell', effects: [{ op: 'choose-mode', count: 1, modes: [[{ op: 'token', count: 2, power: 1, toughness: 1, colors: ['W'], types: ['Creature'], subtypes: ['Soldier'], keywords: ['vigilance'] }], [{ op: 'lose-life', amount: 3, who: 'target-player' }]] }], text: 'Choose one — • Create two 1/1 white Soldier creature tokens with vigilance. • Target player loses 3 life.' },
    { kind: 'activated', cost: { tap: true }, effects: [{ op: 'counter', target: { kind: 'spell' }, unlessPay: 1 }], text: '{T}: Counter target spell unless its controller pays {1}.' },
    { kind: 'static', effect: { kind: 'aura', power: -3, toughness: 0, enchant: { kind: 'creature' } }, text: 'Enchanted creature gets -3/-0.' },
    { kind: 'activated', cost: { tap: true }, effects: [{ op: 'add-mana', mana: ['G'] }], text: '{T}: Add {G}.', manaAbility: true },
  ];
  const d = def({ keywords: ['flying'], kicker: mana, cycling: mana, altCosts: [{ id: 'flashback', label: 'flashback {2}', cost: { mana }, from: 'graveyard' }, { id: 'pitch', label: 'pitch', cost: {}, from: 'hand' }], asEnters: [{ kind: 'tapped' }], abilities, subtypes: ['Forest'] });
  const shapes = ourShapes(d);
  assert.deepEqual(shapes.filter(s => s.cls === 'keyword').flatMap(s => s.keywords), ['as-enters', 'cycling', 'flashback', 'flying', 'kicker']);   // pitch is a sentence in print, not a keyword
  const etb = shapes.find(s => s.cls === 'triggered' && s.trigger!.kinds[0] === 'etb')!;
  assert.equal(etb.optional, true); assert.deepEqual(etb.targets, [{ optional: true, max: 2 }]); assert.deepEqual(etb.magnitudes, [2]); assert.equal(etb.modes, null);
  const combat = shapes.find(s => s.cls === 'triggered' && s.trigger!.kinds.length === 2)!;
  assert.deepEqual(combat.trigger, { kinds: ['attacks', 'blocks'] }); assert.equal(combat.optional, true); assert.deepEqual(combat.magnitudes, [2]);   // +0 is not a magnitude
  const modal = shapes.find(s => s.cls === 'spell')!;
  assert.equal(modal.modes, 2); assert.deepEqual(modal.targets, [{ optional: false, max: null }]);   // `who: 'target-player'` is a target
  assert.deepEqual(modal.tokens, [{ name: null, pt: '1/1', colors: ['W'], types: ['Creature'], subtypes: ['Soldier'], keywords: ['vigilance'] }]);
  assert.deepEqual(modal.magnitudes, [2, 3]);
  const counter = shapes.find(s => s.cls === 'activated' && s.effects[0] === 'counter')!;
  assert.equal(counter.unless, true); assert.deepEqual(counter.targets, [{ optional: false, max: null }]);
  assert.deepEqual(shapes.find(s => s.cls === 'static')!.targets, []);   // the aura's enchant spec is the Enchant keyword, not a target
  assert.equal(shapes.filter(s => s.cls === 'activated').length, 1);   // a Forest's intrinsic mana ability is not printed
});

test('ourShapes: a may directly inside a scoped ("target opponent may draw") or a reflexive is "you may"; a scoped without one and an effect-level optional flag are not', () => {
  const abilities: Ability[] = [
    { kind: 'activated', cost: { mana }, effects: [{ op: 'bounce', target: 'self', to: 'hand' }, { op: 'scoped', who: 'target-opponent', do: [{ op: 'may', effects: [{ op: 'draw', amount: 1, who: 'you' }] }] }], text: "{2}: Return ~ to its owner's hand. Target opponent may draw a card." },
    { kind: 'triggered', event: { on: 'dies', self: false, filter: { types: ['Creature'] }, controller: 'any' }, effects: [{ op: 'bind', as: 'that', from: 'triggering' }, { op: 'scoped', who: 'controller-of-that', do: [{ op: 'may', effects: [{ op: 'draw', amount: 1, who: 'you' }] }] }], text: "Whenever a creature dies, that creature's controller may draw a card." },
    { kind: 'triggered', event: { on: 'etb', self: true }, effects: [{ op: 'reflexive', when: 'you-do', effects: [{ op: 'may', effects: [{ op: 'draw', amount: 1, who: 'you' }] }] }], text: 'When ~ enters, … When you do, you may draw a card.' },
    { kind: 'spell', effects: [{ op: 'scoped', who: 'each-opponent', do: [{ op: 'draw', amount: 1, who: 'you' }] }], text: 'Each opponent draws a card.' },
    { kind: 'spell', effects: [{ op: 'loot', draw: 1, discard: 1, optional: true }], text: 'You may discard a card. If you do, draw a card.' },
  ];
  assert.deepEqual(ourShapes(def({ abilities })).map(s => s.optional), [true, true, true, false, false]);
});

test('faceShapes on a script face (the second face of a split card) and the back face of a DFC are appended in that order', () => {
  const back = def({ name: 'Back', abilities: [{ kind: 'triggered', event: { on: 'upkeep', whose: 'your' }, effects: [{ op: 'mill', amount: 3, who: 'you' }], text: 'At the beginning of your upkeep, mill three cards.' }] });
  const d = def({ layout: 'transform', backFace: back });
  assert.deepEqual(ourShapes(d).map(s => s.cls), ['triggered']);
  const second = faceShapes({ keywords: ['haste'], abilities: [{ kind: 'spell', effects: [{ op: 'damage', amount: 2, target: { kind: 'any' } }], text: '~ deals 2 damage to any target.' }] });
  assert.deepEqual(second.map(s => s.cls), ['keyword', 'spell']);
  assert.deepEqual(ourShapes(def({}), { abilities: second.length ? [{ kind: 'spell', effects: [{ op: 'damage', amount: 2, target: { kind: 'any' } }], text: 'x' }] : [] }).map(s => s.cls), ['spell']);
});

test('ourMagnitudes: literal integers at any depth, 0 and 1 left out, a token\'s P/T and a mana amount excluded, a removed counter by its size', () => {
  const effects: Effect[] = [
    { op: 'may', effects: [{ op: 'draw', amount: 2, who: 'you' }, { op: 'counters', target: 'self', counter: '+1/+1', amount: -2 }] },
    { op: 'token', count: 3, power: 4, toughness: 4, colors: [], types: ['Creature'], subtypes: ['Beast'], keywords: [] },
    { op: 'add-mana', mana: ['R'], amount: 2 }, { op: 'damage', amount: 'X', target: { kind: 'any' } }, { op: 'scry', amount: 1 }, { op: 'loot', draw: 2, discard: 1 },
  ];
  assert.deepEqual(ourMagnitudes(effects), [2, 3]);
});
