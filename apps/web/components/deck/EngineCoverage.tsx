'use client';
import { useMemo, useState } from 'react';
import type { Entry } from '@/lib/deck/stats';
import { Callout } from '@/components/ui/Display';
import { CardRef } from '@/components/shell/CardRef';
import styles from './deck.module.css';

/** Cards whose oracle text the rules engine only partly understands: they still play, with the unparsed lines ignored. */
export function EngineCoverage({ entries }: { entries: Entry[] }) {
  const [open, setOpen] = useState(false);
  const partial = useMemo(() => {
    const seen = new Set<string>();
    return entries.filter(e => e.info && e.info.def && !e.info.def.fullyParsed && !seen.has(e.card.oracleId) && seen.add(e.card.oracleId));
  }, [entries]);
  if (!partial.length) return null;
  const copies = partial.reduce((a, e) => a + e.card.count, 0);
  return (
    <Callout variant="engine" title={`${partial.length} card${partial.length === 1 ? '' : 's'} partially simulated in play`} className={styles.callout}>
      <div className={styles.issueCards}>
        {partial.map(e => <CardRef key={e.card.oracleId} name={e.card.name} oracleId={e.card.oracleId} printingId={e.card.printingId ?? e.info?.representativePrintingId} />)}
      </div>
      <button type="button" className={styles.linkBtn} onClick={() => setOpen(o => !o)} aria-expanded={open}>{open ? 'Hide' : 'Show'} what the engine skips ({copies} cop{copies === 1 ? 'y' : 'ies'})</button>
      {open && (
        <ul className={styles.issueList}>
          {partial.map(e => <li key={e.card.oracleId}><b>{e.card.name}</b>: {e.info!.def.unparsed.slice(0, 3).join(' · ') || 'unrecognised text'}{e.info!.def.unparsed.length > 3 && ' …'}</li>)}
        </ul>
      )}
    </Callout>
  );
}
