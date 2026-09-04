'use client';
// The 13 steps of the turn with the current one lit in brass, and per-step stop toggles for the turn being shown.
// On your own turn a later step that has a stop is clickable: it sets a one-shot stop there and passes until it.
import clsx from 'clsx';
import { STEPS, type Step } from '@engine/state';
import type { StopPolicy } from '@engine/agents/deferred';
import { Tooltip } from '@/components/ui/Tooltip';
import { STEP_LABELS, STEP_SHORT, stopKeyFor } from '@/lib/game/ui';
import styles from './table.module.css';

export interface PhaseStripProps {
  step: Step;
  turn: number;
  myTurn: boolean;
  stops: StopPolicy;
  onToggleStop: (key: keyof StopPolicy, value: boolean) => void;
  /** Pass until a later step of this turn (only offered while the viewer can pass). */
  onSkipTo?: (step: Step, key: keyof StopPolicy) => void;
  canSkip?: boolean;
}

export function PhaseStrip({ step, turn, myTurn, stops, onToggleStop, onSkipTo, canSkip }: PhaseStripProps) {
  const cur = STEPS.indexOf(step);
  return (
    <div className={styles.phase} role="group" aria-label={`Turn ${turn}, ${myTurn ? 'your' : "opponent's"} turn, ${STEP_LABELS[step]}`} data-testid="phase-strip" data-step={step}>
      <div className={styles.phaseTurn}>
        <span className={styles.phaseTurnNum}>T<span className="mono">{turn}</span></span>
        <span className={clsx(styles.phaseWho, myTurn ? styles.phaseMine : styles.phaseTheirs)}>{myTurn ? 'your turn' : 'their turn'}</span>
      </div>
      <ol className={styles.steps}>
        {STEPS.map((s, i) => {
          const key = stopKeyFor(s, myTurn);
          const on = key ? stops[key] : false;
          const skippable = !!onSkipTo && !!canSkip && myTurn && i > cur && !!key;
          return (
            <li key={s} className={clsx(styles.step, i === cur && styles.stepCur, i < cur && styles.stepPast)} aria-current={i === cur ? 'step' : undefined}>
              <Tooltip content={skippable ? `Pass until ${STEP_LABELS[s]}` : STEP_LABELS[s]}>
                {skippable ? (
                  <button type="button" key={`${s}-skip`} className={clsx(styles.stepLabel, styles.stepSkip)} aria-label={`Pass until ${STEP_LABELS[s]}`} onClick={() => onSkipTo!(s, key!)} data-testid={`phase-skip-${s}`}>{STEP_SHORT[s]}</button>
                ) : (
                  <span key={i === cur ? `${s}-cur` : s} className={clsx(styles.stepLabel, i === cur && styles.stepFlash)} aria-label={STEP_LABELS[s]}>{STEP_SHORT[s]}</span>
                )}
              </Tooltip>
              {key ? (
                <button type="button" className={clsx(styles.stopBtn, on && styles.stopOn)} role="switch" aria-checked={on} aria-label={`Stop at ${STEP_LABELS[s]} on ${myTurn ? 'my' : "the opponent's"} turn`} title={`Stop at ${STEP_LABELS[s]}`} onClick={() => onToggleStop(key, !on)} />
              ) : <span className={styles.stopNone} aria-hidden />}
            </li>
          );
        })}
      </ol>
      <label className={styles.stackStop} title="Always stop when something is on the stack">
        <input type="checkbox" checked={stops.alwaysOnStack} onChange={e => onToggleStop('alwaysOnStack', e.target.checked)} />
        <span>stack</span>
      </label>
    </div>
  );
}
