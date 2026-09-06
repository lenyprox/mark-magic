// Parser rules for the piles-choices family (Phase 9.1; docs/vocabulary/piles-choices.md, "Parser wordings").
//
// The engine half (src/engine/ops/piles-choices.ts) adds the ops; this file teaches src/cards/parse.ts the oracle
// wordings that produce them. Every rule here is consulted only after every built-in stage of parse.ts has declined
// the sentence (the registry contract in ./types.ts), so nothing a built-in already parsed can move.
//
// Two disciplines specific to this family:
//
//   * an instant or sorcery never reaches the line hook (parse.ts's spell-text branch claims its lines first), so the
//     pile and "for each player" cards — all of them sorceries and instants — are read SENTENCE by sentence. The ops
//     are built for exactly that: `separate-piles` / `choose-pile` / `choose-objects` / `choose-for-each-player`
//     record their result on the source, and `chosen-fate` (the next sentence) reads it back. See the family doc.
//   * a rule never emits the frame words `that` / `those` unless the sentence really follows a binding antecedent:
//     parse.ts's `bindAntecedent` declines a frame-reading sentence whose antecedent does not bind, and the ops of a
//     family are not in its `BINDING_OPS` list. `from: 'those'` is therefore emitted only after "reveal the top N
//     cards of your library", whose rule keeps the built-in `look-top` (a binding op) at the front of the block it
//     emits for exactly that reason.
import type { CardType, Filter } from '../types.js';
import type { EffectRule, RuleFamily, TriggerRule } from './types.js';

/** "an artifact" / "a creature" / "a planeswalker" → the card type it names; null for anything else. */
const TYPE_WORD: Record<string, CardType> = {
  artifact: 'Artifact', creature: 'Creature', enchantment: 'Enchantment', land: 'Land',
  planeswalker: 'Planeswalker', battle: 'Battle', instant: 'Instant', sorcery: 'Sorcery',
};
const NUM_WORD: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const num = (w: string): number => NUM_WORD[w.toLowerCase()] ?? Number(w);

