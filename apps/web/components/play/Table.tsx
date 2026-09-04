'use client';
// The play table: boots (or re-creates) the game for the route's gameId, lays out the zones, and wires clicks,
// keys, the analysis panel and the decision surfaces to the game store.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { FlaskConical, HelpCircle, PanelLeft, ScrollText } from 'lucide-react';
import { useReducedMotion } from 'motion/react';
import type { LegalAction, PlayerId, TargetRef } from '@engine/state';
import { DEFAULT_STOPS, type StopPolicy } from '@engine/agents/deferred';
import { DEFAULT_START_OPTIONS, type StartOptions } from '@play/protocol';
import { describeDecision, planDrag, sameZone, type DragContext, type DragPlan, type DragSource, type DropEffect, type DropZone, type IllegalReason } from '@play/targeting';
import type { CardView, PermanentView } from '@play/view';
import { Button, Callout, EmptyState, IconButton, Skeleton, Drawer } from '@/components/ui';
import { useGameStore } from '@/lib/game/store';
import { parseGameId, payloadFor, type DeckRef } from '@/lib/game/api';
import { indexObjects, loadSetup, me as meOf, opp as oppOf, refFromKey, STEP_LABELS } from '@/lib/game/ui';
import { readLocal, writeLocal } from '@/lib/hooks/useLocalStorage';
import { useIsMobile } from '@/lib/hooks/useMediaQuery';
import { toast } from '@/lib/stores/ui';
import { AnalysisPanel } from '@/components/analysis/AnalysisPanel';
import { useTableInteraction } from './useTableInteraction';
import { PlayerPlate } from './PlayerPlate';
import { Battlefield } from './Battlefield';
import { Hand } from './Hand';
import { PhaseStrip } from './PhaseStrip';
import { StackPanel } from './StackPanel';
import { TargetArrows, type Connector } from './TargetArrows';
import { PriorityBar } from './PriorityBar';
import { ActionBar } from './ActionBar';
import { DecisionSheet } from './DecisionSheet';
import { LogPanel } from './LogPanel';
import { ZoneDrawer } from './ZoneDrawer';
import { GameOver } from './GameOver';
import { ShortcutsSheet } from './ShortcutsSheet';
import { useDragIntent } from './useDragIntent';
import { CastingSlot, DragLayer } from './DragLayer';
import { ActionsPopover } from './ActionsPopover';
import type { TableCardProps } from './TableCard';
import styles from './table.module.css';

const sourceIdOf = (s: DragSource) => (s.kind === 'hand' ? s.cardId : s.id);

const STOPS_KEY = 'vault.play.stops';
const PANELS_KEY = 'vault.play.panels';

