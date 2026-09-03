'use client';
// One derivation, expanded: method badge, formula, inputs, numbered steps, assumptions; Monte Carlo derivations
// carry n / seed / CI and a "Re-run with seed" button whose result shows as identical ✓ or differs.
import { useState } from 'react';
import clsx from 'clsx';
import { ChevronDown, RefreshCw } from 'lucide-react';
import type { Derivation, McRequest } from '@analysis/types';
import { Badge, Button } from '@/components/ui';
import { rerunKey } from '@/lib/game/store';
import { fmtNum, METHOD_LABEL, METHOD_TONE, pct } from '@/lib/game/ui';
import styles from './analysis.module.css';

export interface DerivationViewProps {
  d: Derivation;
  reruns: Record<string, { identical: boolean; results: unknown[] }>;
  onRerun: (req: McRequest) => void;
  defaultOpen?: boolean;
}

export function DerivationView({ d, reruns, onRerun, defaultOpen }: DerivationViewProps) {
  const [open, setOpen] = useState(!!defaultOpen);
  const [pending, setPending] = useState(false);
  const rr = d.mc ? reruns[rerunKey(d.mc.rerun)] : undefined;
  const isProb = d.result >= 0 && d.result <= 1 && d.method !== 'heuristic';
  return (
    <div className={clsx(styles.deriv, open && styles.derivOpen)} data-testid="derivation" data-method={d.method}>
      <button type="button" className={styles.derivHead} aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <ChevronDown size={14} className={styles.chev} aria-hidden />
        <span className={styles.derivTitle}>{d.title}</span>
        <Badge tone={METHOD_TONE[d.method]}>{METHOD_LABEL[d.method]}</Badge>
        <span className={clsx('mono', styles.derivResult)}>{isProb ? pct(d.result) : fmtNum(d.result)}</span>
      </button>
      {open && (
        <div className={styles.derivBody}>
          <code className={styles.formula}>{d.formula}</code>
          {d.inputs.length > 0 && (
            <table className={styles.inputs}><tbody>
              {d.inputs.map((i, k) => <tr key={k}><th scope="row">{i.name}</th><td className="mono">{fmtNum(i.value)}</td><td className={styles.inputNote}>{i.note}</td></tr>)}
            </tbody></table>
          )}
          {d.steps.length > 0 && (
            <ol className={styles.steps}>
              {d.steps.map((s, k) => <li key={k}><span>{s.text}</span>{s.value !== undefined && <span className={clsx('mono', styles.stepVal)}>{fmtNum(s.value)}</span>}</li>)}
            </ol>
          )}
          {d.mc && (
            <div className={styles.mc}>
              <div className={styles.mcStats}>
                <span>n <b className="mono">{d.mc.n}</b></span>
                <span>seed <b className="mono">{d.mc.seed}</b></span>
                <span>successes <b className="mono">{fmtNum(d.mc.successes)}</b></span>
                <span>95% CI <b className="mono">{pct(d.mc.ci95[0])} – {pct(d.mc.ci95[1])}</b></span>
                <span>policy <b className="mono">{d.mc.rerun.policy}</b> · horizon <b className="mono">{d.mc.rerun.horizon}</b></span>
              </div>
              <div className={styles.mcRow}>
                <Button size="sm" variant="quiet" icon={<RefreshCw size={12} className={pending && !rr ? styles.spin : undefined} />} onClick={() => { setPending(true); onRerun(d.mc!.rerun); }} data-testid="rerun-seed">Re-run with seed</Button>
                {rr && <span data-testid="rerun-result" data-identical={rr.identical ? 'true' : 'false'}><Badge tone={rr.identical ? 'ok' : 'warn'} dot>{rr.identical ? 'identical ✓' : 'differs'}</Badge></span>}
                {rr && <span className="faint small">{rr.results.length} trials reproduced</span>}
                {pending && !rr && <span className="faint small">re-running…</span>}
              </div>
            </div>
          )}
          {d.assumptions.length > 0 && (
            <ul className={styles.assumptions}>{d.assumptions.map((a, k) => <li key={k}>{a}</li>)}</ul>
          )}
        </div>
      )}
    </div>
  );
}
