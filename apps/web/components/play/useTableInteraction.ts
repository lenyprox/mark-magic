'use client';
// The table's interaction state: idle → (targeting | x | armed | pay) for spells and abilities, attackers / blockers
// declarations, and the multi-action card menu. Pure state from @play/targeting; this hook only wires it to the store.
// `pay` is the manual-mana tray: a cast whose payment the player should confirm (see @play/targeting shouldAskToPay).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AttackDeclaration, AttackTarget, BlockDeclaration, LegalAction, PlayerAction, PlayerId, TargetRef } from '@engine/state';
import { actionsForCard, assignBlock, beginAction, canConfirm, confirmRequirement, currentRequirement, initialSources, isManaSource, legalTargets, pickTarget, playableCardIds, setX, shouldAskToPay, toggleAttacker, type AskToPay, type DragMode, type Flow, type TargetingState } from '@play/targeting';
import type { PlayAnalysis } from '@analysis/types';
import type { PlayerView } from '@play/view';
import { useGameStore } from '@/lib/game/store';
import { involvedIn } from '@/lib/game/ui';

export type CastAction = Extract<PlayerAction, { type: 'cast' }>;

export type Mode =
  | { kind: 'idle' }
  | { kind: 'targeting'; st: TargetingState }
  | { kind: 'x'; st: TargetingState }
  | { kind: 'armed'; action: PlayerAction; label: string; legal: LegalAction }
  | { kind: 'pay'; action: CastAction; legal: LegalAction; sources: number[] }
  | { kind: 'attackers'; decl: AttackDeclaration; candidates: number[]; mustAttack: number[]; defenders: PlayerId[]; planeswalkers: { id: number; controller: PlayerId }[] }
  | { kind: 'blockers'; decl: BlockDeclaration; selected: number | null; attackers: number[]; candidates: number[] };

const EMPTY_IDS = new Set<number>();
const EMPTY_PLAYERS = new Set<PlayerId>();

/** Keep `targets` consistent with the attacker list (dropping entries for withdrawn attackers). */
function withTargets(decl: AttackDeclaration, targets: Record<number, AttackTarget> | undefined): AttackDeclaration {
  if (!targets) return { attackers: decl.attackers };
  const kept: Record<number, AttackTarget> = {};
  for (const id of decl.attackers) if (targets[id] !== undefined) kept[id] = targets[id];
  return Object.keys(kept).length ? { attackers: decl.attackers, targets: kept } : { attackers: decl.attackers };
}

export interface TableInteractionOptions {
  /** When the pay tray opens for a cast that carries a payment suggestion (default: when the choice of sources matters). */
  askToPay?: AskToPay;
}

