// Round-trip renderer (plan 2.2 stage 6): deterministic English for every node of the ability AST, and the score
// that compares one oracle LINE against the rendering of the ability that claims it.
//
// The point is not prose. It is a MECHANICAL CROSS-CHECK on a script: an author (or an LLM) who writes
// `{ op: 'damage', amount: 2 }` for the line "~ deals 3 damage to any target." produces a rendering whose numbers do
// not match the line, and the card fails verification. So the templates are deliberately literal and terse — every
// content word the oracle prints, in the oracle's own vocabulary, and nothing else. Extra words only cost Jaccard.
//
// Coverage is total by construction: `renderEffect` switches on every op in `CoreEffect`, `renderCondition` on every
// `CoreCondition`, `renderTrigger` on every `CoreTriggerEvent` and `renderStatic` on every `CoreStaticEffect`; a
// FAMILY op is rendered by its own `render` entry in the registry barrel (`RENDERERS`), and an op with neither is
// rendered as `<op …>` and reported by `renderGaps` as a renderer gap the batch report prints. `test/render.test.ts`
// pins the calibration: the median score over a seeded sample of 400 parser-produced cards stays >= 0.55.
//
// TOOLING ONLY (like src/cards/schema.ts): nothing under src/engine, src/sim, src/ai or apps/web imports this.
import { RENDERERS } from '../engine/ops/_registry.js';
import { KEYWORDS } from './schema.js';
import { abilityClaimLines, COVER_KINDS, coverProblem, keywordLineClaimed, type CoverKind, type KeywordParams } from './scripts.js';
import type {
  Ability, AbilityCost, AltCost, Amount, AsEnters, CardDef, Condition, CostModifier, Effect, Filter, Keyword,
  ManaCost, ObjectSet, Ref, StaticEffect, TargetSpec, TriggerEvent,
} from './types.js';

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

/** A kebab-cased AST word as English: `each-opponent` -> `each opponent`. The fallback for every enum. */
const words = (s: string): string => s.replace(/[-:]/g, ' ').trim();
/** Join a list the way oracle text does: "a, b, and c". */
const list = (xs: string[], conj = 'and'): string =>
  xs.length <= 1 ? (xs[0] ?? '') : xs.length === 2 ? `${xs[0]} ${conj} ${xs[1]}` : `${xs.slice(0, -1).join(', ')}, ${conj} ${xs[xs.length - 1]}`;
const plural = (n: string, word: string): string => (n === '1' ? word : `${word}s`);
/** A signed pump term: `+2`, `-1`, `+X`. */
const signed = (a: Amount): string => { const s = renderAmount(a); return /^[+-]/.test(s) ? s : `+${s}`; };
/** Whether an anthem / aura / equipment grants no P/T at all — `+0/+0` is a bonus the oracle never prints. */
const zeroPT = (x: Record<string, unknown>): boolean => x.power === 0 && x.toughness === 0;
const dropEmpty = (xs: (string | undefined | null | false)[]): string[] => xs.filter((x): x is string => !!x && x.trim() !== '');
/** Sentence-join: the pieces of one ability, separated the way oracle text separates clauses. */
const sentences = (xs: string[]): string => dropEmpty(xs).join('. ');

/**
 * "you may <body>", with the SUBJECT written once. An optional triggered ability whose only effect is itself a `may`
 * / `optional-pay`, and a `may` around an effect that names its own actor, both used to print the subject twice
 * ("you may you may pay {2}", "you may you draw a card") — noise that cost every such card real score.
 */
const may = (body: string, you = 'you'): string =>
  !body ? '' : body.startsWith(`${you} may `) ? body
    : body.startsWith(`${you} `) ? `${you} may ${body.slice(you.length + 1)}` : `${you} may ${body}`;

/** The English for a `duration` field. `permanent` prints nothing — oracle text says nothing either. */
const duration = (d: 'eot' | 'permanent' | undefined): string => (d === 'eot' ? 'until end of turn' : '');

/** A mana cost as the symbols it prints (`{2}{R}`); the raw string is what the oracle line carries. */
export function renderMana(m: ManaCost | undefined): string { return m?.raw ?? ''; }

// ---------------------------------------------------------------------------
// Leaves: amounts, filters, targets, refs, costs
// ---------------------------------------------------------------------------

/** The English of an `Amount.count`: `creatures-you-control` -> `the number of creatures you control`. */
const COUNT_PHRASE: Record<string, string> = {
  'creatures-you-control': 'creatures you control', 'cards-in-hand': 'cards in your hand',
  'lands-you-control': 'lands you control', 'power-of-source': "~'s power", 'creatures-attacking': 'attacking creatures',
  'opponent-creatures': 'creatures your opponents control', 'life-lost-this-turn': 'life you lost this turn',
  'permanents-you-control': 'permanents you control', domain: 'basic land types among lands you control',
  'exiled-with': 'cards exiled with ~', 'cards-in-graveyard': 'cards in your graveyard',
  'power-of-that': "that creature's power", 'mv-of-that': "that spell's mana value",
  'colors-spent': 'colors of mana spent to cast it', 'card-types-in-graveyard': 'card types among cards in your graveyard',
  'card-types-in-all-graveyards': 'card types among cards in all graveyards', 'counters-on-source': 'counters on ~',
  'counters-on-permanents': 'counters on permanents you control', 'that-many': 'that many',
  'commander-casts': 'times your commander was cast', opponents: 'opponents you have',
  'player-counters': 'counters you have', 'cards-drawn-this-turn': 'cards you have drawn this turn',
  'permanents-on-battlefield': 'permanents on the battlefield', 'creatures-died-this-turn': 'creatures that died this turn',
  'attached-to-source': 'creatures attached to ~', 'blocking-source': 'creatures blocking ~',
  'cards-in-all-hands': 'cards in all hands', 'spells-cast-this-turn': 'spells cast this turn',
};

/**
 * An `Amount` as the oracle prints it: a literal number, `X`, or the count expression's phrase
 * ("the number of creatures you control", "twice the number of…", "half that much, rounded up").
 */
export function renderAmount(a: Amount | undefined): string {
  if (a === undefined) return '';
  if (typeof a === 'number') return String(a);
  if (a === 'X') return 'X';
  if (a.prop !== undefined) return `${renderRef(a.of ?? 'that')}'s ${a.prop === 'mv' ? 'mana value' : words(a.prop)}`;
  if (a.diff) return `the difference between ${renderAmount(a.diff[0])} and ${renderAmount(a.diff[1])}`;
  if (a.sum) return `the total of ${list(a.sum.map(renderAmount))}`;
  if (Array.isArray(a.max)) return `the greatest of ${list(a.max.map(renderAmount))}`;
  if (a.min) return `the least of ${list(a.min.map(renderAmount))}`;
  const base = a.count === 'objects'
    ? `the number of ${renderFilter(a.filter ?? {}, 'permanent')}${a.zone && a.zone !== 'battlefield' ? ` in ${zoneOf(a.zone, a.who)}` : ''}${a.who && a.who !== 'you' ? ` ${words(a.who)}` : ''}`
    : `the number of ${COUNT_PHRASE[a.count ?? ''] ?? words(a.count ?? '')}`;
  const scaled = a.times !== undefined && a.times !== 1 ? `${a.times === 2 ? 'twice' : `${a.times} times`} ${base}` : base;
  const halved = a.half ? `half ${scaled}, rounded ${a.half}` : scaled;
  const plus = a.plus ? `${halved} plus ${a.plus}` : halved;
  return typeof a.max === 'number' ? `${plus}, up to ${a.max}` : plus;
}

/** A zone as oracle text names it, from the point of view of `who` (default: the acting player). */
function zoneOf(zone: string, who?: string): string {
  const whose = who === undefined || who === 'you' ? 'your' : `${words(who)}'s`;
  if (zone === 'battlefield') return 'the battlefield';
  if (zone === 'exile') return 'exile';
  if (zone === 'command') return 'the command zone';
  return `${whose} ${zone}`;
}

const COLOR_WORD: Record<string, string> = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green', C: 'colorless' };

/**
 * A `Filter` as the noun phrase the oracle prints — "another red Goblin creature you control with power 2 or less".
 * `fallback` is the head noun when the filter names no card type ("creature", "card", "permanent").
 */
export function renderFilter(f: Filter | undefined, fallback = 'creature'): string {
  if (!f) return fallback;
  const pre: string[] = [];
  if (f.other) pre.push('another');
  if (f.basic) pre.push('basic');
  if (f.nonbasic) pre.push('nonbasic');
  if (f.tapped) pre.push('tapped');
  if (f.untapped) pre.push('untapped');
  if (f.attacking) pre.push('attacking');
  if (f.blocking) pre.push('blocking');
  if (f.token) pre.push('token');
  if (f.nontoken) pre.push('nontoken');
  if (f.colorless) pre.push('colorless');
  for (const c of f.colors ?? []) pre.push(COLOR_WORD[c] ?? c);
  for (const c of f.notColors ?? []) pre.push(`non${COLOR_WORD[c] ?? c}`);
  for (const t of f.notTypes ?? []) pre.push(`non${t.toLowerCase()}`);
  if (f.chosenType) pre.push('of the chosen type');
  for (const s of f.subtypes ?? []) pre.push(s);
  // a filter with a SUBTYPE and no card type needs no head noun: the oracle prints "a Mountain", "another Goblin"
  const head = f.types?.length ? f.types.map(t => t.toLowerCase()).join(' ') : f.subtypes?.length ? '' : fallback;
  const post: string[] = [];
  if (f.flying) post.push('with flying');
  if (f.withKeyword) post.push(`with ${f.withKeyword}`);
  if (f.powerLE !== undefined) post.push(`with power ${f.powerLE} or less`);
  if (f.powerGE !== undefined) post.push(`with power ${f.powerGE} or greater`);
  if (f.toughnessLE !== undefined) post.push(`with toughness ${f.toughnessLE} or less`);
  if (f.toughnessGtPower) post.push('with toughness greater than its power');
  if (f.mvLE !== undefined) post.push(`with mana value ${renderAmount(f.mvLE as Amount)} or less`);
  if (f.mvGE !== undefined) post.push(`with mana value ${f.mvGE} or greater`);
  if (f.mvEQ !== undefined) post.push(`with mana value ${renderAmount(f.mvEQ as Amount)}`);
  if (f.withCounter) post.push(`with a ${f.withCounter} counter on it`);
  else if (f.withCounters) post.push('with a counter on it');
  return dropEmpty([...pre, head, ...post]).join(' ');
}

