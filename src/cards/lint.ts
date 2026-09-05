// Script lint (plan 2.2 stage 4): the vocabulary and card-shape checks that the strict zod schema cannot make.
//
// The schema says "this field is a string"; the lint says "that string is a counter Magic prints, a subtype the pool
// prints, a keyword the engine knows". It is the stage that catches the LLM-written script whose every field
// validates and whose `counter: "power"` / `subtypes: ["Zomby"]` / `withKeyword: "flanking "` names nothing.
//
// EVERY vocabulary here has a RUNTIME source, which is what closes HANDOFF item 12's "type-only registries":
//   * ops / conditions / triggers / statics / as-enters — the discriminator LITERALS of the COMPOSED zod unions of
//     `./schema.ts` (`schemaVocabulary()`: the core variant lists plus every family's `<family>.schema.ts`, folded
//     by the generated `./_schemas.ts`), plus whatever a family registered in `src/engine/ops/_registry.ts` — so an
//     op a family declares in its schema is never "unknown" here, and one it registers at run time only is not
//     unknown either;
//   * cost modifiers — the core union (no family slot in the schema contract);
//   * target kinds / amount counts — the composed enums of the same file, plus the registries; keywords — the named
//     `z.enum` constant (a family can only widen `Keyword` by declaration merging, which has no runtime source);
//   * subtypes — the GENERATED `./subtype-vocab.ts` (`npm run gen:subtypes`), never a live master.db query, so the
//     lint runs in a worktree with no database and gives the same answer on every machine;
//   * counter names — a curated core list plus every keyword (CR 122.1 keyword counters) plus every name THIS card's
//     oracle text prints before the word "counter", which is how the long tail (fuse, hoofprint, hatchling …) passes
//     without a hand-maintained list of 200 names.
//
// TOOLING ONLY, like ./schema.ts and ./render.ts: zod is a devDependency.
import {
  AMOUNTS, CONDITIONS, EFFECT_OPS, STATICS, TARGET_KINDS as TARGET_KIND_HOOKS, TRIGGERS,
} from '../engine/ops/_registry.js';
import { COST_MODIFIER_VARIANTS, KEYWORDS, schemaVocabulary } from './schema.js';
import {
  coverProblems, ignoreLineProblem, scriptableLines, type CardScript, type ScriptFace,
} from './scripts.js';
import { SUBTYPE_KIND } from './subtype-vocab.js';
/** Subtypes no printed card carries but tokens do (the vocabulary is generated from type lines): Living weapon's Germ, Fabricate's Servo, and the predefined artifact tokens. */
const TOKEN_ONLY_SUBTYPES: ReadonlySet<string> = new Set(['Germ', 'Servo', 'Powerstone', 'Junk', 'Map', 'Incubator', 'Blood', 'Gold', 'Clue', 'Food', 'Treasure', 'Thopter', 'Spawn', 'Scion']);
import type { PoolTier } from './pool.js';
import type { CardDef } from './types.js';

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * The discriminator literals of a zod variant list — `EFFECT_VARIANTS` keyed by `op`, `CONDITION_VARIANTS` by `kind`.
 * zod's object shape and `z.literal.value` are the only internals touched, and an empty result THROWS rather than
 * silently producing a vocabulary that accepts everything: a zod upgrade that moved them must fail loudly here.
 */
export function discriminators(variants: readonly unknown[], key: string): string[] {
  const out: string[] = [];
  for (const v of variants) {
    const shape = (v as { def?: { shape?: Record<string, { value?: unknown }> } }).def?.shape;
    const value = shape?.[key]?.value;
    if (typeof value === 'string') out.push(value);
  }
  if (out.length !== variants.length) throw new Error(`lint: could not read the '${key}' discriminator of ${out.length}/${variants.length} zod variants — re-anchor src/cards/lint.ts on the zod version in use`);
  return out;
}

const union = (core: readonly string[], registry: Record<string, unknown>): ReadonlySet<string> => new Set<string>([...core, ...Object.keys(registry)]);

/** The composed vocabulary: the core lists plus every generated family schema (read once, when this module loads). */
const COMPOSED = schemaVocabulary();

