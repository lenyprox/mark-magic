// The generic-when-enchanted-dies rule family (src/cards/rules/generic-when-enchanted-dies.ts, Phase 9.1p): the one
// trigger head it claims, the exact `TriggerEvent` it emits for it, and the four wordings one shelf over that it must
// leave `{ on: 'unknown' }`.
//
// Lines are written the way parseCard sees them (the card's own name already rewritten to `~`), and every effect the
// claimed head unlocks is validated against the composed script schema, so a rule can never emit a shape a per-card
// script could not carry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCard, parseEffects, type OracleRow } from '../src/cards/parse.js';
import { EffectSchema } from '../src/cards/schema.js';
import { RULE_FAMILIES } from '../src/cards/rules/_registry.js';
import type { CardDef, Effect, TriggeredAbility, TriggerEvent } from '../src/cards/types.js';

/** The effects of a wording (JSON-normalised: an explicit `undefined` member is no member), each checked against the script schema. */
function parsed(text: string): Effect[] {
  const effs = JSON.parse(JSON.stringify(parseEffects(text))) as Effect[];
  for (const e of effs) if (e.op !== 'unknown') assert.doesNotThrow(() => EffectSchema.parse(e), `schema rejects ${JSON.stringify(e)}`);
  return effs;
}

/** A printed Aura, parsed as parseCard sees it. `mana` only has to be legal — nothing here reads it. */
function aura(name: string, oracle_text: string, extra: Partial<OracleRow> = {}): CardDef {
  return parseCard({
    name, oracle_id: `probe-${name.toLowerCase().replace(/\W+/g, '-')}`, mana_cost: '{1}{B}', mana_value: 2, colors: ['B'], color_identity: ['B'],
    types: ['Enchantment'], supertypes: [], subtypes: ['Aura'], type_line: 'Enchantment — Aura', oracle_text, power: null, toughness: null,
    loyalty: null, keywords: [], layout: 'normal', ...extra,
  });
}

/** The `i`th triggered ability of a parsed card, JSON-normalised, with every known effect schema-checked. */
function triggered(def: CardDef, i = 0): TriggeredAbility {
  const abs = def.abilities.filter(a => a.kind === 'triggered') as TriggeredAbility[];
  assert.ok(abs.length > i, `${def.name}: no triggered ability #${i} (abilities: ${JSON.stringify(def.abilities.map(a => a.kind))})`);
  const ab = JSON.parse(JSON.stringify(abs[i])) as TriggeredAbility;
  for (const e of ab.effects) if (e.op !== 'unknown') assert.doesNotThrow(() => EffectSchema.parse(e), `schema rejects ${JSON.stringify(e)}`);
  return ab;
}

/**
 * THE shape this family claims, once. "Enchanted creature" is the permanent the Aura is attached to (CR 303.4a),
 * which is what `attachedToSource` means to `characteristics.ts:matchesFilter`; "dies" is "put into a graveyard from
 * the battlefield" (CR 700.4); `controller: 'any'` because the head says nothing about who controlled the creature.
 */
const ENCHANTED_CREATURE_DIES: TriggerEvent = { on: 'dies', self: false, filter: { attachedToSource: true }, controller: 'any' };

test('the generic-when-enchanted-dies family is registered from src/cards/rules/generic-when-enchanted-dies.ts', () => {
  const fam = RULE_FAMILIES.find(f => f.name === 'generic-when-enchanted-dies');
  assert.ok(fam, 'family not in the generated barrel — run npm run gen:registry');
  // One rule kind and one rule: the family claims a trigger head and nothing else.
  assert.deepEqual(Object.keys(fam).filter(k => k !== 'name'), ['triggers']);
  assert.equal(fam.triggers?.length, 1);
});

// ---------------------------------------------------------------------------------------------------------------
// (a) the claimed head — one AST pin per printed wording it finishes
// ---------------------------------------------------------------------------------------------------------------

