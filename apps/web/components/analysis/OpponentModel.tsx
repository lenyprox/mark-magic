'use client';
// "What could they have": model badge, hidden hand / unknown pool, interaction classes and the top cards, each
// with its derivation, plus the publicly known cards in their hand.
import { useState } from 'react';
import clsx from 'clsx';
import { ChevronDown } from 'lucide-react';
import type { CouldHaveReport, Estimate, McRequest } from '@analysis/types';
import { Badge, Meter, Callout } from '@/components/ui';
import { CardRef } from '@/components/shell/CardRef';
import { ciHalfWidth, pct } from '@/lib/game/ui';
import { DerivationView } from './DerivationView';
import styles from './analysis.module.css';

const MODEL_LABEL = { exact: 'exact list', archetype: 'archetype', none: 'no model' } as const;

export function OpponentModel({ report, reruns, onRerun }: { report: CouldHaveReport; reruns: Record<string, { identical: boolean; results: unknown[] }>; onRerun: (req: McRequest) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const byId = new Map(report.derivations.map(d => [d.id, d]));
  const row = (key: string, label: React.ReactNode, prob: Estimate, copies: number, derivationId: string) => {
    const d = byId.get(derivationId); const isOpen = open === key; const half = ciHalfWidth(prob);
    return (
      <li key={key} className={clsx(styles.ohRow, isOpen && styles.ohOpen)}>
        <button type="button" className={styles.ohMain} aria-expanded={!!d && isOpen} onClick={() => d && setOpen(isOpen ? null : key)}>
          <span className={styles.ohLabel}>{label}</span>
          <Meter value={prob.value} label={`${pct(prob.value)}`} showValue={false} className={styles.ohMeter} />
          <span className={clsx('mono', styles.ohProb)}>{pct(prob.value)}{half != null && <span className="faint"> ±{(half * 100).toFixed(1)}</span>}</span>
          <span className={clsx('mono', styles.ohCopies)} title="Copies unseen">×{copies}</span>
          {d && <ChevronDown size={12} className={styles.chev} aria-hidden />}
        </button>
        {d && isOpen && <div className={styles.ohDeriv}><DerivationView d={d} reruns={reruns} onRerun={onRerun} defaultOpen /></div>}
      </li>
    );
  };
  return (
    <section className={styles.section} aria-labelledby="an-opp" data-testid="opponent-model">
      <div className={styles.sectionHead}>
        <h3 id="an-opp">What could they have</h3>
        <Badge tone={report.model === 'none' ? 'mute' : 'brass'}>{MODEL_LABEL[report.model]}</Badge>
      </div>
      <div className={styles.stats}>
        <span>hidden hand <b className="mono">{report.hiddenHand}</b></span>
        <span>unknown pool <b className="mono">{report.unknownPool}</b></span>
        {report.known.length > 0 && <span>known in hand <b className="mono">{report.known.length}</b></span>}
      </div>
      {report.model === 'none' ? <Callout variant="note">No opponent model: the analysis treats their hand as unknown noise.</Callout> : (
        <>
          {report.classes.length > 0 && (
            <ul className={styles.ohList} aria-label="Interaction classes">
              {report.classes.map(c => row(`c:${c.cls}`, <span className={styles.cls}>{c.cls}</span>, c.prob, c.copiesUnseen, c.derivationId))}
            </ul>
          )}
          {report.cards.length > 0 && (
            <ul className={styles.ohList} aria-label="Most likely cards">
              {report.cards.slice(0, 8).map(c => row(`k:${c.name}`, <CardRef name={c.name} className={styles.cardRef} />, c.prob, c.copiesUnseen, c.derivationId))}
            </ul>
          )}
        </>
      )}
      {report.known.length > 0 && (
        <div className={styles.known}>Known: {report.known.map((k, i) => <span key={k.id}>{i > 0 && ', '}<CardRef name={k.name} /></span>)}</div>
      )}
      {report.warnings.map((w, i) => <Callout key={i} variant="warn" className={styles.warn}>{w}</Callout>)}
    </section>
  );
}