/** "an artifact, a creature, an enchantment, and a planeswalker" → one `{ types: [T] }` filter per item, or null. */
function pickFilters(list: string): Filter[] | null {
  const parts = list.split(/,\s*(?:and\s+)?|\s+and\s+/).map(s => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const out: Filter[] = [];
  for (const p of parts) {
    const m = p.match(/^(?:a|an|one)\s+([a-z]+)$/i);
    const t = m ? TYPE_WORD[m[1].toLowerCase()] : undefined;
    if (!t) return null;
    out.push({ types: [t] });
  }
  return out;
}

const effects: EffectRule[] = [
  // ---- piles (CR 700.3) ---------------------------------------------------------------------------------------
  // "Reveal the top five cards of your library and separate them into two piles." (Steam Augury, Intrude on the Mind)
  { re: /^reveal the top (a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+) cards? of your library and separate them into (two|three) piles$/i,
    make: m => ({ op: 'separate-piles', from: { zone: 'library', who: 'you', top: num(m[1]) }, piles: num(m[2]), separator: 'you', reveal: true }) },
  // "Reveal the top five cards of your library." on its own (Fact or Fiction, Sphinx of Uthuun, Unesh). Two ops, in a
  // `scoped you` no-op container: the built-in `look-top` is the only one parse.ts counts as BINDING the cards it read
  // — which is what the "an opponent separates those cards …" sentence below needs, and what a family op can never be
  // — and `reveal-cards` is the half `look-top` does not do, making those cards public knowledge (CR 701.20a vs
  // 701.20e). The container still binds `those` for the next sentence: parse.ts's `bindsFrame` enters a `do` list.
  { re: /^reveal the top (a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+) cards? of your library$/i,
    make: m => ({ op: 'scoped', who: 'you', do: [{ op: 'look-top', who: 'you', amount: num(m[1]) }, { op: 'reveal-cards', what: 'those' }] }) },
  // "An opponent separates those cards into two piles."
  { re: /^an opponent separates those cards into (two|three) piles$/i,
    make: m => ({ op: 'separate-piles', from: 'those', piles: num(m[1]), separator: 'an-opponent' }) },
  // "An opponent chooses one of those piles."
  { re: /^an opponent chooses one of those piles$/i, make: () => ({ op: 'choose-pile', chooser: 'an-opponent' }) },
  // "Put that pile into your hand and the other into your graveyard." — the pile the previous sentence chose
  { re: /^put that pile into your hand and the other into your graveyard$/i,
    make: () => ({ op: 'chosen-fate', chosen: { how: 'move', to: 'hand' }, other: { how: 'move', to: 'graveyard' } }) },
  // "Put one pile into your hand and the other into your graveyard." — you choose the pile as part of the same
  // sentence, so the choice and its consequence are one `scoped you` block (a no-op container, composition.md §4)
  { re: /^put one pile into your hand and the other into your graveyard$/i,
    make: () => ({ op: 'scoped', who: 'you', do: [{ op: 'choose-pile', chooser: 'you' }, { op: 'chosen-fate', chosen: { how: 'move', to: 'hand' }, other: { how: 'move', to: 'graveyard' } }] }) },
  { re: /^put one pile into your hand and the other on the bottom of your library in any order$/i,
    make: () => ({ op: 'scoped', who: 'you', do: [{ op: 'choose-pile', chooser: 'you' }, { op: 'chosen-fate', chosen: { how: 'move', to: 'hand' }, other: { how: 'move', to: 'library', pos: 'bottom' } }] }) },

  // ---- "an opponent chooses N of those cards" -------------------------------------------------------------------
  { re: /^an opponent chooses (a|an|one|two|three|four|five|\d+) of (?:those|them) cards?$/i,
    make: m => ({ op: 'choose-objects', chooser: 'an-opponent', from: 'those', count: num(m[1]) }) },
  { re: /^put the chosen cards? into your graveyard and the rest into your hand$/i,
    make: () => ({ op: 'chosen-fate', chosen: { how: 'move', to: 'graveyard' }, other: { how: 'move', to: 'hand' } }) },
  { re: /^put the chosen cards? into your hand and the rest into your graveyard$/i,
    make: () => ({ op: 'chosen-fate', chosen: { how: 'move', to: 'hand' }, other: { how: 'move', to: 'graveyard' } }) },

  // ---- "For each player, you choose …" (CR 608.2f, 101.4) -------------------------------------------------------
  // Tragic Arrogance: "For each player, you choose from among the permanents that player controls an artifact, a
  // creature, an enchantment, and a planeswalker."
  { re: /^for each player, you choose from among the permanents that player controls (.+)$/i,
    make: m => { const picks = pickFilters(m[1]); return picks ? { op: 'choose-for-each-player', chooser: 'you', picks } : null; } },
  // Winnowing: "For each player, you choose a creature that player controls."
  { re: /^for each player, you choose (?:a|an|one) ([a-z]+) that player controls$/i,
    make: m => { const t = TYPE_WORD[m[1].toLowerCase()]; return t ? { op: 'choose-for-each-player', chooser: 'you', picks: [{ types: [t] }], from: { types: [t] } } : null; } },
  // "[Then] each player sacrifices all other nonland permanents they control." (the leading "Then " is normalised off)
  { re: /^each player sacrifices all other (nonland permanents|permanents|creatures) they control$/i,
    make: m => ({ op: 'chosen-fate', other: { how: 'sacrifice' }, among: /creature/i.test(m[1]) ? { types: ['Creature'] } : /nonland/i.test(m[1]) ? { notTypes: ['Land'] } : {} }) },
  // Winnowing's tail: the unchosen creatures that share a creature type with their controller's chosen one are spared
  { re: /^each player sacrifices all other creatures they control that don't share a creature type with the chosen creature they control$/i,
    make: () => ({ op: 'chosen-fate', other: { how: 'sacrifice' }, among: { types: ['Creature'] }, excludeSharing: 'creature-type' }) },
];

const triggers: TriggerRule[] = [
  // CR 716.2a: "When this Class becomes level N, …" (the class level bar's own trigger; the level bar line itself is
  // claimed by parse.ts's built-in activated-ability branch and stays unparsed — see the family doc's Declines)
  { name: 'became-level', make: head => {
    const m = head.trim().replace(/\.$/, '').match(/^when(?:ever)? (?:this class|~) becomes level (\d)$/i);
    return m ? { on: 'became-level', level: Number(m[1]) } : null;
  } },
];

const pilesChoices: RuleFamily = { name: 'piles-choices', effects, triggers };
export default pilesChoices;