test('"When enchanted creature dies" is a dies trigger on the Aura\'s own host (CR 700.4, 303.4a)', () => {
  // Bequeathal — the whole card is the head plus a draw.
  const bequeathal = aura('Bequeathal', 'Enchant creature\nWhen enchanted creature dies, you draw two cards.');
  assert.equal(bequeathal.fullyParsed, true);
  assert.deepEqual(bequeathal.unparsed, []);
  assert.deepEqual(triggered(bequeathal), {
    kind: 'triggered', event: ENCHANTED_CREATURE_DIES,
    effects: [{ op: 'draw', amount: 2, who: 'you' }],
    text: 'When enchanted creature dies, you draw two cards.', optional: false,
  });
  // and the body on its own is the same effect list, schema-checked
  assert.deepEqual(parsed('You draw two cards.'), [{ op: 'draw', amount: 2, who: 'you' }]);
});

test('the head the registry claims and its built-in "Whenever" twin are byte-identical (CR 603.2)', () => {
  // parse.ts already reads `whenever (equipped|enchanted) (creature|permanent) dies`; the registry rule exists only
  // for the "When" spelling, and the two spellings of one trigger must not produce two different ASTs.
  const when = aura('Probe When', 'Enchant creature\nWhen enchanted creature dies, you draw two cards.');
  const whenever = aura('Probe Whenever', 'Enchant creature\nWhenever enchanted creature dies, you draw two cards.');
  assert.deepEqual(triggered(when).event, ENCHANTED_CREATURE_DIES);
  assert.deepEqual(triggered(whenever).event, ENCHANTED_CREATURE_DIES);
});

test('the printed bodies the head unlocks: the trigger\'s object, the Aura itself, and a controller-scoped search', () => {
  // Demonic Vigor — "that card" is the object the ability triggered on (CR 608.2f), bound out of the trigger frame.
  const vigor = aura('Demonic Vigor', 'Enchant creature\nEnchanted creature gets +1/+1.\nWhen enchanted creature dies, return that card to its owner\'s hand.');
  assert.equal(vigor.fullyParsed, true);
  assert.deepEqual(triggered(vigor), {
    kind: 'triggered', event: ENCHANTED_CREATURE_DIES,
    effects: [{ op: 'bind', as: 'that', from: 'triggering' }, { op: 'move', what: 'that', to: 'hand' }],
    text: "When enchanted creature dies, return that card to its owner's hand.", optional: false,
  });

  // Angelic Destiny — "this card" is the Aura, which is in its owner's graveyard by then (CR 704.5m); the bounce
  // targets the source, not the trigger's object.
  const destiny = aura('Angelic Destiny', 'Enchant creature\nWhen enchanted creature dies, return this card to its owner\'s hand.');
  assert.equal(destiny.fullyParsed, true);
  assert.deepEqual(triggered(destiny).effects, [{ op: 'bounce', target: 'self', to: 'hand' }]);

  // Minion's Return — the same trigger frame, onto the battlefield under the Aura controller's control.
  const minion = aura("Minion's Return", 'Flash\nEnchant creature\nWhen enchanted creature dies, return that card to the battlefield under your control.');
  assert.equal(minion.fullyParsed, true);
  assert.deepEqual(triggered(minion).effects, [{ op: 'bind', as: 'that', from: 'triggering' }, { op: 'move', what: 'that', to: 'battlefield', controller: 'you' }]);

  // Fungal Fortitude — "it" in a non-self trigger body is the trigger's object too, and it comes back tapped.
  const fungal = aura('Fungal Fortitude', 'Flash\nEnchant creature\nEnchanted creature gets +2/+0.\nWhen enchanted creature dies, return it to the battlefield tapped under its owner\'s control.');
  assert.equal(fungal.fullyParsed, true);
  assert.deepEqual(triggered(fungal).effects, [{ op: 'bind', as: 'that', from: 'triggering' }, { op: 'move', what: 'that', to: 'battlefield', controller: 'owner', tapped: true }]);

  // Pattern of Rebirth — the search is the dead creature's controller's, inside a `scoped` (CR 608.2f).
  const pattern = aura('Pattern of Rebirth', "Enchant creature\nWhen enchanted creature dies, that creature's controller may search their library for a creature card, put that card onto the battlefield, then shuffle.");
  assert.equal(pattern.fullyParsed, true);
  assert.deepEqual(triggered(pattern).event, ENCHANTED_CREATURE_DIES);
  assert.equal(triggered(pattern).effects[0].op, 'bind');
});

