'use client';
// Collapsible groups of DeckCardRow: qty stepper, hover-preview name, cost, type, printing picker, move, remove.
import { useState } from 'react';
import clsx from 'clsx';
import { ArrowRightLeft, ChevronDown, Minus, Plus, X } from 'lucide-react';
import type { DeckBoard } from '@cards/db';
import { useDeckStore } from '@/lib/stores/deck';
import { shortType, type Entry, type Group } from '@/lib/deck/stats';
import { IconButton } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Display';
import { CardRef } from '@/components/shell/CardRef';
import { ManaCost } from '@/components/text/ManaSymbol';
import { PrintingPicker } from './PrintingPicker';
import styles from './deck.module.css';

export function DeckGroups({ groups, board, loading }: { groups: Group[]; board: 'main' | 'side' | 'maybe'; loading: boolean }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = (k: string) => setCollapsed(s => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  return (
    <div className={styles.groups}>
      {groups.map(g => {
        const open = !collapsed.has(g.key);
        return (
          <section key={g.key} className={styles.group}>
            <button type="button" className={styles.groupHead} onClick={() => toggle(g.key)} aria-expanded={open}>
              <ChevronDown className={clsx(styles.chev, !open && styles.chevClosed)} aria-hidden />
              <span className={styles.groupLabel}>{g.label}</span>
              <span className={styles.groupCount}>{g.count}</span>
            </button>
            {open && (
              <div className={styles.groupBody} role="list">
                {g.entries.map(e => <DeckCardRow key={`${e.card.board}:${e.card.oracleId}`} entry={e} tab={board} loading={loading && !e.info} />)}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function DeckCardRow({ entry, tab, loading }: { entry: Entry; tab: 'main' | 'side' | 'maybe'; loading: boolean }) {
  const { card, info } = entry;
  const adjust = useDeckStore(s => s.adjust);
  const removeCard = useDeckStore(s => s.removeCard);
  const moveCard = useDeckStore(s => s.moveCard);
  const setPrinting = useDeckStore(s => s.setPrinting);
  const printingId = card.printingId ?? info?.representativePrintingId ?? null;
  const moveTo: DeckBoard = tab === 'main' ? 'side' : 'main';
  return (
    <div className={styles.row} role="listitem">
      <div className={styles.qty} role="group" aria-label={`${card.name} quantity`}>
        <IconButton label={`Remove one ${card.name}`} size="sm" onClick={() => adjust(card.board, card.oracleId, -1)}><Minus /></IconButton>
        <span className={styles.qtyNum} aria-live="polite">{card.count}</span>
        <IconButton label={`Add one ${card.name}`} size="sm" onClick={() => adjust(card.board, card.oracleId, 1)}><Plus /></IconButton>
      </div>
      <div className={styles.rowMain}>
        <span className={styles.rowTitle}>
          <CardRef name={card.name} oracleId={card.oracleId} printingId={printingId ?? undefined} className={styles.rowRef} />
          {info && <ManaCost cost={info.manaCost} size={12} className={styles.rowCost} />}
        </span>
        <span className={styles.rowSub}>{loading ? <Skeleton kind="text" width={120} /> : info ? shortType(info.typeLine) : <span className={styles.rowMissing}>not in the card database</span>}</span>
      </div>
      <div className={styles.rowActions}>
        {info && <PrintingPicker info={info} printingId={printingId} onPick={(id) => setPrinting(card.board, card.oracleId, id)} />}
        {card.board !== 'commander' && <IconButton label={tab === 'main' ? `Move ${card.name} to sideboard` : `Move ${card.name} to main deck`} size="sm" onClick={() => moveCard(card.oracleId, card.board, moveTo)}><ArrowRightLeft /></IconButton>}
        <IconButton label={`Remove ${card.name}`} size="sm" onClick={() => removeCard(card.board, card.oracleId)}><X /></IconButton>
      </div>
    </div>
  );
}
