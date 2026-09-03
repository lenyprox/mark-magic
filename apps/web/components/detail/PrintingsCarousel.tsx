'use client';
import { useMemo } from 'react';
import type { PrintingDetail } from '@cards/query';
import { imgUrl } from '@/lib/img';
import { yearOf } from '@/lib/text/format';
import { Tooltip } from '@/components/ui/Tooltip';
import styles from '@/app/cards/cards.module.css';

export function PrintingsCarousel({ printings, selected, onSelect }: { printings: PrintingDetail[]; selected?: string; onSelect: (id: string) => void }) {
  const groups = useMemo(() => {
    const m = new Map<string, PrintingDetail[]>();
    for (const p of printings) { const y = yearOf(p.releasedAt); (m.get(y) ?? m.set(y, []).get(y)!).push(p); }
    return [...m.entries()];
  }, [printings]);
  return (
    <div className={styles.printings} role="listbox" aria-label="Printings">
      {groups.map(([year, list]) => (
        <div key={year} className={styles.yearGroup}>
          <div className={styles.year}>{year}</div>
          <div className={styles.thumbs}>
            {list.map(p => (
              <Tooltip key={p.id} content={`${p.setName} (${p.setCode.toUpperCase()} ${p.collectorNumber})${p.lang !== 'en' ? `, ${p.lang}` : ''}${p.finishes.includes('foil') && !p.finishes.includes('nonfoil') ? ', foil only' : ''}`}>
                <button type="button" role="option" aria-selected={p.id === selected} aria-pressed={p.id === selected} className={styles.thumb} onClick={() => onSelect(p.id)} aria-label={`${p.setName} ${p.collectorNumber}`}>
                  {p.hasImage ? <img src={imgUrl(p.id, 'small')} alt="" loading="lazy" decoding="async" width={62} height={86} style={{ borderRadius: 5, width: '100%', height: 'auto', display: 'block', background: 'var(--bg-3)' }} /> : <span className={styles.thumbNoImg}>{p.setCode}</span>}
                  <span className={styles.thumbTag}>{p.setCode}</span>
                </button>
              </Tooltip>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
