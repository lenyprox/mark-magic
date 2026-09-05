// Parser rules for the `cost-alter` family (src/engine/ops/cost-alter.ts): the oracle wordings that produce its
// statics, its cost parts and its ops. Consulted only after every built-in stage has declined the text
// (src/cards/rules/types.ts), so a parse that worked before is untouched — `npm run parse:diff` is the check.
//
// Four kinds are registered here:
//   `costs`    — the cost phrases the built-in table cannot read: "Pay {W}{U}{B}{R}{G}" (the built-in phrase table
//                matches a bare "{2}{G}" but not the word "pay" in front of it, which is what every
//                "You may pay … rather than pay ~'s mana cost" line spells), counted sacrifices and returns,
//                "Exile ~", and a filtered exile from the graveyard.
//   `lines`    — "~ costs {2} less to cast if <condition>", "Hideaway N", "If <condition>, you may cast ~ without
//                paying its mana cost", "You may cast ~ from your graveyard by discarding a card …", and the
//                "{2}{B}, Exile ~ from your graveyard: …" activated shape (which the built-ins cannot read because
//                the ability has to be marked `fromGraveyard`).
//   `statics`  — "Spells you cast from your graveyard cost {1} less to cast", "The second spell you cast each turn
//                costs {2} less to cast".
//   `effects`  — "You may cast a spell with mana value X or less from your hand without paying its mana cost".
//
// A rule never imports a parse.ts internal; the sub-parsers arrive on `LineCtx` / `EffectCtx`. `CostRule.make` is
// handed no context at all, so the two vocabularies a cost phrase needs — mana symbols and a small filter of plain
// types and basic land names — are spelled out below rather than guessed at.
import type { AbilityCost, Amount, Condition, Filter, ManaCost, StaticEffect } from '../types.js';
import type { RuleFamily } from './types.js';

// ------------------------------------------------------------------ small local vocabularies

/** "{2}{W/U}{X}" → a ManaCost, exactly as parse.ts:parseManaCost reads one (a cost rule cannot call it). */
function manaCost(raw: string): ManaCost | null {
  const cost: ManaCost = { generic: 0, x: 0, pips: [], hybrid: [], phyrexian: [], raw };
  const re = /\{([^}]+)\}/g; let m: RegExpExecArray | null; let seen = 0;
  while ((m = re.exec(raw))) {
    const p = m[1]; seen++;
    if (/^\d+$/.test(p)) cost.generic += Number(p);
    else if (p === 'X') cost.x++;
    else if (/^[WUBRG]$/.test(p) || p === 'C') cost.pips.push(p as ManaCost['pips'][number]);
    else if (/^[WUBRG]\/P$/.test(p)) cost.phyrexian.push(p[0] as ManaCost['phyrexian'][number]);
    else if (/^[WUBRG]\/[WUBRG]$/.test(p)) cost.hybrid.push(p.split('/') as ManaCost['pips']);
    else if (/^2\/[WUBRG]$/.test(p)) cost.hybrid.push([p[2] as ManaCost['pips'][number], 'C']);
    else return null;                                       // an exotic symbol: decline rather than mis-price it
  }
  return seen ? cost : null;
}

const WORD_NUM: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
/** "two" / "3" → 2 / 3, or null for a word this family will not guess at. */
function count(w: string): number | null {
  const n = WORD_NUM[w.toLowerCase()] ?? (/^\d+$/.test(w) ? Number(w) : null);
  return n && n > 0 ? n : null;
}

const BASICS = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];
const PLAIN_TYPES: Record<string, Filter> = {
  creature: { types: ['Creature'] }, artifact: { types: ['Artifact'] }, land: { types: ['Land'] },
  enchantment: { types: ['Enchantment'] }, permanent: {}, instant: { types: ['Instant'] }, sorcery: { types: ['Sorcery'] },
};
/**
 * The narrow filter vocabulary a cost phrase may use: a plural plain type ("creatures") or a plural basic land name
 * ("Mountains"), optionally "you control" (which a sacrifice or a return already implies). Anything else declines —
 * a cost rule has no `parseFilterWords`, and a filter this family invented would disagree with the rest of the
 * vocabulary (see the subtype-vocabulary note in docs/vocabulary/composition.md §8).
 */
function costFilter(words: string): Filter | null {
  const w = words.trim().replace(/ you control$/i, '').replace(/ cards?$/i, '');
  const singular = w.replace(/s$/, '');
  const basic = BASICS.find(b => b.toLowerCase() === singular.toLowerCase());
  if (basic) return { subtypes: [basic] };
  const plain = PLAIN_TYPES[singular.toLowerCase()];
  return plain ? { ...plain } : null;
}

/** A `{N}` mana-symbol amount as a plain number ("costs {2} less"). */
const braces = (s: string): number => Number(s.replace(/[{}]/g, ''));

// ------------------------------------------------------------------ the family

