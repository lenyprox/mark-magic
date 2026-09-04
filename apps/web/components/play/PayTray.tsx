'use client';
// The manual-mana tray: shown when a cast's payment should be confirmed. Lists the cost as pips, the sources chosen
// so far (the engine's suggestion to start with) and lets the player click their lands / mana rocks on the table to
// change which ones tap. Confirm sends `pay.sources`; the engine falls back to its own payment when they cannot pay.
import clsx from 'clsx';
import { Check, Coins, RotateCcw, X as XIcon } from 'lucide-react';
import type { LegalAction } from '@engine/state';
import type { PlayerView } from '@play/view';
import { costPips, manaColorsOf, untappedManaSources } from '@play/targeting';
import { Button, Kbd } from '@/components/ui';
import { ManaSymbol } from '@/components/text/ManaSymbol';
import type { CastAction } from './useTableInteraction';
import styles from './table.module.css';

export interface PayTrayProps {
  action: CastAction;
  legal: LegalAction;
  sources: number[];
  me: PlayerView;
  cardName: string;
  onToggle: (id: number) => void;
  onReset: (sources: number[]) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function PayTray({ action, legal, sources, me, cardName, onToggle, onReset, onConfirm, onCancel }: PayTrayProps) {
  const pay = legal.pay;
  const pips = costPips(pay?.cost ?? '');
  const tax = action.from === 'command' ? 2 * (me.commanderCasts?.[action.cardId] ?? 0) : 0;
  const candidates = untappedManaSources(me);
  const suggested = pay?.taps.map(t => t.id) ?? [];
  const isSuggestion = sources.length === suggested.length && sources.every(id => suggested.includes(id));
  return (
    <div className={clsx(styles.actionBar, styles.payTray)} role="region" aria-label="Choose mana sources" data-testid="pay-tray" data-sources={sources.join(',')}>
      <Coins size={16} aria-hidden className={styles.abIcon} />
      <div className={styles.abText}>
        <b>{cardName}</b> · pay
        <span className={styles.payPips} aria-label={`cost ${pay?.cost ?? ''}${tax ? ` plus commander tax {${tax}}` : ''}`}>
          {pips.map((p, i) => <ManaSymbol key={i} sym={p} size={14} />)}
          {tax > 0 && <><span className="faint">+</span><ManaSymbol sym={String(tax)} size={14} title={`Commander tax {${tax}}`} /></>}
        </span>
        <span className="faint"> · click your lands to choose what taps{pay?.pool.length ? `, ${pay.pool.map(m => `{${m}}`).join('')} floats` : ''}</span>
      </div>
      <div className={styles.abTargets} role="group" aria-label="Mana sources">
        {candidates.map(o => {
          const on = sources.includes(o.id);
          const colors = manaColorsOf(o);
          return (
            <button key={o.id} type="button" className={clsx(styles.abTarget, on && styles.abTargetOn)} aria-pressed={on} onClick={() => onToggle(o.id)} data-testid={`pay-source-${o.id}`} title={on ? `Tapping ${o.name}` : `Tap ${o.name} instead`}>
              {o.name}
              {colors.length > 0 && <span className={styles.paySourceMana}>{colors.slice(0, 3).map((c, i) => <ManaSymbol key={i} sym={c} size={11} />)}</span>}
            </button>
          );
        })}
        {!candidates.length && <span className="faint small">No untapped mana sources.</span>}
      </div>
      <div className={styles.abButtons}>
        {!isSuggestion && suggested.length > 0 && <Button size="sm" variant="quiet" icon={<RotateCcw size={13} />} onClick={() => onReset(suggested)} title="Back to what the engine would tap">Auto</Button>}
        <Button size="sm" variant="primary" icon={<Check size={14} />} onClick={onConfirm} data-testid="pay-confirm" trailing={<Kbd>Enter</Kbd>}>Tap {sources.length}</Button>
        <Button size="sm" variant="ghost" icon={<XIcon size={14} />} onClick={onCancel} trailing={<Kbd>Esc</Kbd>}>Cancel</Button>
      </div>
    </div>
  );
}
