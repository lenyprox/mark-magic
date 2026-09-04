'use client';
// Hover inspector for any card on the table (350 ms hover intent): image, oracle text, current P/T, counters and
// keywords, a Rulings tab (react-query, cached per oracle id) and a "Why?" tab that explains why a card in hand or
// a permanent has no legal action right now — from the engine's illegal hints when the decision carries them, else
// from the client-side heuristics in @play/targeting. It closes on any pointer-down so drags never start under it.
import { useEffect, useMemo, useState } from 'react';
import { autoUpdate, flip, FloatingPortal, offset, shift, useFloating } from '@floating-ui/react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import type { IllegalHint, LegalAction } from '@engine/state';
import type { CardView, PermanentView } from '@play/view';
import { whyNotPlayable, type DragContext, type IllegalReason } from '@play/targeting';
import { api } from '@/lib/api';
import { CardImage } from '@/components/card/CardImage';
import { OracleText } from '@/components/text/OracleText';
import { Tabs } from '@/components/ui';
import { RuleChip } from '@/components/rules/RuleChip';
import styles from './table.module.css';

export const HOVER_INTENT_MS = 350;

export interface HoverInspectorProps {
  card: CardView | PermanentView | null;
  anchor: HTMLElement | null;
  /** The drag context for the "Why?" heuristics (null when no decision is pending). */
  dragCtx: DragContext | null;
  /** Engine-provided reasons for the current priority decision. */
  hints: IllegalHint[] | undefined;
  /** Legal actions this card has right now (a card with actions needs no "why not"). */
  actions: LegalAction[];
  mine: boolean;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}

type Tab = 'card' | 'rulings' | 'why';

