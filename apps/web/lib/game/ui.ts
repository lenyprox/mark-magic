'use client';
// Presentation helpers for the play table and the analysis panel: card → renderer printing, step labels, stop-policy
// mapping, setup persistence (so a hard reload of /play/<gameId> can re-create the game) and small formatters.
import type { PlayerAction, PlayerId, Step, TargetRef } from '@engine/state';
import type { StopPolicy } from '@engine/agents/deferred';
import type { CardView, PlayerView, ViewState } from '@play/view';
import type { StartOptions } from '@play/protocol';
import type { Estimate, Method } from '@analysis/types';
import type { Card3DPrinting } from '@/components/card/Card3D';
import type { DeckRef } from './api';

export const STEP_LABELS: Record<Step, string> = {
  untap: 'Untap', upkeep: 'Upkeep', draw: 'Draw', main1: 'Main 1', 'combat-begin': 'Combat', 'declare-attackers': 'Attackers', 'declare-blockers': 'Blockers',
  'first-strike-damage': 'First strike', 'combat-damage': 'Damage', 'combat-end': 'End combat', main2: 'Main 2', end: 'End', cleanup: 'Cleanup',
};
export const STEP_SHORT: Record<Step, string> = {
  untap: 'UN', upkeep: 'UP', draw: 'DR', main1: 'M1', 'combat-begin': 'BC', 'declare-attackers': 'DA', 'declare-blockers': 'DB',
  'first-strike-damage': 'FS', 'combat-damage': 'CD', 'combat-end': 'EC', main2: 'M2', end: 'END', cleanup: 'CL',
};

/** Which StopPolicy key a step toggle controls, for my turn or the opponent's. */
export function stopKeyFor(step: Step, myTurn: boolean): keyof StopPolicy | null {
  if (myTurn) {
    if (step === 'main1' || step === 'main2') return 'ownMain';
    if (step === 'combat-begin') return 'ownCombatBegin';
    if (step === 'declare-blockers') return 'ownBlockers';
    if (step === 'end') return 'ownEnd';
    return null;
  }
  if (step === 'upkeep') return 'oppUpkeep';
  if (step === 'main1' || step === 'main2') return 'oppMain';
  if (step === 'declare-attackers') return 'oppAttackers';
  if (step === 'declare-blockers') return 'oppBlockers';
  if (step === 'end') return 'oppEnd';
  return null;
}

/** Renderer printing descriptor for a card in play (frame data is not in the view; the renderer probes it). */
export function printingFor(card: CardView): Card3DPrinting | null {
  if (!card.printingId) return null;
  return { printingId: card.printingId, name: card.name, layout: card.layout, frame: null, frameEffects: [], finishes: ['nonfoil'], fullArt: false, textless: false, borderColor: null, hasBack: card.hasBack };
}

/** Every visible card object keyed by id (hands, battlefields, graveyards, exile, stack sources). */
export function indexObjects(view: ViewState | null): Map<number, CardView> {
  const m = new Map<number, CardView>();
  if (!view) return m;
  for (const p of view.players) {
    for (const c of p.hand ?? []) m.set(c.id, c);
    for (const c of p.battlefield) m.set(c.id, c);
    for (const c of p.graveyard) m.set(c.id, c);
    for (const c of p.exile) m.set(c.id, c);
  }
  for (const it of view.stack) if (!m.has(it.source.id)) m.set(it.source.id, it.source);
  return m;
}

/** Object ids and players an action touches (for hover highlighting). */
export function involvedIn(action: PlayerAction | undefined | null): { objects: Set<number>; players: Set<PlayerId> } {
  const objects = new Set<number>(); const players = new Set<PlayerId>();
  if (!action) return { objects, players };
  if (action.type === 'play-land' || action.type === 'cast') objects.add(action.cardId);
  if (action.type === 'activate') objects.add(action.objectId);
  if ((action.type === 'cast' || action.type === 'activate') && action.targets) {
    for (const group of action.targets) for (const t of group) { if (t.kind === 'object') objects.add(t.id); else if (t.kind === 'player') players.add(t.id); }
  }
  return { objects, players };
}

export function refLabel(ref: TargetRef, view: ViewState | null, objects: Map<number, CardView>): string {
  if (ref.kind === 'player') return view?.players[ref.id]?.name ?? `Player ${ref.id + 1}`;
  if (ref.kind === 'stack') return view?.stack.find(s => s.id === ref.id)?.name ?? `Stack #${ref.id}`;
  return objects.get(ref.id)?.name ?? `#${ref.id}`;
}