export function useTableInteraction(opts: TableInteractionOptions = {}) {
  const decision = useGameStore(s => s.decision);
  const answer = useGameStore(s => s.answer);
  const liveView = useGameStore(s => s.liveView);
  const [mode, setMode] = useState<Mode>({ kind: 'idle' });
  const [menuCard, setMenuCard] = useState<number | null>(null);
  const [hover, setHover] = useState<{ objects: Set<number>; players: Set<PlayerId> }>({ objects: EMPTY_IDS, players: EMPTY_PLAYERS });
  const lastRequest = useRef<number | null>(null);
  const askToPay = opts.askToPay ?? 'when-ambiguous';
  const meView: PlayerView | null = liveView ? liveView.players[liveView.viewer ?? 0] ?? null : null;
  const ctxRef = useRef({ askToPay, meView });
  ctxRef.current = { askToPay, meView };
  /** A payment intent set when an action starts (drop on a land / forced tray), consumed when the action completes. */
  const payIntent = useRef<{ source?: number; force?: boolean } | null>(null);

  // A new decision resets the mode; combat decisions start in their declaration mode.
  useEffect(() => {
    const id = decision?.requestId ?? null;
    if (id === lastRequest.current) return;
    lastRequest.current = id;
    setMenuCard(null); payIntent.current = null;
    const d = decision?.decision;
    if (!d) { setMode({ kind: 'idle' }); return; }
    if (d.kind === 'attackers') setMode({ kind: 'attackers', decl: { attackers: [...d.mustAttack] }, candidates: d.candidates, mustAttack: d.mustAttack, defenders: d.defenders ?? [], planeswalkers: d.planeswalkers ?? [] });
    else if (d.kind === 'blockers') setMode({ kind: 'blockers', decl: { blocks: [] }, selected: null, attackers: d.attackers, candidates: d.candidates });
    else setMode({ kind: 'idle' });
  }, [decision]);

  const legal = useMemo<LegalAction[]>(() => decision?.decision.kind === 'priority' ? decision.decision.legal : [], [decision]);
  const playable = useMemo(() => playableCardIds(legal), [legal]);
  const numbered = useMemo(() => legal.filter(l => l.action.type !== 'pass'), [legal]);
  const isPriority = decision?.decision.kind === 'priority';

  /** A finished flow either answers straight away or parks in the pay tray. */
  const applyFlow = useCallback((flow: Flow, l: LegalAction) => {
    if (flow.kind === 'done') {
      const intent = payIntent.current; payIntent.current = null;
      const a = flow.action;
      const { askToPay: ask, meView: pv } = ctxRef.current;
      if (a.type === 'cast' && l.pay && pv && (intent?.force || shouldAskToPay(ask, l.pay, pv))) {
        setMode({ kind: 'pay', action: a, legal: l, sources: initialSources(l.pay, pv, intent?.source) });
        return;
      }
      answer(a); setMode({ kind: 'idle' });
    }
    else if (flow.kind === 'x') setMode({ kind: 'x', st: flow.state });
    else setMode({ kind: 'targeting', st: flow.state });
  }, [answer]);

  /** Begin an action; `pay` starts it with the tray forced open (and a chosen first source, the land it was dropped on). */
  const beginLegal = useCallback((l: LegalAction, pay?: { source?: number; force?: boolean }) => { setMenuCard(null); payIntent.current = pay ?? null; applyFlow(beginAction(l), l); }, [applyFlow]);
  /** Begin an action and, when it asks for targets, pick `ref` for the first requirement straight away (drag → drop on a target). */
  const beginWithPick = useCallback((l: LegalAction, ref: TargetRef) => {
    setMenuCard(null); payIntent.current = null;
    const flow = beginAction(l);
    applyFlow(flow.kind === 'targeting' ? pickTarget(flow.state, ref) : flow, l);
  }, [applyFlow]);

  /** Card click on the table or in hand: dispatch by mode. */
  const onObjectClick = useCallback((id: number) => {
    setMode(m => {
      switch (m.kind) {
        case 'targeting': { const flow = pickTarget(m.st, { kind: 'object', id }); queueMicrotask(() => applyFlow(flow, m.st.legal)); return m; }
        case 'attackers': return { ...m, decl: withTargets(toggleAttacker(m.decl, id, m.mustAttack), m.decl.targets) };
        case 'blockers': {
          if (m.candidates.includes(id)) return { ...m, selected: m.selected === id ? null : id };
          if (m.attackers.includes(id) && m.selected !== null) return { ...m, decl: assignBlock(m.decl, m.selected, id), selected: null };
          return m;
        }
        case 'pay': {
          const pv = ctxRef.current.meView;
          const o = pv?.battlefield.find(x => x.id === id);
          if (!o || o.tapped || !isManaSource(o)) return m;
          return { ...m, sources: m.sources.includes(id) ? m.sources.filter(s => s !== id) : [...m.sources, id] };
        }
        case 'idle': {
          const acts = actionsForCard(legal, id);
          if (acts.length === 1) queueMicrotask(() => beginLegal(acts[0]));
          else if (acts.length > 1) setMenuCard(cur => (cur === id ? null : id));
          return m;
        }
        default: return m;
      }
    });
  }, [legal, applyFlow, beginLegal]);

  const onPlayerClick = useCallback((pid: PlayerId) => {
    setMode(m => { if (m.kind === 'targeting') { const flow = pickTarget(m.st, { kind: 'player', id: pid }); queueMicrotask(() => applyFlow(flow, m.st.legal)); } return m; });
  }, [applyFlow]);
  const onStackClick = useCallback((sid: number) => {
    setMode(m => { if (m.kind === 'targeting') { const flow = pickTarget(m.st, { kind: 'stack', id: sid }); queueMicrotask(() => applyFlow(flow, m.st.legal)); } return m; });
  }, [applyFlow]);
  const pickRef = useCallback((ref: TargetRef) => { if (ref.kind === 'object') onObjectClick(ref.id); else if (ref.kind === 'player') onPlayerClick(ref.id); else onStackClick(ref.id); }, [onObjectClick, onPlayerClick, onStackClick]);

  const cancel = useCallback(() => {
    setMenuCard(null); payIntent.current = null;
    setMode(m => {
      if (m.kind === 'attackers') return { ...m, decl: { attackers: [...m.mustAttack] } };
      if (m.kind === 'blockers') return { ...m, decl: { blocks: [] }, selected: null };
      return { kind: 'idle' };
    });
  }, []);

  const confirm = useCallback(() => {
    setMode(m => {
      if (m.kind === 'targeting' && canConfirm(m.st)) { const flow = confirmRequirement(m.st); queueMicrotask(() => applyFlow(flow, m.st.legal)); return m; }
      if (m.kind === 'armed') { queueMicrotask(() => answer(m.action)); return { kind: 'idle' }; }
      if (m.kind === 'pay') { const action: CastAction = { ...m.action, pay: { ...(m.action.pay ?? {}), sources: [...m.sources] } }; queueMicrotask(() => answer(action)); return { kind: 'idle' }; }
      if (m.kind === 'attackers') { queueMicrotask(() => answer(m.decl)); return { kind: 'idle' }; }
      if (m.kind === 'blockers') { queueMicrotask(() => answer(m.decl)); return { kind: 'idle' }; }
      return m;
    });
  }, [applyFlow, answer]);

  const chooseX = useCallback((x: number) => { setMode(m => { if (m.kind === 'x') { const flow = setX(m.st, x); queueMicrotask(() => applyFlow(flow, m.st.legal)); } return m; }); }, [applyFlow]);
  const noAttack = useCallback(() => { setMode(m => { if (m.kind === 'attackers') { queueMicrotask(() => answer({ attackers: [...m.mustAttack] })); return { kind: 'idle' }; } return m; }); }, [answer]);
  const noBlocks = useCallback(() => { setMode(m => { if (m.kind === 'blockers') { queueMicrotask(() => answer({ blocks: [] })); return { kind: 'idle' }; } return m; }); }, [answer]);
  const clearBlock = useCallback((blocker: number) => { setMode(m => m.kind === 'blockers' ? { ...m, decl: assignBlock(m.decl, blocker, null) } : m); }, []);
  /** Drag helpers: set (rather than toggle) an attacker with an optional defender (player or planeswalker), and assign a block in one step. */
  const setAttacking = useCallback((id: number, on: boolean, target?: AttackTarget) => {
    setMode(m => {
      if (m.kind !== 'attackers') return m;
      const has = m.decl.attackers.includes(id);
      if (!on) return has ? { ...m, decl: withTargets(toggleAttacker(m.decl, id, m.mustAttack), m.decl.targets) } : m;
      const attackers = has ? m.decl.attackers : toggleAttacker(m.decl, id, m.mustAttack).attackers;
      const targets: Record<number, AttackTarget> = { ...(m.decl.targets ?? {}) };
      if (target !== undefined) targets[id] = target; else delete targets[id];
      return { ...m, decl: withTargets({ attackers }, targets) };
    });
  }, []);
  const setBlock = useCallback((blocker: number, attacker: number) => {
    setMode(m => m.kind === 'blockers' && m.candidates.includes(blocker) && m.attackers.includes(attacker) ? { ...m, decl: assignBlock(m.decl, blocker, attacker), selected: null } : m);
  }, []);
  /** Pay tray: toggle a mana source, or replace the whole selection. */
  const togglePaySource = useCallback((id: number) => { onObjectClick(id); }, [onObjectClick]);
  const setPaySources = useCallback((sources: number[]) => { setMode(m => m.kind === 'pay' ? { ...m, sources } : m); }, []);
  const pass = useCallback(() => { if (isPriority && mode.kind === 'idle') answer({ type: 'pass' }); }, [isPriority, mode.kind, answer]);
  const pickNumbered = useCallback((n: number) => { const l = numbered[n - 1]; if (l && mode.kind === 'idle') beginLegal(l); }, [numbered, mode.kind, beginLegal]);

  /** Arm a candidate play from the analysis panel: its targets are pre-filled, nothing executes until confirmed. */
  const armPlay = useCallback((play: PlayAnalysis) => {
    if (!isPriority) return;
    setMenuCard(null);
    const a = play.concrete;
    if (a.type === 'pass') { setMode({ kind: 'armed', action: a, label: 'Pass priority', legal: play.action }); return; }
    setMode({ kind: 'armed', action: a, label: play.label, legal: play.action });
  }, [isPriority]);
  const usePlay = useCallback((play: PlayAnalysis) => { if (!isPriority) return; setMode({ kind: 'idle' }); answer(play.concrete); }, [isPriority, answer]);

  // Highlight sets for the table.
  const targets = useMemo(() => (mode.kind === 'targeting' ? legalTargets(mode.st) : null), [mode]);
  const picked = useMemo(() => {
    const objects = new Set<number>(); const players = new Set<PlayerId>();
    if (mode.kind === 'targeting') for (const group of [...mode.st.picks, mode.st.current]) for (const t of group) { if (t.kind === 'object') objects.add(t.id); else if (t.kind === 'player') players.add(t.id); }
    if (mode.kind === 'armed') { const inv = involvedIn(mode.action); inv.objects.forEach(o => objects.add(o)); inv.players.forEach(p => players.add(p)); }
    if (mode.kind === 'pay') for (const t of (mode.action.targets ?? []).flat()) { if (t.kind === 'object') objects.add(t.id); else if (t.kind === 'player') players.add(t.id); }
    return { objects, players };
  }, [mode]);
  const sourceId = mode.kind === 'targeting' || mode.kind === 'x' ? (mode.st.legal.action.type === 'cast' || mode.st.legal.action.type === 'play-land' ? mode.st.legal.action.cardId : mode.st.legal.action.type === 'activate' ? mode.st.legal.action.objectId : null) : mode.kind === 'pay' ? mode.action.cardId : null;
  const requirement = mode.kind === 'targeting' ? currentRequirement(mode.st) : null;
  const canConfirmNow = mode.kind === 'targeting' ? canConfirm(mode.st) : mode.kind === 'armed' || mode.kind === 'attackers' || mode.kind === 'blockers' || mode.kind === 'pay';

  const setHoverAction = useCallback((action: PlayerAction | null) => { setHover(action ? involvedIn(action) : { objects: EMPTY_IDS, players: EMPTY_PLAYERS }); }, []);

  // The serialisable picture of this mode that the drag planner (@play/targeting planDrag) reads. `x`, `armed` and
  // `pay` are not draggable states and read as idle-without-actions.
  const dragMode = useMemo<DragMode>(() => {
    switch (mode.kind) {
      case 'idle': return { kind: 'idle', legal: isPriority ? legal : [] };
      case 'targeting': return { kind: 'targeting', legal, targeting: mode.st };
      case 'attackers': return { kind: 'attackers', legal: [], attackers: { decl: mode.decl, candidates: mode.candidates, mustAttack: mode.mustAttack, defenders: mode.defenders, planeswalkers: mode.planeswalkers } };
      case 'blockers': return { kind: 'blockers', legal: [], blockers: { decl: mode.decl, selected: mode.selected, attackers: mode.attackers, candidates: mode.candidates } };
      default: return { kind: 'idle', legal: [] };
    }
  }, [mode, legal, isPriority]);

  // One stable object per state change: the table threads this through `cardState`, so a fresh identity on every
  // render would re-render every card on the table (a real cost at four seats).
  return useMemo(() => ({
    mode, decision, legal, numbered, playable, isPriority, menuCard, setMenuCard, dragMode,
    targets, picked, sourceId, requirement, canConfirmNow, hover, setHoverAction,
    onObjectClick, onPlayerClick, onStackClick, pickRef, beginLegal, beginWithPick, cancel, confirm, chooseX, noAttack, noBlocks, clearBlock, setAttacking, setBlock, togglePaySource, setPaySources, pass, pickNumbered, armPlay, usePlay,
  }), [
    mode, decision, legal, numbered, playable, isPriority, menuCard, dragMode,
    targets, picked, sourceId, requirement, canConfirmNow, hover, setHoverAction,
    onObjectClick, onPlayerClick, onStackClick, pickRef, beginLegal, beginWithPick, cancel, confirm, chooseX, noAttack, noBlocks, clearBlock, setAttacking, setBlock, togglePaySource, setPaySources, pass, pickNumbered, armPlay, usePlay,
  ]);
}

export type TableInteraction = ReturnType<typeof useTableInteraction>;