/**
 * A noun phrase for a filter in a zone: on the battlefield oracle text says "creature", everywhere else it says
 * "creature card" — and the word `card` is what a line naming a graveyard or a hand prints.
 */
function zoneNoun(f: Filter | undefined, zone: string | undefined): string {
  const offBattlefield = !!zone && zone !== 'battlefield';
  const noun = renderFilter(f, offBattlefield ? 'card' : 'permanent');
  return offBattlefield && (f?.types?.length || f?.subtypes?.length) ? `${noun} card` : noun;
}

/** An `ObjectSet` (a filter plus where and whose) as "creatures you control", "cards in each opponent's graveyard". */
export function renderObjectSet(o: ObjectSet): string {
  const noun = zoneNoun(o, o.zone);
  const whose = o.who === 'you' ? 'you control' : o.who === 'each-opponent' ? 'your opponents control' : o.who ? `${words(o.who)} controls` : '';
  if (o.zone && o.zone !== 'battlefield') return `${noun} in ${zoneOf(o.zone, o.who)}`;
  return dropEmpty([noun, whose]).join(' ');
}

/** A `Ref` — what "it" / "that creature" / "them" stand for in the oracle line the effect came from. */
export function renderRef(r: string): string {
  switch (r) {
    case 'self': return '~';
    case 'that': case 'triggering': return 'that permanent';
    case 'those': return 'those permanents';
    case 'enchanted': return 'enchanted creature';
    case 'equipped': return 'equipped creature';
    case 'sacrificed': return 'the sacrificed permanent';
    case 'exiled-with': return 'the exiled card';
    case 'you': return 'you';
    default: return r.startsWith('target:') ? 'that permanent' : words(r);
  }
}

/** The noun a `TargetSpec.kind` names, without the word "target". */
const TARGET_NOUN: Record<string, string> = {
  creature: 'creature', player: 'player', any: 'any target', permanent: 'permanent', spell: 'spell',
  'creature-or-player': 'creature or player', 'creature-or-planeswalker': 'creature or planeswalker',
  planeswalker: 'planeswalker', opponent: 'opponent', artifact: 'artifact', enchantment: 'enchantment',
  land: 'land', 'nonland-permanent': 'nonland permanent', 'artifact-or-enchantment': 'artifact or enchantment',
  'creature-spell': 'creature spell', 'noncreature-spell': 'noncreature spell',
  'attacking-creature': 'attacking creature', 'blocking-creature': 'blocking creature',
  'tapped-creature': 'tapped creature', ability: 'ability',
  'artifact-enchantment-or-nonbasic-land': 'artifact, enchantment, or nonbasic land',
  'spell-or-nonland-permanent': 'spell or nonland permanent', 'graveyard-card': 'card in a graveyard',
};

/**
 * A target as the oracle prints it: `target creature you control`, `up to two target lands`, `any target`.
 * A `Ref` or one of the literal group words (`all-creatures`, `each-opponent`) is rendered as its own phrase.
 */
export function renderTarget(t: TargetSpec | Ref | string | undefined): string {
  if (t === undefined) return '';
  if (typeof t === 'string') {
    if (t.startsWith('all-') || t.startsWith('each-') || t.endsWith('-you-control') || t.endsWith('-creatures')) return words(t);
    return renderRef(t);
  }
  if (t.kind === 'multi') return list((t.specs ?? []).map(renderTarget));
  const noun = TARGET_NOUN[t.kind] ?? words(t.kind);
  const filtered = t.filter ? `${renderFilter(t.filter, noun === 'any target' ? 'permanent' : noun)}` : noun;
  const control = t.controller === 'you' ? ' you control' : t.controller === 'opponent' ? " an opponent controls" : '';
  const n = t.count ?? 1;
  const head = t.optional ? `up to ${n === 1 ? 'one' : n} target` : n === 1 ? 'target' : `${n} target`;
  // "any target" already contains its own quantifier; the parser never counts or makes it optional
  if (t.kind === 'any' && !t.filter && n === 1 && !t.optional) return 'any target';
  return `${head} ${n === 1 ? filtered : plural(String(n), filtered)}${control}`;
}

/** One `AbilityCost` as the oracle prints a cost line: `{2}{R}, {T}, Sacrifice a creature`. */
export function renderCost(c: AbilityCost | undefined): string {
  if (!c) return '';
  const parts: string[] = [];
  if (c.mana) parts.push(renderMana(c.mana));
  if (c.tap) parts.push('{T}');
  if (c.untap) parts.push('{Q}');
  if (c.sacrificeSelf) parts.push('sacrifice ~');
  if (c.sacrifice) parts.push(`sacrifice a ${renderFilter(c.sacrifice)}`);
  if (c.discard !== undefined) parts.push(`discard ${c.discard} ${plural(String(c.discard), 'card')}`);
  if (c.discardSelf) parts.push('discard ~');
  if (c.discardHand) parts.push('discard your hand');
  if (c.energy !== undefined) parts.push(`pay ${c.energy} {E}`);
  if (c.payLife !== undefined) parts.push(`pay ${c.payLife} life`);
  if (c.removeCounters) parts.push(`remove ${renderAmount(c.removeCounters.amount as Amount)} ${c.removeCounters.counter} ${plural(String(c.removeCounters.amount), 'counter')} from ~`);
  if (c.exileFromGraveyard !== undefined) parts.push(`exile ${c.exileFromGraveyard} ${plural(String(c.exileFromGraveyard), 'card')} from your graveyard`);
  if (c.exileOtherFromGraveyard) parts.push(`exile ${c.exileOtherFromGraveyard.count === 'any' ? 'any number of' : c.exileOtherFromGraveyard.count} other cards from your graveyard`);
  if (c.exileFromHand) parts.push(`exile ${c.exileFromHand.count} ${renderFilter(c.exileFromHand.filter, 'card')} from your hand`);
  if (c.returnToHand) parts.push(`return a ${renderFilter(c.returnToHand)} you control to its owner's hand`);
  if (c.tapUntappedCreature) parts.push(`tap an untapped ${renderFilter(c.tapUntappedCreature)} you control`);
  if (c.tapCreaturesTotalPower) parts.push(`tap any number of ${c.tapCreaturesTotalPower.other ? 'other ' : ''}creatures you control with total power ${c.tapCreaturesTotalPower.power} or greater`);
  // a family cost part with no core field: name the key so the number it carries still reaches the score
  for (const [k, v] of Object.entries(c as Record<string, unknown>)) {
    if (CORE_COST_FIELDS.has(k) || v === undefined) continue;
    parts.push(`${words(k)}${typeof v === 'number' || typeof v === 'string' ? ` ${String(v)}` : ''}`);
  }
  return parts.join(', ');
}

const CORE_COST_FIELDS: ReadonlySet<string> = new Set([
  'mana', 'tap', 'untap', 'sacrificeSelf', 'sacrifice', 'discard', 'discardSelf', 'energy', 'discardHand', 'payLife',
  'removeCounters', 'exileFromGraveyard', 'exileOtherFromGraveyard', 'exileFromHand', 'returnToHand',
  'tapUntappedCreature', 'tapCreaturesTotalPower',
]);

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

/** The ability words and no-payload conditions, in the wording the card prints them with. */
const NULLARY_CONDITION: Record<string, string> = {
  'self-entered-this-turn': '~ entered the battlefield this turn', 'opponent-more-lands': 'an opponent controls more lands than you',
  'self-was-cast': '~ was cast', 'self-in-graveyard': '~ is in your graveyard',
  'descended-this-turn': 'a permanent card was put into your graveyard from anywhere this turn',
  threshold: 'seven or more cards are in your graveyard', metalcraft: 'you control three or more artifacts',
  delirium: 'there are four or more card types among cards in your graveyard', kicked: 'it was kicked',
  raid: 'you attacked this turn', morbid: 'a creature died this turn', revolt: 'a permanent you controlled left the battlefield this turn',
  'spell-mastery': 'there are two or more instant and sorcery cards in your graveyard',
  ferocious: 'you control a creature with power 4 or greater', formidable: 'creatures you control have total power 8 or greater',
  hellbent: 'you have no cards in hand', 'landfall-this-turn': 'a land entered the battlefield under your control this turn',
  'not-your-turn': "it's not your turn", 'your-turn': "it's your turn", escaped: 'it escaped', evoked: 'it was evoked',
  'cast-from-hand': 'it was cast from your hand', 'self-not-renowned': '~ is not renowned', 'self-attacking': '~ is attacking',
  'self-tapped': '~ is tapped', 'self-untapped': '~ is untapped', 'more-life-than-opponent': 'you have more life than an opponent',
  'opponent-more-life': 'an opponent has more life than you', 'you-lost-life-this-turn': 'you lost life this turn',
  'opponent-hellbent': 'an opponent has no cards in hand', 'controls-commander': 'you control your commander',
  'opponent-lost-life-this-turn': 'an opponent lost life this turn', 'life-gained-this-turn': 'you gained life this turn',
};

