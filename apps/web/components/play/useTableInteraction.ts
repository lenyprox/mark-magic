'use client';
// The table's interaction state: idle → (targeting | x | armed) for spells and abilities, attackers / blockers
// declarations, and the multi-action card menu. Pure state from @play/targeting; this hook only wires it to the store.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AttackDeclaration, BlockDeclaration, LegalAction, PlayerAction, PlayerId, TargetRef } from '@engine/state';
import { actionsForCard, assignBlock, beginAction, canConfirm, confirmRequirement, currentRequirement, legalTargets, pickTarget, playableCardIds, setX, toggleAttacker, type Flow, type TargetingState } from '@play/targeting';
import type { PlayAnalysis } from '@analysis/types';
import { useGameStore } from '@/lib/game/store';
import { involvedIn } from '@/lib/game/ui';

export type Mode =
  | { kind: 'idle' }
  | { kind: 'targeting'; st: TargetingState }
  | { kind: 'x'; st: TargetingState }
  | { kind: 'armed'; action: PlayerAction; label: string; legal: LegalAction }
  | { kind: 'attackers'; decl: AttackDeclaration; candidates: number[]; mustAttack: number[] }
  | { kind: 'blockers'; decl: BlockDeclaration; selected: number | null; attackers: number[]; candidates: number[] };

const EMPTY_IDS = new Set<number>();
const EMPTY_PLAYERS = new Set<PlayerId>();

