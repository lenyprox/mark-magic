// Family taxonomy (plan Part 3). Which vocabulary wave a card is waiting for, decided from the lines the parser did
// NOT understand plus Scryfall's keyword list. `scripts:queue` groups batches by family so an author sees thirty
// cards that need the same thinking, and `scripts:needs --taxonomy` re-measures the plan's cards-touching table.
//
// This REPLACES the ad-hoc regex heuristic that produced docs/plans/owner-decks-needs.md. Two things changed:
//
//   * one table, not a chain of `if`s — `FAMILY_RULES` below is the whole classifier, every rule carries a `why`
//     string, and `test/taxonomy.test.ts` pins > 60 real cards against it;
//   * the heuristic's known over-tags are fixed. The loudest was `control`: it fired on any line containing the
//     word "control", so "Creatures you control gain trample until end of turn" was filed under control change
//     (the doc says so itself: "heuristic over-tags this"). A control line has to CHANGE control — `gain control`,
//     `exchange control`, `untap … under your control`. Likewise `layers` no longer eats every "becomes" line
//     ("becomes blocked" is combat, "becomes the target" is generic) and `replacement` needs a `would … instead`
//     shape rather than the bare word "instead".
//
// A card's families are the union of its lines' families; its PRIMARY family is the RAREST of them over the pool,
// so a card that needs one exotic family and some generic composition is queued with the exotic one. Rarity comes
// from a measured frequency map when the caller has one (`scripts:queue` measures the selection it is about to
// issue) and from `DEFAULT_FAMILY_RANK` otherwise.
import { normalizeOracleLine } from './oracle-lines.js';
import type { CardDef } from './types.js';

/** The families of plan Part 3, plus `named-keyword:<name>` for a printed keyword and `other` for "no rule matched". */
export const BASE_FAMILIES = [
  'generic', 'control', 'cost-alter', 'combat-restr', 'replacement', 'keyword-action', 'piles-choices',
  'copy-clone', 'layers', 'transform', 'planeswalker', 'dice-coin', 'saga', 'other',
] as const;
export type BaseFamily = typeof BASE_FAMILIES[number];
export type Family = BaseFamily | `named-keyword:${string}`;

export const isNamedKeyword = (f: Family): f is `named-keyword:${string}` => f.startsWith('named-keyword:');

/** One classifier rule. Rules are tried in order; the FIRST match wins for that line (a line has one family). */
export interface FamilyRule {
  family: BaseFamily;
  /** Matched against the normalised, lower-cased line. */
  re: RegExp;
  /** A veto: when this matches, the rule declines and the next one is tried. Fixes the heuristic's over-tags. */
  not?: RegExp;
  /** What the rule is for — printed by `scripts:needs --taxonomy --explain`. */
  why: string;
}

/**
 * The classifier. Ordered most specific first: a line that mentions a planeswalker loyalty cost is planeswalker
 * work even though it also says "draw a card", and only a line no other rule claims is `generic`.
 *
 * Every regex runs against the line lower-cased with the card name already replaced by `~` (parse.ts normalisation),
 * so `~` is safe to write and no rule may depend on a card's own name.
 */
