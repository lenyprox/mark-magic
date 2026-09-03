'use client';
import { useMemo } from 'react';
import type { CardDetail } from '@cards/query';
import { imgUrl } from '@/lib/img';
import { Popover } from '@/components/ui/Popover';
import { SetIcon } from '@/components/text/SetIcon';
import styles from './deck.module.css';

export function PrintingPicker({ info, printingId, onPick }: { info: CardDetail; printingId: string | null; onPick: (id: string) => void }) {
  const printings = useMemo(() => info.printings.filter(p => p.hasImage !== false).slice().sort((a, b) => (b.releasedAt ?? '').localeCompare(a.releasedAt ?? '')), [info.printings]);
  const current = printings.find(p => p.id === printingId) ?? printings.find(p => p.id === info.representativePrintingId) ?? printings[0];
  if (!current) return null;
  return (
    <Popover placement="bottom-end" trigger={
      <button type="button" className={styles.printBtn} aria-label={`Printing: ${current.setName} ${current.collectorNumber}. Change printing`} title={`${current.setName} #${current.collectorNumber}`}>
        <SetIcon code={current.setCode} rarity={current.rarity} size={13} />
        <span>{current.setCode.toUpperCase()}</span>
      </button>}>
      {(close) => (
        <div className={styles.printGrid} role="listbox" aria-label={`Printings of ${info.name}`}>
          {printings.map(p => (
            <button key={p.id} type="button" role="option" aria-selected={p.id === current.id} className={styles.printItem} onClick={() => { onPick(p.id); close(); }} title={`${p.setName} #${p.collectorNumber}${p.artist ? ` · ${p.artist}` : ''}`}>
              <img src={imgUrl(p.id, 'small')} alt="" loading="lazy" decoding="async" />
              <span className={styles.printTag}><SetIcon code={p.setCode} rarity={p.rarity} size={11} /><span>{p.setCode.toUpperCase()} {p.collectorNumber}</span></span>
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}