export function useTableInteraction() {
  const decision = useGameStore(s => s.decision);
  const answer = useGameStore(s => s.answer);
  const [mode, setMode] = useState<Mode>({ kind: 'idle' });
  const [menuCard, setMenuCard] = useState<number | null>(null);
  const [hover, setHover] = useState<{ objects: Set<number>; players: Set<PlayerId> }>({ objects: EMPTY_IDS, players: EMPTY_PLAYERS });
  const lastRequest = useRef<number | null>(null);

  // A new decision resets the mode; combat decisions start in their declaration mode.
  useEffect(() => {
    const id = decision?.requestId ?? null;
    if (id === lastRequest.current) return;
    lastRequest.current = id;
    setMenuCard(null);
    const d = decision?.decision;
    if (!d) { setMode({ kind: 'idle' }); return; }
    if (d.kind === 'attackers') setMode({ kind: 'attackers', decl: { attackers: [...d.mustAttack] }, candidates: d.candidates, mustAttack: d.mustAttack });
    else if (d.kind === 'blockers') setMode({ kind: 'blockers', decl: { blocks: [] }, selected: null, attackers: d.attackers, candidates: d.candidates });
    else setMode({ kind: 'idle' });
  }, [decision]);

  const legal = useMemo<LegalAction[]>(() => decision?.decision.kind === 'priority' ? decision.decision.legal : [], [decision]);
  const playable = useMemo(() => playableCardIds(legal), [legal]);
  const numbered = useMemo(() => legal.filter(l => l.action.type !== 'pass'), [legal]);
  const isPriority = decision?.decision.kind === 'priority';

  const applyFlow = useCallback((flow: Flow) => {
    if (flow.kind === 'done') { answer(flow.action); setMode({ kind: 'idle' }); }
    else if (flow.kind === 'x') setMode({ kind: 'x', st: flow.state });
    else setMode({ kind: 'targeting', st: flow.state });
  }, [answer]);

  const beginLegal = useCallback((l: LegalAction) => { setMenuCard(null); applyFlow(beginAction(l)); }, [applyFlow]);

  /** Card click on the table or in hand: dispatch by mode. */
  const onObjectClick = useCallback((id: number) => {
    setMode(m => {
      switch (m.kind) {
        case 'targeting': { const flow = pickTarget(m.st, { kind: 'object', id }); queueMicrotask(() => applyFlow(flow)); return m; }
        case 'attackers': return { ...m, decl: toggleAttacker(m.decl, id, m.mustAttack) };
        case 'blockers': {
          if (m.candidates.includes(id)) return { ...m, selected: m.selected === id ? null : id };
          if (m.attackers.includes(id) && m.selected !== null) return { ...m, decl: assignBlock(m.decl, m.selected, id), selected: null };
          return m;
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
    setMode(m => { if (m.kind === 'targeting') { const flow = pickTarget(m.st, { kind: 'player', id: pid }); queueMicrotask(() => applyFlow(flow)); } return m; });
  }, [applyFlow]);
  const onStackClick = useCallback((sid: number) => {
    setMode(m => { if (m.kind === 'targeting') { const flow = pickTarget(m.st, { kind: 'stack', id: sid }); queueMicrotask(() => applyFlow(flow)); } return m; });
  }, [applyFlow]);
  const pickRef = useCallback((ref: TargetRef) => { if (ref.kind === 'object') onObjectClick(ref.id); else if (ref.kind === 'player') onPlayerClick(ref.id); else onStackClick(ref.id); }, [onObjectClick, onPlayerClick, onStackClick]);

  const cancel = useCallback(() => {
    setMenuCard(null);
    setMode(m => {
      if (m.kind === 'attackers') return { ...m, decl: { attackers: [...m.mustAttack] } };
      if (m.kind === 'blockers') return { ...m, decl: { blocks: [] }, selected: null };
      return { kind: 'idle' };
    });
  }, []);

  const confirm = useCallback(() => {
    setMode(m => {
      if (m.kind === 'targeting' && canConfirm(m.st)) { const flow = confirmRequirement(m.st); queueMicrotask(() => applyFlow(flow)); return m; }
      if (m.kind === 'armed') { queueMicrotask(() => answer(m.action)); return { kind: 'idle' }; }
      if (m.kind === 'attackers') { queueMicrotask(() => answer(m.decl)); return { kind: 'idle' }; }
      if (m.kind === 'blockers') { queueMicrotask(() => answer(m.decl)); return { kind: 'idle' }; }
      return m;
    });
  }, [applyFlow, answer]);

  const chooseX = useCallback((x: number) => { setMode(m => { if (m.kind === 'x') { const flow = setX(m.st, x); queueMicrotask(() => applyFlow(flow)); } return m; }); }, [applyFlow]);
  const noAttack = useCallback(() => { setMode(m => { if (m.kind === 'attackers') { queueMicrotask(() => answer({ attackers: [...m.mustAttack] })); return { kind: 'idle' }; } return m; }); }, [answer]);
  const noBlocks = useCallback(() => { setMode(m => { if (m.kind === 'blockers') { queueMicrotask(() => answer({ blocks: [] })); return { kind: 'idle' }; } return m; }); }, [answer]);
  const clearBlock = useCallback((blocker: number) => { setMode(m => m.kind === 'blockers' ? { ...m, decl: assignBlock(m.decl, blocker, null) } : m); }, []);
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
    return { objects, players };
  }, [mode]);
  const sourceId = mode.kind === 'targeting' || mode.kind === 'x' ? (mode.st.legal.action.type === 'cast' || mode.st.legal.action.type === 'play-land' ? mode.st.legal.action.cardId : mode.st.legal.action.type === 'activate' ? mode.st.legal.action.objectId : null) : null;
  const requirement = mode.kind === 'targeting' ? currentRequirement(mode.st) : null;
  const canConfirmNow = mode.kind === 'targeting' ? canConfirm(mode.st) : mode.kind === 'armed' || mode.kind === 'attackers' || mode.kind === 'blockers';

  const setHoverAction = useCallback((action: PlayerAction | null) => { setHover(action ? involvedIn(action) : { objects: EMPTY_IDS, players: EMPTY_PLAYERS }); }, []);

  return {
    mode, decision, legal, numbered, playable, isPriority, menuCard, setMenuCard,
    targets, picked, sourceId, requirement, canConfirmNow, hover, setHoverAction,
    onObjectClick, onPlayerClick, onStackClick, pickRef, beginLegal, cancel, confirm, chooseX, noAttack, noBlocks, clearBlock, pass, pickNumbered, armPlay, usePlay,
  };
}

export type TableInteraction = ReturnType<typeof useTableInteraction>;