/** Every `Effect.op` a script may use: the composed union (core + family schemas) plus every family-registered op. */
export const EFFECT_OP_VOCAB: ReadonlySet<string> = union(discriminators(COMPOSED.effectVariants, 'op'), EFFECT_OPS);
/** Every `Condition.kind`. */
export const CONDITION_VOCAB: ReadonlySet<string> = union(discriminators(COMPOSED.conditionVariants, 'kind'), CONDITIONS);
/** Every `TriggerEvent.on`. */
export const TRIGGER_VOCAB: ReadonlySet<string> = union(discriminators(COMPOSED.triggerVariants, 'on'), TRIGGERS);
/** Every `StaticEffect.kind`. */
export const STATIC_VOCAB: ReadonlySet<string> = union(discriminators(COMPOSED.staticVariants, 'kind'), STATICS);
/** Every `AsEnters.kind` (composed) and `CostModifier.kind` (core only: the family schema contract has no slot for it). */
export const AS_ENTERS_VOCAB: ReadonlySet<string> = new Set(discriminators(COMPOSED.asEntersVariants, 'kind'));
export const COST_MODIFIER_VOCAB: ReadonlySet<string> = new Set(discriminators(COST_MODIFIER_VARIANTS, 'kind'));
/** Every `Keyword`. The zod enum IS the runtime source item 12 asked for. */
export const KEYWORD_VOCAB: ReadonlySet<string> = new Set<string>(KEYWORDS.map(String));
/** Every `TargetSpec.kind` (`multi` is the composition core's own; the families' come from their schemas and their registry hooks). */
export const TARGET_KIND_VOCAB: ReadonlySet<string> = union(COMPOSED.targetKinds, TARGET_KIND_HOOKS);
/** Every `Amount.count` (`objects` counts a filter rather than a named set). */
export const AMOUNT_COUNT_VOCAB: ReadonlySet<string> = union(COMPOSED.amountCounts, AMOUNTS);

/**
 * Counter names the engine and the pool use often enough to be worth naming here. It is deliberately NOT the full
 * list — a card that prints an exotic counter says so in its own oracle text, and `countersOf` adds those.
 */
export const CORE_COUNTERS: readonly string[] = [
  '+1/+1', '-1/-1', '+1/+0', '+0/+1', '+2/+2', '-0/-1', 'loyalty', 'charge', 'time', 'lore', 'poison', 'age', 'stun',
  'energy', 'oil', 'quest', 'shield', 'finality', 'storage', 'fade', 'spore', 'experience', 'depletion', 'level',
  'rad', 'verse', 'ki', 'divinity', 'study', 'plan', 'ice', 'doom', 'soul', 'tide', 'page', 'fuse', 'flood', 'bounty',
  'hour', 'growth', 'egg', 'flame', 'brick', 'blood', 'dream', 'fate', 'plague', 'luck', 'omen', 'pressure', 'slime',
  'fungus', 'defense', 'feather', 'book', 'hit', 'corpse', 'infection', 'burden', 'healing', 'hatchling', 'dread',
  'delay', 'wish', 'coin', 'scream', 'cage', 'wind', 'gold', 'petal', 'hoofprint', 'incubation', 'rust', 'net',
  'music', 'mining', 'mine', 'javelin', 'strife', 'training', 'pin', 'lock', 'knowledge', 'gem', 'crystal',
];

/** The `aiHints.role` vocabulary. Free text would make the field useless to the AI; this is the closed list. */
export const AI_ROLES: readonly string[] = [
  'creature', 'removal', 'sweeper', 'ramp', 'mana', 'land', 'draw', 'tutor', 'counterspell', 'discard', 'recursion',
  'anthem', 'protection', 'lifegain', 'token', 'combo', 'stax', 'finisher', 'utility',
];

