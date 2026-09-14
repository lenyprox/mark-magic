// Forge's card scripts (github.com/Card-Forge/forge, GPL-3.0) read as a COMPARISON SOURCE for `npm run forge:diff`
// (docs/plans/forge-oracle.md). The checkout lives outside the repo (`FORGE_RES()`); nothing read here is ever
// written back into the repo except the gitignored JSON cache under data/master/, and the test fixtures are
// synthetic. This is a reader of the file format, not a translator: it makes the facts Forge states explicit
// (trigger mode and qualifiers, the effect chain, targets, "you may", tokens, magnitudes) and leaves them as the
// parameter maps they are; src/cards/forge/shape.ts turns them into the comparable `AbilityShape`.
//
// The format (measured on the checkout, see the plan): one file per card under cardsfolder/<letter>/<name>.txt,
// `Key:value` lines; a multi-face card's other face follows a line `ALTERNATE` with its own `Name:`. Ability lines:
//   A:AB$ <api> | Cost$ … | …          activated                         A:SP$ <api> | …   spell
//   T:Mode$ <mode> | … | Execute$ <SVar> | TriggerDescription$ …         triggered
//   S:Mode$ <mode> | … | Description$ …                                 static
//   R:Event$ <event> | … | ReplaceWith$ <SVar> | Description$ …          replacement
//   SVar:<name>:DB$ <api> | … | SubAbility$ <SVar>                       the next effect of a chain
//   K:<keyword>[:<params>]                                                keyword
// `Execute$` / `ReplaceWith$` name the chain's first effect, `SubAbility$` the next; `Charm`'s `Choices$` names one
// chain per mode; `TokenScript$` names tokenscripts/<id>.txt. Deck-building and AI hints (`DeckHas`, `DeckHints`,
// `DeckNeeds`, `AI`, `Draft`, the AI-only SVars) are never read into the shape.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, FORGE_RES } from '../../config/paths.js';

export type ForgeAbilityClass = 'activated' | 'spell' | 'triggered' | 'static' | 'replacement';

/** A resolved tokenscripts/<id>.txt: the token's exact shape (Forge's `Types:` split into card types and subtypes). */
export interface ForgeToken { id: string; name: string; colors: string[]; types: string[]; subtypes: string[]; pt: string | null; keywords: string[] }

/** One effect of a chain: the `DB$` / `SP$` / `AB$` api name and its `Key$ value` parameters. */
export interface ForgeEffect {
  api: string;
  params: Record<string, string>;
  /** `Charm` only: one resolved chain per `Choices$` entry. */
  modes?: ForgeEffect[][];
  /** `Token` only: the `TokenScript$` ids that resolved to a token file. */
  tokens?: ForgeToken[];
}

export interface ForgeAbility {
  cls: ForgeAbilityClass;
  /** The ability line's own `Key$ value` pairs (`Mode`, `Cost`, `Execute`, `OptionalDecider`, …). */
  params: Record<string, string>;
  /** `SpellDescription$` / `TriggerDescription$` / `Description$` with CARDNAME → ~, or null when the line has none. */
  description: string | null;
  /** The effect chain (`Execute$` / the A line itself / `ReplaceWith$`, then every `SubAbility$`), `Cleanup` dropped, cycles guarded. Empty for a static. */
  chain: ForgeEffect[];
}

export interface ForgeFace {
  name: string;
  manaCost: string | null;
  types: string;
  pt: string | null;
  loyalty: string | null;
  colors: string | null;
  /** The `K:` lines verbatim (parameters after `:` kept). */
  keywords: string[];
  abilities: ForgeAbility[];
  /** Every `SVar:` except the AI-only ones (`PlayMain1`, `AIPreference`, `BuffedBy`, …). */
  svars: Record<string, string>;
  oracle: string;
  alternateMode: string | null;
  /** Path relative to the res directory (never absolute, so the cache carries no machine path). */
  file: string;
}

export interface ForgeCard { file: string; faces: ForgeFace[] }

export interface ForgeIndex {
  /** The checkout's `git rev-parse HEAD`, or the res directory's mtime when git is absent. */
  head: string;
  /** How many .txt files were read (cardsfolder + tokenscripts). */
  files: number;
  cards: ForgeCard[];
  /** Every face by its exact `Name:`, and every multi-face card by the joined `Front // Back` name; first file (sorted path) wins. */
  byName: Map<string, ForgeCard>;
}

// ---------------------------------------------------------------------------
// Parsing one file
// ---------------------------------------------------------------------------

