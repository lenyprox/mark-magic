'use client';
// Candidate plays ranked by win probability (or the heuristic delta while Monte Carlo is still running).
import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { ChevronDown, Crosshair, Play } from 'lucide-react';
import type { McRequest, PlayAnalysis } from '@analysis/types';
import type { PlayerAction } from '@engine/state';
import { Badge, Button, Meter } from '@/components/ui';
import { ciHalfWidth, pct } from '@/lib/game/ui';
import { DerivationView } from './DerivationView';
import styles from './analysis.module.css';

export interface CandidatePlaysProps {
  baseline: PlayAnalysis;
  plays: PlayAnalysis[];
  reruns: Record<string, { identical: boolean; results: unknown[] }>;
  interactive: boolean;
  onHover: (action: PlayerAction | null) => void;
  onArm: (play: PlayAnalysis) => void;
  onUse: (play: PlayAnalysis) => void;
  onRerun: (req: McRequest) => void;
}

const score = (p: PlayAnalysis) => p.winProb?.value ?? Number.NEGATIVE_INFINITY;

export function CandidatePlays({ baseline, plays, reruns, interactive, onHover, onArm, onUse, onRerun }: CandidatePlaysProps) {
  const [open, setOpen] = useState<string | null>(null);
  const all = useMemo(() => {
    const rows = [...plays, baseline];
    const anyMc = rows.some(p => p.winProb);
    rows.sort((a, b) => anyMc ? (score(b) - score(a)) || (b.evalDelta - a.evalDelta) : b.evalDelta - a.evalDelta);
    // Normalise evalDelta to [0,1] for the heuristic meter across the visible rows.
    const deltas = rows.map(r => r.evalDelta); const lo = Math.min(...deltas); const hi = Math.max(...deltas);
    const norm = (v: number) => hi === lo ? 0.5 : (v - lo) / (hi - lo);
    return rows.map(r => ({ play: r, norm: norm(r.evalDelta), anyMc }));
  }, [plays, baseline]);

  return (
    <ol className={styles.plays} data-testid="candidate-plays" aria-label="Candidate plays">
      {all.map(({ play, norm }, i) => {
        const half = ciHalfWidth(play.winProb);
        const isOpen = open === play.id;
        const isPass = play.concrete.type === 'pass';
        return (
          <li key={play.id} className={clsx(styles.play, isOpen && styles.playOpen, play.status === 'mc-running' && styles.playRunning)} data-testid="candidate-play" data-status={play.status}
            onMouseEnter={() => onHover(play.concrete)} onMouseLeave={() => onHover(null)} onFocusCapture={() => onHover(play.concrete)} onBlurCapture={() => onHover(null)}>
            <div className={styles.playRow}>
              <span className={clsx('mono', styles.rank)}>{i + 1}</span>
              <div className={styles.playMain}>
                <div className={styles.playLabel}>
                  <span className={styles.playName}>{isPass ? 'Pass' : play.label}</span>
                  {isPass && <span className="faint small">baseline</span>}
                  {play.status === 'mc-running' && <span className={styles.running} aria-label="Monte Carlo running" />}
                </div>
                <div className={styles.playMeter}>
                  {play.winProb ? <Meter value={play.winProb.value} label={`Win probability ${pct(play.winProb.value)}`} /> : <Meter value={norm} label={`Heuristic ${play.evalDelta.toFixed(2)}`} showValue={false} />}
                  {play.winProb && half != null ? <span className={clsx('mono', styles.ci)} title="95% confidence half-width">±{(half * 100).toFixed(1)}%</span>
                    : <Badge tone="mute" title="1-ply heuristic score minus the pass baseline; not a probability">heuristic {play.evalDelta >= 0 ? '+' : ''}{play.evalDelta.toFixed(2)}</Badge>}
                </div>
                {(play.expectedLifeDelta || play.risks.length > 0) && (
                  <div className={styles.playMeta}>
                    {play.expectedLifeDelta && <span>life <b className="mono">{play.expectedLifeDelta.value >= 0 ? '+' : ''}{play.expectedLifeDelta.value.toFixed(1)}</b></span>}
                    {play.expectedBoardDelta && <span>board <b className="mono">{play.expectedBoardDelta.value >= 0 ? '+' : ''}{play.expectedBoardDelta.value.toFixed(1)}</b></span>}
                    {play.risks.slice(0, 2).map(r => <span key={r.kind} className={styles.risk} title={r.text}>{r.kind} <b className="mono">{pct(r.prob.value, 0)}</b></span>)}
                  </div>
                )}
              </div>
              <div className={styles.playActions}>
                {!isPass && <Button size="sm" variant="ghost" icon={<Crosshair size={12} />} disabled={!interactive} onClick={() => onArm(play)} title="Arm on the table without executing">Arm</Button>}
                <Button size="sm" variant={i === 0 ? 'primary' : 'quiet'} icon={<Play size={12} />} disabled={!interactive} onClick={() => onUse(play)} data-testid="use-play">Use</Button>
                <button type="button" className={styles.why} aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : play.id)}>Why <ChevronDown size={12} className={styles.chev} aria-hidden /></button>
              </div>
            </div>
            {isOpen && (
              <div className={styles.playWhy}>
                {play.derivations.length === 0 && <div className="faint small">No derivation yet; the quick pass only scored this play heuristically.</div>}
                {play.derivations.map((d, k) => <DerivationView key={d.id} d={d} reruns={reruns} onRerun={onRerun} defaultOpen={k === 0} />)}
                {play.risks.map(r => <div key={r.derivationId + r.kind} className={styles.riskLine}><Badge tone="warn">{r.kind}</Badge><span>{r.text}</span><span className="mono">{pct(r.prob.value)}</span></div>)}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