/** Every counter name this card may legitimately use: the core list, every keyword (CR 122.1), and its own text. */
export function countersOf(def: Pick<CardDef, 'oracleText'>): ReadonlySet<string> {
  const out = new Set<string>([...CORE_COUNTERS, ...KEYWORD_VOCAB]);
  for (const m of (def.oracleText ?? '').matchAll(/([A-Za-z'+/0-9-]+) counters?\b/g)) out.add(m[1].toLowerCase());
  return out;
}

// ---------------------------------------------------------------------------
// The lint
// ---------------------------------------------------------------------------

export interface LintResult {
  level: 'ok' | 'warn' | 'fail';
  problems: string[];
  warnings: string[];
}

/** Walk every object in a value, deepest last, so a rule can look at one node without a hand-written recursion. */
function walk(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) { for (const v of value) walk(v, visit); return; }
  if (!value || typeof value !== 'object') return;
  visit(value as Record<string, unknown>);
  for (const v of Object.values(value as Record<string, unknown>)) walk(v, visit);
}

/** The self-referential trigger events that need the source to be able to be a creature on the battlefield. */
const COMBAT_SELF_TRIGGERS: ReadonlySet<string> = new Set(['attacks', 'blocks', 'becomes-blocked', 'combat-damage-player', 'deals-damage']);
/** Trigger events that need the source to be a PERMANENT at all. */
const PERMANENT_SELF_TRIGGERS: ReadonlySet<string> = new Set(['etb', 'dies', 'ltb', 'tapped', 'turned-face-up', 'targeted', ...COMBAT_SELF_TRIGGERS]);

/** Whether anything in the face can turn the source into a creature (so a combat trigger on it is reachable). */
function canBecomeCreature(face: ScriptFace | undefined, def: CardDef): boolean {
  if (def.types.includes('Creature') || def.types.includes('Kindred')) return true;
  if (def.subtypes.includes('Vehicle')) return true;                       // crewed
  let found = false;
  walk(face, node => {
    if (node.op === 'animate' || node.op === 'set-pt' || node.op === 'crew-self' || node.op === 'saddle-self') found = true;
    if (node.kind === 'aura' || node.kind === 'equipment') found = true;   // the trigger is on the attached creature
    if (node.op === 'token' || node.op === 'token-copy') found = true;
  });
  return found;
}

/**
 * Lint one script against its card. Problems FAIL the lint (`level: 'fail'`), warnings do not (`'warn'`); a script
 * with neither is `'ok'`. Nothing here duplicates `scripts:check`: the covers / ignore rules call the SAME helpers
 * (`coverProblems`, `ignoreLineProblem`), so the two tools can never disagree about a line.
 */
export function lintScript(script: CardScript, def: CardDef, tier: PoolTier = 'paper'): LintResult {
  const problems: string[] = [];
  const warnings: string[] = [];
  const counters = countersOf(def);
  const faces: [string, ScriptFace | undefined][] = [['', script], ['backFace: ', script.backFace], ['secondFace: ', script.secondFace]];

  for (const [where, face] of faces) {
    if (!face) continue;
    // --- vocabulary ------------------------------------------------------
    walk(face, node => {
      const op = typeof node.op === 'string' ? node.op : undefined;
      const kind = typeof node.kind === 'string' ? node.kind : undefined;
      const on = typeof node.on === 'string' ? node.on : undefined;
      if (op && !EFFECT_OP_VOCAB.has(op)) problems.push(`${where}unknown effect op '${op}'`);
      if (on && !TRIGGER_VOCAB.has(on)) problems.push(`${where}unknown trigger event '${on}'`);
      // `kind` is the discriminator of four different unions and of a TargetSpec; a value in ANY of them is fine
      if (kind && !CONDITION_VOCAB.has(kind) && !STATIC_VOCAB.has(kind) && !AS_ENTERS_VOCAB.has(kind)
        && !COST_MODIFIER_VOCAB.has(kind) && !TARGET_KIND_VOCAB.has(kind) && !ABILITY_KINDS.has(kind)) {
        problems.push(`${where}unknown kind '${kind}' (no condition, static effect, as-enters, cost modifier, target kind or ability kind of that name)`);
      }
      if (typeof node.count === 'string' && node.filter === undefined && !AMOUNT_COUNT_VOCAB.has(node.count) && !/^\d+$/.test(node.count)) {
        problems.push(`${where}unknown amount count '${node.count}'`);
      }
      if (node.count === 'objects' && node.filter === undefined) warnings.push(`${where}an 'objects' amount with no filter counts every object`);
      for (const k of ['counter'] as const) {
        const v = node[k];
        if (typeof v === 'string' && !counters.has(v.toLowerCase())) problems.push(`${where}unknown counter name ${JSON.stringify(v)} — the card's text never names it and it is not a known counter`);
      }
      if (Array.isArray(node.counters)) for (const v of node.counters) if (typeof v === 'string' && !counters.has(v.toLowerCase())) problems.push(`${where}unknown counter name ${JSON.stringify(v)}`);
      for (const k of ['keywords'] as const) {
        const v = node[k];
        if (Array.isArray(v)) for (const kw of v) if (typeof kw === 'string' && !KEYWORD_VOCAB.has(kw)) problems.push(`${where}unknown keyword ${JSON.stringify(kw)}`);
      }
      if (typeof node.withKeyword === 'string' && !KEYWORD_VOCAB.has(node.withKeyword)) problems.push(`${where}unknown keyword ${JSON.stringify(node.withKeyword)} in a filter`);
      if (Array.isArray(node.subtypes)) {
        for (const s of node.subtypes) if (typeof s === 'string' && !SUBTYPE_KIND[s] && !TOKEN_ONLY_SUBTYPES.has(s)) problems.push(`${where}${JSON.stringify(s)} is not a subtype the pool prints (src/cards/subtype-vocab.ts — run npm run gen:subtypes after a Scryfall refresh)`);
      }
    });
    for (const kw of face.keywords ?? []) if (!KEYWORD_VOCAB.has(String(kw))) problems.push(`${where}unknown keyword ${JSON.stringify(kw)}`);
    for (const t of face.landwalk ?? []) if (!SUBTYPE_KIND[t]) problems.push(`${where}${JSON.stringify(t)} is not a land type`);

    // --- triggers the card can never raise --------------------------------
    for (const a of face.abilities ?? []) {
      if (a.kind !== 'triggered') continue;
      const events = a.event.on === 'or' ? a.event.events : [a.event];
      for (const ev of events) {
        const self = (ev as { self?: boolean }).self !== false;
        if (!self || !PERMANENT_SELF_TRIGGERS.has(ev.on)) continue;
        if (!def.types.some(t => t !== 'Instant' && t !== 'Sorcery')) {
          problems.push(`${where}a '${ev.on}' trigger on ${JSON.stringify(a.text)} can never fire: ${def.name} is only ${def.types.join('/')} and never reaches the battlefield`);
          continue;
        }
        if (COMBAT_SELF_TRIGGERS.has(ev.on) && !canBecomeCreature(face, def)) {
          problems.push(`${where}a '${ev.on}' trigger on ${JSON.stringify(a.text)} can never fire: ${def.name} is not a creature and nothing in the script animates it`);
        }
      }
      if (a.event.on === 'chapter' && !def.subtypes.includes('Saga') && !def.subtypes.includes('Case')) {
        warnings.push(`${where}a 'chapter' trigger on a card that is not a Saga`);
      }
    }

    // --- covers -----------------------------------------------------------
    for (const why of coverProblems(face)) problems.push(`${where}covers ${why}`);
  }

  // --- covers / ignore lines are lines of the card --------------------------
  const lines = new Set(scriptableLines(def));
  for (const [where, face] of faces) {
    for (const c of face?.covers ?? []) {
      const line = c.line.trim().replace(/^\/\/ /, '');
      if (!lines.has(line) && !lines.has(`// ${line}`)) problems.push(`${where}covers names a line the card does not print: ${JSON.stringify(c.line)}`);
    }
  }
  for (const ig of script.ignore ?? []) {
    if (!lines.has(ig.line.trim())) problems.push(`ignore names a line the card does not print: ${JSON.stringify(ig.line)}`);
    const why = ignoreLineProblem(ig.line, ig.reason, tier);
    if (why) problems.push(`ignore[${ig.reason}] ${why}: ${JSON.stringify(ig.line)}`);
  }

  // --- aiHints --------------------------------------------------------------
  const role = script.aiHints?.role;
  if (role !== undefined && !AI_ROLES.includes(role)) problems.push(`aiHints.role ${JSON.stringify(role)} is not one of ${AI_ROLES.join(', ')}`);
  const value = script.aiHints?.value;
  if (value !== undefined && (value < 0 || value > 10)) warnings.push(`aiHints.value ${value} is outside 0..10`);

  return { level: problems.length ? 'fail' : warnings.length ? 'warn' : 'ok', problems, warnings };
}

/** `kind` is also the discriminator of `Ability`; those four values are not a vocabulary error. */
const ABILITY_KINDS: ReadonlySet<string> = new Set(['triggered', 'activated', 'static', 'spell']);