/** AI-only SVars: deck-building and AI hints, never card facts (the plan's list plus everything named `AI…`). */
const AI_SVARS = new Set(['PlayMain1', 'PlayMain2', 'AIPreference', 'SacMeAfterBlock', 'NonStackingEffect', 'RemAIDeck', 'RemRandomDeck', 'BuffedBy', 'AntiBuffedBy',
  'AttachAILogic', 'HasAttackEffect', 'HasBlockEffect', 'HasCombatEffect', 'NeedsToPlayVar', 'NeedsToPlay', 'NeedsToPlayKicked', 'NeedsToPlayKickedVar', 'SacMe', 'DiscardMe',
  'DiscardMeByOpp', 'EnchantMe', 'EquipMe', 'MustAttack', 'MustBeBlocked', 'MustBlock', 'AgendaLogic', 'CanAttack', 'PlayBeforeAILands', 'EndOfTurnLeavePlay']);
const isAiSvar = (name: string) => AI_SVARS.has(name) || /^AI/.test(name);

/** `AB$ Mana | Cost$ T | Produced$ G` → `{ AB: 'Mana', Cost: 'T', Produced: 'G' }` (values keep their inner spaces). */
export function parseParams(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(' | ')) {
    const i = part.indexOf('$');
    if (i <= 0) continue;
    const key = part.slice(0, i).trim();
    if (key && !(key in out)) out[key] = part.slice(i + 1).trim();
  }
  return out;
}

/** `Key$ value` maps of the parts that name an effect: the api sits under `DB` / `SP` / `AB`. */
function effectOf(params: Record<string, string>): { api: string; params: Record<string, string> } | null {
  const api = params.DB ?? params.SP ?? params.AB;
  if (!api) return null;
  const { DB: _d, SP: _s, AB: _a, ...rest } = params; void _d; void _s; void _a;
  return { api, params: rest };
}

const CARDNAME = /\bCARDNAME\b/g;

/** Every `.txt` under `dir` (recursive, sorted), relative to `dir`. */
function listTxt(dir: string, prefix = ''): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (e.isDirectory()) out.push(...listTxt(path.join(dir, e.name), prefix + e.name + '/'));
    else if (e.name.endsWith('.txt')) out.push(prefix + e.name);
  }
  return out;
}

const SUPERTYPES = new Set(['Legendary', 'Snow', 'Basic', 'World', 'Ongoing', 'Host']);
const CARD_TYPES = new Set(['Creature', 'Artifact', 'Enchantment', 'Land', 'Planeswalker', 'Instant', 'Sorcery', 'Battle', 'Kindred', 'Tribal']);
const COLOR_WORDS: Record<string, string> = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G', w: 'W', u: 'U', b: 'B', r: 'R', g: 'G' };

/** Forge's `Types:` line → card types and subtypes (supertypes dropped). */
export function splitForgeTypes(types: string): { types: string[]; subtypes: string[] } {
  const out = { types: [] as string[], subtypes: [] as string[] };
  for (const w of types.split(/\s+/).filter(Boolean)) {
    if (SUPERTYPES.has(w)) continue;
    if (CARD_TYPES.has(w)) out.types.push(w); else out.subtypes.push(w);
  }
  return out;
}

/** Forge's `Colors:` value (`white`, `red,white`, `all`, `colorless`) → WUBRG letters. */
export function forgeColors(colors: string | null | undefined): string[] {
  if (!colors) return [];
  const c = colors.trim().toLowerCase();
  if (c === 'all') return ['W', 'U', 'B', 'R', 'G'];
  const out: string[] = [];
  for (const w of c.split(/[,\s]+/)) { const l = COLOR_WORDS[w]; if (l && !out.includes(l)) out.push(l); }
  return out;
}

/** The plain `Key:value` fields of one face section. */
interface RawFace { fields: Record<string, string>; keywords: string[]; lines: { kind: 'A' | 'T' | 'S' | 'R'; text: string }[]; svars: Record<string, string> }

function rawFaces(text: string): RawFace[] {
  const faces: RawFace[] = [];
  let cur: RawFace | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line === 'ALTERNATE') { cur = null; continue; }
    if (!cur) { cur = { fields: {}, keywords: [], lines: [], svars: {} }; faces.push(cur); }
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const key = line.slice(0, i);
    const value = line.slice(i + 1);
    if (key === 'SVar') { const j = value.indexOf(':'); if (j > 0) { const name = value.slice(0, j); if (!isAiSvar(name)) cur.svars[name] = value.slice(j + 1); } continue; }
    if (key === 'K') { cur.keywords.push(value); continue; }
    if (key === 'A' || key === 'T' || key === 'S' || key === 'R') { cur.lines.push({ kind: key, text: value }); continue; }
    // DeckHas / DeckHints / DeckNeeds / AI / Draft / Variant / … are never read
    if (['Name', 'ManaCost', 'Types', 'PT', 'Loyalty', 'Colors', 'Oracle', 'AlternateMode', 'Defense', 'Text'].includes(key)) cur.fields[key] = value;
  }
  return faces;
}