const COST_ALTER_RULES: RuleFamily = {
  name: 'cost-alter',

  // ---------------------------------------------------------------- cost phrases
  costs: [
    // "Pay {W}{U}{B}{R}{G}" / "pay {1}" — the built-in table reads a bare symbol run, never one with "pay" in front,
    // which is the whole reason every "You may pay … rather than pay ~'s mana cost" line is unparsed (CR 118.9).
    { name: 'pay-mana', make: p => { const m = p.match(/^pay ((?:\{[^}]+\})+)$/i); const c = m && manaCost(m[1]); return c ? { mana: c } : null; } },
    // "Sacrifice two Mountains" / "Sacrifice two creatures" — the built-in part sacrifices exactly one (CR 601.2h).
    {
      name: 'sacrifice-many',
      make: p => {
        const m = p.match(/^sacrifice (\w+) (.+)$/i); if (!m) return null;
        const n = count(m[1]); const f = costFilter(m[2]);
        return n && n > 1 && f ? { sacrificeMany: { filter: f, count: n } } : null;
      },
    },
    // "Return two Islands you control to their owner's hand" (Sea Drake's alternative cost).
    {
      name: 'return-many',
      make: p => {
        const m = p.match(/^return (\w+) (.+?) you control to (?:their|its) owner'?s'? hand$/i); if (!m) return null;
        const n = count(m[1]); const f = costFilter(m[2]);
        return n && n > 1 && f ? { returnToHandMany: { filter: f, count: n } } : null;
      },
    },
    // "Exile ~" (CR 118.3): the source pays with itself. Deliberately NOT "Exile ~ from your graveyard" — that shape
    // must reach the `activated-from-graveyard` line rule below, which is the only place the ability can be marked
    // `fromGraveyard`; claiming the phrase here would let the built-in activated branch build an ability that legal.ts
    // never offers, and the card would look fully parsed while the ability was unusable.
    { name: 'exile-self', make: p => /^exile ~$/i.test(p) ? { exileSelf: true } : null },
    // "Exile three creature cards from your graveyard" — the built-in part counts but cannot filter.
    {
      name: 'exile-graveyard-matching',
      make: p => {
        const m = p.match(/^exile (\w+) (.+?) cards? from your graveyard$/i); if (!m) return null;
        const n = count(m[1]); const f = costFilter(m[2]);
        return n && f ? { exileFromGraveyardMatching: { count: n, filter: f } } : null;
      },
    },
  ],

  // ---------------------------------------------------------------- whole lines
  lines: [
    // "Hideaway N" (CR 702.75) — a keyword the built-ins know of but do not implement, so this rule is offered the
    // line inside the keyword bail-out. The exiled card stays linked to the source, which is how the card's own
    // "you may play that card" line reaches it.
    {
      name: 'hideaway',
      match: (line, ctx) => {
        const m = line.match(/^hideaway (\d+)\.?$/i); if (!m) return false;
        ctx.addAbility({ kind: 'triggered', event: { on: 'etb', self: true }, effects: [{ op: 'hideaway', count: Number(m[1]) }], text: line });
        return true;
      },
    },
    // "~ costs {2} less to cast if a creature died this turn" / "… {2} more to cast if …" (CR 601.2f).
    {
      name: 'self-cost-if',
      match: (line, ctx) => {
        const m = line.match(/^~ costs (\{\d+\}) (less|more) to cast if (.+?)\.?$/i); if (!m) return false;
        const cond: Condition = ctx.parseCondition(m[3]);
        if (cond.kind === 'unknown') return false;
        const effect: StaticEffect = { kind: 'cost-alter', amount: braces(m[1]), self: true, condition: cond, ...(m[2].toLowerCase() === 'more' ? { more: true as const } : {}) };
        ctx.addAbility({ kind: 'static', effect, text: line });
        return true;
      },
    },
    // "~ costs {1} less to cast for each creature in your party" (CR 700.7).
    {
      name: 'self-cost-party',
      match: (line, ctx) => {
        const m = line.match(/^~ costs (\{\d+\}) less to cast for each creature in your party\.?$/i); if (!m) return false;
        const amount: Amount = braces(m[1]) === 1 ? { count: 'party' } : { count: 'party', times: braces(m[1]) };
        ctx.addCostModifier({ kind: 'reduce', amount });
        return true;
      },
    },
    // "~ costs {X} less to cast, where X is the greatest power among creatures you control" — the composition core's
    // aggregate amount (docs/vocabulary/composition.md §2).
    {
      name: 'self-cost-greatest-power',
      match: (line, ctx) => {
        const m = line.match(/^~ costs \{x\} less to cast, where x is the (greatest|highest) (power|toughness) among creatures you control\.?$/i); if (!m) return false;
        ctx.addCostModifier({ kind: 'reduce', amount: { prop: m[2].toLowerCase() as 'power', agg: 'max', over: { types: ['Creature'], who: 'you' } } });
        return true;
      },
    },
    // "If you control a commander, you may cast ~ without paying its mana cost." (CR 118.9b) — an alternative cost
    // of nothing at all, which is exactly what an `AltCost` with no mana is.
    {
      name: 'free-cast-if',
      match: (line, ctx) => {
        const m = line.match(/^if (.+?), you may cast ~ without paying its mana cost\.?$/i); if (!m) return false;
        const cond = ctx.parseCondition(m[1]);
        if (cond.kind === 'unknown') return false;
        ctx.addAltCost({ id: 'free-cast', label: 'without paying its mana cost', cost: {}, condition: cond, from: 'hand' });
        return true;
      },
    },
    // "You may cast ~ from your graveyard by discarding a card in addition to paying its other costs." (CR 601.2b):
    // the printed mana cost plus the extra, cast from the graveyard.
    {
      name: 'cast-from-graveyard-plus',
      match: (line, ctx) => {
        const m = line.match(/^you may cast ~ from your graveyard by discarding (\w+) cards? in addition to paying its other costs\.?$/i); if (!m) return false;
        const n = count(m[1]); if (!n || !ctx.def.manaCost) return false;
        ctx.addAltCost({ id: 'from-graveyard', label: `from graveyard, discard ${n}`, cost: { mana: ctx.def.manaCost, discard: n }, from: 'graveyard' });
        return true;
      },
    },
    // "{2}{B}, Exile ~ from your graveyard: Put a flying counter … Activate only as a sorcery." — the built-in
    // activated shape cannot mark the ability `fromGraveyard`, so the whole line is claimed here.
    {
      name: 'activated-from-graveyard',
      match: (line, ctx) => {
        const m = line.match(/^(.+?), exile ~ from your graveyard: (.+)$/i); if (!m) return false;
        const body = m[2].replace(/\s*Activate only as a sorcery\.?\s*$/i, '');
        const sorcery = body !== m[2];
        if (/\bactivate only\b/i.test(body)) return false;              // another restriction: leave it unparsed
        const cost: AbilityCost | null = ctx.parseCost(m[1]);
        if (!cost) return false;
        const effects = ctx.parseEffects(body);
        if (!effects.length || effects.some(e => e.op === 'unknown')) return false;
        // `exileSelfFromGraveyard`, not `exileSelf`: the cost part carries the zone the ability functions in
        // (CR 113.6b, 118.4). legal.ts's battlefield scan does not skip `ab.fromGraveyard`, so a part payable from
        // the battlefield would let the permanent exile itself from PLAY to get this ability's effect.
        ctx.addAbility({ kind: 'activated', cost: { ...cost, exileSelfFromGraveyard: true }, effects, text: line, fromGraveyard: true, ...(sorcery ? { sorcerySpeed: true } : {}) });
        return true;
      },
    },
  ],

  // ---------------------------------------------------------------- static lines
  statics: [
    // "Spells you cast from your graveyard cost {1} less to cast" — the core `cost-adjust` static knows only
    // `from: 'non-hand'`, never a named zone.
    {
      name: 'spells-from-zone-cost',
      make: line => {
        const m = line.match(/^spells you cast from your (graveyard|exile) cost (\{\d+\}) (less|more) to cast\.?$/i); if (!m) return null;
        return { kind: 'cost-alter', amount: braces(m[2]), who: 'you', from: m[1].toLowerCase() === 'exile' ? 'exile' : 'graveyard', ...(m[3].toLowerCase() === 'more' ? { more: true as const } : {}) };
      },
    },
    // "The second spell you cast each turn costs {2} less to cast" (CR 601.2f).
    {
      name: 'nth-spell-cost',
      make: line => {
        const m = line.match(/^the (first|second|third|fourth) spell you cast each turn costs (\{\d+\}) (less|more) to cast\.?$/i); if (!m) return null;
        const nth = { first: 1, second: 2, third: 3, fourth: 4 }[m[1].toLowerCase()] ?? 2;
        return { kind: 'cost-alter', amount: braces(m[2]), who: 'you', nthSpellEachTurn: nth, ...(m[3].toLowerCase() === 'more' ? { more: true as const } : {}) };
      },
    },
  ],

  // ---------------------------------------------------------------- sentences
  effects: [
    // "You may cast a spell with mana value X or less from your hand without paying its mana cost." (Electrodominance)
    // parse.ts strips the leading "You may " and wraps what this returns in a `may`, so the op stays bare.
    {
      re: /^cast a spell with mana value (x|\d+) or less from your (hand|graveyard) without paying its mana cost$/i,
      make: m => ({ op: 'cast-free', from: m[2].toLowerCase() as 'hand', mvLE: (m[1].toLowerCase() === 'x' ? 'X' : Number(m[1])) as Amount }),
    },
    // "You may play the exiled card without paying its mana cost" — the payoff half of Hideaway (CR 702.75b) and of
    // every "exile … you may play that card" line whose card is linked to the source (`exiledWith`). A land among
    // them cannot be played this way (the engine has no play-land-from-exile action): see the family doc.
    {
      re: /^(?:play|cast) the exiled cards? without paying (?:its|their) mana costs?$/i,
      make: () => ({ op: 'cast-free', from: 'exiled-with' }),
    },
  ],
};

export default COST_ALTER_RULES;
