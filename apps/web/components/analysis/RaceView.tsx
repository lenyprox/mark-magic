'use client';
// The race: both clocks (unopposed / through blockers) and the crackback line, with its derivation.
import clsx from 'clsx';
import type { McRequest, RaceReport } from '@analysis/types';
import { Badge } from '@/components/ui';
import { METHOD_LABEL, METHOD_TONE } from '@/lib/game/ui';
import { DerivationView } from './DerivationView';
import styles from './analysis.module.css';

const turns = (t: number | null) => t === null ? '∞' : String(t);

export function RaceView({ report, reruns, onRerun }: { report: RaceReport; reruns: Record<string, { identical: boolean; results: unknown[] }>; onRerun: (req: McRequest) => void }) {
  return (
    <section className={styles.section} aria-labelledby="an-race" data-testid="race">
      <div className={styles.sectionHead}><h3 id="an-race">Race</h3><Badge tone={METHOD_TONE[report.method]}>{METHOD_LABEL[report.method]}</Badge></div>
      <table className={styles.race}>
        <thead><tr><th /><th scope="col">unopposed</th><th scope="col">blocked</th></tr></thead>
        <tbody>
          <tr><th scope="row">Your clock</th><td className="mono" title={report.mine.unopposed.text}>{turns(report.mine.unopposed.turns)}t · {report.mine.unopposed.damagePerTurn}/t</td><td className="mono" title={report.mine.blocked.text}>{turns(report.mine.blocked.turns)}t · {report.mine.blocked.damagePerTurn}/t</td></tr>
          <tr><th scope="row">Their clock</th><td className="mono" title={report.theirs.unopposed.text}>{turns(report.theirs.unopposed.turns)}t · {report.theirs.unopposed.damagePerTurn}/t</td><td className="mono" title={report.theirs.blocked.text}>{turns(report.theirs.blocked.turns)}t · {report.theirs.blocked.damagePerTurn}/t</td></tr>
        </tbody>
      </table>
      <p className={clsx(styles.crackback, report.crackback.lethal && styles.crackbackLethal)}>
        {report.crackback.lethal && <Badge tone="danger">lethal crackback</Badge>} {report.crackback.text}
      </p>
      <DerivationView d={report.derivation} reruns={reruns} onRerun={onRerun} />
      {report.assumptions.length > 0 && <ul className={styles.assumptions}>{report.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>}
    </section>
  );
}