/** Resolves `TokenScript$` ids against tokenscripts/, once per id (a fixture directory in the tests). */
export class TokenReader {
  private cache = new Map<string, ForgeToken | null>();
  constructor(private readonly dir: string) {}
  read(id: string): ForgeToken | null {
    if (this.cache.has(id)) return this.cache.get(id)!;
    const file = path.join(this.dir, `${id}.txt`);
    let tok: ForgeToken | null = null;
    if (fs.existsSync(file)) {
      const f = rawFaces(fs.readFileSync(file, 'utf8'))[0];
      if (f) {
        const t = splitForgeTypes(f.fields.Types ?? '');
        tok = { id, name: f.fields.Name ?? id, colors: forgeColors(f.fields.Colors), types: t.types, subtypes: t.subtypes, pt: f.fields.PT ?? null, keywords: f.keywords };
      }
    }
    this.cache.set(id, tok);
    return tok;
  }
}

/**
 * The chain that starts at `head`: `head`, then every `SubAbility$` through `svars`; `Cleanup` dropped; a name seen
 * twice ends the walk (cycle guard). `Charm` resolves its `Choices$` into `modes`, each a chain of its own; an
 * `ImmediateTrigger` / `DelayedTrigger`'s `Execute$` and a `RepeatEach`'s `RepeatSubAbility$` are chains the effect
 * runs later — appended in place, so the ability's targets, "you may" and magnitudes are read off them too.
 */
function resolveChain(head: { api: string; params: Record<string, string> } | null, svars: Record<string, string>, tokens: TokenReader | null, visited: Set<string>): ForgeEffect[] {
  const chain: ForgeEffect[] = [];
  let cur = head;
  while (cur) {
    if (cur.api !== 'Cleanup') {
      const e: ForgeEffect = { api: cur.api, params: cur.params };
      if (cur.api === 'Charm' && cur.params.Choices) {
        e.modes = cur.params.Choices.split(',').map(s => s.trim()).filter(Boolean).map(name => {
          if (visited.has(name)) return [];
          const seen = new Set(visited); seen.add(name);
          return resolveChain(svarEffect(svars, name), svars, tokens, seen);
        });
      }
      if (cur.api === 'Token' && cur.params.TokenScript && tokens) {
        const list = cur.params.TokenScript.split(',').map(s => s.trim()).filter(Boolean).map(id => tokens.read(id)).filter((t): t is ForgeToken => !!t);
        if (list.length) e.tokens = list;
      }
      chain.push(e);
      for (const key of ['Execute', 'RepeatSubAbility'] as const) {
        const name = cur.params[key];
        if (name && !visited.has(name)) { visited.add(name); chain.push(...resolveChain(svarEffect(svars, name), svars, tokens, visited)); }
      }
    }
    const next = cur.params.SubAbility;
    if (!next || visited.has(next)) break;
    visited.add(next);
    cur = svarEffect(svars, next);
  }
  return chain;
}

function svarEffect(svars: Record<string, string>, name: string): { api: string; params: Record<string, string> } | null {
  const v = svars[name];
  return v === undefined ? null : effectOf(parseParams(v));
}

function faceOf(raw: RawFace, file: string, tokens: TokenReader | null): ForgeFace {
  const abilities: ForgeAbility[] = [];
  for (const { kind, text } of raw.lines) {
    const params = parseParams(text);
    let cls: ForgeAbilityClass, chain: ForgeEffect[] = [], description: string | null = null;
    if (kind === 'A') {
      cls = params.AB !== undefined ? 'activated' : 'spell';   // `A:AB$` = activated; `A:SP$` = spell (a spell's `Cost$` is its additional cost)
      const head = effectOf(params);
      chain = resolveChain(head, raw.svars, tokens, new Set());
      description = params.SpellDescription ?? null;
      // the A line IS the first effect: its parameters stay on the ability too (the shape reads OptionalDecider / UnlessCost off both)
    } else if (kind === 'T') {
      cls = 'triggered';
      chain = params.Execute ? resolveChain(svarEffect(raw.svars, params.Execute), raw.svars, tokens, new Set([params.Execute])) : [];
      description = params.TriggerDescription ?? null;
    } else if (kind === 'R') {
      cls = 'replacement';
      chain = params.ReplaceWith ? resolveChain(svarEffect(raw.svars, params.ReplaceWith), raw.svars, tokens, new Set([params.ReplaceWith])) : [];
      description = params.Description ?? null;
    } else {
      cls = 'static';
      description = params.Description ?? null;
    }
    abilities.push({ cls, params, description: description === null ? null : description.replace(CARDNAME, '~'), chain });
  }
  const f = raw.fields;
  return {
    name: f.Name ?? '', manaCost: f.ManaCost ?? null, types: f.Types ?? '', pt: f.PT ?? null, loyalty: f.Loyalty ?? null, colors: f.Colors ?? null,
    keywords: raw.keywords, abilities, svars: raw.svars, oracle: (f.Oracle ?? '').replace(/\\n/g, '\n'), alternateMode: f.AlternateMode ?? null, file,
  };
}

