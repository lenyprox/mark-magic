'use client';
// The play table: boots (or re-creates) the game for the route's gameId, lays out the seats (the viewer at the
// bottom, one to three opponents across the top), and wires clicks, keys, the right rail (analysis · explain ·
// timeline) and the decision surfaces to the game store. The DOM renders `shownView`, which the animation queue
// walks through the typed events; table interaction is enabled only once it has caught up with the decision's
// view (`data-settled="true"` on the root).
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { FlaskConical, HelpCircle, PanelLeft, ScrollText, Settings2 } from 'lucide-react';
import { useReducedMotion } from 'motion/react';
import { describeEvent } from '@play/anim';
import type { IllegalHint, LegalAction, PlayerId, Step, TargetRef } from '@engine/state';
import { DEFAULT_STOPS, type StopPolicy } from '@engine/agents/deferred';
import { DEFAULT_START_OPTIONS, type StartOptions } from '@play/protocol';
import { describeDecision, defaultDefender, dragSourceId, isManaSource, planDrag, sameZone, type DragContext, type DragPlan, type DragSource, type DropEffect, type DropZone, type IllegalReason } from '@play/targeting';
import type { CardView, PermanentView, PlayerView } from '@play/view';
import { Button, Callout, EmptyState, IconButton, Skeleton, Drawer, Tabs } from '@/components/ui';
import { useCardGL } from '@/components/card/CardGLProvider';
import { useGameStore } from '@/lib/game/store';
import { parseGameId, payloadFor, type DeckRef } from '@/lib/game/api';
import { indexObjects, loadSetup, me as meOf, opponents as oppsOf, refFromKey, seatsOf, STEP_LABELS } from '@/lib/game/ui';
import { usePlaySettings, writeSettings, type PlaySettings } from '@/lib/game/settings';
import { readLocal, writeLocal } from '@/lib/hooks/useLocalStorage';
import { useIsMobile } from '@/lib/hooks/useMediaQuery';
import { configureSfx, playSfx, unlockSfx } from '@/lib/audio/sfx';
import { configureHaptics, HAPTIC, installPointerTracking, vibrate } from '@/lib/audio/haptics';
import { toast } from '@/lib/stores/ui';
import { AnalysisPanel } from '@/components/analysis/AnalysisPanel';
import { useTableInteraction } from './useTableInteraction';
import { PlayerPlate } from './PlayerPlate';
import { Battlefield } from './Battlefield';
import { CommandZone } from './CommandZone';
import { Seat, SeatRing } from './Seat';
import { Hand } from './Hand';
import { PhaseStrip } from './PhaseStrip';
import { StackColumn } from './StackColumn';
import { TargetArrows, type Connector } from './TargetArrows';
import { PriorityBar } from './PriorityBar';
import { ActionBar } from './ActionBar';
import { PayTray } from './PayTray';
import { DecisionSheet } from './DecisionSheet';
import { LogPanel } from './LogPanel';
import { ZoneDrawer } from './ZoneDrawer';
import { GameOver } from './GameOver';
import { ShortcutsSheet } from './ShortcutsSheet';
import { TableSettingsSheet } from './TableSettingsSheet';
import { useDragIntent } from './useDragIntent';
import { CastingSlot, DragLayer } from './DragLayer';
import { ActionsPopover } from './ActionsPopover';
import { ExplainPanel } from './ExplainPanel';
import { Timeline } from './Timeline';
import { PlaybackBar } from './PlaybackBar';
import { EventChips, NumberPops, TurnBanner } from './TableFx';
import { HOVER_INTENT_MS, HoverInspector } from './HoverInspector';
import { TutorialTip, useTutorial } from './Tutorial';
import type { TableCardProps } from './TableCard';
import styles from './table.module.css';

const sourceIdOf = (s: DragSource) => dragSourceId(s);

const STOPS_KEY = 'vault.play.stops';
const PANELS_KEY = 'vault.play.panels';
type Rail = 'analysis' | 'explain' | 'timeline';
const EMPTY_IDS: number[] = [];
/** The own-turn stop keys in step order (a one-shot skip turns the earlier ones off and the target on). */
const OWN_STOP_KEYS: (keyof StopPolicy)[] = ['ownMain', 'ownCombatBegin', 'ownBlockers', 'ownEnd'];