/** A `Condition` as the "if …" clause the oracle prints. */
export function renderCondition(c: Condition | undefined): string {
  if (!c) return '';
  const k = (c as { kind: string }).kind;
  const nullary = NULLARY_CONDITION[k];
  if (nullary) return nullary;
  const x = c as Record<string, unknown>;
  const who = (w: unknown) => (w === 'you' ? 'you' : w === 'opponent' ? 'an opponent' : 'a player');
  /** "you control", "an opponent controls" — the third-person `-s` only when the subject is not "you". */
  const verbFor = (w: unknown) => (w === 'you' ? 'control' : 'controls');
  switch (k) {
    case 'or': return list(((x.conditions ?? []) as Condition[]).map(renderCondition), 'or');
    case 'total-toughness-ge': return `creatures you control have total toughness ${x.value} or greater`;
    case 'hand-has': return `you have a ${renderFilter(x.filter as Filter, 'card')} in your hand`;
    case 'opponents-lands-ge': return `an opponent controls ${x.value} or more lands`;
    case 'spells-cast-last-turn': return x.who === 'none' ? 'no spells were cast last turn' : `a player cast ${x.value} or more spells last turn`;
    case 'self-is-type': return `~ is ${String(x.type).toLowerCase()}`;
    case 'self-had-counters': case 'self-has-counters': return `~ has a ${x.counter} counter on it`;
    case 'self-no-counters': return `~ has no ${x.counter} counters on it`;
    case 'life-gained-ge': return `you gained ${x.value} or more life this turn`;
    case 'unspent-mana-ge': return `you have ${x.value} or more unspent mana`;
    case 'life-le': return `${who(x.who)} has ${x.value} or less life`;
    case 'life-ge': return `${who(x.who)} has ${x.value} or more life`;
    case 'opponents-ge': return `you have ${x.value} or more opponents`;
    // "you control a Mountain" / "you control 2 or more creatures" — `atLeast: 1` is "a", not "1 or more", and the
    // verb agrees with the subject ("you control", "an opponent controls")
    case 'controls': return `${who(x.who)} ${verbFor(x.who)} ${x.atLeast === 1 ? 'a' : `${x.atLeast} or more`} ${renderFilter(x.filter as Filter)}${x.atLeast === 1 ? '' : 's'}`;
    case 'controls-le': return `${who(x.who)} ${verbFor(x.who)} ${x.atMost} or fewer ${renderFilter(x.filter as Filter)}s`;
    case 'cards-in-hand-ge': return `${who(x.who)} has ${x.value} or more cards in hand`;
    case 'cards-in-hand-le': return `${who(x.who)} has ${x.value} or fewer cards in hand`;
    case 'domain-ge': return `there are ${x.value} or more basic land types among lands you control`;
    case 'lands-le': return `you control ${x.value} or fewer ${x.other ? 'other ' : ''}lands`;
    case 'lands-ge': return `you control ${x.value} or more ${x.other ? 'other ' : ''}lands`;
    case 'turn-le': return `it is turn ${x.value} or earlier`;
    case 'graveyard-has-each': return `your graveyard has ${list(((x.filters ?? []) as Filter[]).map(f => renderFilter(f, 'card')))}`;
    case 'controls-each': return `you control ${list(((x.filters ?? []) as Filter[]).map(f => renderFilter(f)))}`;
    case 'attacked-with-ge': return `you attacked with ${x.value} or more creatures this turn`;
    case 'spells-cast-this-turn-ge': return `you cast ${x.value} or more spells this turn`;
    case 'graveyard-ge': return `there are ${x.value} or more ${x.filter ? renderFilter(x.filter as Filter, 'card') + 's' : 'cards'} in your graveyard`;
    case 'cards-drawn-ge': return `you have drawn ${x.value} or more cards this turn`;
    case 'unknown': return '<unknown condition>';
    default: return words(k);
  }
}

// ---------------------------------------------------------------------------
// Trigger events
// ---------------------------------------------------------------------------

/**
 * The "Whenever …" / "When …" / "At the beginning of …" clause of a triggered ability, WITHOUT the trailing comma.
 * The leading word is part of the template because oracle text picks it per event ("When ~ enters", "Whenever ~
 * attacks", "At the beginning of your upkeep") and the score is over tokens, so the wrong word costs a point.
 */
export function renderTrigger(t: TriggerEvent | undefined): string {
  if (!t) return '';
  const e = t as Record<string, unknown>;
  const subject = (self: unknown, fallback: string) => (self ? '~' : fallback);
  switch (t.on) {
    case 'etb': return t.self ? 'when ~ enters' : `whenever ${renderFilter(e.filter as Filter, 'another creature')}${e.controller === 'you' ? ' you control' : ''} enters`;
    case 'dies': return t.self ? 'when ~ dies' : `whenever ${renderFilter(e.filter as Filter, 'another creature')}${e.controller === 'you' ? ' you control' : ''} dies`;
    case 'ltb': return 'when ~ leaves the battlefield';
    case 'attacks': return t.self ? 'whenever ~ attacks' : `whenever ${renderFilter(e.filter as Filter, 'a creature')} you control attacks`;
    case 'you-attack': return 'whenever you attack';
    case 'turned-face-up': return 'when ~ is turned face up';
    case 'blocks': return `whenever ${subject(e.self, 'a creature')} blocks`;
    case 'becomes-blocked': return `whenever ${subject(e.self, 'a creature')} becomes blocked`;
    case 'combat-damage-player': return `whenever ${t.self || !e.filter ? '~' : `${renderFilter(e.filter as Filter)} you control`} deals combat damage to a player`;
    case 'deals-damage': return 'whenever ~ deals damage';
    case 'upkeep': return `at the beginning of ${e.whose === 'each' ? "each player's" : e.whose === 'opponent' ? "each opponent's" : 'your'} upkeep`;
    case 'end-step': return `at the beginning of ${e.whose === 'each' ? "each player's" : 'your'} end step`;
    case 'draw-step': return 'at the beginning of your draw step';
    case 'combat-begin': return 'at the beginning of combat on your turn';
    case 'cast': return `whenever ${e.who === 'you' ? 'you' : e.who === 'opponent' ? 'an opponent' : 'a player'} casts ${renderFilter(e.filter as Filter, 'spell')}${e.nth ? ` for the ${e.nth === 2 ? 'second' : `${e.nth}th`} time this turn` : ''}`;
    case 'landfall': return `whenever a land ${e.played ? 'you play ' : ''}enters the battlefield under your control`;
    case 'draw': return `whenever ${e.who === 'opponent' ? 'an opponent' : 'you'} draw${e.who === 'opponent' ? 's' : ''} a card`;
    case 'chapter': return `chapter ${(e.chapters as number[] ?? []).join(', ')}`;
    case 'leaves-graveyard': return `whenever ${renderFilter(e.filter as Filter, 'card')} leaves your graveyard`;
    case 'or': return list(((e.events ?? []) as TriggerEvent[]).map(renderTrigger), 'or');
    case 'life-gain': return 'whenever you gain life';
    case 'life-loss-opponent': return 'whenever an opponent loses life';
    case 'sacrifice': return `whenever you sacrifice ${renderFilter(e.filter as Filter, 'a permanent')}`;
    case 'tapped': return 'whenever ~ becomes tapped';
    case 'targeted': return `whenever ~ becomes the target of a spell or ability${e.bySpellYouCast ? ' you control' : ''}`;
    case 'discard': return `whenever you discard ${renderFilter(e.filter as Filter, 'a card')}`;
    case 'end-of-turn': return 'at the beginning of the end step';
    case 'reflexive': return 'when you do';
    case 'unknown': return '<unknown trigger>';
    default: return `whenever ${words(String((e as { on: string }).on))}`;
  }
}

// ---------------------------------------------------------------------------
// Static effects
// ---------------------------------------------------------------------------

const KEYWORD_LIST = (ks: Keyword[] | undefined): string => list((ks ?? []).map(String));

/**
 * What an Aura / Equipment grants the thing it is attached to, in the oracle's own shape: "equipped creature gets
 * +2/+2 and has trample", "enchanted creature has flying" — never "gets +0/+0 and has flying", which is what a
 * keyword-only Aura used to render as and what cost every such card a third of its round-trip score.
 */
function grants(subject: string, x: Record<string, unknown>): string {
  const kws = (x.keywords as Keyword[] | undefined)?.length ? KEYWORD_LIST(x.keywords as Keyword[]) : '';
  const bonus = zeroPT(x) ? '' : `gets ${signed(x.power as Amount)}/${signed(x.toughness as Amount)}`;
  const body = dropEmpty([bonus, kws ? `${bonus ? 'and ' : ''}has ${kws}` : '']).join(' ');
  return body ? `${subject} ${body}` : '';
}