/** Parse one card file's text into its faces. `file` is recorded on every face; `tokens` resolves `TokenScript$` ids. */
export function parseForgeCard(text: string, file: string, tokens: TokenReader | null = null): ForgeCard {
  return { file, faces: rawFaces(text).map(r => faceOf(r, file, tokens)) };
}

// ---------------------------------------------------------------------------
// The whole checkout, cached
// ---------------------------------------------------------------------------

/** `git rev-parse HEAD` run inside the checkout, else the directory's mtime — the cache key together with the file count. */
export function forgeHead(res: string): string {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: res, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim(); } catch { /* not a git checkout */ }
  return `mtime:${fs.statSync(res).mtimeMs}`;
}

export const DEFAULT_FORGE_CACHE = (): string => path.join(DATA_DIR(), 'master', 'forge-index.json');
/** Part of the cache key: bump it whenever this file's parse changes shape, or a stale cache keeps the old reading. */
export const FORGE_LOADER_VERSION = 3;

function indexOf(head: string, files: number, cards: ForgeCard[]): ForgeIndex {
  const byName = new Map<string, ForgeCard>();
  for (const c of cards) {
    for (const f of c.faces) if (f.name && !byName.has(f.name)) byName.set(f.name, c);
    if (c.faces.length > 1) { const joined = c.faces.map(f => f.name).join(' // '); if (!byName.has(joined)) byName.set(joined, c); }
  }
  return { head, files, cards, byName };
}

/**
 * Read the whole checkout (cardsfolder/ recursively + tokenscripts/) into an index, through the JSON cache when its
 * key (HEAD + file count + `FORGE_LOADER_VERSION`) matches. `cache: false` reads the files every time (tests on
 * fixture directories).
 */
export function loadForge(res = FORGE_RES(), opts: { cache?: string | false } = {}): ForgeIndex {
  const cardsDir = path.join(res, 'cardsfolder');
  const tokensDir = path.join(res, 'tokenscripts');
  const cardFiles = listTxt(cardsDir);
  const files = cardFiles.length + listTxt(tokensDir).length;
  const head = forgeHead(res);
  const cache = opts.cache === undefined ? DEFAULT_FORGE_CACHE() : opts.cache;
  if (cache && fs.existsSync(cache)) {
    try {
      const j = JSON.parse(fs.readFileSync(cache, 'utf8')) as { head?: string; files?: number; loader?: number; cards?: ForgeCard[] };
      if (j.head === head && j.files === files && j.loader === FORGE_LOADER_VERSION && Array.isArray(j.cards)) return indexOf(head, files, j.cards);
    } catch { /* unreadable cache: rebuild */ }
  }
  const tokens = new TokenReader(tokensDir);
  const cards = cardFiles.map(rel => parseForgeCard(fs.readFileSync(path.join(cardsDir, rel), 'utf8'), 'cardsfolder/' + rel, tokens));
  if (cache) { fs.mkdirSync(path.dirname(cache), { recursive: true }); fs.writeFileSync(cache, JSON.stringify({ head, files, loader: FORGE_LOADER_VERSION, cards })); }
  return indexOf(head, files, cards);
}

/** The Forge card for a name: exact, then the front-face name of `A // B`, then case-insensitively. */
export function forgeCardFor(idx: ForgeIndex, name: string): ForgeCard | null {
  const exact = idx.byName.get(name);
  if (exact) return exact;
  const front = name.split(' // ')[0];
  if (front !== name) { const f = idx.byName.get(front); if (f) return f; }
  return lowerIndex(idx).get(name.toLowerCase()) ?? null;
}

const lowerCache = new WeakMap<ForgeIndex, Map<string, ForgeCard>>();
function lowerIndex(idx: ForgeIndex): Map<string, ForgeCard> {
  let m = lowerCache.get(idx);
  if (!m) { m = new Map(); for (const [k, c] of idx.byName) { const l = k.toLowerCase(); if (!m.has(l)) m.set(l, c); } lowerCache.set(idx, m); }
  return m;
}
