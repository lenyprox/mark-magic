// Per-card scripts (B7): a checked-in JSON file per oracle id under data/scripts/ that overrides or completes what
// the oracle-text parser produced for that card. The parser stays the generator of first drafts; a script is the
// canonical, reviewed form. A script names the oracle text hash it was written against so a Scryfall refresh that
// changes the card's text flags the script as stale instead of silently applying it.
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../config/paths.js';
import type { Ability, AltCost, AsEnters, CardDef, CostModifier, Keyword } from './types.js';

export type ScriptSource = 'generated' | 'reviewed' | 'hand';

export interface CardScript {
  oracleId: string;
  name: string;
  /** fnv-1a of the normalised oracle text the script was written for (see oracleHash). */
  oracleHash: string;
  source: ScriptSource;
  /** 0..1 confidence for generated scripts; reviewed/hand scripts are 1. */
  confidence?: number;
  /** 'replace' (default): the script's abilities replace the parser's; 'extend': they are appended and unparsed lines it covers are cleared. */
  mode?: 'replace' | 'extend';
  keywords?: Keyword[];
  abilities?: Ability[];
  altCosts?: AltCost[];
  asEnters?: AsEnters[];
  costModifiers?: CostModifier[];
  /** Oracle lines (normalised, `~` for the card name) this script accounts for; with mode 'extend' they are removed from `unparsed`. */
  covers?: string[];
  /** Scenario names in test/scenarios/ that verify this script. */
  scenarios?: string[];
  aiHints?: { role?: string; value?: number; timing?: 'main' | 'instant' | 'end-step' | 'response' };
  notes?: string;
}

export interface ScriptStatus { applied: boolean; stale: boolean; source?: ScriptSource; confidence?: number }

export function oracleHash(text: string): string {
  let h = 0x811c9dc5;
  for (const ch of text.replace(/\s+/g, ' ').trim()) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

export const DEFAULT_SCRIPTS_DIR = () => path.join(projectRoot(), 'data', 'scripts');

/** Lazily indexed script directory (one JSON per oracle id). */
export class ScriptStore {
  private index: Map<string, string> | null = null;
  private cache = new Map<string, CardScript | null>();
  constructor(readonly dir: string = DEFAULT_SCRIPTS_DIR()) {}

  private load() {
    if (this.index) return;
    this.index = new Map();
    if (!fs.existsSync(this.dir)) return;
    for (const f of fs.readdirSync(this.dir)) if (f.endsWith('.json')) this.index.set(f.slice(0, -5), path.join(this.dir, f));
  }
  size(): number { this.load(); return this.index!.size; }
  ids(): string[] { this.load(); return [...this.index!.keys()]; }
  get(oracleId: string): CardScript | null {
    this.load();
    if (this.cache.has(oracleId)) return this.cache.get(oracleId)!;
    const file = this.index!.get(oracleId);
    let script: CardScript | null = null;
    if (file) { try { script = JSON.parse(fs.readFileSync(file, 'utf8')) as CardScript; } catch { script = null; } }
    this.cache.set(oracleId, script);
    return script;
  }
  /** Write (or overwrite) a script; generated scripts never overwrite reviewed/hand ones. */
  put(script: CardScript, opts: { force?: boolean } = {}): boolean {
    this.load();
    const existing = this.get(script.oracleId);
    if (existing && !opts.force && script.source === 'generated' && existing.source !== 'generated') return false;
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `${script.oracleId}.json`);
    fs.writeFileSync(file, JSON.stringify(script, null, 2) + '\n');
    this.index!.set(script.oracleId, file); this.cache.set(script.oracleId, script);
    return true;
  }
  /** Forget cached contents (tests). */
  reset() { this.index = null; this.cache.clear(); }
}

let shared: ScriptStore | null = null;
export function scriptStore(): ScriptStore { return (shared ??= new ScriptStore()); }
export function useScriptStore(store: ScriptStore | null) { shared = store; }

/**
 * Apply a card's script to the parser's output. A stale script (oracle text changed since it was written) is not
 * applied; the def records the status either way so coverage reports can list stale scripts.
 */
export function applyScript(def: CardDef, script: CardScript | null): CardDef {
  if (!script) return def;
  const status: ScriptStatus = { applied: false, stale: false, source: script.source, confidence: script.confidence };
  if (script.oracleHash !== oracleHash(def.oracleText)) { status.stale = true; def.script = status; return def; }
  const out: CardDef = { ...def, keywords: [...def.keywords], abilities: [...def.abilities], unparsed: [...def.unparsed] };
  const mode = script.mode ?? 'replace';
  if (mode === 'replace') {
    if (script.keywords) out.keywords = [...script.keywords];
    if (script.abilities) out.abilities = [...script.abilities];
    if (script.altCosts) out.altCosts = [...script.altCosts];
    if (script.asEnters) out.asEnters = [...script.asEnters];
    if (script.costModifiers) out.costModifiers = [...script.costModifiers];
    out.unparsed = []; out.fullyParsed = true;
  } else {
    if (script.keywords) for (const k of script.keywords) if (!out.keywords.includes(k)) out.keywords.push(k);
    if (script.abilities) out.abilities.push(...script.abilities);
    if (script.altCosts) out.altCosts = [...(out.altCosts ?? []), ...script.altCosts];
    if (script.asEnters) out.asEnters = [...(out.asEnters ?? []), ...script.asEnters];
    if (script.costModifiers) out.costModifiers = [...(out.costModifiers ?? []), ...script.costModifiers];
    const covered = new Set((script.covers ?? []).map(c => c.trim()));
    out.unparsed = out.unparsed.filter(u => !covered.has(u.trim()));
    out.fullyParsed = out.unparsed.length === 0 && !out.abilities.some(a => 'effects' in a && a.effects.some(e => e.op === 'unknown'));
  }
  // producesMana follows mana abilities the script may have added
  for (const a of out.abilities) if (a.kind === 'activated' && a.manaAbility) for (const e of a.effects) if (e.op === 'add-mana' && Array.isArray(e.mana)) for (const m of e.mana) if (!out.producesMana.includes(m)) out.producesMana.push(m);
  status.applied = true; out.script = status;
  return out;
}
