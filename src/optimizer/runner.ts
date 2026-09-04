// Runs an optimiser run end to end: resolves the seed deck, the field and the owned pool from the databases, drives
// the search with status/heartbeat bookkeeping, and stores the report. Used by the detached daemon and by tests.
import type Database from 'better-sqlite3';
import type { ListEntry } from '../analysis/types.js';
import type { CardDB } from '../cards/db.js';
import type { CardQueryDB } from '../cards/query.js';
import type { CardDef } from '../cards/types.js';
import { CollectionStore } from '../collection/store.js';
import { buildDeckPayload } from '../play/payload.js';
import type { BatchPool } from '../sim/batchPool.js';
import { DeckStore } from '../user/decks.js';
import type { FieldDeck } from './evaluator.js';
import { optimize, type SearchContext } from './search.js';
import { OptimizerStore } from './store.js';
import type { OptimizerProgress, OptimizerReport, OptimizerSpec } from './types.js';

export interface RunDeps { db: Database.Database; cards: CardDB; query?: CardQueryDB | null; pool?: BatchPool | null; log?: (msg: string) => void; pid?: number | null; onProgress?: (p: OptimizerProgress) => void }

export interface ResolvedRun { seedList: ListEntry[]; commander: CardDef | null; field: FieldDeck[]; owned: Map<string, number>; ownedNames: Set<string>; deckName: string }

/** Everything the search needs from the databases (throws with a readable message when something is missing). */
export function resolveRun(deps: RunDeps, spec: OptimizerSpec): ResolvedRun {
  const decks = new DeckStore(deps.db);
  const seed = decks.get(spec.seedDeckId); if (!seed) throw new Error(`seed deck ${spec.seedDeckId} not found`);
  const commanderName = spec.commander ?? seed.cards.find(c => c.board === 'commander')?.name ?? null;
  const commander = commanderName ? deps.cards.get(commanderName) : null;
  if (spec.format === 'commander' && !commander) throw new Error('Commander runs need a commander (choose one in the deck builder)');
  const seedList: ListEntry[] = [];
  for (const c of seed.cards) { if (c.board !== 'main') continue; if (commander && c.name === commander.name) continue; if (!deps.cards.get(c.name)) continue; const e = seedList.find(x => x.name === c.name); if (e) e.count += c.count; else seedList.push({ name: c.name, count: c.count }); }
  if (seedList.reduce((a, e) => a + e.count, 0) < 20) throw new Error('the seed deck has too few resolvable cards (20 or more needed)');
  const field: FieldDeck[] = [];
  for (const f of spec.field) {
    if (f.kind === 'deck') {
      const d = decks.get(f.deckId); if (!d) throw new Error(`field deck ${f.deckId} not found`);
      const printings: Record<string, string | null> = {}; for (const c of d.cards) if (c.printingId) printings[c.name] = c.printingId;
      field.push({ entry: { ...f, name: d.name }, payload: buildDeckPayload(deps.cards, decks.toDeckList(d.id)!, { deckId: d.id, name: d.name, printings }) });
    } else throw new Error('archetype field entries need a metagame sync for Commander (not available yet)');
  }
  if (!field.length) throw new Error('the field needs at least one opponent deck');
  if (field.length < spec.players - 1) throw new Error(`a ${spec.players}-player pod needs at least ${spec.players - 1} field decks`);
  const collection = new CollectionStore(deps.db, deps.cards);
  const owned = collection.ownedMap();
  const ownedNames = new Set<string>();
  for (const [oid] of owned) { const d = deps.cards.getByOracleId(oid); if (d) ownedNames.add(d.name); }
  // the seed deck's own cards count as available even when not registered (the user built the deck from them)
  for (const e of seedList) ownedNames.add(e.name);
  return { seedList, commander, field, owned, ownedNames, deckName: seed.name };
}

/** Run a stored optimiser run to completion (or until cancelled/paused). Returns the report when it finished. */
export async function runOptimizer(deps: RunDeps, runId: string): Promise<OptimizerReport | null> {
  const store = new OptimizerStore(deps.db);
  const run = store.get(runId); if (!run) throw new Error(`run ${runId} not found`);
  const log = deps.log ?? (() => undefined);
  store.setStatus(runId, 'running');
  const p0 = store.get(runId)!.progress; store.saveProgress(runId, { ...p0, status: 'running', pid: deps.pid ?? null, startedAt: p0.startedAt ?? new Date().toISOString(), heartbeat: new Date().toISOString(), message: 'resolving the deck, field and owned pool' });
  try {
    const resolved = resolveRun(deps, run.spec);
    // the seed deck's own copies are available; a registered pool may be smaller than the deck (bulk not registered)
    const ownedWithSeed = new Map(resolved.owned);
    for (const e of resolved.seedList) { const d = deps.cards.get(e.name); if (d && !ownedWithSeed.has(d.oracleId)) ownedWithSeed.set(d.oracleId, e.count); }
    const shouldStop = () => { const st = store.status(runId); return st === 'cancelling' || st === 'paused' || st === 'cancelled'; };
    const ctx: SearchContext = { store, runId, spec: run.spec, cards: deps.cards, query: deps.query, owned: ownedWithSeed, ownedNames: resolved.ownedNames, commander: resolved.commander, seedList: resolved.seedList, field: resolved.field, pool: deps.pool, log, shouldStop, pid: deps.pid, onProgress: deps.onProgress };
    const report = await optimize(ctx);
    const st = store.status(runId);
    if (st === 'cancelling' || st === 'cancelled') { store.saveReport(runId, report); store.setStatus(runId, 'cancelled'); return report; }
    if (st === 'paused') { store.saveReport(runId, report); return report; }
    store.saveReport(runId, report); store.setStatus(runId, 'done');
    return report;
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === 'cancelled') { store.setStatus(runId, 'cancelled'); return null; }
    store.setStatus(runId, 'failed', msg); log(`failed: ${msg}`);
    throw e;
  }
}