// ---------------------------------------------------------------------------------------------------------------
// (b) the declines — wordings one shelf over that must stay `unknown` (see the file header for the reasons)
// ---------------------------------------------------------------------------------------------------------------

/** The trigger head of a card whose head the family must refuse: still `{ on: 'unknown' }`, the line still unparsed. */
function declined(def: CardDef, head: string): void {
  assert.deepEqual(triggered(def).event, { on: 'unknown', text: head }, `${def.name}: the family claimed "${head}"`);
  assert.equal(def.fullyParsed, false);
  assert.ok(def.unparsed.some(l => l.startsWith(head)), `${def.name}: the line is not recorded unparsed`);
}

test('DECLINE: a compound head is not this construct — "dies or is put into exile" (Kaya\'s Ghostform)', () => {
  // A TriggerRule is handed nothing but the head string (no EffectCtx, no sub-parsers), so it cannot build the `or`
  // branch — and the engine has no "put into exile from the battlefield" trigger event to build it out of.
  const ghostform = aura("Kaya's Ghostform", 'Enchant creature or planeswalker you control\nWhen enchanted permanent dies or is put into exile, return that card to the battlefield under your control.');
  declined(ghostform, 'When enchanted permanent dies or is put into exile');
});

test('DECLINE: "When enchanted permanent dies" and "When enchanted land dies" — the engine raises `dies` only for creatures', () => {
  // Game.moveTo queues the event `if (zone === 'graveyard' && creature)`, so a non-creature permanent never raises it.
  // CR 700.4 covers every permanent, so claiming these heads would be a trigger that silently never fires.
  declined(aura('Probe Permanent', 'Enchant permanent\nWhen enchanted permanent dies, return that card to its owner\'s hand.'), 'When enchanted permanent dies');
  declined(aura('Vastwood Zendikon', "Enchant land\nEnchanted land is a 6/4 green Elemental creature. It's still a land.\nWhen enchanted land dies, return that card to its owner's hand."), 'When enchanted land dies');
});

test('DECLINE: "is put into a graveyard" is the old templating, on a non-creature permanent (Tezzeret\'s Touch)', () => {
  const touch = aura("Tezzeret's Touch", 'Enchant artifact\nEnchanted artifact is a creature with base power and toughness 5/5 in addition to its other types.\nWhen enchanted artifact is put into a graveyard, return that card to its owner\'s hand.');
  declined(touch, 'When enchanted artifact is put into a graveyard');
});

test('DECLINE: a head with a second branch needing a filter parser (One with the Kami)', () => {
  // "another modified creature you control" needs parseFilterWords, which a TriggerRule is not given; approximating
  // the head with `attachedToSource` alone would silently drop half the trigger.
  const kami = aura('One with the Kami', "Flash\nEnchant creature you control\nWhenever enchanted creature or another modified creature you control dies, create X 1/1 colorless Spirit creature tokens, where X is that creature's power.");
  declined(kami, 'Whenever enchanted creature or another modified creature you control dies');
});

test('DECLINE: the claimed head is anchored — a tail after "dies" is a different trigger', () => {
  declined(aura('Probe Tail', 'Enchant creature\nWhen enchanted creature dies this turn, you draw two cards.'), 'When enchanted creature dies this turn');
});
