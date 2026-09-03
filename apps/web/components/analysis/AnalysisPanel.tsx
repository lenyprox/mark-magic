'use client';
// The analysis panel: header (seed, trials, status, deepen, policy), candidate plays, opponent model, draw odds,
// race and warnings. Presentation only; the report comes from the game worker through the store.
import { useState } from 'react';
import clsx from 'clsx';
import { Check, Copy, Layers } from 'lucide-react';
import type { AnalysisReport, McRequest, PlayAnalysis } from '@analysis/types';
import type { PlayerAction } from '@engine/state';
import type { CardView, ViewState } from '@play/view';
import type { AnalysisPhase } from '@/lib/game/store';
import { Button, Callout, IconButton, Segmented, Skeleton } from '@/components/ui';
import { CandidatePlays } from './CandidatePlays';
import { OpponentModel } from './OpponentModel';
import { DrawOdds } from './DrawOdds';
import { RaceView } from './RaceView';
import styles from './analysis.module.css';

export interface AnalysisPanelProps {
  report: AnalysisReport | null;
  phase: AnalysisPhase;
  reruns: Record<string, { identical: boolean; results: unknown[] }>;
  seed: number;
  enabled: boolean;
  interactive: boolean;
  onDeepen: (policy?: 'rollout' | 'ai30') => void;
  onRerun: (req: McRequest) => void;
  onHover: (action: PlayerAction | null) => void;
  onArm: (play: PlayAnalysis) => void;
  onUse: (play: PlayAnalysis) => void;
  objects: Map<number, CardView>;
  view: ViewState;
}

const PHASE_LABEL: Record<AnalysisPhase, string> = { idle: 'waiting for a decision', quick: 'quick pass', update: 'sampling…', done: 'done' };

export function AnalysisPanel({ report, phase, reruns, seed, enabled, interactive, onDeepen, onRerun, onHover, onArm, onUse }: AnalysisPanelProps) {
  const [copied, setCopied] = useState(false);
  const [policy, setPolicy] = useState<'rollout' | 'ai30'>('rollout');
  const trials = report ? Math.max(0, ...[report.baseline, ...report.plays].map(p => p.winProb?.n ?? 0)) : 0;
  const copy = async () => { try { await navigator.clipboard.writeText(String(report?.baseSeed ?? seed)); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* clipboard unavailable */ } };

  return (
    <div className={styles.panel} data-testid="analysis-panel" data-phase={phase} aria-busy={phase === 'update' || phase === 'quick'}>
      <header className={styles.head}>
        <div className={styles.headRow}>
          <span className={clsx(styles.dot, styles[`dot_${phase}`])} title={PHASE_LABEL[phase]} aria-hidden />
          <span className={styles.title}>Analysis</span>
          <span className={styles.phaseText} role="status">{enabled ? PHASE_LABEL[phase] : 'off'}</span>
        </div>
        <div className={styles.headRow}>
          <span className={styles.seed}>seed <b className="mono" data-testid="analysis-seed">{report?.baseSeed ?? seed}</b></span>
          <IconButton size="sm" label={copied ? 'Copied' : 'Copy seed'} onClick={copy}>{copied ? <Check size={13} /> : <Copy size={13} />}</IconButton>
          <span className={styles.trials}>trials <b className="mono">{trials}</b>{report && <span className="faint"> · quick {report.quickMs} ms</span>}</span>
        </div>
        <div className={styles.headRow}>
          <Segmented size="sm" label="Rollout policy" value={policy} onChange={setPolicy} options={[{ value: 'rollout', label: 'rollout' }, { value: 'ai30', label: 'AI·30' }]} />
          <Button size="sm" variant="quiet" icon={<Layers size={13} />} disabled={!enabled || !report || phase === 'update' || phase === 'quick'} onClick={() => onDeepen(policy)} title="Run 400 more trials per candidate" data-testid="deepen">Deepen</Button>
        </div>
      </header>

      <div className={styles.body}>
        {!enabled && <Callout variant="note">Analysis is off for this game. Turn it on from the setup page.</Callout>}
        {enabled && !report && (
          <div className={styles.skeletons} aria-hidden>
            <Skeleton height={44} /><Skeleton height={44} /><Skeleton height={44} />
            <span className="faint small">{phase === 'idle' ? 'The analysis runs when you have a decision to make.' : 'Scoring candidate plays…'}</span>
          </div>
        )}
        {report && (
          <>
            {report.warnings.map((w, i) => <Callout key={i} variant="warn" className={styles.warn}>{w}</Callout>)}
            <section className={styles.section} aria-labelledby="an-plays">
              <div className={styles.sectionHead}><h3 id="an-plays">Candidate plays</h3><span className="faint small">{report.plays.length} + pass</span></div>
              <CandidatePlays baseline={report.baseline} plays={report.plays} reruns={reruns} interactive={interactive} onHover={onHover} onArm={onArm} onUse={onUse} onRerun={onRerun} />
            </section>
            <OpponentModel report={report.couldHave} reruns={reruns} onRerun={onRerun} />
            <DrawOdds report={report.draws} reruns={reruns} onRerun={onRerun} />
            <RaceView report={report.race} reruns={reruns} onRerun={onRerun} />
            <p className={styles.foot}>Generated {new Date(report.generatedAt).toLocaleTimeString()} · request <span className="mono">{report.requestId}</span></p>
          </>
        )}
      </div>
    </div>
  );
}