export const me = (view: ViewState): PlayerView => view.players[view.viewer ?? 0];
/** Every other seat in turn order starting after the viewer (eliminated players included, so plates stay put). */
export function opponents(view: ViewState): PlayerView[] {
  const myId = view.viewer ?? 0;
  const order = view.turnOrder?.length ? view.turnOrder : view.players.map(p => p.id);
  const i = Math.max(0, order.indexOf(myId));
  const ring = [...order.slice(i + 1), ...order.slice(0, i)].filter(id => id !== myId);
  const seen = new Set(ring);
  for (const p of view.players) if (p.id !== myId && !seen.has(p.id)) ring.push(p.id);
  return ring.map(id => view.players[id]).filter((p): p is PlayerView => !!p);
}
/** The first opponent (the only one in a duel). */
export const opp = (view: ViewState): PlayerView => opponents(view)[0] ?? view.players[(view.viewer ?? 0) === 0 ? 1 : 0];

// ---- formatting --------------------------------------------------------------------------------
export const pct = (v: number, digits = 1) => `${(v * 100).toFixed(digits)}%`;
export function ciHalfWidth(est: Estimate | undefined): number | null {
  if (!est?.ci95) return null;
  return (est.ci95[1] - est.ci95[0]) / 2;
}
export const METHOD_LABEL: Record<Method, string> = { exact: 'exact', hypergeometric: 'hypergeometric', montecarlo: 'Monte Carlo', heuristic: 'heuristic' };
export const METHOD_TONE: Record<Method, 'ok' | 'info' | 'brass' | 'mute'> = { exact: 'ok', hypergeometric: 'info', montecarlo: 'brass', heuristic: 'mute' };
export const fmtNum = (v: number | string) => typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) < 0.01 ? 4 : 3)) : v;

// ---- setup persistence -------------------------------------------------------------------------
/** `a` / `b` are seats 0 and 1 (kept for older records); `seats` lists every seat in order when there are more than two. */
export interface SetupRecord { a: DeckRef; b: DeckRef; seats?: DeckRef[]; options: StartOptions; playerName?: string }
export const seatsOf = (rec: SetupRecord): DeckRef[] => (rec.seats && rec.seats.length >= 2 ? rec.seats : [rec.a, rec.b]);
const KEY = (gameId: string) => `vault.play.setup:${gameId}`;
export const LAST_SETUP_KEY = 'vault.play.lastSetup';

export function saveSetup(gameId: string, rec: SetupRecord) {
  try { sessionStorage.setItem(KEY(gameId), JSON.stringify(rec)); localStorage.setItem(LAST_SETUP_KEY, JSON.stringify(rec)); } catch { /* private mode */ }
}
export function loadSetup(gameId: string): SetupRecord | null {
  try { const raw = sessionStorage.getItem(KEY(gameId)); return raw ? (JSON.parse(raw) as SetupRecord) : null; } catch { return null; }
}
export function loadLastSetup(): SetupRecord | null {
  try { const raw = localStorage.getItem(LAST_SETUP_KEY); return raw ? (JSON.parse(raw) as SetupRecord) : null; } catch { return null; }
}

/** Rebuild deck refs from a parsed game id key ("s.<id>", "b.<file>", "a.<id>") when no setup record survived. */
export function refFromKey(key: string, name?: string): DeckRef | null {
  const [kind, ...rest] = key.split('.'); const id = rest.join('.');
  if (!id) return null;
  if (kind === 's') return { kind: 'saved', id, name: name ?? 'Saved deck' };
  if (kind === 'b') return { kind: 'bundled', file: id, name: name ?? id };
  if (kind === 'a') return { kind: 'archetype', id, name: name ?? 'Archetype', format: '' };
  return null;
}

export const randomSeed = () => Math.floor(Math.random() * 0x7fffffff);

/** Group a battlefield row by name for the compact land display. */
export function groupByName<T extends { name: string; tapped: boolean }>(items: T[]): { name: string; items: T[]; tapped: number }[] {
  const out = new Map<string, { name: string; items: T[]; tapped: number }>();
  for (const it of items) {
    const g = out.get(it.name) ?? { name: it.name, items: [], tapped: 0 };
    g.items.push(it); if (it.tapped) g.tapped++;
    out.set(it.name, g);
  }
  return [...out.values()];
}