export function Table({ gameId }: { gameId: string }) {
  const status = useGameStore(s => s.status);
  const storeGameId = useGameStore(s => s.gameId);
  const view = useGameStore(s => s.shownView);
  const liveView = useGameStore(s => s.liveView);
  const settled = useGameStore(s => s.settled);
  const fx = useGameStore(s => s.fx);
  const pulse = useGameStore(s => s.pulse);
  const playback = useGameStore(s => s.playback);
  const events = useGameStore(s => s.events);
  const eventBase = useGameStore(s => s.eventBase);
  const decision = useGameStore(s => s.decision);
  const undoAvailable = useGameStore(s => s.undoAvailable);
  const undoRefused = useGameStore(s => s.undoRefused);
  const undoing = useGameStore(s => s.undoing);
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
  const undo = useGameStore(s => s.undo);
  const setStopsRemote = useGameStore(s => s.setStops);
  const deepen = useGameStore(s => s.deepen);
  const rerun = useGameStore(s => s.rerun);
  const setSpeed = useGameStore(s => s.setSpeed);
  const setExplain = useGameStore(s => s.setExplain);
  const setReducedMotion = useGameStore(s => s.setReducedMotion);
  const skip = useGameStore(s => s.skip);
  const scrubTo = useGameStore(s => s.scrubTo);
  const pauseQueue = useGameStore(s => s.pause);
  const playQueue = useGameStore(s => s.play);
  const goLive = useGameStore(s => s.goLive);
  const showMe = useGameStore(s => s.showMe);

  const isMobile = useIsMobile();
  const settings = usePlaySettings();
  const gl = useCardGL();
  const ix = useTableInteraction({ askToPay: settings.askToPay });
  const rootRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const [boot, setBoot] = useState<'idle' | 'loading' | 'missing' | 'ready' | 'failed'>('idle');
  const [bootError, setBootError] = useState<string | null>(null);
  const [zone, setZone] = useState<{ pid: PlayerId; zone: 'graveyard' | 'exile' | 'command' } | null>(null);
  /** Phone layout: the opponent seat whose battlefield is open in a sheet. */
  const [bfSeat, setBfSeat] = useState<PlayerId | null>(null);
  const [panels, setPanels] = useState<{ log: boolean; analysis: boolean; rail: Rail }>({ log: false, analysis: true, rail: 'analysis' });
  const [sheet, setSheet] = useState<'analysis' | 'log' | null>(null);
  const [help, setHelp] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [stops, setStops] = useState<StopPolicy>(DEFAULT_STOPS);
  const toasted = useRef<string | null>(null);
  const tut = useTutorial();

  // ---- boot: reuse the store's game when it matches, otherwise re-create from the persisted setup / the id itself
  useEffect(() => {
    if (storeGameId === gameId && status !== 'idle') { setBoot('ready'); return; }
    if (boot === 'loading') return;
    const rec = loadSetup(gameId);
    const parsed = parseGameId(gameId);
    let seats: (DeckRef | null)[] = rec ? seatsOf(rec) : [];
    let opts: StartOptions | null = rec?.options ?? null;
    if ((!seats.length || seats.some(r => !r)) && parsed) { seats = parsed.keys.map(k => refFromKey(k)); opts = opts ?? { ...DEFAULT_START_OPTIONS, seed: parsed.seed }; }
    if (seats.length < 2 || seats.some(r => !r) || !opts) { setBoot('missing'); return; }
    const refs = seats as DeckRef[];
    setBoot('loading');
    const seed = opts.seed;
    Promise.all(refs.map(r => payloadFor(r, seed)))
      .then(payloads => { void start(gameId, payloads, { ...opts!, aiName: opts!.aiName ?? payloads[1].archetype?.name ?? refs[1].name }); setBoot('ready'); })
      .catch(e => { setBootError((e as Error).message); setBoot('failed'); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId, storeGameId, status]);

  // ---- stops: persisted per browser, pushed to the worker when the game runs; a phase-strip skip sets a one-shot
  // policy that is restored at the next decision
  const oneShot = useRef(false);
  useEffect(() => { setStops({ ...DEFAULT_STOPS, ...readLocal<Partial<StopPolicy>>(STOPS_KEY, {}) }); setPanels(p => ({ ...p, ...readLocal<Partial<typeof panels>>(PANELS_KEY, {}) })); }, []);
  useEffect(() => { if (status === 'running' && storeGameId === gameId) setStopsRemote(stops); }, [status, storeGameId, gameId, stops, setStopsRemote]);
  useEffect(() => { if (decision && oneShot.current) { oneShot.current = false; setStopsRemote(stops); } }, [decision, stops, setStopsRemote]);
  const toggleStop = useCallback((key: keyof StopPolicy, value: boolean) => { setStops(s => { const n = { ...s, [key]: value }; writeLocal(STOPS_KEY, n); return n; }); }, []);
  const togglePanel = useCallback((key: 'log' | 'analysis') => { setPanels(p => { const n = { ...p, [key]: !p[key] }; writeLocal(PANELS_KEY, n); return n; }); }, []);
  const setRail = useCallback((rail: Rail) => { setPanels(p => { const n = { ...p, rail, analysis: true }; writeLocal(PANELS_KEY, n); return n; }); }, []);

  // ---- reduced motion zeroes the queue's durations (the setting can override the system preference)
  const systemReducedMotion = !!useReducedMotion();
  const reducedMotion = settings.reducedMotion === 'system' ? systemReducedMotion : settings.reducedMotion === 'on';
  useEffect(() => { setReducedMotion(reducedMotion); }, [reducedMotion, setReducedMotion]);
  const changeSettings = useCallback((patch: Partial<PlaySettings>) => {
    writeSettings(patch);
    if (patch.speed !== undefined) setSpeed(patch.speed);
    if (patch.glQuality !== undefined) gl?.setQuality(patch.glQuality);
  }, [setSpeed, gl]);
  const changeSpeed = useCallback((s: number) => { setSpeed(s); writeSettings({ speed: s }); }, [setSpeed]);

  // ---- sound and haptics: the settings are pushed into the two modules, which the animation queue and the drag /
  // combat handlers call. The AudioContext is created and resumed on the first pointer-down / key-down.
  useEffect(() => { configureSfx({ enabled: settings.sound, volume: settings.soundVolume }); }, [settings.sound, settings.soundVolume]);
  useEffect(() => { configureHaptics(settings.haptics); }, [settings.haptics]);
  useEffect(() => installPointerTracking(), []);
  const previewSound = useCallback(() => { unlockSfx(); playSfx('resolve'); }, []);

  // ---- one toast at game start listing partially simulated cards; the explain default applies then too
  useEffect(() => {
    if (status !== 'running' || !decks || toasted.current === gameId) return;
    toasted.current = gameId;
    if (settings.explain) setExplain(true);
    const mine = decks[0].partial.length; const theirs = decks.slice(1).reduce((n, d) => n + d.partial.length, 0);
    if (mine || theirs) toast({ title: 'Some cards are only partly simulated', body: `${mine} in your deck, ${theirs} in ${decks.slice(1).map(d => d.name).join(' and ')}. The engine notes each one in the log when it matters.`, kind: 'note', ttl: 9000 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, decks, gameId]);

  // ---- undo refusals surface as a toast with the worker's reason
  useEffect(() => { if (undoRefused) toast({ title: 'Cannot undo', body: undoRefused.reason, kind: 'warn', ttl: 4500 }); }, [undoRefused]);

  const objects = useMemo(() => indexObjects(view), [view]);
  const myId: PlayerId = view?.viewer ?? 0;
  const me = view ? meOf(view) : null;
  const opps = useMemo(() => (view ? oppsOf(view) : []), [view]);
  const thinking = status === 'running' && !decision;
  const narration = useMemo(() => {
    for (let i = log.length - 1; i >= 0 && i > log.length - 40; i--) if (log[i].kind === 'ai') return log[i].line.replace(/^\s*\[[^\]]+ thinks\]\s*/, '');
    return reasoning.length ? reasoning[reasoning.length - 1].summary : null;
  }, [log, reasoning]);
  const decisionText = decision ? describeDecision(decision.decision) : '';
  /** Screen-reader narration: the event line the table has just played, then what is being asked for. */
  const pnameOf = useCallback((p: PlayerId) => view?.players[p]?.name ?? `Player ${p + 1}`, [view]);
  const lastEventLine = useMemo(() => {
    const i = playback.cursor - eventBase - 1;
    const ev = i >= 0 && i < events.length ? events[i] : null;
    return ev ? describeEvent(ev, pnameOf) : '';
  }, [events, eventBase, playback.cursor, pnameOf]);
  const nonPriorityDecision = decision && decision.decision.kind !== 'priority' && decision.decision.kind !== 'attackers' && decision.decision.kind !== 'blockers' ? decision.decision : null;
  /** Table interaction is only meaningful once the shown view is the decision's view. */
  const interactive = settled && status === 'running' && !playback.paused;
  const hints: IllegalHint[] | undefined = decision?.decision.kind === 'priority' ? decision.decision.illegal : undefined;
  const nameOf = useCallback((id: number): string | null => {
    const o = objects.get(id); if (o) return o.name;
    for (const p of view?.players ?? []) { const c = p.command.find(x => x.id === id); if (c) return c.name; }
    return null;
  }, [objects, view]);
  /** Where a commander that is not in its zone currently is. */
  const whereIs = useCallback((id: number): string | null => {
    if (!view) return null;
    for (const p of view.players) {
      if (p.battlefield.some(o => o.id === id)) return 'on the battlefield';
      if (p.graveyard.some(o => o.id === id)) return 'in the graveyard';
      if (p.exile.some(o => o.id === id)) return 'in exile';
      if (p.hand?.some(o => o.id === id)) return 'in hand';
    }
    if (view.stack.some(s => s.sourceId === id)) return 'on the stack';
    return null;
  }, [view]);

  // ---- drag and drop: plans come from @play/targeting, effects go back into the interaction hook
  const [choice, setChoice] = useState<{ card: CardView; actions: LegalAction[]; at: { x: number; y: number } } | null>(null);
  useEffect(() => { setChoice(null); }, [decision]);
  const dragCtx = useMemo<DragContext | null>(() => (liveView ? { mode: ix.dragMode, view: liveView, me: myId } : null), [ix.dragMode, liveView, myId]);
  const dragRef = useRef({ ctx: dragCtx, mode: ix.mode.kind, status, blocked: !!nonPriorityDecision, objects, interactive, hints });
  dragRef.current = { ctx: dragCtx, mode: ix.mode.kind, status, blocked: !!nonPriorityDecision, objects, interactive, hints };
  const planFor = useCallback((source: DragSource): DragPlan | null => {
    const { ctx, mode: mk, status: st, blocked, objects: objs, interactive: ok } = dragRef.current;
    if (!ctx || st !== 'running' || blocked || !ok || mk === 'x' || mk === 'armed' || mk === 'pay') return null;
    if (source.kind === 'permanent') { const p = objs.get(source.id) as PermanentView | undefined; if (!p || !('controller' in p) || p.controller !== ctx.me) return null; }
    if (source.kind === 'command' && !ctx.view.players[ctx.me].command.some(c => c.id === source.cardId)) return null;
    return planDrag(source, ctx);
  }, []);
  const onDrop = useCallback((plan: DragPlan, _zone: DropZone, effect: Exclude<DropEffect, { kind: 'none' }>, point: { x: number; y: number }) => {
    switch (effect.kind) {
      case 'begin': {
        if (plan.choices && plan.choices.length > 1) { const card = objects.get(sourceIdOf(plan.source)) ?? liveView?.players[myId].command.find(c => c.id === sourceIdOf(plan.source)); if (card) { setChoice({ card, actions: plan.choices, at: point }); return; } }
        vibrate(HAPTIC.cast);
        if (effect.pick) ix.beginWithPick(effect.legal, effect.pick);
        else if (effect.paySource !== undefined) ix.beginLegal(effect.legal, { source: effect.paySource, force: true });
        else ix.beginLegal(effect.legal);
        return;
      }
      case 'pick': ix.pickRef(effect.ref); return;
      case 'attack': ix.setAttacking(effect.id, true, effect.target); return;
      case 'unattack': ix.setAttacking(effect.id, false); return;
      case 'block': ix.setBlock(effect.blocker, effect.attacker); return;
      case 'unblock': ix.clearBlock(effect.blocker); return;
    }
  }, [ix, objects, liveView, myId]);
  // Snap-back toasts prefer the engine's own reason for the card (decision.illegal) over the client heuristic.
  const onIllegal = useCallback((plan: DragPlan, _zone: DropZone, reason: IllegalReason) => {
    const hint = dragRef.current.hints?.find(h => h.id === sourceIdOf(plan.source));
    const r = hint?.reasons[0];
    const text = r && plan.illegal ? `${r.text.replace(/\.$/, '')} (CR ${r.rule})` : reason.text;
    toast({ title: text, kind: 'warn', ttl: 4500 });
  }, []);
  const drag = useDragIntent({ planFor, onDrop, onIllegal, reducedMotion });
  const drops = useMemo(() => {
    const out = { bf: new Set<PlayerId>(), players: new Set<PlayerId>(), objects: new Set<number>(), stack: new Set<number>(), willTap: new Set<number>() };
    if (drag.phase !== 'dragging' || !drag.plan) return out;
    for (const { zone, effect } of drag.plan.zones) {
      if (zone.kind === 'battlefield') out.bf.add(zone.player); else if (zone.kind === 'player') out.players.add(zone.id); else if (zone.kind === 'object') out.objects.add(zone.id); else if (zone.kind === 'stack') out.stack.add(zone.id);
      // the lands the engine would tap for the spell being dragged get a dashed rim
      if (effect.kind === 'begin' && effect.paySource === undefined && effect.legal.pay) for (const t of effect.legal.pay.taps) out.willTap.add(t.id);
    }
    return out;
  }, [drag.phase, drag.plan]);
  const overIs = useCallback((z: DropZone) => !!drag.over && sameZone(drag.over, z), [drag.over]);
  const liftedId = drag.phase !== 'idle' && drag.phase !== 'pending' && drag.ghost ? sourceIdOf(drag.ghost.source) : null;
  // The spell being cast from hand (or the command zone) sits in the casting slot while its targets are chosen; a tether runs from there.
  const slotCard = useMemo<CardView | null>(() => {
    if (ix.mode.kind !== 'targeting' || ix.sourceId == null || ix.mode.st.legal.action.type !== 'cast') return null;
    return me?.hand?.find(c => c.id === ix.sourceId) ?? me?.command.find(c => c.id === ix.sourceId) ?? null;
  }, [ix.mode, ix.sourceId, me]);
  const tether = useMemo(() => (ix.mode.kind === 'targeting' && ix.sourceId != null ? { from: slotCard ? '[data-cast-slot]' : `[data-obj-id="${ix.sourceId}"]`, rootRef, tone: 'brass' as const } : null), [ix.mode.kind, ix.sourceId, slotCard]);

  // ---- hover inspector (350 ms hover intent on any table card; closes on pointer-down so drags never start under it)
  const [inspect, setInspect] = useState<{ id: number; el: HTMLElement } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const overInspector = useRef(false);
  const clearTimers = () => { if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null; } if (leaveTimer.current) { clearTimeout(leaveTimer.current); leaveTimer.current = null; } };
  const cardElOf = (t: EventTarget | null): HTMLElement | null => { const el = (t as HTMLElement | null)?.closest?.('[data-obj-id]') as HTMLElement | null; return el && el.dataset.objId && tableRef.current?.contains(el) && el.offsetWidth > 4 ? el : null; };
  const onTablePointerOver = (e: ReactPointerEvent) => {
    if (e.pointerType === 'touch') return;
    const el = cardElOf(e.target); if (!el) return;
    const id = Number(el.dataset.objId);
    if (leaveTimer.current) { clearTimeout(leaveTimer.current); leaveTimer.current = null; }
    if (inspect?.id === id) return;
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => { hoverTimer.current = null; setInspect({ id, el }); }, HOVER_INTENT_MS);
  };
  const onTablePointerOut = (e: ReactPointerEvent) => {
    const el = cardElOf(e.target); if (!el) return;
    const rel = e.relatedTarget as Node | null;
    if (rel && el.contains(rel)) return;
    if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null; }
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => { leaveTimer.current = null; if (!overInspector.current) setInspect(null); }, 160);
  };
  const closeInspector = useCallback(() => { clearTimers(); overInspector.current = false; setInspect(null); }, []);
  // Any pointer-down on the table closes the inspector (so drags never start under it); clicks inside it are its own.
  const onRootPointerDown = useCallback((e: ReactPointerEvent) => { if ((e.target as HTMLElement | null)?.closest?.('[data-inspector]')) return; closeInspector(); }, [closeInspector]);
  useEffect(() => { if (drag.phase !== 'idle') closeInspector(); }, [drag.phase, closeInspector]);
  useEffect(() => () => clearTimers(), []);
  const inspectCard = inspect ? objects.get(inspect.id) ?? me?.command.find(c => c.id === inspect.id) ?? null : null;
  const inspectMine = !!inspectCard && (('controller' in inspectCard) ? (inspectCard as PermanentView).controller === myId : !!me?.hand?.some(c => c.id === inspectCard.id) || !!me?.command.some(c => c.id === inspectCard.id));
  const inspectActions = useMemo(() => (inspectCard && interactive ? ix.legal.filter(l => (l.action.type === 'play-land' && l.action.cardId === inspectCard.id) || (l.action.type === 'cast' && l.action.cardId === inspectCard.id) || (l.action.type === 'activate' && l.action.objectId === inspectCard.id)) : []), [inspectCard, interactive, ix.legal]);

  // ---- tutorial spotlights
  useEffect(() => {
    if (!decision || !settled) return;
    if (decision.decision.kind === 'priority') tut.trigger('priority');
    else if (decision.decision.kind === 'attackers' || decision.decision.kind === 'blockers') tut.trigger('combat');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decision, settled]);
  const tutTrigger = tut.trigger;
  useEffect(() => { if (drag.phase === 'dragging') tutTrigger('drag'); }, [drag.phase, tutTrigger]);
  const stackLen = view?.stack.length ?? 0;
  useEffect(() => { if (stackLen > 0) tutTrigger('stack'); }, [stackLen, tutTrigger]);
  useEffect(() => { if (fx.trigger) tutTrigger('trigger'); if (fx.death) tutTrigger('sba'); }, [fx.key, fx.trigger, fx.death, tutTrigger]);

  // ---- haptics: damage that lands on the viewer, and the end of the game
  const viewerId: PlayerId = liveView?.viewer ?? view?.viewer ?? 0;
  useEffect(() => {
    if (fx.pops.some(p => p.target.kind === 'player' && p.target.id === viewerId && (p.tone === 'damage' || p.tone === 'loss'))) vibrate(HAPTIC.damage);
  }, [fx.key, fx.pops, viewerId]);
  useEffect(() => { if (status === 'finished') vibrate(HAPTIC.gameOver); }, [status]);

  // ---- phase strip: pass until a later step of my turn (one-shot stop, restored at the next decision)
  const skipTo = useCallback((_step: Step, key: keyof StopPolicy) => {
    if (!interactive || !ix.isPriority || ix.mode.kind !== 'idle') return;
    const policy: StopPolicy = { ...stops };
    for (const k of OWN_STOP_KEYS) policy[k] = k === key;
    oneShot.current = true;
    setStopsRemote(policy);
    ix.pass();
  }, [interactive, ix, stops, setStopsRemote]);

  // ---- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (e.key === '?' && !typing) { e.preventDefault(); setHelp(h => !h); return; }
      if (e.key === 'Escape') { if (inspect) closeInspector(); if (ix.mode.kind !== 'idle' || ix.menuCard !== null) { e.preventDefault(); ix.cancel(); } return; }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'z' || e.key === 'Z') && !typing) { e.preventDefault(); if (status === 'running' && liveView?.viewer !== null) undo(); return; }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === ' ' && !(t && t.getAttribute('role') === 'button')) { e.preventDefault(); if (interactive) ix.pass(); return; }
      if (e.key === 'Enter' && ix.mode.kind !== 'idle' && ix.mode.kind !== 'x' && !(t && (t.tagName === 'BUTTON' || t.getAttribute('role') === 'button'))) { e.preventDefault(); if (interactive) ix.confirm(); return; }
      if (e.key === 'l' || e.key === 'L') { e.preventDefault(); if (isMobile) setSheet(s => s === 'log' ? null : 'log'); else togglePanel('log'); return; }
      if (e.key === 'p' || e.key === 'P') { e.preventDefault(); if (isMobile) setSheet(s => s === 'analysis' ? null : 'analysis'); else togglePanel('analysis'); return; }
      if (e.key === 'e' || e.key === 'E') { e.preventDefault(); setExplain(!playback.explain); return; }
      const n = Number(e.key);
      if (n >= 1 && n <= 9) {
        if (!interactive) return;
        if (ix.mode.kind === 'targeting') { const o = ix.requirement?.options[n - 1]; if (o) { e.preventDefault(); ix.pickRef(o); } }
        else if (ix.mode.kind === 'attackers') { const id = ix.mode.candidates[n - 1]; if (id !== undefined) { e.preventDefault(); ix.onObjectClick(id); } }
        else if (ix.mode.kind === 'idle' && !nonPriorityDecision) { e.preventDefault(); ix.pickNumbered(n); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ix, isMobile, togglePanel, nonPriorityDecision, interactive, playback.explain, setExplain, inspect, closeInspector, undo, status, liveView?.viewer]);

  // ---- per-card interaction state
  const pulseObjects = useMemo(() => new Set(pulse?.objects ?? EMPTY_IDS), [pulse]);
  const fxSets = useMemo(() => ({ glow: new Set(fx.glow), dying: new Set(fx.dying), hits: new Set(fx.hits), moving: new Set(fx.moving) }), [fx]);
  const payMode = ix.mode.kind === 'pay' ? ix.mode : null;
  const cardState = useCallback((id: number): TableCardProps['state'] => {
    const m = ix.mode;
    const legal = interactive && (m.kind === 'targeting' ? ix.targets!.objects.has(id) : m.kind === 'attackers' ? m.candidates.includes(id) : m.kind === 'blockers' ? (m.candidates.includes(id) || (m.selected !== null && m.attackers.includes(id))) : false);
    const pickedNow = ix.picked.objects.has(id) || (m.kind === 'attackers' && m.decl.attackers.includes(id)) || (m.kind === 'blockers' && m.decl.blocks.some(b => b.blocker === id || b.attacker === id));
    const perm = objects.get(id);
    const attacking = !!perm && 'attacking' in perm && (perm as { attacking: PlayerId | null }).attacking !== null;
    const blocking = !!perm && 'blocking' in perm && (perm as { blocking: number[] }).blocking.length > 0;
    const payCandidate = !!payMode && !!perm && 'controller' in perm && (perm as PermanentView).controller === myId && !(perm as PermanentView).tapped && isManaSource(perm);
    return {
      castable: interactive && m.kind === 'idle' && ix.isPriority && ix.playable.has(id),
      legalTarget: legal,
      dimmed: (m.kind === 'targeting' && !legal && id !== ix.sourceId && !ix.picked.objects.has(id)) || (m.kind === 'armed' && !ix.picked.objects.has(id)),
      picked: pickedNow, hovered: ix.hover.objects.has(id), selected: m.kind === 'blockers' && m.selected === id, source: ix.sourceId === id,
      attacking: attacking || (m.kind === 'attackers' && m.decl.attackers.includes(id)), blocking,
      dropTarget: drops.objects.has(id), dropOver: overIs({ kind: 'object', id }), lifted: liftedId === id || slotCard?.id === id,
      willTap: drops.willTap.has(id), paySource: !!payMode && payMode.sources.includes(id), payCandidate: payCandidate && !payMode!.sources.includes(id),
      glow: fxSets.glow.has(id), dying: fxSets.dying.has(id), hit: fxSets.hits.has(id), moving: fxSets.moving.has(id), pulsed: pulseObjects.has(id),
    };
  }, [ix, objects, drops, overIs, liftedId, slotCard, interactive, fxSets, pulseObjects, payMode, myId]);
  const actionsFor = useCallback((id: number) => (interactive ? ix.legal.filter(l => (l.action.type === 'play-land' && l.action.cardId === id) || (l.action.type === 'cast' && l.action.cardId === id) || (l.action.type === 'activate' && l.action.objectId === id)) : []), [ix.legal, interactive]);
  const onMenuOpenChange = useCallback((id: number, open: boolean) => ix.setMenuCard(open ? id : null), [ix]);
  const onOpenZone = useCallback((pid: PlayerId, z: 'graveyard' | 'exile' | 'command') => setZone({ pid, zone: z }), []);
  const openSeatBattlefield = useCallback((pid: PlayerId) => setBfSeat(pid), []);
  const onObjectClick = useCallback((id: number) => { if (dragRef.current.interactive) ix.onObjectClick(id); }, [ix]);
  const onPlayerClick = useCallback((pid: PlayerId) => { if (dragRef.current.interactive) ix.onPlayerClick(pid); }, [ix]);
  const onStackClick = useCallback((sid: number) => { if (dragRef.current.interactive) ix.onStackClick(sid); }, [ix]);

  // ---- connectors for the SVG overlay
  const connectors = useMemo<Connector[]>(() => {
    const out: Connector[] = [];
    if (!view) return out;
    for (const it of view.stack) for (const t of it.targets) out.push({ from: { kind: 'stack', id: it.id }, to: t, tone: 'brass' });
    for (const p of view.players) for (const perm of p.battlefield) {
      if (perm.attacking !== null && view.step !== 'combat-end') out.push({ from: { kind: 'object', id: perm.id }, to: perm.attackingPlaneswalker != null ? { kind: 'object', id: perm.attackingPlaneswalker } : { kind: 'player', id: perm.attacking }, tone: 'danger' });
      for (const a of perm.blocking) out.push({ from: { kind: 'object', id: perm.id }, to: { kind: 'object', id: a }, tone: 'info' });
    }
    const m = ix.mode;
    if (m.kind === 'blockers') for (const b of m.decl.blocks) out.push({ from: { kind: 'object', id: b.blocker }, to: { kind: 'object', id: b.attacker }, tone: 'info' });
    if (m.kind === 'attackers') {
      const fallback = dragCtx ? defaultDefender(dragCtx) : null;
      for (const id of m.decl.attackers) {
        const t = m.decl.targets?.[id];
        const to: TargetRef | null = t !== undefined ? (typeof t === 'number' ? { kind: 'player', id: t } : { kind: 'object', id: t.planeswalker }) : fallback !== null ? { kind: 'player', id: fallback } : null;
        if (to) out.push({ from: { kind: 'object', id }, to, tone: 'danger' });
      }
    }
    if ((m.kind === 'targeting') && ix.sourceId != null) for (const group of [...m.st.picks, m.st.current]) for (const t of group) out.push({ from: { kind: 'object', id: ix.sourceId }, to: t, tone: 'brass' });
    if (m.kind === 'armed' && (m.action.type === 'cast' || m.action.type === 'activate')) { const src = m.action.type === 'cast' ? m.action.cardId : m.action.objectId; for (const t of (m.action.targets ?? []).flat()) out.push({ from: { kind: 'object', id: src }, to: t as TargetRef, tone: 'brass' }); }
    if (m.kind === 'pay') for (const t of (m.action.targets ?? []).flat()) out.push({ from: { kind: 'object', id: m.action.cardId }, to: t as TargetRef, tone: 'brass' });
    return out;
  }, [view, ix.mode, ix.sourceId, dragCtx]);

  const rematch = useCallback(() => { if (decks && options) void start(gameId, decks, options); }, [decks, options, start, gameId]);
  const legalPlayers = interactive && ix.mode.kind === 'targeting' ? ix.targets!.players : null;
  const layoutKey = fx.key;
  const names = useMemo(() => (view ? view.players.map(p => p.name) : []), [view]);

  // ---- boot states
  if (boot === 'missing') {
    return <div className="container" style={{ paddingBlock: 48 }}><EmptyState title="No table to restore" actions={<Button variant="primary" onClick={() => undefined}><Link href="/play">Set up a game</Link></Button>}>This game id has no setup in this browser session, so it cannot be re-dealt.</EmptyState></div>;
  }
  if (boot === 'failed' || status === 'error') {
    return <div className="container" style={{ paddingBlock: 48 }}><Callout variant="danger" title="The table could not be set up">{bootError ?? error}</Callout><p style={{ marginTop: 16 }}><Link className="link" href="/play">Back to setup</Link></p></div>;
  }
  if (!view || !me || !opps.length || !liveView) {
    return (
      <div className={styles.shell} aria-busy="true">
        <div className={styles.table}><div className={styles.booting}><Skeleton height={120} /><Skeleton height={40} width="60%" /><Skeleton height={160} /><span className="faint small">Shuffling and building the analysis pool…</span></div></div>
      </div>
    );
  }

  const myTurn = view.activePlayer === myId;
  const activeName = view.players[view.activePlayer]?.name ?? 'Opponent';
  const humanSeat = liveView.viewer !== null;
  const analysisPanel = (
    <AnalysisPanel report={analysis} phase={analysisPhase} reruns={reruns} seed={options?.seed ?? 0} enabled={!!options?.analysis.enabled} interactive={interactive && ix.isPriority && ix.mode.kind === 'idle'}
      onDeepen={policy => deepen(400, policy)} onRerun={rerun} onHover={ix.setHoverAction} onArm={ix.armPlay} onUse={ix.usePlay} objects={objects} view={liveView} />
  );
  const explainPanel = <ExplainPanel events={events} eventBase={eventBase} cursor={playback.cursor} view={liveView} explain={playback.explain} onToggleExplain={setExplain} onShowMe={showMe} />;
  const timelinePanel = <Timeline events={events} eventBase={eventBase} cursor={playback.cursor} paused={playback.paused} settled={settled} decisionPending={!!decision} view={liveView} onScrub={scrubTo} onPause={pauseQueue} onPlay={playQueue} onLive={goLive} />;
  const rail = (
    <div className={styles.rail} data-testid="right-rail" data-rail={panels.rail}>
      <Tabs value={panels.rail} onChange={setRail} label="Right rail" className={styles.railTabs} idBase="rail" items={[{ value: 'analysis', label: 'Analysis' }, { value: 'explain', label: 'Explain' }, { value: 'timeline', label: 'Timeline' }]} />
      <div className={styles.railPane} role="tabpanel" id={`rail-panel-${panels.rail}`} aria-labelledby={`rail-tab-${panels.rail}`} tabIndex={0}>{panels.rail === 'analysis' ? analysisPanel : panels.rail === 'explain' ? explainPanel : timelinePanel}</div>
    </div>
  );
  const logPanel = <LogPanel log={log} />;
  const canPass = interactive && ix.isPriority && ix.mode.kind === 'idle';
  const pod = opps.length > 1;

  const plateProps = (p: PlayerView) => ({
    active: view.activePlayer === p.id, hasPriority: view.priority === p.id, thinking: thinking && status === 'running' && (view.priority === p.id || (opps.length === 1)),
    legalTarget: !!legalPlayers?.has(p.id), picked: ix.picked.players.has(p.id), hovered: ix.hover.players.has(p.id), dimmed: ix.mode.kind === 'targeting' && !legalPlayers?.has(p.id),
    onClick: onPlayerClick, onOpenZone, nameOf,
    dropTarget: drops.players.has(p.id), dropOver: overIs({ kind: 'player', id: p.id }), pulsed: !!pulse?.players.includes(p.id), layoutKey, reducedMotion,
  });
  const bfSeatPlayer = bfSeat !== null ? view.players[bfSeat] ?? null : null;

  return (
    <div ref={rootRef} className={clsx(styles.shell, panels.log && !isMobile && styles.shellLog, panels.analysis && !isMobile && styles.shellAnalysis, ix.mode.kind === 'targeting' && styles.shellTargeting)}
      data-testid="play-table" data-status={status} data-settled={settled ? 'true' : 'false'} data-cursor={playback.cursor} data-paused={playback.paused ? 'true' : undefined} data-seats={view.players.length}
      onPointerDownCapture={onRootPointerDown}>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="table-announcer">
        Turn {view.turn}, {myTurn ? 'your' : `${activeName}'s`} turn, {STEP_LABELS[view.step]}.
        {lastEventLine ? ` ${lastEventLine}.` : ''}
        {status === 'finished' ? ' The game is over.' : decisionText ? ` ${decisionText}.` : thinking ? ` Waiting for ${activeName}.` : ''}
      </div>

      {!isMobile && panels.log && <aside className={styles.logRail} aria-label="Log rail">{logPanel}</aside>}

      <div ref={tableRef} className={clsx(styles.table, pod && styles.tableRing)} onPointerOver={onTablePointerOver} onPointerOut={onTablePointerOut}>
        <TargetArrows rootRef={rootRef} connectors={connectors} version={`${view.logLength}:${layoutKey}`} />
        <NumberPops fx={fx} rootRef={tableRef} reducedMotion={reducedMotion} />
        <EventChips fx={fx} rootRef={tableRef} explain={playback.explain} reducedMotion={reducedMotion} />
        <TurnBanner fx={fx} viewer={myId} names={names} reducedMotion={reducedMotion} />

        <section className={clsx(styles.oppZone, pod && styles.oppZonePod)} aria-label={pod ? 'Opponents' : `${opps[0].name}'s side`}>
          <SeatRing opponents={opps}>
            {p => (
              <Seat key={p.id} player={p} seats={opps.length} isMobile={isMobile} cardState={cardState} onActivate={onObjectClick} whereIs={whereIs} onExpand={isMobile ? openSeatBattlefield : undefined}
                plate={plateProps(p)}
                battlefield={{ cardState, onActivate: onObjectClick, dropTarget: drops.bf.has(p.id), dropOver: overIs({ kind: 'battlefield', player: p.id }), layoutKey, reducedMotion }} />
            )}
          </SeatRing>
        </section>

        <section className={styles.mid} aria-label="Turn, stack and priority">
          <div className={styles.phaseRow}>
            <PhaseStrip step={view.step} turn={view.turn} myTurn={myTurn} stops={stops} onToggleStop={toggleStop} onSkipTo={skipTo} canSkip={canPass && !undoing} />
            {!isMobile && <PlaybackBar playback={playback} settled={settled} pending={Math.max(0, eventBase + events.length - playback.cursor)} onSpeed={changeSpeed} onSkip={skip} onExplain={setExplain} onOpenSettings={() => setSettingsOpen(true)} />}
          </div>
          <div className={styles.midRow}>
            <StackColumn stack={view.stack} viewer={myId} legalStack={interactive ? ix.targets?.stack ?? null : null} dimOthers={ix.mode.kind === 'targeting'} onClick={onStackClick} dropStack={drops.stack} dropOver={drag.over?.kind === 'stack' ? drag.over.id : null} glowId={fx.stackGlow} layoutKey={layoutKey} reducedMotion={reducedMotion} />
            <div className={styles.midRight}>
              <PriorityBar hasDecision={!!decision} decisionText={decisionText} thinking={thinking} narration={narration} numbered={canPass ? ix.numbered : []} onPick={ix.beginLegal} onPass={ix.pass} onConcede={concede} canPass={canPass} stackSize={view.stack.length} finished={status === 'finished'} settled={settled && !playback.paused}
                undo={undoAvailable} undoing={undoing} onUndo={humanSeat ? undo : undefined} />
              {interactive && payMode && <PayTray action={payMode.action} legal={payMode.legal} sources={payMode.sources} me={liveView.players[myId]} cardName={objects.get(payMode.action.cardId)?.name ?? me.command.find(c => c.id === payMode.action.cardId)?.name ?? 'Spell'} onToggle={ix.togglePaySource} onReset={ix.setPaySources} onConfirm={ix.confirm} onCancel={ix.cancel} />}
              {interactive && !payMode && <ActionBar ix={ix} view={liveView} objects={objects} />}
            </div>
          </div>
        </section>

        <section className={styles.myZone} aria-label="Your side">
          <Battlefield permanents={me.battlefield} mine player={myId} cardWidth={isMobile ? 64 : 84} cardState={cardState} onActivate={onObjectClick} actionsFor={actionsFor} menuCard={ix.menuCard} onMenuOpenChange={onMenuOpenChange} onPickAction={ix.beginLegal}
            bindDrag={drag.bind} dropTarget={drops.bf.has(myId)} dropOver={overIs({ kind: 'battlefield', player: myId })} layoutKey={layoutKey} reducedMotion={reducedMotion} />
          {slotCard && <CastingSlot card={slotCard} label={ix.requirement ? `choose ${ix.requirement.optional ? 'up to ' : ''}${ix.requirement.count} ${ix.requirement.spec}` : 'choose targets'} bind={drag.bind} onCancel={ix.cancel} width={isMobile ? 72 : 96} />}
          <div className={styles.myBottom}>
            <div className={styles.mySeat}>
              <PlayerPlate {...plateProps(me)} player={me} isMe thinking={false} />
              {me.commanders?.length > 0 && <CommandZone player={me} mine cardWidth={isMobile ? 48 : 56} cardState={cardState} onActivate={onObjectClick} bindDrag={drag.bind} whereIs={whereIs} layoutKey={layoutKey} reducedMotion={reducedMotion} />}
            </div>
            <Hand cards={me.hand ?? []} cardState={cardState} onActivate={onObjectClick} actionsFor={actionsFor} menuCard={ix.menuCard} onMenuOpenChange={onMenuOpenChange} onPickAction={ix.beginLegal} compact={isMobile} bindDrag={drag.bind} layoutKey={layoutKey} reducedMotion={reducedMotion} />
            <div className={styles.tableTools}>
              {isMobile ? (
                <>
                  <IconButton label="Log" onClick={() => setSheet('log')} data-testid="mobile-log"><ScrollText size={16} /></IconButton>
                  <IconButton label="Analysis, explain and timeline" onClick={() => setSheet('analysis')} data-testid="mobile-rail"><FlaskConical size={16} /></IconButton>
                  <IconButton label="Table settings" onClick={() => setSettingsOpen(true)} data-testid="table-settings-button"><Settings2 size={16} /></IconButton>
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
          {nonPriorityDecision && <DecisionSheet decision={nonPriorityDecision} view={liveView} objects={objects} onAnswer={answer} />}
        </section>

        <TutorialTip step={tut.active} rootRef={tableRef} hidden={drag.phase !== 'idle' && tut.active !== 'drag'} onDismiss={tut.dismiss} onOff={() => tut.setOff(true)} />
        {status === 'finished' && settled && <GameOver onRematch={rematch} />}
      </div>

      {!isMobile && panels.analysis && <aside className={styles.analysisRail} aria-label="Analysis">{rail}</aside>}
      {isMobile && <Drawer open={sheet === 'analysis'} onClose={() => setSheet(null)} side="bottom" title="Analysis, explain and timeline" className={styles.railSheet} testId="rail-sheet">{rail}</Drawer>}
      {isMobile && <Drawer open={sheet === 'log'} onClose={() => setSheet(null)} side="bottom" title="Log" testId="log-sheet">{logPanel}</Drawer>}
      {isMobile && (
        <Drawer open={bfSeatPlayer !== null} onClose={() => setBfSeat(null)} side="bottom" title={bfSeatPlayer ? `${bfSeatPlayer.name}'s battlefield` : ''} testId="seat-sheet">
          {bfSeatPlayer && <Battlefield permanents={bfSeatPlayer.battlefield} mine={false} player={bfSeatPlayer.id} cardWidth={72} cardState={cardState} onActivate={onObjectClick} layoutKey={layoutKey} reducedMotion={reducedMotion} />}
        </Drawer>
      )}

      <ZoneDrawer open={!!zone} onClose={() => setZone(null)} title={zone ? `${view.players[zone.pid].name} · ${zone.zone}` : ''} cards={zone ? view.players[zone.pid][zone.zone] : []} />
      <ShortcutsSheet open={help} onClose={() => setHelp(false)} />
      <TableSettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} settings={settings} onChange={changeSettings} tutorialOff={tut.state.off} onTutorialOff={tut.setOff} onResetTutorial={tut.reset} glQuality={gl?.quality} systemReducedMotion={systemReducedMotion} onPreviewSound={previewSound} />
      {choice && <ActionsPopover title={choice.card.name} manaCost={choice.card.manaCost} actions={choice.actions} at={choice.at} onPick={l => { setChoice(null); ix.beginLegal(l); }} onClose={() => setChoice(null)} testId="drop-choice" />}
      <DragLayer drag={drag} tether={tether} reducedMotion={reducedMotion} />
      {drag.phase === 'idle' && (
        <HoverInspector card={inspectCard} anchor={inspect?.el ?? null} dragCtx={dragCtx} hints={hints} actions={inspectActions} mine={inspectMine}
          onPointerEnter={() => { overInspector.current = true; if (leaveTimer.current) { clearTimeout(leaveTimer.current); leaveTimer.current = null; } }}
          onPointerLeave={() => { overInspector.current = false; leaveTimer.current = setTimeout(() => setInspect(null), 160); }} />
      )}
    </div>
  );
}
