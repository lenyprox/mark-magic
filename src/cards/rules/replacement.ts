// Parser rules for the replacement / prevention family (Phase 9.1; docs/vocabulary/replacement.md).
//
// The wordings of CR 614 and CR 615 that the built-in tables decline: the prevention shields that are not "prevent
// all damage that would be dealt to <target> this turn" (which parse.ts already has), the two "can't be prevented"
// shapes, "if <this> would <happen>, <that> instead" on damage / a zone change / counters, "Players can't gain
// life.", "Skip your draw step." and "Lands you control enter untapped."
//
// Every rule here is consulted only after every built-in stage of parse.ts declined the line or sentence (the
// registry contract in ./types.ts). Two disciplines on top of that, the same two the composition family follows:
//
//   * a rule never claims what it cannot express. The filter words a source or a recipient may use are a CLOSED
//     vocabulary (`sourceFilter` / `recipientOf` below) rather than the built-in — and lossy — filter parser, so a
//     wording with one word outside it declines instead of parsing into a filter that means something else;
//   * a static rule refuses an instant or a sorcery outright. The static branch of the line ladder sits above the
//     spell-text branch, so a static rule that fired on a sorcery line would leave the card `fullyParsed` with an
//     empty spell ability — the quiet failure docs/vocabulary/README.md warns about.
import type { Effect, Filter, StaticEffect } from '../types.js';
import type { EffectRule, LineRule, RuleFamily, StaticCard, StaticRule } from './types.js';

// ---------------------------------------------------------------------------------------------------------------
// The closed vocabularies
// ---------------------------------------------------------------------------------------------------------------

const COLOR: Record<string, 'W' | 'U' | 'B' | 'R' | 'G'> = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
const NUMBER: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
/** "3" / "four" → 3 / 4; null for anything else (an "X" shield has no fixed size and is left to a script). */
const numWord = (w: string | undefined): number | null => {
  if (!w) return null;
  const t = w.trim().toLowerCase();
  return /^\d+$/.test(t) ? Number(t) : (NUMBER[t] ?? null);
};

/** Whose source / permanent, as the card words it. */
function controlWord(w: string | undefined): 'you' | 'opponent' | 'any' | null {
  if (!w) return 'any';
  const t = w.trim().toLowerCase();
  if (t === 'you control') return 'you';
  if (t === "you don't control" || t === 'an opponent controls' || t === 'your opponents control') return 'opponent';
  return null;
}

/**
 * The words a damage SOURCE may be described with: a colour, "creature(s)", "source(s)", "permanent(s)", with an
 * optional leading "another"/"other". Anything else declines the whole rule.
 */
function sourceFilter(desc: string | undefined): Filter | null | undefined {
  if (desc === undefined) return undefined;                                   // no "by …" clause at all
  const words = desc.trim().toLowerCase().replace(/^(a|an|the) /, '').split(/\s+/);
  const f: Filter = {};
  let sawNoun = false;
  for (const w of words) {
    if (w === 'another' || w === 'other') { f.other = true; continue; }
    if (COLOR[w]) { (f.colors ??= []).push(COLOR[w]); continue; }
    if (w === 'source' || w === 'sources') { sawNoun = true; continue; }
    if (w === 'creature' || w === 'creatures') { (f.types ??= []).push('Creature'); sawNoun = true; continue; }
    if (w === 'permanent' || w === 'permanents') { sawNoun = true; continue; }
    return null;
  }
  if (!sawNoun) return null;
  return f;
}