export function Table({ gameId }: { gameId: string }) {
  const status = useGameStore(s => s.status);
  const storeGameId = useGameStore(s => s.gameId);
  const view = useGameStore(s => s.view);
  const decision = useGameStore(s => s.decision);
  const log = useGameStore(s => s.log);
  const reasoning = useGameStore(s => s.reasoning);
  const analysis = useGameStore(s => s.analysis);
  const analysisPhase = useGameStore(s => s.analysisPhase);
  const reruns = useGameStore(s => s.reruns);
  const error = useGameStore(s => s.error);
  const decks = useGameStore(s => s.decks);
  const options = useGameStore(s => s.options);
  const start = useGameStore(s => s.start);
  const answer = useGameStore(s => s.answer);
  const concede = useGameStore(s => s.concede);
  const setStopsRemote = useGameStore(s => s.setStops);
  const deepen = useGameStore(s => s.deepen);
  const rerun = useGameStore(s => s.rerun);

  const isMobile = useIsMobile();
  const ix = useTableInteraction();
  const rootRef = useRef<HTMLDivElement>(null);
  const [boot, setBoot] = useState<'idle' | 'loading' | 'missing' | 'ready' | 'failed'>('idle');
  const [bootError, setBootError] = useState<string | null>(null);
  const [zone, setZone] = useState<{ pid: PlayerId; zone: 'graveyard' | 'exile' | 'command' } | null>(null);
  const [panels, setPanels] = useState<{ log: boolean; analysis: boolean }>({ log: false, analysis: true });
  const [sheet, setSheet] = useState<'analysis' | 'log' | null>(null);
  const [help, setHelp] = useState(false);
  const [stops, setStops] = useState<StopPolicy>(DEFAULT_STOPS);
  const toasted = useRef<string | null>(null);

  // ---- boot: reuse the store's game when it matches, otherwise re-create from the persisted setup / the id itself
  useEffect(() => {
    if (storeGameId === gameId && status !== 'idle') { setBoot('ready'); return; }
    if (boot === 'loading') return;
    const rec = loadSetup(gameId);
    const parsed = parseGameId(gameId);
    let a: DeckRef | null = rec?.a ?? null; let b: DeckRef | null = rec?.b ?? null;
    let opts: StartOptions | null = rec?.options ?? null;
    if ((!a || !b) && parsed) { a = refFromKey(parsed.a); b = refFromKey(parsed.b); opts = opts ?? { ...DEFAULT_START_OPTIONS, seed: parsed.seed }; }
    if (!a || !b || !opts) { setBoot('missing'); return; }
    setBoot('loading');
    const seed = opts.seed;
    Promise.all([payloadFor(a, seed), payloadFor(b, seed)])
      .then(([pa, pb]) => { void start(gameId, [pa, pb], { ...opts!, aiName: opts!.aiName ?? pb.archetype?.name ?? b!.name }); setBoot('ready'); })
      .catch(e => { setBootError((e as Error).message); setBoot('failed'); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId, storeGameId, status]);

  // ---- stops: persisted per browser, pushed to the worker when the game runs
  useEffect(() => { setStops({ ...DEFAULT_STOPS, ...readLocal<Partial<StopPolicy>>(STOPS_KEY, {}) }); setPanels(p => ({ ...p, ...readLocal<Partial<typeof panels>>(PANELS_KEY, {}) })); }, []);
  useEffect(() => { if (status === 'running' && storeGameId === gameId) setStopsRemote(stops); }, [status, storeGameId, gameId, stops, setStopsRemote]);
  const toggleStop = useCallback((key: keyof StopPolicy, value: boolean) => { setStops(s => { const n = { ...s, [key]: value }; writeLocal(STOPS_KEY, n); return n; }); }, []);
  const togglePanel = useCallback((key: 'log' | 'analysis') => { setPanels(p => { const n = { ...p, [key]: !p[key] }; writeLocal(PANELS_KEY, n); return n; }); }, []);

  // ---- one toast at game start listing partially simulated cards
  useEffect(() => {
    if (status !== 'running' || !decks || toasted.current === gameId) return;
    toasted.current = gameId;
    const mine = decks[0].partial.length; const theirs = decks[1].partial.length;
    if (mine || theirs) toast({ title: 'Some cards are only partly simulated', body: `${mine} in your deck, ${theirs} in ${decks[1].name}. The engine notes each one in the log when it matters.`, kind: 'note', ttl: 9000 });
  }, [status, decks, gameId]);

  const objects = useMemo(() => indexObjects(view), [view]);
  const myId: PlayerId = view?.viewer ?? 0;
  const me = view ? meOf(view) : null; const opp = view ? oppOf(view) : null;
  const thinking = status === 'running' && !decision;
  const narration = useMemo(() => {
    for (let i = log.length - 1; i >= 0 && i > log.length - 40; i--) if (log[i].kind === 'ai') return log[i].line.replace(/^\s*\[[^\]]+ thinks\]\s*/, '');
    return reasoning.length ? reasoning[reasoning.length - 1].summary : null;
  }, [log, reasoning]);
  const decisionText = decision ? describeDecision(decision.decision) : '';
  const nonPriorityDecision = decision && decision.decision.kind !== 'priority' && decision.decision.kind !== 'attackers' && decision.decision.kind !== 'blockers' ? decision.decision : null;

  // ---- drag and drop: plans come from @play/targeting, effects go back into the interaction hook
  const reducedMotion = !!useReducedMotion();
  const [choice, setChoice] = useState<{ card: CardView; actions: LegalAction[]; at: { x: number; y: number } } | null>(null);
  useEffect(() => { setChoice(null); }, [decision]);
  const dragCtx = useMemo<DragContext | null>(() => (view ? { mode: ix.dragMode, view, me: myId } : null), [ix.dragMode, view, myId]);
  const dragRef = useRef({ ctx: dragCtx, mode: ix.mode.kind, status, blocked: !!nonPriorityDecision, objects });
  dragRef.current = { ctx: dragCtx, mode: ix.mode.kind, status, blocked: !!nonPriorityDecision, objects };
  const planFor = useCallback((source: DragSource): DragPlan | null => {
    const { ctx, mode: mk, status: st, blocked, objects: objs } = dragRef.current;
    if (!ctx || st !== 'running' || blocked || mk === 'x' || mk === 'armed') return null;
    if (source.kind === 'permanent') { const p = objs.get(source.id) as PermanentView | undefined; if (!p || !('controller' in p) || p.controller !== ctx.me) return null; }
    return planDrag(source, ctx);
  }, []);
  const onDrop = useCallback((plan: DragPlan, _zone: DropZone, effect: Exclude<DropEffect, { kind: 'none' }>, point: { x: number; y: number }) => {
    switch (effect.kind) {
      case 'begin': {
        if (plan.choices && plan.choices.length > 1) { const card = objects.get(sourceIdOf(plan.source)); if (card) { setChoice({ card, actions: plan.choices, at: point }); return; } }
        if (effect.pick) ix.beginWithPick(effect.legal, effect.pick); else ix.beginLegal(effect.legal);
        return;
      }
      case 'pick': ix.pickRef(effect.ref); return;
      case 'attack': ix.setAttacking(effect.id, true); return;
      case 'unattack': ix.setAttacking(effect.id, false); return;
      case 'block': ix.setBlock(effect.blocker, effect.attacker); return;
      case 'unblock': ix.clearBlock(effect.blocker); return;
    }
  }, [ix, objects]);
  const onIllegal = useCallback((_plan: DragPlan, _zone: DropZone, reason: IllegalReason) => { toast({ title: reason.text, kind: 'warn', ttl: 4500 }); }, []);
  const drag = useDragIntent({ planFor, onDrop, onIllegal, reducedMotion });
  const drops = useMemo(() => {
    const out = { bf: new Set<PlayerId>(), players: new Set<PlayerId>(), objects: new Set<number>(), stack: new Set<number>() };
    if (drag.phase !== 'dragging' || !drag.plan) return out;
    for (const { zone } of drag.plan.zones) {
      if (zone.kind === 'battlefield') out.bf.add(zone.player); else if (zone.kind === 'player') out.players.add(zone.id); else if (zone.kind === 'object') out.objects.add(zone.id); else if (zone.kind === 'stack') out.stack.add(zone.id);
    }
    return out;
  }, [drag.phase, drag.plan]);
  const overIs = useCallback((z: DropZone) => !!drag.over && sameZone(drag.over, z), [drag.over]);
  const liftedId = drag.phase !== 'idle' && drag.phase !== 'pending' && drag.ghost ? sourceIdOf(drag.ghost.source) : null;
  // The spell being cast from hand sits in the casting slot while its targets are chosen; a tether runs from there.
  const slotCard = useMemo<CardView | null>(() => {
    if (ix.mode.kind !== 'targeting' || ix.sourceId == null || ix.mode.st.legal.action.type !== 'cast') return null;
    return me?.hand?.find(c => c.id === ix.sourceId) ?? null;
  }, [ix.mode, ix.sourceId, me]);
  const tether = useMemo(() => (ix.mode.kind === 'targeting' && ix.sourceId != null ? { from: slotCard ? '[data-cast-slot]' : `[data-obj-id="${ix.sourceId}"]`, rootRef, tone: 'brass' as const } : null), [ix.mode.kind, ix.sourceId, slotCard]);

  // ---- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (e.key === '?' && !typing) { e.preventDefault(); setHelp(h => !h); return; }
      if (e.key === 'Escape') { if (ix.mode.kind !== 'idle' || ix.menuCard !== null) { e.preventDefault(); ix.cancel(); } return; }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === ' ' && !(t && t.getAttribute('role') === 'button')) { e.preventDefault(); ix.pass(); return; }
      if (e.key === 'Enter' && ix.mode.kind !== 'idle' && ix.mode.kind !== 'x' && !(t && (t.tagName === 'BUTTON' || t.getAttribute('role') === 'button'))) { e.preventDefault(); ix.confirm(); return; }
      if (e.key === 'l' || e.key === 'L') { e.preventDefault(); if (isMobile) setSheet(s => s === 'log' ? null : 'log'); else togglePanel('log'); return; }
      if (e.key === 'p' || e.key === 'P') { e.preventDefault(); if (isMobile) setSheet(s => s === 'analysis' ? null : 'analysis'); else togglePanel('analysis'); return; }
      const n = Number(e.key);
      if (n >= 1 && n <= 9) {
        if (ix.mode.kind === 'targeting') { const o = ix.requirement?.options[n - 1]; if (o) { e.preventDefault(); ix.pickRef(o); } }
        else if (ix.mode.kind === 'attackers') { const id = ix.mode.candidates[n - 1]; if (id !== undefined) { e.preventDefault(); ix.onObjectClick(id); } }
        else if (ix.mode.kind === 'idle' && !nonPriorityDecision) { e.preventDefault(); ix.pickNumbered(n); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ix, isMobile, togglePanel, nonPriorityDecision]);

  // ---- per-card interaction state
  const cardState = useCallback((id: number): TableCardProps['state'] => {
    const m = ix.mode;
    const legal = m.kind === 'targeting' ? ix.targets!.objects.has(id) : m.kind === 'attackers' ? m.candidates.includes(id) : m.kind === 'blockers' ? (m.candidates.includes(id) || (m.selected !== null && m.attackers.includes(id))) : false;
    const pickedNow = ix.picked.objects.has(id) || (m.kind === 'attackers' && m.decl.attackers.includes(id)) || (m.kind === 'blockers' && m.decl.blocks.some(b => b.blocker === id || b.attacker === id));
    const perm = objects.get(id);
    const attacking = !!perm && 'attacking' in perm && (perm as { attacking: PlayerId | null }).attacking !== null;
    const blocking = !!perm && 'blocking' in perm && (perm as { blocking: number[] }).blocking.length > 0;
    return {
      castable: m.kind === 'idle' && ix.isPriority && ix.playable.has(id),
      legalTarget: legal,
      dimmed: (m.kind === 'targeting' && !legal && id !== ix.sourceId && !ix.picked.objects.has(id)) || (m.kind === 'armed' && !ix.picked.objects.has(id)),
      picked: pickedNow, hovered: ix.hover.objects.has(id), selected: m.kind === 'blockers' && m.selected === id, source: ix.sourceId === id,
      attacking: attacking || (m.kind === 'attackers' && m.decl.attackers.includes(id)), blocking,
      dropTarget: drops.objects.has(id), dropOver: overIs({ kind: 'object', id }), lifted: liftedId === id || slotCard?.id === id,
    };
  }, [ix, objects, drops, overIs, liftedId, slotCard]);
  const actionsFor = useCallback((id: number) => ix.legal.filter(l => (l.action.type === 'play-land' && l.action.cardId === id) || (l.action.type === 'cast' && l.action.cardId === id) || (l.action.type === 'activate' && l.action.objectId === id)), [ix.legal]);
  const onMenuOpenChange = useCallback((id: number, open: boolean) => ix.setMenuCard(open ? id : null), [ix]);

  // ---- connectors for the SVG overlay
  const connectors = useMemo<Connector[]>(() => {
    const out: Connector[] = [];
    if (!view) return out;
    for (const it of view.stack) for (const t of it.targets) out.push({ from: { kind: 'stack', id: it.id }, to: t, tone: 'brass' });
    for (const p of view.players) for (const perm of p.battlefield) {
      if (perm.attacking !== null && view.step !== 'combat-end') out.push({ from: { kind: 'object', id: perm.id }, to: { kind: 'player', id: perm.attacking }, tone: 'danger' });
      for (const a of perm.blocking) out.push({ from: { kind: 'object', id: perm.id }, to: { kind: 'object', id: a }, tone: 'info' });
    }
    const m = ix.mode;
    if (m.kind === 'blockers') for (const b of m.decl.blocks) out.push({ from: { kind: 'object', id: b.blocker }, to: { kind: 'object', id: b.attacker }, tone: 'info' });
    if (m.kind === 'attackers') for (const id of m.decl.attackers) out.push({ from: { kind: 'object', id }, to: { kind: 'player', id: myId === 0 ? 1 : 0 }, tone: 'danger' });
    if ((m.kind === 'targeting') && ix.sourceId != null) for (const group of [...m.st.picks, m.st.current]) for (const t of group) out.push({ from: { kind: 'object', id: ix.sourceId }, to: t, tone: 'brass' });
    if (m.kind === 'armed' && (m.action.type === 'cast' || m.action.type === 'activate')) { const src = m.action.type === 'cast' ? m.action.cardId : m.action.objectId; for (const t of (m.action.targets ?? []).flat()) out.push({ from: { kind: 'object', id: src }, to: t as TargetRef, tone: 'brass' }); }
    return out;
  }, [view, ix.mode, ix.sourceId, myId]);

  const rematch = useCallback(() => { if (decks && options) void start(gameId, decks, options); }, [decks, options, start, gameId]);
  const legalPlayers = ix.mode.kind === 'targeting' ? ix.targets!.players : null;

  // ---- boot states
  if (boot === 'missing') {
    return <div className="container" style={{ paddingBlock: 48 }}><EmptyState title="No table to restore" actions={<Button variant="primary" onClick={() => undefined}><Link href="/play">Set up a game</Link></Button>}>This game id has no setup in this browser session, so it cannot be re-dealt.</EmptyState></div>;
  }
  if (boot === 'failed' || status === 'error') {
    return <div className="container" style={{ paddingBlock: 48 }}><Callout variant="danger" title="The table could not be set up">{bootError ?? error}</Callout><p style={{ marginTop: 16 }}><Link className="link" href="/play">Back to setup</Link></p></div>;
  }
  if (!view || !me || !opp) {
    return (
      <div className={styles.shell} aria-busy="true">
        <div className={styles.table}><div className={styles.booting}><Skeleton height={120} /><Skeleton height={40} width="60%" /><Skeleton height={160} /><span className="faint small">Shuffling and building the analysis pool…</span></div></div>
      </div>
    );
  }

  const myTurn = view.activePlayer === myId;
  const analysisPanel = (
    <AnalysisPanel report={analysis} phase={analysisPhase} reruns={reruns} seed={options?.seed ?? 0} enabled={!!options?.analysis.enabled} interactive={ix.isPriority && ix.mode.kind === 'idle'}
      onDeepen={policy => deepen(400, policy)} onRerun={rerun} onHover={ix.setHoverAction} onArm={ix.armPlay} onUse={ix.usePlay} objects={objects} view={view} />
  );
  const logPanel = <LogPanel log={log} />;

  return (
    <div ref={rootRef} className={clsx(styles.shell, panels.log && !isMobile && styles.shellLog, panels.analysis && !isMobile && styles.shellAnalysis, ix.mode.kind === 'targeting' && styles.shellTargeting)} data-testid="play-table" data-status={status}>
      <span className="sr-only" aria-live="polite">Turn {view.turn}, {myTurn ? 'your' : `${opp.name}'s`} turn, {STEP_LABELS[view.step]}.</span>

      {!isMobile && panels.log && <aside className={styles.logRail} aria-label="Log rail">{logPanel}</aside>}

      <div className={styles.table}>
        <TargetArrows rootRef={rootRef} connectors={connectors} version={view.logLength} />

        <section className={styles.oppZone} aria-label={`${opp.name}'s side`}>
          <PlayerPlate player={opp} isMe={false} active={!myTurn} hasPriority={view.priority === opp.id} thinking={thinking && status === 'running'} legalTarget={!!legalPlayers?.has(opp.id)} picked={ix.picked.players.has(opp.id)} hovered={ix.hover.players.has(opp.id)} dimmed={ix.mode.kind === 'targeting' && !legalPlayers?.has(opp.id)} onClick={ix.onPlayerClick} onOpenZone={(pid, z) => setZone({ pid, zone: z })}
            dropTarget={drops.players.has(opp.id)} dropOver={overIs({ kind: 'player', id: opp.id })} />
          <Battlefield permanents={opp.battlefield} mine={false} player={opp.id} cardWidth={isMobile ? 60 : 78} cardState={cardState} onActivate={ix.onObjectClick} dropTarget={drops.bf.has(opp.id)} dropOver={overIs({ kind: 'battlefield', player: opp.id })} />
        </section>

        <section className={styles.mid} aria-label="Turn, stack and priority">
          <PhaseStrip step={view.step} turn={view.turn} myTurn={myTurn} stops={stops} onToggleStop={toggleStop} />
          <div className={styles.midRow}>
            <StackPanel stack={view.stack} viewer={myId} legalStack={ix.targets?.stack ?? null} dimOthers={ix.mode.kind === 'targeting'} onClick={ix.onStackClick} dropStack={drops.stack} dropOver={drag.over?.kind === 'stack' ? drag.over.id : null} />
            <div className={styles.midRight}>
              <PriorityBar hasDecision={!!decision} decisionText={decisionText} thinking={thinking} narration={narration} numbered={ix.isPriority && ix.mode.kind === 'idle' ? ix.numbered : []} onPick={ix.beginLegal} onPass={ix.pass} onConcede={concede} canPass={ix.isPriority && ix.mode.kind === 'idle'} stackSize={view.stack.length} finished={status === 'finished'} />
              <ActionBar ix={ix} view={view} objects={objects} />
            </div>
          </div>
        </section>

        <section className={styles.myZone} aria-label="Your side">
          <Battlefield permanents={me.battlefield} mine player={myId} cardWidth={isMobile ? 64 : 84} cardState={cardState} onActivate={ix.onObjectClick} actionsFor={actionsFor} menuCard={ix.menuCard} onMenuOpenChange={onMenuOpenChange} onPickAction={ix.beginLegal}
            bindDrag={drag.bind} dropTarget={drops.bf.has(myId)} dropOver={overIs({ kind: 'battlefield', player: myId })} />
          {slotCard && <CastingSlot card={slotCard} label={ix.requirement ? `choose ${ix.requirement.optional ? 'up to ' : ''}${ix.requirement.count} ${ix.requirement.spec}` : 'choose targets'} bind={drag.bind} onCancel={ix.cancel} width={isMobile ? 72 : 96} />}
          <div className={styles.myBottom}>
            <PlayerPlate player={me} isMe active={myTurn} hasPriority={view.priority === myId} legalTarget={!!legalPlayers?.has(myId)} picked={ix.picked.players.has(myId)} hovered={ix.hover.players.has(myId)} dimmed={ix.mode.kind === 'targeting' && !legalPlayers?.has(myId)} onClick={ix.onPlayerClick} onOpenZone={(pid, z) => setZone({ pid, zone: z })}
              dropTarget={drops.players.has(myId)} dropOver={overIs({ kind: 'player', id: myId })} />
            <Hand cards={me.hand ?? []} cardState={cardState} onActivate={ix.onObjectClick} actionsFor={actionsFor} menuCard={ix.menuCard} onMenuOpenChange={onMenuOpenChange} onPickAction={ix.beginLegal} compact={isMobile} bindDrag={drag.bind} />
            <div className={styles.tableTools}>
              {isMobile ? (
                <>
                  <IconButton label="Log" onClick={() => setSheet('log')}><ScrollText size={16} /></IconButton>
                  <IconButton label="Analysis" onClick={() => setSheet('analysis')}><FlaskConical size={16} /></IconButton>
                </>
              ) : (
                <>
                  <IconButton label={panels.log ? 'Hide log (L)' : 'Show log (L)'} onClick={() => togglePanel('log')} aria-pressed={panels.log}><PanelLeft size={16} /></IconButton>
                  <IconButton label={panels.analysis ? 'Hide analysis (P)' : 'Show analysis (P)'} onClick={() => togglePanel('analysis')} aria-pressed={panels.analysis}><FlaskConical size={16} /></IconButton>
                </>
              )}
              <IconButton label="Keyboard shortcuts (?)" onClick={() => setHelp(true)}><HelpCircle size={16} /></IconButton>
            </div>
          </div>
          {nonPriorityDecision && <DecisionSheet decision={nonPriorityDecision} view={view} objects={objects} onAnswer={answer} />}
        </section>

        {status === 'finished' && <GameOver onRematch={rematch} />}
      </div>

      {!isMobile && panels.analysis && <aside className={styles.analysisRail} aria-label="Analysis">{analysisPanel}</aside>}
      {isMobile && <Drawer open={sheet === 'analysis'} onClose={() => setSheet(null)} side="bottom" title="Analysis">{analysisPanel}</Drawer>}
      {isMobile && <Drawer open={sheet === 'log'} onClose={() => setSheet(null)} side="bottom" title="Log">{logPanel}</Drawer>}

      <ZoneDrawer open={!!zone} onClose={() => setZone(null)} title={zone ? `${view.players[zone.pid].name} · ${zone.zone}` : ''} cards={zone ? view.players[zone.pid][zone.zone] : []} />
      <ShortcutsSheet open={help} onClose={() => setHelp(false)} />
      {choice && <ActionsPopover title={choice.card.name} manaCost={choice.card.manaCost} actions={choice.actions} at={choice.at} onPick={l => { setChoice(null); ix.beginLegal(l); }} onClose={() => setChoice(null)} testId="drop-choice" />}
      <DragLayer drag={drag} tether={tether} reducedMotion={reducedMotion} />
    </div>
  );
}