export const FAMILY_RULES: readonly FamilyRule[] = [
  // --- planeswalker: loyalty abilities are printed as "[+N]: …" / "[−N]: …" and nothing else looks like that
  { family: 'planeswalker', re: /^\[?[+\-−]?\d+\]?\s*:/, why: 'a loyalty ability' },
  { family: 'planeswalker', re: /\bloyalty counter|\bplaneswalker you control\b.*\bloyalty\b|\bproliferate\b.*\bloyalty\b/, why: 'loyalty counters' },

  // --- saga / chapters
  { family: 'saga', re: /^(?:i{1,3}|iv|v|vi{0,3}|ix|x)\s*(?:,\s*(?:i{1,3}|iv|v|vi{0,3}|ix|x)\s*)*[—\-:]/, why: 'a saga chapter line' },
  { family: 'saga', re: /\b(?:lore|chapter) counter/, why: 'lore counters' },

  // --- dice and coins
  { family: 'dice-coin', re: /\bflips? a coin|\brolls? a (?:six|twenty|d\d|\d+)|\bd\d{1,3}\b|\bdie roll|\brolls? two dice/, why: 'a die roll or coin flip' },

  // --- transform / meld / flip / disturb-side faces
  { family: 'transform', re: /\btransforms?\b|\bmelds? with\b|\bexile them, then meld|\bturn(?:s)? it face up\b|\bnight becomes day|\bday becomes night|\bit becomes day|\bit becomes night/, why: 'a transform / meld / day-night switch' },

  // --- copy / clone
  { family: 'copy-clone', re: /\bcopy (?:of )?(?:target|that|it|each)|\bcopies? (?:target|that spell)|\bas a copy\b|\bcreate a (?:token that's a )?copy\b|\bcopy that spell\b|\bmay choose new targets for (?:the|that) copy\b|\bexcept it's a\b.*\bcopy\b/, why: 'copying a spell or permanent' },
  { family: 'copy-clone', re: /\benters as a copy\b|\byou may have ~ enter as a copy\b/, why: 'a clone' },

  // --- layers: base P/T, type / colour / subtype changes with durations, and ability loss
  {
    family: 'layers',
    re: /\bbase power and toughness\b|\bbecomes? a(?:n)? [^.]*\b(?:creature|artifact|land|enchantment)\b|\bis a(?:n)? [^.]*\b(?:land|plains|island|swamp|mountain|forest)\b|\bare (?:plains|islands|swamps|mountains|forests)\b|\bin addition to its other (?:types|land types|creature types)\b|\bbecomes? the chosen (?:color|colour|type)\b|\bis the chosen (?:color|colour|type)\b|\bloses? all (?:other )?(?:creature )?types\b|\bbecomes? a (?:plains|island|swamp|mountain|forest)\b|\bchangeling\b|\bis every creature type\b|\bloses? all abilities\b|\bcan't have or gain\b|\bpower (?:and toughness are|is) (?:each )?equal to\b/,
    not: /\bbecomes? blocked\b|\bbecomes? the target\b|\bbecomes? tapped\b|\bbecomes? untapped\b|\bbecomes? attached\b/,
    why: 'a type / base-P-T / colour change or ability loss (layers)',
  },

  // --- control change. NOT "creatures you control gain flying" — that is generic composition. Control has to MOVE.
  {
    family: 'control',
    // `under its owner's control` is deliberately NOT here: "return it to the battlefield under its owner's control"
    // is a zone move, not a control change, and the `not` clause below drops the same wording with "your".
    re: /\bgains? control of\b|\bgain control of\b|\bexchange control\b|\bexchanges? control\b|\bunder (?:your|that player's|an opponent's) control\b|\bcontrol of (?:target|that|all|each|another)\b|\byou control (?:target|enchanted|it)\b(?=[^.]*\buntil\b)/,
    not: /\bcreatures? you control\b(?![^.]*\bgains? control\b)|\bpermanents? you control\b(?![^.]*\bgains? control\b)|\breturns?\b[^.]*\bunder\b[^.]*\bcontrol\b/,
    why: 'control of a permanent changes hands',
  },
  { family: 'control', re: /\buntap (?:it|that permanent)\b[^.]*\bgain control\b|\buntil end of turn[^.]*\bgain control\b/, why: 'a temporary control change' },

  // --- cost alteration and free casts
  { family: 'cost-alter', re: /\bcosts? \{[^}]+\} (?:less|more) to cast\b|\bcost \{[^}]+\} (?:less|more)\b|\bspells? (?:you|your opponents) cast cost\b/, why: 'a cost adjustment' },
  { family: 'cost-alter', re: /\brather than pay\b|\bwithout paying (?:its|that|their) mana costs?\b|\byou may cast\b[^.]*\bfrom (?:your graveyard|exile|the top|your hand)\b|\bmay play (?:lands|it) from\b|\byou may spend mana as though\b/, why: 'a free cast / alternative cost / cast-from permission' },

  // --- combat restrictions and requirements
  { family: 'combat-restr', re: /\bcan't be blocked except by\b|\bmust be blocked if able\b|\bblocks? (?:this turn )?if able\b|\battacks? (?:each|this) (?:combat|turn) if able\b|\bcan't attack\b|\bcan't block\b|\bcan block only\b|\bcan't be blocked by more than\b|\bassigns? (?:its )?combat damage as though it weren't blocked\b|\bextra combat phase\b|\battacks? as though it (?:didn't|weren't)\b|\bable to block [^.]*\bdo so\b|\bmenace\b(?=[^.]*except)/, why: 'a combat restriction or requirement' },

  // --- replacement / prevention: needs a "would … instead" or a prevention shape, not the bare word "instead"
  { family: 'replacement', re: /\bif [^.]*\bwould\b[^.]*\binstead\b|\bwould (?:be dealt|deal) damage[^.]*\bprevent\b|\bprevent the next\b|\bprevent all\b[^.]*\bdamage\b|\bcan't be prevented\b|\bis prevented this way\b|\binstead of\b[^.]*\bpay(?:ing)?\b|\bif you would\b[^.]*\binstead\b|\benters with an additional\b|\bskip (?:your|that player's)\b|\btriggers an additional time\b|\benters? untapped\b|\benter untapped\b|\blife total can't change\b|\bdon't cause abilities to trigger\b|\bcan't (?:lose|win) the game\b/, why: 'a replacement or prevention effect' },

  // --- piles, votes, opponent chooses, "hasn't been chosen"
  { family: 'piles-choices', re: /\bseparates? (?:those cards|them) into two piles\b|\bin (?:two|three) piles\b|\ban opponent chooses\b|\bchoose(?:s)? one that hasn't been chosen\b|\bvotes?\b|\bwill of the council\b|\bcouncil's dilemma\b|\btarget opponent chooses\b|\bthat player chooses one\b|\bsecretly\b|\bchoose any number of modes\b|\bthe same mode more than once\b/, why: 'piles, votes or an opponent-made choice' },

  // --- keyword ACTIONS (verbs, not keyword abilities): CR 701
  {
    family: 'keyword-action',
    re: /\b(?:investigate|amass|adapt|bolster|support|manifest(?: dread)?|populate|goad|incubate|connive|learn|discover|forage|clash|monstrosity|becomes? monstrous|exert|collect evidence|cloak|endure|harness|suspect|behold|surveil|explore|proliferate|mill|scry|fateseal|venture into|the ring tempts you|day begins|meld|bargain|convert|open an attraction|roll to visit)\b/,
    why: 'a CR 701 keyword action',
  },

  // --- generic composition: everything the composition core (9.0) is meant to express
  {
    family: 'generic',
    re: /\b(?:destroys?|exiles?|counters?|draws?|discards?|searches|search|shuffles?|sacrifices?|returns?|creates?|taps?|untaps?|target|each player|each opponent|counters? on|reveals?)\b|\bdeals?\b[^.]*\bdamage\b|\b(?:gains?|loses?)\b[^.]*\b(?:life|until end of turn)\b|\+\d+\/\+\d+|-\d+\/-\d+|\badd \{|\bgets? [+\-]|\bputs? [^.]*\b(?:onto the battlefield|on top of|into (?:its|their|your) (?:owner's )?(?:librar|graveyard|hand))|\blook at the top\b|\bpoison counter|\bchoose (?:one|two|three)\b|\bchoose a (?:basic land type|land type|creature type|colou?r|card name)\b|\bas an additional cost to cast\b/,
    why: 'ordinary composition (destroy / pump / counters / draw / tokens / damage / life / library / tap / mana)',
  },
];

/**
 * Named keywords (plan 9.2). A line whose FIRST word is one of these, or a Scryfall keyword the parser left in an
 * unparsed line, files the card under `named-keyword:<name>` — one queue group per keyword, which is how the 9.2
 * modules are cut ("3–5 related keywords per module").
 *
 * Keywords the parser already handles in full (flying, trample, …) are not here: they never appear in an unparsed
 * line, so listing them would only slow the scan.
 */
export const NAMED_KEYWORDS: readonly string[] = [
  'adapt', 'afflict', 'afterlife', 'aftermath', 'amplify', 'annihilator', 'ascend', 'assist', 'aura swap',
  'awaken', 'backup', 'banding', 'bargain', 'bestow', 'blitz', 'bloodthirst', 'boast', 'bushido', 'buyback',
  'cascade', 'casualty', 'champion', 'changeling', 'cipher', 'cleave', 'companion', 'compleated', 'conspire',
  'convoke', 'craft', 'crew', 'cumulative upkeep', 'cycling', 'dash', 'daybound', 'delve', 'demonstrate',
  'dethrone', 'devour', 'disguise', 'disturb', 'double team', 'dredge', 'echo', 'embalm', 'emerge', 'encore',
  // 'equip' is deliberately absent: "equipped creature …" is ordinary composition on an Equipment, and the printed
  // "Equip {2}" line is already parsed — listing it filed 438 pool cards under a keyword none of them needs.
  'enlist', 'entwine', 'epic', 'escalate', 'escape', 'eternalize', 'evoke', 'evolve', 'exalted', 'exhaust',
  'exploit', 'extort', 'fabricate', 'fading', 'flashback', 'foretell', 'forecast', 'fortify', 'fortified',
  'freerunning', 'fuse', 'graft', 'gift', 'haunt', 'hidden agenda', 'hideaway', 'horsemanship', 'improvise',
  'ingest', 'initiative', 'job select', 'kicker', 'landcycling', 'level', 'living weapon', 'madness', 'mayhem', 'melee',
  'mentor', 'miracle', 'modular', 'morph', 'multikicker', 'mutate', 'myriad', 'ninjutsu', 'offering', 'offspring',
  'outlast', 'overload', 'partner', 'persist', 'phase out', 'phases out', 'phasing', 'plot', 'poisonous',
  'prepare', 'prepared', 'prototype', 'provoke', 'prowl', 'rampage', 'ravenous', 'read ahead', 'rebound',
  'reconfigure', 'recover', 'reinforce', 'renown', 'replicate', 'retrace', 'riot', 'ripple', 'scavenge',
  'soulbond', 'soulshift', 'specialize', 'spectacle', 'splice', 'split second', 'spree', 'squad', 'station',
  'storm', 'sunburst', 'surge', 'suspend', 'tiered', 'toxic', 'training', 'transfigure', 'transmute', 'tribute',
  'undaunted', 'undying', 'unearth', 'unleash', 'vanishing', 'wither', 'web-slinging',
];

/**
 * Inflections that name the SAME family as their base keyword, so a queue group is not split in two. Applied on
 * BOTH paths into a named family — the line wording (`namedKeywordOfLine`) and Scryfall's own keyword list — or an
 * inflected keyword produces two families for one card and counts the same line twice in every histogram.
 */
export const KEYWORD_ALIAS: Readonly<Record<string, string>> = {
  prepared: 'prepare', fortified: 'fortify', 'phase out': 'phasing', 'phases out': 'phasing', level: 'level up',
};

/**
 * `\bkeyword\b` matchers, built once (some keywords contain spaces or hyphens). A trailing `s` / `d` / `es` / `ed`
 * is tolerated so the printed inflections match: "stations permanents", "the creature is fortified", "enters
 * prepared", "crews a Vehicle".
 */
const NAMED_KEYWORD_RES: readonly [string, RegExp][] = NAMED_KEYWORDS.map(k => [k, new RegExp(`(^|[^a-z])${k.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}(?:s|d|es|ed)?([^a-z]|$)`, 'i')]);

/** Families whose SHAPE is unmistakable, so they outrank a keyword word the same line happens to contain. */
const STRUCTURAL: ReadonlySet<BaseFamily> = new Set<BaseFamily>(['planeswalker', 'saga', 'dice-coin', 'transform']);

/** How the classifier read one line. */
export interface LineFamily { line: string; family: Family; why: string }

export interface TaxonomyResult {
  /** Every family the card touches, sorted (rarest first once `primary` is decided). */
  families: Family[];
  /** The rarest of them over the pool — the family the queue groups this card under. */
  primary: Family;
  /** Per unparsed line, the family it was filed under. */
  lines: LineFamily[];
}

/** The unparsed facts `familiesOf` needs. A whole `CardDef` satisfies it. */
export interface TaxonomyDef {
  unparsed: string[];
  /** Scryfall's own `keywords` array for the card (`oracle_cards.json`.keywords), not the parser's enum. */
  scryfallKeywords?: string[];
  backFace?: { unparsed: string[] } | null;
}

export interface TaxonomyOptions {
  /** Measured `family -> cards touching` counts; the RAREST family wins. Falls back to `DEFAULT_FAMILY_RANK`. */
  frequencies?: ReadonlyMap<string, number>;
}

/**
 * Rarity fallback, lowest = rarest. Used when no measured frequency map is supplied — the order is the plan's own
 * Part 3 ordering (a named keyword is always rarer than a broad rules family, and `generic` is the commonest thing
 * there is, so it only ever becomes a primary family when it is the card's ONLY family).
 *
 * `npm run scripts:needs -- --taxonomy` prints the measured counts; keep this table in step with them when the pool
 * moves, or pass `frequencies` (which `scripts:queue` always does).
 */
export const DEFAULT_FAMILY_RANK: Record<BaseFamily, number> = {
  saga: 1, 'dice-coin': 2, transform: 3, planeswalker: 4, 'piles-choices': 5, 'copy-clone': 6, layers: 7,
  replacement: 8, 'combat-restr': 9, 'cost-alter': 10, control: 11, 'keyword-action': 12, other: 13, generic: 1000,
};
/** A named keyword sits between the rules families and `other`: rarer than any of them, commoner than nothing. */
export const NAMED_KEYWORD_RANK = 0;

function rankOf(f: Family, freq?: ReadonlyMap<string, number>): number {
  if (freq) { const n = freq.get(f); if (n !== undefined) return n; }
  if (isNamedKeyword(f)) return NAMED_KEYWORD_RANK;
  return DEFAULT_FAMILY_RANK[f as BaseFamily] ?? 999;
}

/** The one family a line belongs to, or null when no rule matched (the caller files that as `other`). */
export function familyOfLine(line: string): { family: BaseFamily; why: string } | null {
  const l = normalizeOracleLine(line).toLowerCase().replace(/^\/\/ /, '').replace(/^• /, '');
  if (!l) return null;
  for (const r of FAMILY_RULES) {
    if (!r.re.test(l)) continue;
    if (r.not?.test(l)) continue;
    return { family: r.family, why: r.why };
  }
  return null;
}

/** The canonical family name of a printed keyword: its base form when it is an inflection, else itself. */
export function canonicalKeyword(name: string): string {
  return KEYWORD_ALIAS[name.toLowerCase()] ?? name.toLowerCase();
}

/** The named keyword a line is about, or null. The FIRST word wins ("Bestow {4}{W}" is bestow, not an aura line). */
export function namedKeywordOfLine(line: string): string | null {
  const l = normalizeOracleLine(line).toLowerCase().replace(/^\/\/ /, '').replace(/^• /, '');
  for (const [name, re] of NAMED_KEYWORD_RES) if (re.test(l)) return canonicalKeyword(name);
  return null;
}

/**
 * The families a card is waiting for. Reads the lines the parser did NOT understand (front face, back face and the
 * fragments `parse.ts` reports) plus Scryfall's keyword list: a keyword that appears in an unparsed line is a named
 * keyword the card needs, and a keyword that appears in no unparsed line is already handled and is ignored.
 *
 * A fully parsed card has no unparsed line and therefore no family — the result is `{ families: [], primary: 'other' }`
 * and the queue never issues it.
 */
export function familiesOf(def: TaxonomyDef | CardDef, opts: TaxonomyOptions = {}): TaxonomyResult {
  const d = def as TaxonomyDef & { keywords?: unknown };
  const lines: LineFamily[] = [];
  const raw = [...(d.unparsed ?? []), ...((d.backFace?.unparsed ?? []).map(l => '// ' + l))];
  const seen = new Set<string>();
  for (const line of raw) {
    if (seen.has(line)) continue;
    seen.add(line);
    const hit = familyOfLine(line);
    // the STRUCTURAL families win over a keyword the line happens to mention: a saga chapter that says "escape" is
    // still saga work, and a loyalty ability that says "kicker" is still a planeswalker's
    if (hit && STRUCTURAL.has(hit.family)) { lines.push({ line, family: hit.family, why: hit.why }); continue; }
    const kw = namedKeywordOfLine(line);
    if (kw) { lines.push({ line, family: `named-keyword:${kw}`, why: `the printed keyword "${kw}"` }); continue; }
    lines.push(hit ? { line, family: hit.family, why: hit.why } : { line, family: 'other', why: 'no rule matched this wording' });
  }
  // Scryfall's keywords catch a keyword the line wording hides ("Station 5" prints as a table, "Gift a card" as a cost)
  const scry = (d.scryfallKeywords ?? []).map(k => k.toLowerCase());
  for (const k of scry) {
    if (!NAMED_KEYWORDS.includes(k)) continue;
    // the SAME alias the line path applies: "Prepared" and "prepare" are one family, not two
    const fam: Family = `named-keyword:${canonicalKeyword(k)}`;
    if (lines.some(l => l.family === fam)) continue;
    // only when the card actually has unparsed text — a keyword the parser finished is not a need
    if (!raw.length) continue;
    const line = raw.find(l => new RegExp(`(^|[^a-z])${k.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}`, 'i').test(l));
    if (line) lines.push({ line, family: fam, why: `Scryfall lists the keyword "${k}"` });
  }
  const families = [...new Set(lines.map(l => l.family))];
  families.sort((a, b) => rankOf(a, opts.frequencies) - rankOf(b, opts.frequencies) || (a < b ? -1 : a > b ? 1 : 0));
  return { families, primary: families[0] ?? 'other', lines };
}

/** `family -> cards touching it` and `family -> lines`, over any set of cards. The `--taxonomy` histogram. */
export interface FamilyHistogram { cards: Map<Family, number>; lines: Map<Family, number>; totalCards: number; totalLines: number }

export function emptyFamilyHistogram(): FamilyHistogram { return { cards: new Map(), lines: new Map(), totalCards: 0, totalLines: 0 }; }

/** Fold one card's taxonomy into a histogram (cards are counted ONCE per family, lines once each). */
export function addToHistogram(h: FamilyHistogram, t: TaxonomyResult): void {
  if (!t.lines.length) return;
  h.totalCards++;
  h.totalLines += t.lines.length;
  for (const f of new Set(t.lines.map(l => l.family))) h.cards.set(f, (h.cards.get(f) ?? 0) + 1);
  for (const l of t.lines) h.lines.set(l.family, (h.lines.get(l.family) ?? 0) + 1);
}

/** The histogram as sorted rows (most cards first, ties by name) — what `scripts:needs --taxonomy` prints. */
export function histogramRows(h: FamilyHistogram): { family: Family; cards: number; lines: number }[] {
  return [...h.cards.keys()]
    .map(family => ({ family, cards: h.cards.get(family) ?? 0, lines: h.lines.get(family) ?? 0 }))
    .sort((a, b) => b.cards - a.cards || b.lines - a.lines || (a.family < b.family ? -1 : 1));
}