/** "a creature you control" / "a permanent or player" / "you" → the recipient half. `null` declines. */
function recipientOf(desc: string): { players?: 'you' | 'each-opponent' | 'any'; filter?: Filter; who?: 'you' | 'opponent' | 'any' } | null {
  const raw = desc.trim().toLowerCase();
  if (raw === 'you') return { players: 'you' };
  // "a permanent or player" / "a creature or player" / "any target": every recipient, so neither half is restricted
  if (/^(any target|(?:a |an )?(?:permanent|creature|planeswalker) or player|(?:a )?player or (?:permanent|creature|planeswalker))$/.test(raw)) return {};
  const t = raw.replace(/^(a|an|the) /, '');
  const m = t.match(/^(creature|permanent|planeswalker)s?( you control| you don't control| an opponent controls| your opponents control)?$/);
  if (!m) return null;
  const who = controlWord(m[2]?.trim() || undefined);
  if (who === null) return null;
  const filter: Filter = m[1] === 'creature' ? { types: ['Creature'] } : m[1] === 'planeswalker' ? { types: ['Planeswalker'] } : {};
  return { filter, ...(who === 'any' ? {} : { who }) };
}

/** The permanent an "enchanted / equipped creature" phrase names, as the shield's `self` / `attached` flag. */
function selfOrAttached(w: string): { self: true } | { attached: true } | null {
  const t = w.trim().toLowerCase();
  if (t === '~') return { self: true };
  if (/^(enchanted|equipped) (creature|permanent|land|artifact)$/.test(t)) return { attached: true };
  return null;
}

const combatOf = (w: string | undefined): { combat: 'combat' } | { combat: 'noncombat' } | Record<string, never> =>
  (w && /combat/i.test(w) && !/non/i.test(w) ? { combat: 'combat' } : w && /noncombat/i.test(w) ? { combat: 'noncombat' } : {});

/** Normalised static line: trimmed, no trailing full stop. */
const norm = (line: string): string => line.trim().replace(/\.$/, '');

/** An instant or a sorcery must never reach a static rule — its lines are spell text (see the header). */
const isSpellCard = (card: StaticCard): boolean => card.types.includes('Instant') || card.types.includes('Sorcery');

// ---------------------------------------------------------------------------------------------------------------
// Static rules
// ---------------------------------------------------------------------------------------------------------------

const statics: StaticRule[] = [
  // ---- CR 615.1: a continuous prevention shield printed on a permanent -----------------------------------------
  // "Prevent all combat damage that would be dealt to and dealt by enchanted creature." — two shields, one each way.
  { name: 'prevent-to-and-by', make: (line, card) => {
    if (isSpellCard(card)) return null;
    const m = norm(line).match(/^prevent all (combat |noncombat )?damage that would be dealt to and dealt by (.+)$/i);
    if (!m) return null;
    const who = selfOrAttached(m[2]); if (!who) return null;
    const combat = combatOf(m[1]);
    return [
      { kind: 'prevention-shield', ...(Object.keys(combat).length ? { from: { ...combat } } : {}), to: { ...who } },
      { kind: 'prevention-shield', from: { ...who, ...combat }, to: {} },
    ] as StaticEffect[];
  } },
  // "Prevent all damage that would be dealt by enchanted creature."
  { name: 'prevent-by', make: (line, card) => {
    if (isSpellCard(card)) return null;
    const m = norm(line).match(/^prevent all (combat |noncombat )?damage that would be dealt by (.+)$/i);
    if (!m) return null;
    const who = selfOrAttached(m[2]); if (!who) return null;
    return { kind: 'prevention-shield', from: { ...who, ...combatOf(m[1]) }, to: {} } as StaticEffect;
  } },
  // "Prevent all damage that would be dealt to ~." / "… to ~ by creatures." / "… to ~ by creatures it's blocking."
  { name: 'prevent-to', make: (line, card) => {
    if (isSpellCard(card)) return null;
    const m = norm(line).match(/^prevent all (combat |noncombat )?damage that would be dealt to (~|enchanted \w+|equipped \w+)(?: by (.+))?$/i);
    if (!m) return null;
    const who = selfOrAttached(m[2]); if (!who) return null;
    const f = sourceFilter(m[3]); if (f === null) return null;
    const combat = combatOf(m[1]);
    const from = { ...(f ? { filter: f } : {}), ...combat };
    return { kind: 'prevention-shield', ...(Object.keys(from).length ? { from } : {}), to: { ...who } } as StaticEffect;
  } },

  // ---- CR 615.6: prevention switched off ------------------------------------------------------------------------
  // "Combat damage that would be dealt by creatures you control can't be prevented." / "Damage can't be prevented."
  { name: 'unpreventable', make: (line, card) => {
    if (isSpellCard(card)) return null;
    const m = norm(line).match(/^(combat |noncombat )?damage(?: that would be dealt by (.+?)( you control| you don't control| an opponent controls| your opponents control)?)? can't be prevented$/i);
    if (!m) return null;
    const f = sourceFilter(m[2]); if (f === null) return null;
    const who = controlWord(m[3]?.trim() || undefined); if (who === null) return null;
    return { kind: 'unpreventable-damage', ...(f && Object.keys(f).length ? { filter: f } : {}), ...(who === 'any' ? {} : { who }), ...combatOf(m[1]) } as StaticEffect;
  } },

  // ---- CR 614.1a on damage --------------------------------------------------------------------------------------
  // "If another red source you control would deal damage to a permanent or player, it deals that much damage plus 1
  //  to that permanent or player instead." / "… it deals double that damage … instead."
  { name: 'damage-replacement', make: (line, card) => {
    if (isSpellCard(card)) return null;
    const m = norm(line).match(/^if (.+?)( you control| you don't control| an opponent controls| your opponents control)? would deal (combat |noncombat )?damage to (.+?), (?:it deals|~ deals) (that much damage plus (\d+)|double that damage|triple that damage)(?: to .+)? instead$/i);
    if (!m) return null;
    const f = sourceFilter(m[1]); if (f === null || f === undefined) return null;
    const who = controlWord(m[2]?.trim() || undefined); if (who === null) return null;
    const to = recipientOf(m[4]); if (!to) return null;
    const instead = m[6] !== undefined ? { mode: 'plus' as const, amount: Number(m[6]) }
      : /^double/i.test(m[5]) ? { mode: 'times' as const, factor: 2 } : { mode: 'times' as const, factor: 3 };
    return {
      kind: 'damage-replacement',
      from: { ...(Object.keys(f).length ? { filter: f } : {}), ...(who === 'any' ? {} : { who }), ...combatOf(m[3]) },
      ...(Object.keys(to).length ? { to } : {}), instead,
    } as StaticEffect;
  } },
  // "If a source an opponent controls would deal damage to you, prevent 1 of that damage."
  { name: 'damage-reduction', make: (line, card) => {
    if (isSpellCard(card)) return null;
    const m = norm(line).match(/^if (.+?)( you control| you don't control| an opponent controls| your opponents control)? would deal (combat |noncombat )?damage to (.+?), prevent (\d+) of that damage$/i);
    if (!m) return null;
    const f = sourceFilter(m[1]); if (f === null || f === undefined) return null;
    const who = controlWord(m[2]?.trim() || undefined); if (who === null) return null;
    const to = recipientOf(m[4]); if (!to) return null;
    return {
      kind: 'damage-replacement',
      from: { ...(Object.keys(f).length ? { filter: f } : {}), ...(who === 'any' ? {} : { who }), ...combatOf(m[3]) },
      ...(Object.keys(to).length ? { to } : {}), instead: { mode: 'minus', amount: Number(m[5]) },
    } as StaticEffect;
  } },
  // "If a source you control would deal noncombat damage to a creature an opponent controls, put that many -1/-1
  //  counters on that creature instead." (CR 614.1a: the damage is replaced entirely, so none is dealt)
  { name: 'damage-as-counters', make: (line, card) => {
    if (isSpellCard(card)) return null;
    const m = norm(line).match(/^if (.+?)( you control| you don't control| an opponent controls| your opponents control)? would deal (combat |noncombat )?damage to (.+?), put that many ([+-]\d+\/[+-]\d+|[a-z]+) counters on (?:that|it) ?\w* instead$/i);
    if (!m) return null;
    const f = sourceFilter(m[1]); if (f === null || f === undefined) return null;
    const who = controlWord(m[2]?.trim() || undefined); if (who === null) return null;
    const to = recipientOf(m[4]); if (!to || to.players !== undefined) return null;   // counters only land on a permanent
    return {
      kind: 'damage-replacement',
      from: { ...(Object.keys(f).length ? { filter: f } : {}), ...(who === 'any' ? {} : { who }), ...combatOf(m[3]) },
      to, instead: { mode: 'counters', counter: m[5].toLowerCase() },
    } as StaticEffect;
  } },

  // ---- CR 614.1a on a zone change --------------------------------------------------------------------------------
  // "If ~ would die, exile it instead." / "If a creature an opponent controls would die, exile it instead."
  { name: 'zone-replacement-dies', make: (line, card) => {
    if (isSpellCard(card)) return null;
    const m = norm(line).match(/^if (~|a .+?)( you control| you don't control| an opponent controls| your opponents control)? would die, (exile it|put it on the bottom of its owner's library|return it to its owner's hand) instead$/i);
    if (!m) return null;
    const who = controlWord(m[2]?.trim() || undefined); if (who === null) return null;
    const would = m[1] === '~' ? { self: true as const } : dyingFilter(m[1]);
    if (!would) return null;
    if (m[1] === '~' && who !== 'any') return null;                                   // "if ~ you control would die" is not English
    const instead = /^exile/i.test(m[3]) ? { zone: 'exile' as const } : /^return/i.test(m[3]) ? { zone: 'hand' as const } : { zone: 'library' as const, pos: 'bottom' as const };
    return { kind: 'zone-replacement', would: { ...would, ...(who === 'any' || m[1] === '~' ? {} : { who }), to: 'graveyard', from: 'battlefield' }, instead } as StaticEffect;
  } },

  // ---- CR 614.1c on counters --------------------------------------------------------------------------------------
  // "If one or more +1/+1 counters would be put on a creature you control, twice that many +1/+1 counters are put on
  //  that creature instead." / "… that many plus one … instead." / "… that many minus one … instead."
  { name: 'counter-replacement', make: (line, card) => {
    if (isSpellCard(card)) return null;
    const m = norm(line).match(/^if one or more ([+-]\d+\/[+-]\d+|[a-z]+) counters would be (?:put|placed) on (.+?), (twice that many|that many plus (\w+)|that many minus (\w+)) \1 counters are (?:put|placed) on (?:it|that \w+) instead$/i);
    if (!m) return null;
    const on = countersTarget(m[2]); if (!on) return null;
    const plus = numWord(m[4]); const minus = numWord(m[5]);
    const instead = /^twice/i.test(m[3]) ? { mode: 'times' as const, factor: 2 }
      : plus !== null ? { mode: 'plus' as const, amount: plus }
        : minus !== null ? { mode: 'minus' as const, amount: minus } : null;
    if (!instead) return null;
    return { kind: 'counter-replacement', counter: m[1].toLowerCase(), ...on, instead } as StaticEffect;
  } },

  // ---- CR 614.1b on life gain, CR 121.6 on draws, CR 614.12 on entering ------------------------------------------
  { name: 'cant-gain-life', make: (line, card) => {
    if (isSpellCard(card)) return null;
    const m = norm(line).match(/^(players|you|your opponents|each opponent) can't gain life$/i);
    if (!m) return null;
    const w = m[1].toLowerCase();
    return { kind: 'cant-gain-life', who: w === 'you' ? 'you' : w === 'players' ? 'all' : 'opponent' } as StaticEffect;
  } },
  { name: 'skip-draw-step', make: (line, card) => {
    if (isSpellCard(card)) return null;
    // The card prints it as an instruction to its controller ("Skip your draw step.") or about the table.
    const m = norm(line).match(/^(?:(each player|each opponent|your opponents|players) skips? their|(?:you )?skip your) draw steps?$/i);
    if (!m) return null;
    const w = (m[1] ?? 'you').toLowerCase();
    return { kind: 'draw-replacement', who: w === 'you' ? 'you' : w === 'each player' || w === 'players' ? 'all' : 'opponent', instead: 'skip', drawStepOnly: true } as StaticEffect;
  } },
  { name: 'draw-extra-replacement', make: (line, card) => {
    if (isSpellCard(card)) return null;
    const m = norm(line).match(/^if you would draw a card(?: except the first one you draw in each of your draw steps)?, draw (\w+) cards instead$/i);
    if (!m) return null;
    const n = numWord(m[1]); if (n === null || n < 2) return null;
    return { kind: 'draw-replacement', who: 'you', instead: n, ...(/except the first/i.test(line) ? { exceptFirstInDrawStep: true } : {}) } as StaticEffect;
  } },
  { name: 'enters-untapped', make: (line, card) => {
    if (isSpellCard(card)) return null;
    const m = norm(line).match(/^(lands|creatures|artifacts|enchantments|permanents)( you control)? enter untapped$/i);
    if (!m) return null;
    const t = m[1].toLowerCase();
    const filter: Filter = t === 'permanents' ? {} : { types: [(t[0].toUpperCase() + t.slice(1, -1)) as 'Land'] };
    return { kind: 'enters-untapped', filter, who: m[2] ? 'you' : 'all' } as StaticEffect;
  } },
];

/** "a creature", "a creature dealt damage by ~ this turn", "a token" → the filter of a "would die" clause. */
function dyingFilter(desc: string): { filter: Filter } | null {
  const t = desc.trim().toLowerCase().replace(/^(a|an|another) /, '');
  const m = t.match(/^(creature|permanent|token|artifact|enchantment|land)( dealt damage by ~ this turn)?$/);
  if (!m) return null;
  const filter: Filter = m[1] === 'permanent' ? {} : m[1] === 'token' ? { token: true }
    : { types: [(m[1][0].toUpperCase() + m[1].slice(1)) as 'Creature'] };
  if (m[2]) filter.dealtDamageBySource = true;
  return { filter };
}

/** "a creature you control", "another creature you control", "a permanent" → the filter half of a counter replacement. */
function countersTarget(desc: string): { filter?: Filter; who?: 'you' | 'opponent' | 'any' } | null {
  const t = desc.trim().toLowerCase();
  const m = t.match(/^(?:a |an )?(another |other )?(creature|permanent|artifact|land|planeswalker)( you control| you don't control| an opponent controls)?$/);
  if (!m) return null;
  const who = controlWord(m[3]?.trim() || undefined); if (who === null) return null;
  const filter: Filter = m[2] === 'permanent' ? {} : { types: [(m[2][0].toUpperCase() + m[2].slice(1)) as 'Creature'] };
  if (m[1]) filter.other = true;
  return { ...(Object.keys(filter).length ? { filter } : {}), ...(who === 'any' ? {} : { who }) };
}

// ---------------------------------------------------------------------------------------------------------------
// Effect rules (spell text and the bodies of triggered / activated abilities)
// ---------------------------------------------------------------------------------------------------------------

const effects: EffectRule[] = [
  // "The next time a source of your choice would deal damage to you this turn, prevent that damage." (CR 615.10)
  // — with Deflecting Palm's rider, which is one replacement with the shield and cannot be a second sentence.
  { re: /^the next time (?:a|an) (.+?) of your choice would deal (combat |noncombat )?damage to (you|~) this turn, prevent that damage(?:\. if damage is prevented this way, ~ deals that much damage to (that source's controller|that source|any target))?$/i,
    make: (m) => {
      const f = sourceFilter(m[1] === 'source' ? 'source' : m[1]); if (f === null || f === undefined) return null;
      const to = m[3] === 'you' ? { players: 'you' as const } : { self: true as const };
      const rider = m[4] === undefined ? undefined
        : /controller/i.test(m[4]) ? { mode: 'damage-source-controller' as const }
          : /any target/i.test(m[4]) ? { mode: 'damage-targets' as const } : { mode: 'damage-source' as const };
      return {
        op: 'prevent', amount: 'next',
        from: { chosen: true, ...(Object.keys(f).length ? { filter: f } : {}), ...combatOf(m[2]) },
        to, duration: 'eot', ...(rider ? { rider } : {}),
      } as Effect;
    } },

  // "Prevent all damage that would be dealt to ~ this turn." (the built-in template only takes a target phrase)
  { re: /^prevent all (combat |noncombat )?damage that would be dealt to (~|you|enchanted \w+|equipped \w+) this turn$/i,
    make: (m) => {
      const to = m[2].toLowerCase() === 'you' ? { players: 'you' as const } : selfOrAttached(m[2]);
      if (!to) return null;
      const from = combatOf(m[1]);
      return { op: 'prevent', amount: 'all', ...(Object.keys(from).length ? { from } : {}), to, duration: 'eot' } as Effect;
    } },

  // "Prevent all combat damage that would be dealt this turn by creatures with power 3 or less." — the source half.
  { re: /^prevent all (combat |noncombat )?damage that would be dealt this turn by (.+)$/i,
    make: (m) => {
      const f = sourceFilter(m[2]); if (f === null || f === undefined) return null;
      return { op: 'prevent', amount: 'all', from: { ...(Object.keys(f).length ? { filter: f } : {}), ...combatOf(m[1]) }, to: {}, duration: 'eot' } as Effect;
    } },

  // "Prevent the next 1 damage that would be dealt to ~ this turn." (the built-in template wants a target phrase)
  { re: /^prevent the next (\w+) (combat |noncombat )?damage that would be dealt to (~|you|enchanted \w+|equipped \w+) this turn$/i,
    make: (m) => {
      const n = numWord(m[1]); if (n === null || n <= 0) return null;
      const to = m[3].toLowerCase() === 'you' ? { players: 'you' as const } : selfOrAttached(m[3]);
      if (!to) return null;
      const from = combatOf(m[2]);
      return { op: 'prevent', amount: n, ...(Object.keys(from).length ? { from } : {}), to, duration: 'eot' } as Effect;
    } },

  // The rider half of the same replacement effect, printed as its own sentence (CR 615.1). It is a no-op unless a
  // `prevent` ran before it in the same resolution, which is exactly what the cards that print it do.
  { re: /^you gain life equal to the damage prevented this way$/i, make: () => ({ op: 'prevent-rider', rider: { mode: 'gain-life' } } as Effect) },
  { re: /^if damage is prevented this way, ~ deals that much damage to (that source's controller|that source|any target)$/i,
    make: (m) => (/controller/i.test(m[1])
      ? { op: 'prevent-rider', rider: { mode: 'damage-source-controller' } }
      : /any target/i.test(m[1])
        ? { op: 'prevent-rider', rider: { mode: 'damage-targets' }, target: { kind: 'any' } }
        : { op: 'prevent-rider', rider: { mode: 'damage-source' } }) as Effect },
  { re: /^for each 1 damage prevented this way, put a ([+-]\d+\/[+-]\d+|[a-z]+) counter on that creature$/i,
    make: (m) => ({ op: 'prevent-rider', rider: { mode: 'counters', counter: m[1].toLowerCase() } } as Effect) },

  // CR 615.6 as a one-turn effect: "Damage can't be prevented this turn."
  { re: /^(combat |noncombat )?damage can't be prevented this turn$/i,
    make: (m) => ({ op: 'damage-cant-be-prevented', ...(Object.keys(combatOf(m[1])).length ? { match: { ...combatOf(m[1]) } } : {}), duration: 'eot' } as Effect) },
];

// ---------------------------------------------------------------------------------------------------------------
// Line rules: the "as ~ enters" replacements (CR 614.12), which are not statics and not sentences
// ---------------------------------------------------------------------------------------------------------------

const lines: LineRule[] = [
  // "As ~ enters, choose a basic land type." — on its own, or followed by the shockland clause on the same line
  // (Multiversal Passage): both halves are as-enters replacements applied in printed order.
  { name: 'as-enters-choose-basic-land-type', match: (line, ctx) => {
    if (ctx.isSpell) return false;
    const m = line.trim().replace(/\.$/, '').match(/^as ~ enters, choose a basic land type(?:\. then you may pay (\d+) life\. if you don't, it enters tapped)?$/i);
    if (!m) return false;
    ctx.addAsEnters({ kind: 'choose-type', what: 'basic-land-type' });
    if (m[1]) ctx.addAsEnters({ kind: 'pay-life-or-tapped', life: Number(m[1]) });
    return true;
  } },
];

const replacement: RuleFamily = { name: 'replacement', statics, effects, lines };
export default replacement;