/** A `StaticEffect` as the sentence the oracle prints for it. */
export function renderStatic(s: StaticEffect | undefined): string {
  if (!s) return '';
  const x = s as Record<string, unknown>;
  const cond = x.condition ? ` as long as ${renderCondition(x.condition as Condition)}` : '';
  switch (s.kind) {
    case 'anthem': {
      const scope = x.scope === 'you-control' ? ' you control' : x.scope === 'other-you-control' ? ' you control' : '';
      const who = `${x.scope === 'other-you-control' ? 'other ' : ''}${renderFilter(x.filter as Filter)}${scope}${x.opponentsOnly ? ' your opponents control' : ''}`;
      const granted = dropEmpty([
        (x.keywords as Keyword[] | undefined)?.length ? KEYWORD_LIST(x.keywords as Keyword[]) : '',
        (x.landwalk as string[] | undefined)?.length ? list((x.landwalk as string[]).map(t => `${t.toLowerCase()}walk`)) : '',
      ]).join(' and ');
      // a keyword-only anthem prints no P/T bonus: "Other permanents you control have hexproof.", never "get +0/+0"
      const bonus = zeroPT(x) ? '' : ` get ${signed(x.power as Amount)}/${signed(x.toughness as Amount)}`;
      return `${who}${bonus}${granted ? `${bonus ? ' and' : ''} have ${granted}` : ''}${cond}`;
    }
    case 'damage-by-toughness': return `${x.scope === 'self' ? '~' : 'creatures you control'} assigns combat damage equal to its toughness rather than its power`;
    case 'flash-for': return `you may cast ${renderFilter(x.filter as Filter, 'spell')} as though it had flash`;
    case 'trigger-twice': return `if ${x.equipped ? 'equipped creature' : 'a permanent'} would trigger${x.event ? ` on ${words(String(x.event))}` : ''}, it triggers an additional time`;
    case 'counters-replacement': return `if a ${x.counter ?? ''} counter would be put on a permanent you control, ${x.mode === 'double' ? 'twice that many' : 'that many plus one'} are put on it instead`;
    case 'tokens-replacement': return 'if you would create one or more tokens, you create twice that many instead';
    case 'extra-mana-on-tap': return `whenever ${x.enchanted ? 'enchanted permanent' : renderFilter(x.filter as Filter, 'a permanent')} is tapped for mana, its controller adds an additional ${Array.isArray(x.mana) ? (x.mana as string[]).map(m => `{${m}}`).join('') : words(String(x.mana))}`;
    case 'grant-mana-ability': return `${x.enchanted ? 'enchanted permanent' : renderFilter(x.filter as Filter, 'permanent')} has "${renderEffect(x.effect as Effect)}"`;
    case 'grant-ability': return `${x.enchanted ? 'enchanted permanent' : renderFilter(x.filter as Filter, 'creature')}${x.scope === 'you-control' ? ' you control' : ''} has "${renderAbility(x.ability as Ability)}"`;
    case 'opponents-cant-cast': return `your opponents can't cast ${renderFilter(x.filter as Filter, 'spell')}s during your turn`;
    case 'play-lands-from': return `you may play lands from ${zoneOf(String(x.zone).replace('library-top', 'library'))}`;
    case 'unspent-mana-becomes-red': return 'unspent mana becomes red mana';
    // `self-pt` ADDS to the printed characteristics (src/engine/characteristics.ts: `m.p += …`), so the oracle line it
    // stands for is "~ gets +1/+1", not "~'s power and toughness are 1/1". A card that really SETS its P/T and is
    // parsed into a `self-pt` is a parser bug the round trip is meant to expose, and now does (see openIssues).
    case 'self-pt': return `~ gets ${signed(x.power as Amount)}/${signed(x.toughness as Amount)}${cond}`;
    case 'self-keywords': {
      const flags = dropEmpty([
        x.cantBlock ? "~ can't block" : '', x.mustAttack ? '~ attacks each combat if able' : '',
        x.doesntUntap ? "~ doesn't untap during your untap step" : '',
        x.blockOnlyFlying ? '~ can block only creatures with flying' : '',
        x.evasion ? `~ can't be blocked except by ${renderFilter(x.evasion as Filter)}s` : '',
      ]);
      const kws = (x.keywords as Keyword[] | undefined)?.length ? `~ has ${KEYWORD_LIST(x.keywords as Keyword[])}${cond}` : '';
      return sentences(dropEmpty([kws, ...flags]));
    }
    case 'can-be-commander': return '~ can be your commander';
    case 'look-top-anytime': return 'you may look at the top card of your library any time';
    case 'may-not-untap': return "you may choose not to untap ~ during your untap step";
    case 'no-max-hand-size': return 'you have no maximum hand size';
    case 'cant-attack-unless-defender-controls': return `~ can't attack unless defending player controls a ${renderFilter(x.filter as Filter)}`;
    case 'extra-blocks': return `~ can block an additional ${x.amount} ${plural(String(x.amount), 'creature')} each combat`;
    case 'cant-be-blocked-by-more-than-one': return "~ can't be blocked by more than one creature";
    case 'aura': {
      const flags = dropEmpty([
        x.cantAttackOrBlock ? "enchanted creature can't attack or block" : '', x.cantAttack ? "enchanted creature can't attack" : '',
        x.cantBlock ? "enchanted creature can't block" : '', x.doesntUntap ? "enchanted creature doesn't untap during its controller's untap step" : '',
        x.controlEnchanted ? 'you control enchanted creature' : '',
      ]);
      return sentences(dropEmpty([`enchant ${renderTarget(x.enchant as TargetSpec).replace(/^target /, '')}`, grants('enchanted creature', x), ...flags]));
    }
    case 'equipment':
      return sentences(dropEmpty([grants('equipped creature', x), `equip ${renderMana(x.equipCost as ManaCost)}`]));
    case 'cost-adjust': {
      const n = x.amount as number;
      const whose = x.who === 'you' ? 'you cast' : x.who === 'opponent' ? 'your opponents cast' : 'players cast';
      return `${renderFilter(x.filter as Filter, 'spell')}s ${whose} cost {${Math.abs(n)}} ${n >= 0 ? 'less' : 'more'} to cast`;
    }
    case 'opponent-creatures-etb-tapped': return 'creatures your opponents control enter tapped';
    case 'extra-land': return `you may play ${x.amount} additional ${plural(String(x.amount), 'land')} on each of your turns`;
    case 'cant-be-countered': return "~ can't be countered";
    case 'lifegain-multiplier': return `if you would gain life, you gain twice that much${x.plus ? ` plus ${x.plus}` : ''} instead`;
    case 'unknown': return '<unknown static>';
    default: return words(String((x as { kind: string }).kind));
  }
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

/** Who an effect's `who` field names, and whether the verb after it takes a third-person `-s`. */
function subject(who: string | undefined, you = 'you'): { s: string; verb: (v: string) => string } {
  const map: Record<string, string> = {
    you, opponent: 'target opponent', 'target-player': 'target player', 'target-opponent': 'target opponent',
    'each-player': 'each player', 'each-opponent': 'each opponent', 'that-player': 'that player',
    controller: 'its controller', 'that-controller': "that permanent's controller", 'defending-player': 'defending player',
    'controller-of-that': "that permanent's controller",
  };
  const s = map[who ?? 'you'] ?? words(who ?? 'you');
  const singular = s !== you || you !== 'you';
  return { s, verb: (v: string) => (singular ? `${v}s` : v) };
}

/** Rendering context: `you` is rebound by `scoped` / `unless-pays`, so their children read as the oracle prints them. */
export interface RenderCtx { you: string }
const ROOT: RenderCtx = { you: 'you' };

/** A list of effects as one sentence run. */
export function renderEffects(es: readonly Effect[] | undefined, ctx: RenderCtx = ROOT): string {
  return sentences((es ?? []).map(e => renderEffect(e, ctx)));
}

/**
 * One `Effect` as the sentence the oracle prints for it. Every core op has a template; a family op is rendered by
 * its registry `render` entry; anything else prints `<op …>` and is a renderer gap (see `renderGaps`).
 */
export function renderEffect(e: Effect | undefined, ctx: RenderCtx = ROOT): string {
  if (!e || typeof e !== 'object') return '';
  const x = e as unknown as Record<string, unknown>;
  const op = String((e as { op: string }).op);
  const amt = (f = 'amount') => renderAmount(x[f] as Amount);
  const tgt = (f = 'target') => renderTarget(x[f] as TargetSpec | Ref | string);
  const sub = (f = 'who') => subject(x[f] as string | undefined, ctx.you);
  switch (op) {
    // --- damage, removal ---------------------------------------------------
    case 'damage': return `~ deals ${amt()} damage to ${tgt()}${x.divided ? ' divided as you choose' : ''}`;
    case 'damage-you': return `~ deals ${amt()} damage to ${ctx.you}`;
    case 'each-self-damage': return '~ deals damage equal to its power to each creature';
    case 'destroy': return `destroy ${tgt()}${ifTarget(x)}${x.noRegenerate ? ". it can't be regenerated" : ''}`;
    case 'exile': return `exile ${tgt()}${x.from === 'graveyard' ? ' from a graveyard' : ''}${ifTarget(x)}${x.until === 'leaves' ? ' until ~ leaves the battlefield' : ''}`;
    case 'counter': return `counter ${tgt()}${x.unlessPay !== undefined ? ` unless its controller pays {${x.unlessPay}}` : ''}${x.toExile ? '. if that spell is countered this way, exile it instead' : ''}`;
    case 'counter-triggering': return 'counter that triggered ability';
    case 'fight': return `${x.self ? '~' : 'it'} fights ${tgt()}`;
    case 'bite': return `~ deals damage equal to its power to ${tgt()}`;
    case 'bounce': return `return ${tgt()} to ${x.to === 'hand' ? "its owner's hand" : `the ${x.to === 'library-top' ? 'top' : 'bottom'} of its owner's library`}`;
    case 'shuffle-into-library': return `shuffle ${tgt()} into its owner's library`;
    case 'shuffle-self-into-library': return 'shuffle ~ into its owner\'s library';
    case 'remove-those': return `${x.how === 'exile' ? 'exile' : 'sacrifice'} them`;
    case 'remove-from-combat': return `remove ${tgt()} from combat`;
    case 'regenerate': return `regenerate ${tgt()}`;
    case 'prevent-damage': return `prevent the next ${x.amount === 'all' ? 'all' : amt()} damage that would be dealt to ${tgt()} this turn`;
    case 'exile-if-dies': return `if ${renderRef(String(x.who))} would die this turn, exile it instead`;
    // --- cards, life, counters --------------------------------------------
    case 'draw': { const s = sub(); const n = amt(); return `${s.s} ${s.verb('draw')} ${n === '1' ? 'a card' : `${n} cards`}`; }
    case 'discard': { const s = sub(); const n = x.amount === 'hand' ? 'hand' : amt(); return n === 'hand' ? `${s.s} ${s.verb('discard')} their hand` : `${s.s} ${s.verb('discard')} ${n === '1' ? 'a card' : `${n} cards`}${x.random ? ' at random' : ''}`; }
    case 'loot': return `draw ${x.draw} ${plural(String(x.draw), 'card')}, then discard ${x.discard} ${plural(String(x.discard), 'card')}`;
    case 'gain-life': { const s = sub(); return `${s.s} ${s.verb('gain')} ${amt()} life`; }
    case 'lose-life': { const s = sub(); return `${s.s} ${s.verb('lose')} ${amt()} life`; }
    case 'set-life': { const s = sub(); return `${s.s} life total becomes ${x.amount}`; }
    case 'mill': { const s = sub(); const n = amt(); return `${s.s} ${s.verb('mill')} ${n} ${plural(n, 'card')}`; }
    case 'scry': return `scry ${x.amount}`;
    case 'surveil': return `surveil ${x.amount}`;
    case 'energy': return `${ctx.you} get ${amt()} {E}`;
    case 'poison': { const s = sub(); const n = amt(); return `${s.s} ${s.verb('get')} ${n} poison ${plural(n, 'counter')}`; }
    case 'counters': { const n = amt(); return `put ${n === '1' ? 'a' : n} ${x.counter} ${plural(n, 'counter')} on ${tgt()}`; }
    case 'multi-counters': return `put ${list(((x.counters ?? []) as string[]).map(c => `a ${c} counter`))} on ${tgt()}`;
    case 'move-counters': return `move a ${x.counter} counter from ~ onto ${tgt()}`;
    case 'player-counter': { const s = sub(); const n = amt(); return `${s.s} ${s.verb('get')} ${n} ${x.counter} ${plural(n, 'counter')}`; }
    case 'proliferate': return 'proliferate';
    case 'renown': return `renown ${x.amount}`;
    case 'amass': return `amass ${x.subtype} ${amt()}`;
    case 'evolve': return 'evolve';
    case 'explore': return 'it explores';
    // --- library, hand, graveyard -----------------------------------------
    case 'dig': return `look at the top ${amt('look')} ${plural(amt('look'), 'card')} of your library. put ${x.take} of them into your hand and the rest on the ${x.rest === 'graveyard' ? 'graveyard' : x.rest} ${x.rest === 'graveyard' ? '' : 'of your library'}`.trim();
    case 'look-top': return `look at the top ${x.amount} ${plural(String(x.amount), 'card')} of ${x.who === 'you' ? 'your' : "target player's"} library`;
    case 'impulse': return `exile the top ${x.count} ${plural(String(x.count), 'card')} of your library. you may play ${x.count === 1 ? 'that card' : 'those cards'} until ${x.until === 'eot' ? 'end of turn' : 'the end of your next turn'}`;
    case 'play-exiled': return `you may play that card until ${x.until === 'eot' ? 'end of turn' : 'the end of your next turn'}${x.free ? ' without paying its mana cost' : ''}`;
    case 'search': return `search your library for ${x.count === 1 ? 'a' : x.count} ${renderFilter(x.filter as Filter, 'card')}${x.count === 1 ? '' : ' cards'}, put ${x.count === 1 ? 'it' : 'them'} into your ${x.to === 'top' ? 'library' : x.to}${x.tapped ? ' tapped' : ''}, then shuffle`;
    case 'search-land': return `search your library for ${x.basic ? 'a basic' : 'a'} ${(x.subtypes as string[] | undefined)?.length ? (x.subtypes as string[]).join(' or ') + ' ' : ''}land card, put it onto the ${x.toBattlefield ? 'battlefield' : 'your hand'}${x.tapped ? ' tapped' : ''}, then shuffle`;
    case 'return-from-graveyard': return `return ${x.target ? 'target ' : ''}${renderFilter(x.what as Filter, 'card')} from ${x.anyGraveyard ? 'a graveyard' : 'your graveyard'} to ${x.to === 'hand' ? 'your hand' : x.to === 'battlefield' ? `the battlefield${x.tapped ? ' tapped' : ''}` : `the ${x.to === 'library-top' ? 'top' : 'bottom'} of your library`}`;
    case 'return-own': return `return ${x.count === 1 ? 'a' : x.count} ${renderFilter(x.filter as Filter)}${x.count === 1 ? '' : 's'} you control to ${x.count === 1 ? "its" : 'their'} owner's hand`;
    case 'return-self-to-battlefield': return `return ~ to the battlefield${x.counters ? ` with a ${(x.counters as { counter: string }).counter} counter on it` : ''}`;
    case 'return-to-battlefield': return `return that card to the battlefield under ${x.underControlOf === 'you' ? 'your' : "its owner's"} control`;
    case 'put-from-hand': return `put ${amt()} ${renderFilter(x.filter as Filter, 'card')}${amt() === '1' ? '' : 's'} from your hand onto the ${x.to === 'battlefield' ? `battlefield${x.tapped ? ' tapped' : ''}` : `${x.to === 'library-top' ? 'top' : 'bottom'} of your library`}`;
    case 'exile-from-hand': return `exile ${renderFilter(x.filter as Filter, 'card')} from your hand`;
    case 'exile-graveyard': { const s = sub(); return `exile ${s.s === 'you' ? 'your' : `${s.s}'s`} graveyard`; }
    case 'reveal-hand': { const s = sub(); return `${s.s} ${s.verb('reveal')} their hand`; }
    case 'reveal-hand-discard': { const s = sub(); return `${s.s} ${s.verb('reveal')} their hand. you choose ${renderFilter(x.filter as Filter, 'card')} from it. that player discards ${x.count === 'all-named' ? 'those cards' : 'that card'}`; }
    case 'shuffle': { const s = sub(); return `${s.s} ${s.verb('shuffle')}`; }
    // --- permanents --------------------------------------------------------
    case 'tap': return `tap ${tgt()}${x.noUntap ? ". it doesn't untap during its controller's next untap step" : ''}`;
    case 'untap': return `untap ${tgt()}`;
    case 'untap-all': return `untap all ${renderFilter(x.filter as Filter)}s`;
    case 'untap-choose': return `untap up to ${x.count} target ${renderFilter(x.filter as Filter)}s`;
    case 'no-untap-self': return "~ doesn't untap during your next untap step";
    case 'no-untap-that': return "that permanent doesn't untap during its controller's next untap step";
    case 'sacrifice': { const s = sub(); const n = String(x.amount); return `${s.s} ${s.verb('sacrifice')} ${n === '1' ? 'a' : n} ${renderFilter(x.what as Filter)}${n === '1' ? '' : 's'}`; }
    case 'sacrifice-self': return 'sacrifice ~';
    case 'sacrifice-unless-pay': return `sacrifice ~ unless ${ctx.you} pay ${renderMana(x.mana as ManaCost)}`;
    case 'gain-control': return `gain control of ${tgt()} ${duration(x.duration as 'eot' | 'permanent')}`.trim();
    case 'pump': {
      const kws = (x.keywords as Keyword[] | undefined)?.length ? ` and gains ${KEYWORD_LIST(x.keywords as Keyword[])}` : '';
      return `${tgt()} gets ${signed(x.power as Amount)}/${signed(x.toughness as Amount)}${kws} ${duration(x.duration as 'eot' | 'permanent')}`.trim();
    }
    // `unblockable` is an internal name for a printed sentence, not a printed keyword: the oracle says
    // "Target creature can't be blocked this turn.", never "target creature gains unblockable"
    case 'grant-keyword': {
      const ks = (x.keywords as Keyword[] | undefined) ?? [];
      if (ks.length === 1 && String(ks[0]) === 'unblockable') return `${tgt()} can't be blocked ${duration(x.duration as 'eot' | 'permanent')}`.trim();
      return `${tgt()} gains ${KEYWORD_LIST(ks)} ${duration(x.duration as 'eot' | 'permanent')}`.trim();
    }
    case 'double-power': return `${tgt()}'s power is doubled`;
    case 'cant-block': return `${tgt()} can't block this turn`;
    case 'cant-attack-or-block': return `${tgt()} can't attack or block this turn`;
    case 'animate': return `${tgt()} becomes a ${x.power}/${x.toughness} ${dropEmpty([...(x.colors as string[] ?? []).map(c => COLOR_WORD[c] ?? c), ...(x.subtypes as string[] ?? []), ...(x.types as string[] ?? []).map(t => String(t).toLowerCase())]).join(' ')}${(x.keywords as Keyword[] | undefined)?.length ? ` with ${KEYWORD_LIST(x.keywords as Keyword[])}` : ''} ${duration(x.duration as 'eot' | 'permanent')}`.trim();
    case 'earthbend': return `earthbend ${amt()} on ${tgt()}`;
    case 'attach-self': return `attach ~ to ${tgt()}`;
    case 'attach-to-that': return 'attach ~ to that creature';
    case 'transform-self': return 'transform ~';
    case 'crew-self': return 'crew ~';
    case 'saddle-self': return 'saddle ~';
    case 'unearth': return 'unearth';
    case 'become-monarch': return `${ctx.you} become the monarch`;
    case 'extra-land': return `${ctx.you} may play ${x.count} additional ${plural(String(x.count), 'land')} this turn`;
    case 'extra-turn': return `${ctx.you} take an extra turn after this one`;
    // --- tokens, copies ----------------------------------------------------
    case 'token': {
      const n = amt('count');
      const named = x.treasure ? 'Treasure' : x.clue ? 'Clue' : x.food ? 'Food' : x.spawn ? 'Eldrazi Spawn' : (x.name as string | undefined);
      // a NONCREATURE token (Clue, Treasure, Food) has no printed power and toughness: "create a Clue token", never
      // "create a 0/0 Clue token" — and the stray zeroes were two spurious numbers on every line that made one
      const isCreature = ((x.types as string[] ?? []).some(t => String(t).toLowerCase() === 'creature'));
      const body = dropEmpty([
        isCreature ? `${x.power}/${x.toughness}` : '',
        ...(x.colors as string[] ?? []).map(c => COLOR_WORD[c] ?? c),
        ...((x.subtypes as string[] ?? []).length ? (x.subtypes as string[]) : named ? [named] : []),
        ...(x.types as string[] ?? []).map(t => String(t).toLowerCase()),
      ]).join(' ');
      const kws = (x.keywords as Keyword[] | undefined)?.length ? ` with ${KEYWORD_LIST(x.keywords as Keyword[])}` : '';
      return `create ${n === '1' ? 'a' : n} ${body} ${plural(n, 'token')}${kws}${x.tapped ? ' tapped' : ''}${x.attacking ? ' and attacking' : ''}`;
    }
    case 'token-copy': return `create ${amt('count') === '1' ? 'a' : amt('count')} ${plural(amt('count'), 'token')} that's a copy of ${tgt()}${x.tapped ? ' tapped' : ''}`;
    case 'copy-spell': return `copy ${tgt()}${x.newTargets ? '. you may choose new targets for the copy' : ''}`;
    case 'storm-copies': return 'copy ~ for each spell cast before it this turn';
    case 'cascade': return 'cascade';
    // --- mana --------------------------------------------------------------
    case 'add-mana': {
      const m = x.mana;
      const choices = (x.choices as string[][] | undefined)?.length ? list((x.choices as string[][]).map(c => c.map(s => `{${s}}`).join('')), 'or') : '';
      // `any-one` with `options` is a DUAL LAND: the parser records which colours ("Add {R} or {W}."), and printing
      // the generic "one mana of any color" for it both loses the line's own symbols and reads as a strictly better
      // card than the one on the table.
      const options = (x.options as string[] | undefined)?.length ? list((x.options as string[]).map(s => `{${s}}`), 'or') : '';
      const symbols = choices || options || (Array.isArray(m) ? (m as string[]).map(s => `{${s}}`).join('') : m === 'any' || m === 'any-one' ? 'one mana of any color' : words(String(m)));
      const n = x.amount !== undefined && x.amount !== 1 ? `${x.amount} ` : '';
      return `add ${n}${symbols}${x.perEach ? ` for each ${renderAmount(x.perEach as Amount)}` : ''}`;
    }
    // --- containers and composition ---------------------------------------
    case 'conditional': return `if ${renderCondition(x.condition as Condition)}, ${renderEffects(x.then as Effect[], ctx)}${(x.else as Effect[] | undefined)?.length ? `. otherwise, ${renderEffects(x.else as Effect[], ctx)}` : ''}`;
    case 'optional-pay': return `${ctx.you} may pay ${renderMana(x.mana as ManaCost)}. if you do, ${renderEffects(x.then as Effect[], ctx)}`;
    case 'optional-then': return `${ctx.you} may ${renderEffects(x.first as Effect[], ctx)}. if you do, ${renderEffects(x.then as Effect[], ctx)}`;
    // an EMPTY mode is the parser's fold marker (`modes: [[]]` is how "It can't be regenerated." reaches the AST as
    // a claim of nothing); rendering it as "choose one — •" put a bullet with no text on the card
    case 'choose-mode': {
      const bullets = ((x.modes ?? []) as Effect[][]).map(m => renderEffects(m, ctx)).filter(s => s.trim() !== '');
      return bullets.length ? `choose ${x.count === 1 ? 'one' : x.count} — ${bullets.map(b => `• ${b}`).join(' ')}` : '';
    }
    case 'gain-ability': return `it gains "${renderAbility(x.ability as Ability)}"`;
    case 'delayed-trigger': return `${DELAYED_AT[String(x.at)] ?? words(String(x.at))}, ${renderEffects(x.effects as Effect[], ctx)}`;
    case 'for-each': return `for each ${x.over === 'those' ? 'of those permanents' : x.over === 'targets' ? 'of them' : renderObjectSet(x.over as ObjectSet)}, ${renderEffects(x.do as Effect[], ctx)}`;
    case 'bind': return '';
    case 'reflexive': return `when you do, ${renderEffects(x.effects as Effect[], ctx)}`;
    case 'scoped': { const s = subject(x.who as string, ctx.you); return renderEffects(x.do as Effect[], { you: s.s }); }
    case 'may': return may(renderEffects(x.effects as Effect[], ctx), ctx.you);
    case 'unless-pays': { const s = subject(x.who as string, ctx.you); return `${renderEffects(x.otherwise as Effect[], { you: s.s })} unless ${s.s} ${s.verb('pay')} ${renderCost(x.cost as AbilityCost)}`; }
    case 'move': {
      const what = x.what;
      const subj = typeof what === 'object' && what !== null && 'filter' in (what as object)
        ? (() => { const w = what as { filter: Filter; zone: string; who: string; count: Amount | 'all' }; const n = w.count === 'all' ? 'all' : renderAmount(w.count as Amount); return `${n === '1' ? 'a' : n} ${zoneNoun(w.filter, w.zone)}${n === '1' ? '' : 's'} from ${zoneOf(w.zone, w.who)}`; })()
        : renderTarget(what as TargetSpec | Ref);
      const verb = x.to === 'exile' ? 'exile' : x.to === 'graveyard' ? 'put' : x.to === 'hand' ? 'return' : 'put';
      const dest = x.to === 'exile' ? '' : ` ${x.to === 'battlefield' ? `onto the battlefield${x.tapped ? ' tapped' : ''}${x.faceDown ? ' face down' : ''}` : x.to === 'hand' ? "to its owner's hand" : x.to === 'library' ? `on the ${x.pos === 'bottom' ? 'bottom' : 'top'} of its owner's library` : `into ${x.to === 'graveyard' ? "its owner's graveyard" : 'the command zone'}`}`;
      const counters = x.withCounters ? ` with ${renderAmount((x.withCounters as { amount: Amount }).amount)} ${(x.withCounters as { counter: string }).counter} counters on it` : '';
      const until = x.until === 'leaves' ? ' until ~ leaves the battlefield' : x.until === 'eot' ? ' until end of turn' : x.until === 'your-next-end-step' ? ' until your next end step' : '';
      return `${verb} ${subj}${dest}${counters}${until}`;
    }
    case 'set-pt': return `${tgt()} ${x.base ? 'has base power and toughness' : 'becomes a'} ${renderAmount(x.power as Amount)}/${renderAmount(x.toughness as Amount)} ${duration(x.duration as 'eot' | 'permanent')}`.trim();
    case 'lose-abilities': return `${tgt()} loses ${x.keywords === undefined || x.keywords === 'all' ? 'all abilities' : KEYWORD_LIST(x.keywords as Keyword[])} ${duration(x.duration as 'eot' | 'permanent')}`.trim();
    case 'exchange': return x.what === 'life' ? `${renderExchangeSide(x.a)} and ${renderExchangeSide(x.b)} exchange life totals` : `exchange control of ${renderExchangeSide(x.a)} and ${renderExchangeSide(x.b)}`;
    // --- parser-internal fold markers (never reach the engine; they render as nothing) ------------------------
    case 'alt-if-target': case 'alt-take': case 'fold-counter-if-yours': case 'fold-restriction':
    case 'fold-alt-mana': case 'fold-new-targets': return '';
    case 'alt-kicked-amount': return String(x.text ?? '');
    case 'unknown': return '<unknown effect>';
    default: {
      // a family op renders itself; anything else is a gap the report names
      const r = RENDERERS[op];
      return r ? r(e as never) : `<${words(op)}>`;
    }
  }
}

/**
 * The "if it …" rider `destroy` / `exile` carry (Fatal Push's "if it has mana value 2 or less"): the numbers in it
 * are printed on the line, so a rendering that dropped it would fail the number gate — which is the point.
 */
function ifTarget(x: Record<string, unknown>): string {
  const alt = x.ifTargetAlt as { condition: Condition; filter: Filter } | undefined;
  const parts = dropEmpty([
    x.ifTarget ? `if it is ${renderFilter(x.ifTarget as Filter, 'a permanent')}` : '',
    alt ? `if ${renderCondition(alt.condition)}, instead if it is ${renderFilter(alt.filter, 'a permanent')}` : '',
  ]);
  return parts.length ? ` ${parts.join(' ')}` : '';
}

/** The firing point of a `delayed-trigger` as the oracle phrases it. */
const DELAYED_AT: Record<string, string> = {
  'next-upkeep': 'at the beginning of the next upkeep', 'next-turn:upkeep': "at the beginning of the next turn's upkeep",
  'next-end-step': 'at the beginning of the next end step', 'your-next-end-step': 'at the beginning of your next end step',
  'end-of-combat': 'at end of combat', 'this-turn:dies': 'when that permanent dies this turn',
  'this-turn:ltb': 'when that permanent leaves the battlefield this turn', 'until-eot:end': 'at end of turn',
};

/** One side of an `exchange`: a player word, a Ref or a target spec. */
function renderExchangeSide(v: unknown): string {
  if (typeof v === 'string') return v === 'you' ? 'you' : v === 'target-player' ? 'target player' : renderRef(v);
  return renderTarget(v as TargetSpec);
}

// ---------------------------------------------------------------------------
// Abilities and the whole card
// ---------------------------------------------------------------------------

/**
 * `fromGraveyard` is recorded on the ABILITY, not on the effect that moves the card, so the effect templates cannot
 * see it: "Return ~ from your graveyard to your hand." reaches the AST as a plain `bounce` plus a flag on its
 * activated ability. Naming the zone matters to the score — a line that says "graveyard" needs a rendering that
 * says it (`vocabularyIn`), and every such card was halved for a word the AST really carries.
 */
const fromGraveyard = (body: string): string => body.replace(/\b(return|put) ~ (to|onto|into)\b/, '$1 ~ from your graveyard $2');

/** One `Ability` as the oracle line it stands for. */
export function renderAbility(a: Ability | undefined): string {
  if (!a) return '';
  if ((a as { fromGraveyard?: boolean }).fromGraveyard) {
    return fromGraveyard(renderAbility({ ...a, fromGraveyard: false } as Ability));
  }
  switch (a.kind) {
    case 'triggered': {
      const cond = a.intervening ? `, if ${renderCondition(a.intervening)}` : '';
      const body = a.optional ? may(renderEffects(a.effects)) : renderEffects(a.effects);
      const gate = a.condition ? `if ${renderCondition(a.condition)}, ` : '';
      return `${renderTrigger(a.event)}${cond}, ${gate}${body}${a.oncePerTurn ? '. this ability triggers only once each turn' : ''}`;
    }
    case 'activated': {
      const gate = a.activateOnlyIf ? `. activate only if ${renderCondition(a.activateOnlyIf)}` : '';
      // A LOYALTY ability is sorcery-speed and once-per-turn by rule (CR 606.3), and no planeswalker prints either
      // restriction. Rendering the boilerplate anyway added two clauses to every line a planeswalker claims and cost
      // Karn Liberated's "-3: Exile target permanent." two thirds of its score for saying nothing.
      const boilerplate = a.loyalty !== undefined ? ''
        : `${a.sorcerySpeed ? '. activate only as a sorcery' : ''}${a.oncePerTurn ? '. activate only once each turn' : ''}`;
      const loyalty = a.loyalty !== undefined ? `${a.loyalty >= 0 ? '+' : ''}${a.loyalty}: ` : '';
      return `${loyalty || `${renderCost(a.cost)}: `}${renderEffects(a.effects)}${gate}${boilerplate}`;
    }
    case 'static': return renderStatic(a.effect);
    default: return renderEffects((a as { effects?: Effect[] }).effects);
  }
}

/** An `AltCost` as its printed keyword line (`Flashback {2}{R}`, `Escape—{1}{B}, exile two other cards…`). */
export function renderAltCost(a: AltCost): string {
  return `${words(String(a.id))} ${renderCost(a.cost)}`.trim();
}
/** A `CostModifier` as its printed line. */
export function renderCostModifier(c: CostModifier): string {
  return c.kind === 'reduce' ? `~ costs ${renderAmount(c.amount)} less to cast` : String(c.kind);
}
/** An `AsEnters` as its printed line. */
export function renderAsEnters(a: AsEnters): string {
  const x = a as Record<string, unknown>;
  switch (String(x.kind)) {
    case 'tapped': return '~ enters tapped';
    case 'tapped-unless': return `~ enters tapped unless ${renderCondition(x.condition as Condition)}`;
    case 'pay-life-or-tapped': return `as ~ enters, you may pay ${x.life} life. if you don't, it enters tapped`;
    case 'counters': return `~ enters with ${renderAmount(x.amount as Amount)} ${x.counter} counters on it`;
    case 'choose': return `as ~ enters, choose a ${words(String(x.what))}`;
    case 'discard-or-graveyard': return `if ~ would enter, you may discard a ${renderFilter(x.filter as Filter, 'card')} instead`;
    default: return words(String(x.kind));
  }
}

// ---------------------------------------------------------------------------
// Renderer gaps
// ---------------------------------------------------------------------------

/**
 * Every op inside `value` that no template and no registry `render` covers. The batch report lists them, so a family
 * that ships ops without a renderer is visible instead of silently scoring its cards down.
 */
export function renderGaps(value: unknown, out: Set<string> = new Set()): string[] {
  if (Array.isArray(value)) { for (const v of value) renderGaps(v, out); return [...out]; }
  if (!value || typeof value !== 'object') return [...out];
  const o = value as Record<string, unknown>;
  const op = typeof o.op === 'string' ? o.op : undefined;
  if (op && !CORE_OPS.has(op) && !RENDERERS[op]) out.add(op);
  for (const v of Object.values(o)) renderGaps(v, out);
  return [...out];
}

/**
 * Every op `renderEffect`'s switch handles. Derived from the switch itself would need the TypeScript AST, so the list
 * is written out and `test/render.test.ts` asserts it equals the schema's own op list (a new core op therefore fails
 * the test the day it is added, rather than silently becoming a "gap").
 */
export const CORE_OPS: ReadonlySet<string> = new Set([
  'damage', 'damage-you', 'each-self-damage', 'destroy', 'exile', 'counter', 'counter-triggering', 'fight', 'bite',
  'bounce', 'shuffle-into-library', 'shuffle-self-into-library', 'remove-those', 'remove-from-combat', 'regenerate',
  'prevent-damage', 'exile-if-dies', 'draw', 'discard', 'loot', 'gain-life', 'lose-life', 'set-life', 'mill', 'scry',
  'surveil', 'energy', 'poison', 'counters', 'multi-counters', 'move-counters', 'player-counter', 'proliferate',
  'renown', 'amass', 'evolve', 'explore', 'dig', 'look-top', 'impulse', 'play-exiled', 'search', 'search-land',
  'return-from-graveyard', 'return-own', 'return-self-to-battlefield', 'return-to-battlefield', 'put-from-hand',
  'exile-from-hand', 'exile-graveyard', 'reveal-hand', 'reveal-hand-discard', 'shuffle', 'tap', 'untap', 'untap-all',
  'untap-choose', 'no-untap-self', 'no-untap-that', 'sacrifice', 'sacrifice-self', 'sacrifice-unless-pay',
  'gain-control', 'pump', 'grant-keyword', 'double-power', 'cant-block', 'cant-attack-or-block', 'animate',
  'earthbend', 'attach-self', 'attach-to-that', 'transform-self', 'crew-self', 'saddle-self', 'unearth',
  'become-monarch', 'extra-land', 'extra-turn', 'token', 'token-copy', 'copy-spell', 'storm-copies', 'cascade',
  'add-mana', 'conditional', 'optional-pay', 'optional-then', 'choose-mode', 'gain-ability', 'delayed-trigger',
  'for-each', 'bind', 'reflexive', 'scoped', 'may', 'unless-pays', 'move', 'set-pt', 'lose-abilities', 'exchange',
  'alt-if-target', 'alt-take', 'fold-counter-if-yours', 'fold-restriction', 'fold-alt-mana', 'fold-new-targets',
  'alt-kicked-amount', 'unknown',
]);

// ---------------------------------------------------------------------------
// Scoring one oracle line against a rendering
// ---------------------------------------------------------------------------

/** Words that carry no meaning for the comparison (plan 2.2 names exactly these three). */
const STOP: ReadonlySet<string> = new Set(['the', 'a', 'an']);

/**
 * Wording differences that are not differences of meaning, collapsed on BOTH sides before anything is compared.
 * Both are rules-text synonyms the pool prints in two forms for the SAME event, so the renderer must not be judged
 * on which form it picked:
 *
 *   * WotC's 2024 templating change dropped "the battlefield" from "enters the battlefield" (CR 603.6a);
 *   * "is put into a graveyard from the battlefield" IS "dies" (CR 700.4) — the pre-2010 wording, still printed on
 *     every card that has not been re-templated.
 */
const collapseWording = (s: string): string => s
  .replace(/\benters the battlefield\b/g, 'enters')
  .replace(/\bis put into a graveyard from the battlefield\b/g, 'dies')
  .replace(/\bare put into a graveyard from the battlefield\b/g, 'die');

/**
 * Spelled-out numbers, as the digit the renderer prints. The oracle writes small magnitudes as words ("Draw two
 * cards.", "twice the number of…") and every template in this file prints digits, so without this the comparison
 * charges a correct script for the difference — and, far worse, `numbersIn` sees no digit in the line and the HARD
 * NUMBER GATE never fires, which is precisely the cross-check the round trip exists for ("Draw two cards." scripted
 * as `draw 5` was accepted before this table). Only the forms the oracle uses as a MAGNITUDE are listed: `a` / `an`
 * are articles, not numbers, and stay out (a template that prints "a card" for `amount: 1` is right).
 */
const NUMBER_WORDS: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', twenty: '20',
  twice: '2', thrice: '3',
};
const NUMBER_WORD_RE = new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join('|')})\\b`, 'g');

/**
 * "one or more" / "one or fewer" is a QUANTIFIER, not a magnitude ("Whenever one or more creatures you control deal
 * combat damage…"): the `1` is part of the English idiom for "any", nothing in the AST carries it, and gating on it
 * would zero every correct rendering of such a line. Every other threshold ("two or more", "3 or less") IS a
 * magnitude and stays gated.
 */
const dropQuantifiers = (s: string): string => s.replace(/\b(one|1) or (more|fewer|less)\b/g, 'any');

/** The text with its spelled-out numbers written as digits, so both sides of the comparison speak one language. */
const digits = (s: string): string => s.replace(NUMBER_WORD_RE, w => NUMBER_WORDS[w] ?? w);

/**
 * The comparable words of a piece of text: lower-cased, reminder text in parentheses removed, mana braces and
 * punctuation dropped, `the`/`a`/`an` dropped, and each word lemmatised by stripping a plural `s` / `es`.
 * `+1/+1` and `2/2` survive as single tokens because `+`, `-` and `/` are kept.
 */
export function lemmas(text: string): string[] {
  const cleaned = digits(collapseWording(text.toLowerCase()))
    .replace(/\([^)]*\)/g, ' ')                        // reminder text
    .replace(/[{}]/g, ' ')                             // {2}{R} -> 2 r
    .replace(/[^a-z0-9+\-/~]+/g, ' ');
  const out: string[] = [];
  for (const raw of cleaned.split(/\s+/)) {
    const w = raw.replace(/^[-/]+|[-/]+$/g, '');
    if (!w || STOP.has(w)) continue;
    out.push(lemma(w));
  }
  return out;
}

const IRREGULAR: Record<string, string> = {
  its: 'it', their: 'it', them: 'it', they: 'it', "doesn't": 'not', "don't": 'not', "can't": 'cant',
  becomes: 'become', enters: 'enter', dies: 'die', deals: 'deal', gains: 'gain', loses: 'lose', draws: 'draw',
  discards: 'discard', sacrifices: 'sacrifice', creates: 'create', puts: 'put', gets: 'get', has: 'have',
  controls: 'control', attacks: 'attack', blocks: 'block', mills: 'mill', reveals: 'reveal', taps: 'tap',
  untaps: 'untap', copies: 'copy', abilities: 'ability', libraries: 'library', graveyards: 'graveyard',
};

/**
 * One word's lemma: an irregular from the table, else the plural ending stripped — `es` only after a sibilant
 * (`boxes`, `matches`), a bare `s` otherwise, so `creatures` becomes `creature` and not `creatur`.
 */
function lemma(w: string): string {
  const irr = IRREGULAR[w];
  if (irr) return irr;
  if (w.length >= 5 && /(?:s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length >= 4 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/**
 * Every number the line prints — the hard gate: a rendering missing one of them scores 0. Spelled-out numbers count
 * ("Draw two cards." prints a 2), and "one or more" does not (see `dropQuantifiers`).
 */
export function numbersIn(text: string): string[] {
  const clean = digits(dropQuantifiers(text.replace(/\([^)]*\)/g, ' ').toLowerCase()));
  return [...new Set([...(clean.match(/\d+/g) ?? []), ...(/\bx\b/.test(clean) ? ['x'] : [])])];
}

/** The zone words a line names. */
const ZONE_WORDS = ['battlefield', 'graveyard', 'library', 'exile', 'hand', 'command zone', 'stack'];
const KEYWORD_SET: ReadonlySet<string> = new Set<string>(KEYWORDS.map(k => String(k)));

/**
 * The keyword / zone / counter-name vocabulary the LINE carries and the rendering therefore has to carry too:
 * every keyword the line prints, every zone it names, and every counter it names (`+1/+1 counter`, `loyalty counter`).
 */
export function vocabularyIn(text: string): string[] {
  const low = collapseWording(text.toLowerCase().replace(/\([^)]*\)/g, ' '));
  const out = new Set<string>();
  for (const k of KEYWORD_SET) if (new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(low)) out.add(k);
  for (const z of ZONE_WORDS) if (low.includes(z)) out.add(z);
  for (const m of low.matchAll(/([+-]?\d+\/[+-]?\d+|[a-z]+)\s+counters?\b/g)) if (m[1] !== 'a' && m[1] !== 'the') out.add(`${m[1]} counter`);
  return [...out];
}

export interface LineScore { text: string; rendered: string; score: number; why?: string }

/**
 * Whether a line is a printed KEYWORD-ABILITY line ("Persist", "Crew 3", "Cumulative upkeep {U}", "Enchant creature",
 * "Flashback {4}{G}") rather than a sentence: a capitalised NAME of at most three words, an optional bare-number or
 * mana-cost parameter, and no sentence punctuation at all — no full stop, comma, colon, quotation mark or `~`.
 *
 * Such a line is not prose describing an effect, and the rendering it is scored against is the keyword's REMINDER
 * TEXT ("Crew 3" -> "tap any number of creatures you control with total power 3 or greater: crew ~"). Word overlap
 * between the two is meaningless — the whole class scored 0.00-0.13 and failed the gate on every card that printed
 * one, whether or not the script was right — so `scoreKeywordLine` scores them on their MAGNITUDE alone.
 */
export function printedKeywordLine(line: string): boolean {
  const t = line.trim();
  if (!t || /[.,:;"~•]/.test(t)) return false;
  if (t.split(/\s+/).length > 4) return false;
  return /^[A-Z][A-Za-z'!-]*(?: [a-z'!-]+){0,2}(?:[ —-]*(?:\d+|(?:\{[^}]*\})+|[a-z][a-z ]*))?$/.test(t);
}

/**
 * A printed keyword line against the reminder-text rendering of the ability that implements it. Only the line's own
 * MAGNITUDE is scored — "Crew 3" rendered by an ability that crews for 2 still scores 0, which is the cross-check
 * that matters — and the numbers inside a mana cost are not magnitudes the expansion has to repeat.
 */
export function scoreKeywordLine(line: string, rendered: string): LineScore {
  const have = new Set(numbersIn(rendered));
  const missing = numbersIn(line.replace(/\{[^}]*\}/g, ' ')).filter(n => !have.has(n));
  return missing.length
    ? { text: line, rendered, score: 0, why: `the rendering does not print ${missing.join(', ')}` }
    : { text: line, rendered, score: 1, why: 'a printed keyword line: only its magnitude is scored' };
}

/**
 * Every rendering a claimed line is scored against: the whole ability, each of its top-level effects, and — for a
 * MODAL ability — the whole ability up to its first bullet. "When ~ enters, choose one —" is an oracle line of its
 * own and each "• …" below it is another; the ability that claims the parent renders every bullet with it, so
 * scoring the parent against the full rendering charged it for four lines it does not print.
 */
export function renderingsOf(a: Ability): string[] {
  const parts = a.kind === 'static' ? [] : ((a as { effects?: Effect[] }).effects ?? []).map(e => renderEffect(e));
  const out = [renderAbility(a), ...parts];
  for (const r of [...out]) if (r.includes('•')) out.push(r.slice(0, r.indexOf('•')).trim());
  return out;
}

/**
 * The best score one claimed oracle line reaches against the ability that claims it — THE one definition of a line's
 * score. `scoreAbilities` (and so `scripts:verify`) and `scripts:render` both go through here, so the number the
 * author is shown while debugging is the number the gate used.
 */
export function scoreClaimedLine(a: Ability, line: string): LineScore {
  const score = printedKeywordLine(line) ? scoreKeywordLine : scoreRendering;
  let best: LineScore | null = null;
  for (const r of renderingsOf(a)) { const s = score(line, r); if (!best || s.score > best.score) best = s; }
  return best ?? { text: line, rendered: '', score: 0 };
}

/**
 * How well `rendered` reproduces the oracle `line`, in [0, 1]:
 *
 *   * every NUMBER the line prints must appear in the rendering — else 0 (this is the rule that catches a script
 *     that writes `damage 2` for a line that says 3, and every zero-magnitude bypass HANDOFF item 18 lists);
 *   * every keyword / zone / counter name the line prints must appear too, or the Jaccard is halved per miss;
 *   * otherwise, the Jaccard overlap of the two lemmatised word sets.
 */
export function scoreRendering(line: string, rendered: string): LineScore {
  const rlow = collapseWording(rendered.toLowerCase());
  const rNums = new Set(numbersIn(rendered));
  // A COUNT EXPRESSION is printed two ways — "1 life for each Elf card in your graveyard" and "+X/+X, where X is the
  // number of Gates you control" — and neither the `1` nor the `X` is a magnitude a script could get wrong: the
  // magnitude IS the expression (whose own `times` / `plus` still print as numbers and are still gated). So when the
  // rendering carries a count expression, those two tokens alone are exempt. Every other number stays hard.
  const counted = rlow.includes('the number of');
  const exempt = (n: string) => counted && (n === '1' || n === 'x');
  const missingNum = numbersIn(line).filter(n => !rNums.has(n) && !exempt(n));
  if (missingNum.length) return { text: line, rendered, score: 0, why: `the rendering does not print ${missingNum.join(', ')}` };
  const missingVocab = vocabularyIn(line).filter(v => !rlow.includes(v.replace(/ counter$/, '')));
  const A = new Set(lemmas(line)); const B = new Set(lemmas(rendered));
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  const union = A.size + B.size - inter;
  const jaccard = union ? inter / union : 1;
  const score = jaccard * Math.pow(0.5, missingVocab.length);
  return { text: line, rendered, score: Math.round(score * 1000) / 1000, ...(missingVocab.length ? { why: `the rendering does not name ${missingVocab.join(', ')}` } : {}) };
}

// ---------------------------------------------------------------------------
// A whole card: which ability claims which line, and the card's score
// ---------------------------------------------------------------------------

export interface CardScore {
  /** min over the scored lines; 1 when the card has no ability-claimed line (a vanilla creature). */
  score: number;
  lines: LineScore[];
  /** ops with neither a core template nor a registry renderer. */
  gaps: string[];
}

/**
 * The lines of a face that are the RENDERER's business: the lines each ability really claims
 * (`abilityClaimLines` — an ability with no substantive effect, or one over its line budget, claims nothing), minus
 * the lines the face's KEYWORDS or a valid `covers` declaration account for. A keyword line ("Flying", "Cycling {2}",
 * "Flashback {4}{G}") is implemented by a declaration, not by an ability, and `scripts:check` already checks the
 * declared value against the printed one — rendering the ability that happens to sit next to it and scoring the two
 * would fail every keyworded card for no reason.
 */
export function scorableClaims(face: KeywordParams & { covers?: { line: string; by: string }[] }, abilities: readonly Ability[] | undefined, cardName: string): Map<Ability, string[]> {
  const declared = new Set<string>();
  for (const c of face.covers ?? []) if (COVER_KINDS.includes(c.by as CoverKind) && coverProblem(face as never, c as never) === null) declared.add(c.line.trim());
  const out = new Map<Ability, string[]>();
  for (const a of abilities ?? []) {
    const keep = abilityClaimLines(a, cardName).filter(l => !declared.has(l) && !keywordLineClaimed(l, face));
    if (keep.length) out.set(a, keep);
  }
  return out;
}

/**
 * Score every oracle line an ability claims. The line is compared against the WHOLE ability's rendering and against
 * each of the ability's top-level effects, and the best of those wins (`scoreClaimedLine`): a one-line triggered
 * ability is judged on the whole clause ("Whenever ~ attacks, you gain 1 life."), while a multi-line `spell` ability
 * — which is how the parser writes an instant's whole face text — is judged line against effect.
 */
export function scoreAbilities(claims: Map<Ability, string[]>): CardScore {
  const lines: LineScore[] = [];
  const gaps = new Set<string>();
  for (const [a, claimed] of claims) {
    for (const g of renderGaps(a)) gaps.add(g);
    for (const line of claimed) lines.push(scoreClaimedLine(a, line));
  }
  return { score: lines.length ? Math.min(...lines.map(l => l.score)) : 1, lines, gaps: [...gaps].sort() };
}

/** One face of a card as `scoreCard` scores it: its declarations, the abilities it has, and the name lines print. */
export interface ScorableFace extends KeywordParams { covers?: { line: string; by: string }[]; abilities?: readonly Ability[] }

/**
 * The round-trip score of a parsed (or scripted) card: EVERY face's abilities against the lines they claim.
 *
 * All three faces are scored — the front, `backFace` (the far side of a transforming DFC) and `secondFace` (the
 * second half of a split / adventure / flip card, which has no `CardDef` of its own and reaches this function from
 * `script.secondFace`). A face that is scored nowhere is a face the numbers hard-gate never sees, which is exactly
 * the half of a card a wrong script would hide in.
 */
export function scoreCard(
  def: Pick<CardDef, 'name' | 'abilities' | 'backFace' | 'keywords' | 'protectionFrom' | 'wardCost' | 'toxic' | 'bushido' | 'rampage' | 'landwalk' | 'firebending'>
    & { covers?: { line: string; by: string }[] },
  secondFace?: { face: ScorableFace; name: string } | null,
): CardScore {
  const scored = [scoreAbilities(scorableClaims(def, def.abilities, def.name))];
  if (def.backFace) scored.push(scoreAbilities(scorableClaims(def.backFace, def.backFace.abilities, def.backFace.name)));
  if (secondFace) scored.push(scoreAbilities(scorableClaims(secondFace.face, secondFace.face.abilities, secondFace.name)));
  if (scored.length === 1) return scored[0];
  const lines = scored.flatMap(s => s.lines);
  return { score: lines.length ? Math.min(...lines.map(l => l.score)) : 1, lines, gaps: [...new Set(scored.flatMap(s => s.gaps))].sort() };
}
