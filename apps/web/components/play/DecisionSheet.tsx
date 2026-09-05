'use client';
// Bottom sheet for the non-priority decisions: choose-cards, yes-no (the mulligan prompt shows the hand),
// choose-mode, choose-option, choose-color, choose-player, choose-number, and the two ordering decisions
// (damage assignment order for a blocked attacker, and trigger order), which are drag-to-reorder lists with
// keyboard buttons beside every row. Assertive live region; everything keyboard-reachable.
import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Reorder } from 'motion/react';
import { ArrowDown, ArrowUp, Check, GripVertical } from 'lucide-react';
import type { Decision } from '@engine/state';
import type { CardView, ViewState } from '@play/view';
import { Button, Input, Kbd, ManaChip } from '@/components/ui';
import { ManaSymbol } from '@/components/text/ManaSymbol';
import { CardImage } from '@/components/card/CardImage';
import { describeDecision } from '@play/targeting';
import styles from './table.module.css';

const COLORS = [{ c: 'W', label: 'White' }, { c: 'U', label: 'Blue' }, { c: 'B', label: 'Black' }, { c: 'R', label: 'Red' }, { c: 'G', label: 'Green' }] as const;

function MiniCard({ card, id, selected, onToggle, index }: { card: CardView | undefined; id: number; selected: boolean; onToggle: (id: number) => void; index: number }) {
  return (
    <button type="button" className={clsx(styles.miniCard, selected && styles.miniSelected)} aria-pressed={selected} onClick={() => onToggle(id)} aria-label={`${card?.name ?? `Card #${id}`}${selected ? ', selected' : ''}`}>
      {card?.printingId ? <CardImage printingId={card.printingId} face={card.face} size="small" alt="" /> : <span className={styles.miniPlaceholder}>{card?.name ?? `#${id}`}</span>}
      <span className={styles.miniName}>{index < 9 && <Kbd>{index + 1}</Kbd>} {card?.name ?? `#${id}`}</span>
      {selected && <span className={styles.miniCheck}><Check size={12} /></span>}
    </button>
  );
}

export function DecisionSheet({ decision, view, objects, onAnswer }: { decision: Decision; view: ViewState; objects: Map<number, CardView>; onAnswer: (a: unknown) => void }) {
  const [picked, setPicked] = useState<number[]>([]);
  const [modes, setModes] = useState<number[]>([]);
  const [order, setOrder] = useState<number[]>([]);
  const [number, setNumber] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const title = decision.kind === 'order-triggers' ? 'Order the triggers'
    : decision.kind === 'order-blockers' ? 'Damage assignment order'
    : describeDecision(decision);
  const isMulligan = decision.kind === 'yes-no' && /^Mulligan/i.test(decision.prompt);
  const hand = useMemo(() => view.players[view.viewer ?? 0].hand ?? [], [view]);

  useEffect(() => {
    setPicked([]); setModes([]);
    setOrder(decision.kind === 'order-blockers' ? [...decision.blockers] : decision.kind === 'order-triggers' ? [...decision.items] : []);
    setNumber(decision.kind === 'choose-number' ? decision.min : 0);
  }, [decision]);
  useEffect(() => { ref.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus(); }, [decision]);

  const toggle = (id: number, count: number) => setPicked(p => p.includes(id) ? p.filter(x => x !== id) : p.length >= count ? [...p.slice(1), id] : [...p, id]);

  useEffect(() => {
    if (decision.kind !== 'choose-cards') return;
    const onKey = (e: KeyboardEvent) => { const n = Number(e.key); if (n >= 1 && n <= 9 && decision.from[n - 1] !== undefined) toggle(decision.from[n - 1], decision.count); };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [decision]);

  let body: React.ReactNode = null; let footer: React.ReactNode = null;
  switch (decision.kind) {
    case 'choose-cards': {
      const ok = decision.exact ? picked.length === Math.min(decision.count, decision.from.length) : picked.length <= decision.count;
      body = <div className={styles.miniGrid}>{decision.from.map((id, i) => <MiniCard key={id} id={id} index={i} card={objects.get(id)} selected={picked.includes(id)} onToggle={x => toggle(x, decision.count)} />)}</div>;
      footer = <>
        <span className="faint small">{decision.exact ? 'exactly' : 'up to'} <span className="mono">{decision.count}</span> · picked <span className="mono">{picked.length}</span></span>
        <Button variant="primary" size="sm" disabled={!ok} onClick={() => onAnswer(picked)} icon={<Check size={14} />}>Confirm</Button>
      </>;
      break;
    }
    case 'yes-no': {
      if (isMulligan) {
        body = <div className={styles.miniGrid}>{hand.map(c => <div key={c.id} className={styles.miniStatic}>{c.printingId ? <CardImage printingId={c.printingId} face={c.face} size="small" alt={c.name} /> : <span className={styles.miniPlaceholder}>{c.name}</span>}</div>)}</div>;
        footer = <>
          <span className="faint small">{hand.length} cards</span>
          <Button variant="primary" size="sm" onClick={() => onAnswer(false)} data-testid="keep-hand" icon={<Check size={14} />}>Keep</Button>
          <Button variant="quiet" size="sm" onClick={() => onAnswer(true)} data-testid="mulligan-hand">Mulligan</Button>
        </>;
      } else {
        footer = <>
          <Button variant="primary" size="sm" onClick={() => onAnswer(true)} data-testid="yes">Yes</Button>
          <Button variant="quiet" size="sm" onClick={() => onAnswer(false)} data-testid="no">No</Button>
        </>;
      }
      break;
    }
    case 'may': case 'unless-pays': {
      // composition-core prompts ("you may …", "… unless you pay {2}"): a plain yes/no
      body = <p className="faint small">{decision.prompt}</p>;
      footer = <>
        <Button variant="primary" size="sm" onClick={() => onAnswer(true)} data-testid="yes" icon={<Check size={14} />}>{decision.kind === 'may' ? 'Yes' : `Pay ${decision.cost}`}</Button>
        <Button variant="quiet" size="sm" onClick={() => onAnswer(false)} data-testid="no">{decision.kind === 'may' ? 'No' : "Don't pay"}</Button>
      </>;
      break;
    }
    case 'choose-mode': {
      const single = decision.count === 1;
      body = (
        <div className={styles.modeList} role={single ? 'radiogroup' : 'group'} aria-label="Modes">
          {decision.modes.map((m, i) => {
            const on = modes.includes(i);
            return <button key={i} type="button" role={single ? 'radio' : 'checkbox'} aria-checked={on} className={clsx(styles.modeItem, on && styles.modeOn)} onClick={() => single ? onAnswer([i]) : setModes(ms => on ? ms.filter(x => x !== i) : ms.length >= decision.count ? ms : [...ms, i])}><Kbd>{i + 1}</Kbd><span>{m}</span></button>;
          })}
        </div>
      );
      footer = single ? <span className="faint small">choose one</span> : <>
        <span className="faint small">choose up to <span className="mono">{decision.count}</span></span>
        <Button variant="primary" size="sm" disabled={!modes.length} onClick={() => onAnswer(modes.sort((a, b) => a - b))} icon={<Check size={14} />}>Confirm</Button>
      </>;
      break;
    }
    case 'choose-option': {
      body = (
        <div className={styles.modeList} role="group" aria-label={decision.reason || 'Options'}>
          {decision.options.map((o, i) => <button key={o} type="button" className={styles.modeItem} onClick={() => onAnswer(o)}><Kbd>{i + 1}</Kbd><span>{o}</span></button>)}
        </div>
      );
      footer = <span className="faint small">choose one</span>;
      break;
    }
    case 'choose-color': {
      body = <div className={styles.colorRow}>{COLORS.map(({ c, label }) => <ManaChip key={c} color={c} pressed={false} label={label} onClick={() => onAnswer(c)}><ManaSymbol sym={c} size={18} /></ManaChip>)}</div>;
      break;
    }
    case 'order-blockers':
    case 'order-triggers': {
      const triggers = decision.kind === 'order-triggers' ? decision : null;
      const attackerName = decision.kind === 'order-blockers' ? objects.get(decision.attacker)?.name ?? '' : '';
      const labelOf = (id: number) => (triggers ? triggers.labels[triggers.items.indexOf(id)] ?? `#${id}` : objects.get(id)?.name ?? `#${id}`);
      const listLabel = triggers ? 'Trigger order' : 'Damage assignment order';
      const move = (i: number, d: -1 | 1) => setOrder(o => { const j = i + d; if (j < 0 || j >= o.length) return o; const n = [...o]; [n[i], n[j]] = [n[j], n[i]]; return n; });
      body = (
        <Reorder.Group axis="y" as="ol" values={order} onReorder={setOrder} className={styles.orderList} aria-label={listLabel} data-testid="order-list">
          {order.map((id, i) => (
            <Reorder.Item key={id} value={id} as="li" className={styles.orderItem} data-testid="order-item" data-id={id}>
              <GripVertical size={14} aria-hidden className={styles.orderGrip} />
              <span className="mono faint">{i + 1}</span>
              <span className="grow">{labelOf(id)}</span>
              <button type="button" className={styles.orderBtn} aria-label={`Move ${labelOf(id)} up`} disabled={i === 0} onClick={() => move(i, -1)} data-testid={`order-up-${id}`}><ArrowUp size={14} /></button>
              <button type="button" className={styles.orderBtn} aria-label={`Move ${labelOf(id)} down`} disabled={i === order.length - 1} onClick={() => move(i, 1)} data-testid={`order-down-${id}`}><ArrowDown size={14} /></button>
            </Reorder.Item>
          ))}
        </Reorder.Group>
      );
      footer = <>
        <span className="faint small">{triggers ? `${order.length} triggers · the last one you order resolves first` : `attacker: ${attackerName} · damage is assigned down this list`}</span>
        <Button variant="primary" size="sm" onClick={() => onAnswer(order)} icon={<Check size={14} />} data-testid="order-confirm">Confirm order</Button>
      </>;
      break;
    }
    case 'choose-player': {
      body = (
        <div className={styles.colorRow} role="group" aria-label="Choose a player">
          {decision.options.map((pid, i) => (
            <Button key={pid} size="sm" variant="quiet" onClick={() => onAnswer(pid)} data-testid={`choose-player-${pid}`}><Kbd>{i + 1}</Kbd> {view.players[pid]?.name ?? `Player ${pid + 1}`}</Button>
          ))}
        </div>
      );
      break;
    }
    case 'choose-number': {
      body = (
        <div className={styles.colorRow}>
          <Input type="number" aria-label={decision.reason || 'Choose a number'} min={decision.min} max={decision.max} value={String(number)}
            onChange={e => setNumber(Math.min(decision.max, Math.max(decision.min, Number(e.target.value) || 0)))} data-testid="choose-number" />
        </div>
      );
      footer = <>
        <span className="faint small">{decision.min} – {decision.max}</span>
        <Button variant="primary" size="sm" onClick={() => onAnswer(number)} icon={<Check size={14} />} data-testid="choose-number-confirm">Confirm</Button>
      </>;
      break;
    }
    default: return null;
  }

  return (
    <div ref={ref} className={styles.sheet} role="dialog" aria-modal="false" aria-labelledby="decision-title" aria-live="assertive" data-testid="decision-sheet" data-kind={decision.kind}>
      <div className={styles.sheetHead}><span id="decision-title" className={styles.sheetTitle}>{title}</span></div>
      {body && <div className={styles.sheetBody}>{body}</div>}
      {footer && <div className={styles.sheetFoot}>{footer}</div>}
    </div>
  );
}
