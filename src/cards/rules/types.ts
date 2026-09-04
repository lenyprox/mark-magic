// The parser rule contract: how a mechanic family teaches src/cards/parse.ts its *wordings*.
//
// src/engine/ops/<family>.ts adds behaviour (ops, conditions, triggers, statics, ...); src/cards/rules/<family>.ts adds
// the oracle-text templates that produce them. A family file default-exports a `RuleFamily`; `npm run gen:registry`
// folds every file in this directory into the flat arrays of `./_registry.ts`, and parse.ts consults those arrays
// **after** its own built-in tables at every dispatch point. Built-ins always win, so adding a family can only turn
// `unknown` into something — never change a parse that already worked (`npm run parse:diff` proves it).
//
// Nothing here imports parse.ts at runtime: the helper callbacks on `LineCtx` hand a rule the built-in sub-parsers, so
// a family reuses the shared vocabulary (filters, targets, amounts, costs) instead of re-implementing it. The only
// import from parse.ts is the `OracleRow` *type*, which is erased.
import type { OracleRow } from '../parse.js';
import type { Ability, AbilityCost, AltCost, AsEnters, CardDef, CardType, Condition, CostModifier, Effect, Keyword, ManaCost, StaticEffect, TriggerEvent } from '../types.js';

/**
 * One sentence template — exactly the shape of parse.ts's built-in `Rule`. `re` is matched against the *normalised*
 * sentence (trimmed, whitespace collapsed, trailing "." removed, the card's own name and "this creature"/"it" already
 * rewritten to `~`, a leading "You may "/"Then " stripped). Return `null` to decline the match and let later rules try.
 */
export interface EffectRule { re: RegExp; make: (m: RegExpMatchArray) => Effect | null }

/** The card characteristics `parseStatic` is given (the front face's types and Scryfall's subtypes). */
export interface StaticCard { types: CardType[]; subtypes: string[] }

/**
 * Everything a line rule may touch, so it never has to import a parse.ts internal.
 * `def` is the `CardDef` under construction: read it freely, but write through the `add*` helpers where one exists so
 * the optional arrays (`altCosts`, `asEnters`, `costModifiers`) are created consistently.
 */
export interface LineCtx {
  /** The card being built. Its `abilities`, `keywords`, `unparsed` and flag fields are still mutable. */
  def: CardDef;
  /** The normalised line: reminder text stripped, `~` substituted for the card's name, ability word removed. */
  line: string;
  /** The same line before the ability-word / "Name — " prefix strip. */
  rawLine: string;
  /** The Scryfall oracle row this card came from (type line, layout, faces, produced mana, ...). */
  row: OracleRow;
  /** Scryfall's own keyword tags for this card — the cheap way to gate a rule ("only if this card has `Bestow`"). */
  keywords: readonly string[];
  /** True when the card is an Instant or Sorcery (its lines become spell effects rather than abilities). */
  isSpell: boolean;

  // ---- built-in sub-parsers (the shared vocabulary; all of them are the same functions the built-ins use)
  parseEffects: (text: string) => Effect[];
  parseCost: (costText: string) => AbilityCost | null;
  parseCostPhrase: (phrase: string) => AbilityCost | null;
  parseCondition: (text: string) => Condition;
  parseManaCost: (raw: string | null | undefined) => ManaCost | null;
  parseTrigger: (head: string) => TriggerEvent;

  // ---- mutators
  addAbility: (a: Ability) => void;
  addAltCost: (a: AltCost) => void;
  /** Duplicates are fine: parseCard de-duplicates `def.keywords` once every line is done. */
  addKeyword: (k: Keyword) => void;
  addAsEnters: (a: AsEnters) => void;
  addCostModifier: (c: CostModifier) => void;
  /** Claim the line but record it as not simulable (defaults to `ctx.line`); marks the card partially parsed. */
  markUnparsed: (line?: string) => void;
}

/**
 * A whole-line rule. Return `true` to claim the line (parse.ts moves to the next line), `false` to decline.
 * `name` is used in `rulesHash()` and in error messages, so make it stable and unique within the family.
 */
export interface LineRule { name: string; match: (line: string, ctx: LineCtx) => boolean }

/** A trigger head ("Whenever ~ attacks") → a `TriggerEvent`, or `null` to decline. `head` is raw; lowercase it yourself. */
export interface TriggerRule { name?: string; make: (head: string) => TriggerEvent | null }

/** A condition clause ("you control a Goblin") → a `Condition`, or `null` to decline. */
export interface ConditionRule { name?: string; make: (text: string) => Condition | null }

/** A static-ability line → one or more `StaticEffect`s, or `null` to decline. */
export interface StaticRule { name?: string; make: (line: string, card: StaticCard) => StaticEffect | StaticEffect[] | null }

/** One comma-separated cost phrase ("Sacrifice a Clue") → an `AbilityCost`, or `null` to decline. */
export interface CostRule { name?: string; make: (phrase: string) => AbilityCost | null }

/** The default export of `src/cards/rules/<family>.ts`. `name` must be unique across families (a hard error otherwise). */
export interface RuleFamily {
  name: string;
  effects?: EffectRule[];
  lines?: LineRule[];
  triggers?: TriggerRule[];
  conditions?: ConditionRule[];
  statics?: StaticRule[];
  costs?: CostRule[];
}
