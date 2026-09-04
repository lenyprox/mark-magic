'use client';
// The explain rail: one card per game event in plain words, a rule chip for the Comprehensive Rules paragraph it
// follows, and "Show me", which pulses the objects and players involved on the table.
import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { ArrowDownToLine, Crosshair, Eye, Flame, Heart, Layers, Play, Shield, Sparkles, Swords, Undo2, Zap, Hourglass, Skull, Repeat, BookOpen, CircleDot } from 'lucide-react';
import type { GameEvent } from '@engine/events';
import type { PlayerId } from '@engine/state';
import type { ViewState } from '@play/view';
import { chipFor, classify, describeEvent, involvedInEvent, isExplainable } from '@play/anim';
import { Button } from '@/components/ui';
import { ATTRIBUTION, RuleChip } from '@/components/rules/RuleChip';
import { STEP_LABELS } from '@/lib/game/ui';
import styles from './table.module.css';

export interface ExplainPanelProps {
  events: GameEvent[];
  eventBase: number;
  cursor: number;
  view: ViewState;
  explain: boolean;
  onToggleExplain: (on: boolean) => void;
  onShowMe: (objects: number[], players: PlayerId[]) => void;
}

const PAGE = 250;

function Icon({ ev }: { ev: GameEvent }) {
  const size = 13;
  switch (classify(ev)) {
    case 'draw': return <ArrowDownToLine size={size} aria-hidden />;
    case 'play': case 'enter': case 'token': return <Play size={size} aria-hidden />;
    case 'cast': case 'activate': return <Sparkles size={size} aria-hidden />;
    case 'trigger': return <Zap size={size} aria-hidden />;
    case 'resolve': return <Layers size={size} aria-hidden />;
    case 'counter-spell': case 'fizzle': return <Undo2 size={size} aria-hidden />;
    case 'damage': return <Flame size={size} aria-hidden />;
    case 'life': return <Heart size={size} aria-hidden />;
    case 'death': case 'eliminated': return <Skull size={size} aria-hidden />;
    case 'attack': return <Swords size={size} aria-hidden />;
    case 'block': return <Shield size={size} aria-hidden />;
    case 'step': case 'turn': return <Hourglass size={size} aria-hidden />;
    case 'replaced': case 'prevented': return <Repeat size={size} aria-hidden />;
    case 'shuffle': return <BookOpen size={size} aria-hidden />;
    case 'tap': case 'mana-tap': case 'untap': return <CircleDot size={size} aria-hidden />;
    default: return <CircleDot size={size} aria-hidden />;
  }
}

export function ExplainPanel({ events, eventBase, cursor, view, explain, onToggleExplain, onShowMe }: ExplainPanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [page, setPage] = useState(1);
  const pname = useMemo(() => (p: PlayerId) => view.players[p]?.name ?? `Player ${p + 1}`, [view]);
  const rows = useMemo(() => {
    const out: { ev: GameEvent; index: number }[] = [];
    for (let i = 0; i < events.length; i++) if (isExplainable(events[i])) out.push({ ev: events[i], index: eventBase + i });
    return out;
  }, [events, eventBase]);
  const shown = rows.slice(Math.max(0, rows.length - PAGE * page));
  useEffect(() => { const el = ref.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [rows.length, page]);
  const onScroll = () => { const el = ref.current; if (!el) return; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; };
  let lastTurn = -1;
  return (
    <section className={styles.explain} data-testid="explain-panel" aria-label="Explain">
      <div className={styles.railHead}>
        <span className={styles.railTitle}>Explain</span>
        <span className="faint small">{rows.length} events</span>
        <label className={styles.explainToggle} title="Inline rule chips next to animations, at half speed (E)">
          <input type="checkbox" checked={explain} onChange={e => onToggleExplain(e.target.checked)} data-testid="explain-toggle" />
          <span>inline chips</span>
        </label>
      </div>
      <div ref={ref} className={styles.explainBody} onScroll={onScroll} role="feed" aria-busy={false}>
        {rows.length > shown.length && <Button size="sm" variant="quiet" onClick={() => setPage(p => p + 1)} className={styles.explainMore}>Show earlier events</Button>}
        {shown.map(({ ev, index }) => {
          const turnHead = ev.turn !== lastTurn; lastTurn = ev.turn;
          const cr = chipFor(ev);
          const inv = involvedInEvent(ev);
          const kind = classify(ev);
          const future = index >= cursor;
          return (
            <div key={ev.seq}>
              {turnHead && <div className={styles.logTurn}>{ev.turn === 0 ? 'Before the game' : `Turn ${ev.turn}`}</div>}
              <article className={clsx(styles.evCard, styles[`ev_${kind}` as keyof typeof styles], future && styles.evFuture, ev.type === 'step' && styles.evStep)} data-testid="explain-event" data-seq={ev.seq} data-kind={ev.type}>
                <span className={styles.evIcon}><Icon ev={ev} /></span>
                <div className={styles.evBody}>
                  <p className={styles.evText}>{describeEvent(ev, pname)}</p>
                  <div className={styles.evMeta}>
                    <span className={styles.evStepTag} aria-hidden>{STEP_LABELS[ev.step] ?? ev.step}</span>
                    {cr && <RuleChip cr={cr} size="sm" />}
                    {(inv.objects.length > 0 || inv.players.length > 0) && (
                      <button type="button" className={styles.showMe} onClick={() => onShowMe(inv.objects, inv.players)} title="Pulse the objects involved on the table" data-testid="show-me"><Eye size={11} aria-hidden /> Show me</button>
                    )}
                    {ev.type === 'cast' && ev.targets.length > 0 && <span className={styles.evTargets}><Crosshair size={10} aria-hidden /> {ev.targets.join(', ')}</span>}
                  </div>
                </div>
              </article>
            </div>
          );
        })}
        {!rows.length && <div className="faint small" style={{ padding: 12 }}>Events appear here as the game plays.</div>}
      </div>
      <footer className={styles.railFoot}>{ATTRIBUTION}</footer>
    </section>
  );
}
