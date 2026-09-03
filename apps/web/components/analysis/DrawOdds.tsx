'use client';
// Draw odds: land next / by next turn and the top outs, with derivations.
import { useState } from 'react';
import clsx from 'clsx';
import { ChevronDown } from 'lucide-react';
import type { DrawOddsReport, McRequest } from '@analysis/types';
import { Callout, Meter, Stat } from '@/components/ui';
import { CardRef } from '@/components/shell/CardRef';
import { pct } from '@/lib/game/ui';
import { DerivationView } from './DerivationView';
import styles from './analysis.module.css';

export function DrawOdds({ report, reruns, onRerun }: { report: DrawOddsReport; reruns: Record<string, { identical: boolean; results: unknown[] }>; onRerun: (req: McRequest) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const byId = new Map(report.derivations.map(d => [d.id, d]));
  const landDeriv = report.derivations.find(d => /land/i.test(d.title));
  return (
    <section className={styles.section} aria-labelledby="an-draws" data-testid="draw-odds">
      <div className={styles.sectionHead}><h3 id="an-draws">Draw odds</h3><span className="faint small mono">{report.librarySize} in library</span></div>
      <div className={styles.statRow}>
        <Stat label="Land next draw" value={<span className="mono">{report.landNext ? pct(report.landNext.value) : '—'}</span>} />
        <Stat label="Land by next turn" value={<span className="mono">{report.landByNextTurn ? pct(report.landByNextTurn.value) : '—'}</span>} />
      </div>
      {report.knownTop.length > 0 && <div className={styles.known}>Known on top: {report.knownTop.map((n, i) => <span key={i}>{i > 0 && ', '}<CardRef name={n} /></span>)}</div>}
      {landDeriv && <DerivationView d={landDeriv} reruns={reruns} onRerun={onRerun} />}
      {report.outs.length > 0 && (
        <ul className={styles.ohList} aria-label="Outs">
          {report.outs.slice(0, 8).map(o => {
            const d = byId.get(o.derivationId); const isOpen = open === o.name;
            return (
              <li key={o.name} className={clsx(styles.ohRow, isOpen && styles.ohOpen)}>
                <button type="button" className={styles.ohMain} aria-expanded={!!d && isOpen} onClick={() => d && setOpen(isOpen ? null : o.name)}>
                  <span className={styles.ohLabel}><CardRef name={o.name} className={styles.cardRef} /></span>
                  <Meter value={o.prob.value} label={pct(o.prob.value)} showValue={false} className={styles.ohMeter} />
                  <span className={clsx('mono', styles.ohProb)}>{pct(o.prob.value)}</span>
                  <span className={clsx('mono', styles.ohCopies)} title="Draws considered">{o.draws}d</span>
                  {d && <ChevronDown size={12} className={styles.chev} aria-hidden />}
                </button>
                {d && isOpen && <div className={styles.ohDeriv}><DerivationView d={d} reruns={reruns} onRerun={onRerun} defaultOpen /></div>}
              </li>
            );
          })}
        </ul>
      )}
      {report.warnings.map((w, i) => <Callout key={i} variant="warn" className={styles.warn}>{w}</Callout>)}
    </section>
  );
}