export function HoverInspector({ card, anchor, dragCtx, hints, actions, mine, onPointerEnter, onPointerLeave }: HoverInspectorProps) {
  const [tab, setTab] = useState<Tab>('card');
  const open = !!card && !!anchor;
  const { refs, floatingStyles } = useFloating({ open, placement: 'right-start', whileElementsMounted: autoUpdate, middleware: [offset(10), flip({ padding: 8 }), shift({ padding: 8 })], elements: { reference: anchor } });
  useEffect(() => { if (card?.isToken && tab === 'rulings') setTab('card'); }, [card, tab]);
  const perm = card && 'controller' in card ? (card as PermanentView) : null;
  const oracleId = card?.oracleId ?? null;
  const rulings = useQuery({ queryKey: ['card', oracleId], queryFn: ({ signal }) => api.card(oracleId!, signal), enabled: !!oracleId && tab === 'rulings', staleTime: 60 * 60_000 });
  const why = useMemo<{ reasons: { rule: string; text: string }[]; source: 'engine' | 'heuristic' | 'none'; playable: boolean } | null>(() => {
    if (!card) return null;
    if (actions.length) return { reasons: [], source: 'none', playable: true };
    const hint = hints?.find(h => h.id === card.id);
    if (hint?.reasons.length) return { reasons: hint.reasons.map(r => ({ rule: r.rule, text: r.text })), source: 'engine', playable: false };
    if (dragCtx && mine) { const r: IllegalReason | null = whyNotPlayable(card.id, dragCtx); if (r) return { reasons: [{ rule: r.rule, text: r.text.replace(/\s*\(CR [^)]+\)$/, '') }], source: 'heuristic', playable: false }; }
    return { reasons: [], source: 'none', playable: false };
  }, [card, actions, hints, dragCtx, mine]);
  if (!open || !card) return null;
  const pt = perm?.isCreature ? `${perm.curPower}/${perm.curToughness}` : card.power != null ? `${card.power}/${card.toughness}` : null;
  const counters = perm ? Object.entries(perm.counters) : [];
  const keywords = perm?.isCreature ? perm.curKeywords : card.keywords;
  const items: { value: Tab; label: string }[] = [{ value: 'card', label: 'Card' }];
  if (!card.isToken && oracleId) items.push({ value: 'rulings', label: 'Rulings' });
  items.push({ value: 'why', label: 'Why?' });
  return (
    <FloatingPortal>
      <div ref={refs.setFloating} style={floatingStyles} className={styles.inspector} data-testid="hover-inspector" data-inspector="" data-obj={card.id} role="dialog" aria-label={`${card.name || 'Card'} details`} onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>
        <div className={styles.inspectorTop}>
          {card.printingId ? <CardImage printingId={card.printingId} face={card.face} size="normal" alt="" className={styles.inspectorImg} /> : <div className={clsx(styles.inspectorImg, styles.inspectorImgEmpty)}>{card.name || 'Hidden card'}</div>}
          <div className={styles.inspectorHead}>
            <div className={styles.inspectorName}>{card.name || 'Unknown card'}{card.manaCost && <OracleText text={card.manaCost} symbolSize={12} className={styles.inspectorCost} />}</div>
            <div className={styles.inspectorType}>{card.typeLine}</div>
            <div className={styles.inspectorStats}>
              {pt && <span className={clsx(styles.stat, perm && perm.damage > 0 && styles.statDamaged)} title={perm && perm.damage > 0 ? `${perm.damage} damage marked` : undefined}>{pt}{perm && perm.damage > 0 ? ` · ${perm.damage} dmg` : ''}</span>}
              {perm?.tapped && <span className={styles.stat}>tapped</span>}
              {perm?.summoningSick && <span className={styles.stat}>summoning sick</span>}
              {perm?.attacking !== null && perm?.attacking !== undefined && <span className={clsx(styles.stat, styles.statDanger)}>attacking</span>}
              {(perm?.blocking.length ?? 0) > 0 && <span className={clsx(styles.stat, styles.statInfo)}>blocking</span>}
              {counters.map(([k, v]) => <span key={k} className={clsx(styles.stat, styles.statBrass)}>{v} {k}</span>)}
              {keywords.map(k => <span key={k} className={styles.stat}>{k}</span>)}
            </div>
          </div>
        </div>
        <Tabs value={tab} onChange={setTab} items={items} label="Card details" className={styles.inspectorTabs} />
        <div className={styles.inspectorBody}>
          {tab === 'card' && (card.text ? <OracleText text={card.text} symbolSize={12} className={styles.inspectorText} /> : <p className="faint small">{card.isToken ? 'A token with no rules text.' : 'No rules text.'}</p>)}
          {tab === 'card' && card.unparsed.length > 0 && <p className={clsx('faint', 'small', styles.inspectorNote)}>Not simulated: {card.unparsed.join(' · ')}</p>}
          {tab === 'rulings' && (
            rulings.isLoading ? <p className="faint small">Loading rulings…</p>
              : rulings.isError ? <p className="faint small">Rulings could not be loaded.</p>
              : (rulings.data?.rulings.length ?? 0) === 0 ? <p className="faint small">No rulings for this card.</p>
              : <ul className={styles.rulings} data-testid="rulings">{rulings.data!.rulings.map((r, i) => <li key={i}><span className={styles.rulingDate}>{r.publishedAt}</span><span>{r.comment}</span></li>)}</ul>
          )}
          {tab === 'why' && why && (
            <div className={styles.why} data-testid="why-tab" data-source={why.source}>
              {why.playable ? <p className={styles.whyOk}>{actions.length === 1 ? actions[0].label : `${actions.length} legal actions right now`}.</p>
                : why.reasons.length ? why.reasons.map((r, i) => <p key={i} className={styles.whyRow}><span>{r.text}</span>{r.rule && <RuleChip cr={r.rule} size="sm" />}</p>)
                : <p className="faint small">{!mine ? "This isn't your card." : dragCtx ? 'Nothing to do with this card right now.' : 'Wait for your priority to see what this card can do.'}</p>}
              {why.source === 'heuristic' && <p className="faint small">Reason inferred on the client (the engine did not say).</p>}
            </div>
          )}
        </div>
      </div>
    </FloatingPortal>
  );
}
