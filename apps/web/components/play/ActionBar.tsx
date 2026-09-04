'use client';
// The hint bar for the current interaction: targeting requirement (spec, count, Esc / Confirm), the X prompt,
// an armed candidate play, and the attack / block declarations. Keyboard-reachable alternatives for every target.
import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Check, Crosshair, Swords, Shield, X as XIcon } from 'lucide-react';
import type { ViewState } from '@play/view';
import { Button, Kbd } from '@/components/ui';
import { HAPTIC, vibrate } from '@/lib/audio/haptics';
import { refLabel } from '@/lib/game/ui';
import type { CardView } from '@play/view';
import type { TableInteraction } from './useTableInteraction';
import styles from './table.module.css';

export function ActionBar({ ix, view, objects }: { ix: TableInteraction; view: ViewState; objects: Map<number, CardView> }) {
  const { mode } = ix;
  const [xVal, setXVal] = useState(0);
  const xRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (mode.kind === 'x') { setXVal(mode.st.maxX ?? 0); setTimeout(() => xRef.current?.focus(), 0); } }, [mode]);
  if (mode.kind === 'idle') return null;

  if (mode.kind === 'targeting') {
    const req = ix.requirement!;
    const src = ix.sourceId != null ? objects.get(ix.sourceId)?.name ?? mode.st.legal.label : mode.st.legal.label;
    const picked = mode.st.current.length;
    return (
      <div className={clsx(styles.actionBar, styles.abTargeting)} role="region" aria-label="Targeting" data-testid="targeting-bar">
        <Crosshair size={16} aria-hidden className={styles.abIcon} />
        <div className={styles.abText}>
          <b>{src}</b> · choose {req.optional ? 'up to' : ''} <span className="mono">{req.count}</span> {req.spec}
          {mode.st.reqs.length > 1 && <span className="faint"> (requirement {mode.st.step + 1} of {mode.st.reqs.length})</span>}
          {picked > 0 && <span className="faint"> · picked {picked}/{req.count}</span>}
        </div>
        <div className={styles.abTargets} role="group" aria-label="Legal targets">
          {req.options.slice(0, 12).map((o, i) => {
            const on = mode.st.current.some(c => c.kind === o.kind && c.id === o.id);
            return <button key={`${o.kind}${o.id}`} type="button" className={clsx(styles.abTarget, on && styles.abTargetOn)} aria-pressed={on} onClick={() => ix.pickRef(o)}>{i < 9 && <Kbd>{i + 1}</Kbd>}{refLabel(o, view, objects)}</button>;
          })}
        </div>
        <div className={styles.abButtons}>
          {ix.canConfirmNow && <Button size="sm" variant="primary" icon={<Check size={14} />} onClick={ix.confirm}>Confirm</Button>}
          <Button size="sm" variant="ghost" icon={<XIcon size={14} />} onClick={ix.cancel} trailing={<Kbd>Esc</Kbd>}>Cancel</Button>
        </div>
      </div>
    );
  }

  if (mode.kind === 'x') {
    const max = mode.st.maxX ?? 0;
    return (
      <form className={clsx(styles.actionBar, styles.abX)} role="region" aria-label="Choose X" onSubmit={e => { e.preventDefault(); ix.chooseX(xVal); }}>
        <div className={styles.abText}><b>{mode.st.legal.label}</b> · choose X (max <span className="mono">{max}</span>)</div>
        <input ref={xRef} type="number" min={0} max={max} value={xVal} onChange={e => setXVal(Number(e.target.value))} className={styles.xInput} aria-label="X" />
        <input type="range" min={0} max={max} value={xVal} onChange={e => setXVal(Number(e.target.value))} aria-label="X slider" className={styles.xRange} />
        <div className={styles.abButtons}>
          <Button size="sm" variant="primary" type="submit" icon={<Check size={14} />}>X = {xVal}</Button>
          <Button size="sm" variant="ghost" onClick={ix.cancel} trailing={<Kbd>Esc</Kbd>}>Cancel</Button>
        </div>
      </form>
    );
  }

  if (mode.kind === 'armed') {
    const targets = (mode.action.type === 'cast' || mode.action.type === 'activate') ? (mode.action.targets ?? []).flat().map(t => refLabel(t, view, objects)) : [];
    return (
      <div className={clsx(styles.actionBar, styles.abArmed)} role="region" aria-label="Armed play" data-testid="armed-bar">
        <Crosshair size={16} aria-hidden className={styles.abIcon} />
        <div className={styles.abText}><span className="faint">Armed from analysis:</span> <b>{mode.label}</b>{targets.length > 0 && <span> → {targets.join(', ')}</span>}</div>
        <div className={styles.abButtons}>
          <Button size="sm" variant="primary" icon={<Check size={14} />} onClick={ix.confirm} trailing={<Kbd>Enter</Kbd>}>Do it</Button>
          <Button size="sm" variant="ghost" onClick={ix.cancel} trailing={<Kbd>Esc</Kbd>}>Cancel</Button>
        </div>
      </div>
    );
  }

  if (mode.kind === 'attackers') {
    const n = mode.decl.attackers.length;
    const total = mode.decl.attackers.reduce((s, id) => { const c = objects.get(id); const p = c && 'curPower' in c ? (c as { curPower: number }).curPower : Number(c?.power ?? 0); return s + (p || 0); }, 0);
    return (
      <div className={clsx(styles.actionBar, styles.abAttack)} role="region" aria-label="Declare attackers" data-testid="attack-bar">
        <Swords size={16} aria-hidden className={styles.abIcon} />
        <div className={styles.abText}>
          <b>Declare attackers</b> · click creatures to toggle{mode.mustAttack.length > 0 && <span className="faint"> · {mode.mustAttack.length} must attack</span>}
          {n > 0 && <span> · <span className="mono">{n}</span> attacking for <span className="mono">{total}</span></span>}
        </div>
        <div className={styles.abTargets} role="group" aria-label="Attack candidates">
          {mode.candidates.map((id, i) => {
            const on = mode.decl.attackers.includes(id); const locked = mode.mustAttack.includes(id);
            return <button key={id} type="button" className={clsx(styles.abTarget, on && styles.abTargetOn)} aria-pressed={on} disabled={locked} onClick={() => ix.onObjectClick(id)}>{i < 9 && <Kbd>{i + 1}</Kbd>}{objects.get(id)?.name ?? `#${id}`}{locked && ' (must)'}</button>;
          })}
        </div>
        <div className={styles.abButtons}>
          <Button size="sm" variant="primary" icon={<Swords size={14} />} onClick={() => { if (n) vibrate(HAPTIC.attack); ix.confirm(); }} data-testid="attack-confirm" trailing={<Kbd>Enter</Kbd>}>{n ? `Attack with ${n}` : 'No attack'}</Button>
          {n > 0 && <Button size="sm" variant="ghost" onClick={ix.noAttack}>No attack</Button>}
        </div>
      </div>
    );
  }

  if (mode.kind === 'blockers') {
    const blocks = mode.decl.blocks;
    return (
      <div className={clsx(styles.actionBar, styles.abBlock)} role="region" aria-label="Declare blockers" data-testid="block-bar">
        <Shield size={16} aria-hidden className={styles.abIcon} />
        <div className={styles.abText}>
          <b>Declare blockers</b> · {mode.selected !== null ? <>now click the attacker <b>{objects.get(mode.selected)?.name}</b> should block</> : 'click a blocker, then an attacker'}
          {blocks.length > 0 && <span> · <span className="mono">{blocks.length}</span> {blocks.length === 1 ? 'block' : 'blocks'}</span>}
        </div>
        <div className={styles.abTargets} role="group" aria-label="Blockers">
          {mode.candidates.map(id => {
            const b = blocks.find(x => x.blocker === id);
            return (
              <span key={id} className={styles.abPair}>
                <button type="button" className={clsx(styles.abTarget, mode.selected === id && styles.abTargetOn)} aria-pressed={mode.selected === id} onClick={() => ix.onObjectClick(id)}>{objects.get(id)?.name ?? `#${id}`}</button>
                {b && <><span aria-hidden>⟶</span><span className={styles.abBlocks}>{objects.get(b.attacker)?.name}</span><button type="button" className={styles.abClear} aria-label={`Clear block by ${objects.get(id)?.name}`} onClick={() => ix.clearBlock(id)}><XIcon size={12} /></button></>}
              </span>
            );
          })}
          {mode.selected !== null && mode.attackers.map(id => <button key={`a${id}`} type="button" className={clsx(styles.abTarget, styles.abAttacker)} onClick={() => ix.onObjectClick(id)}>block {objects.get(id)?.name ?? `#${id}`}</button>)}
        </div>
        <div className={styles.abButtons}>
          <Button size="sm" variant="primary" icon={<Shield size={14} />} onClick={ix.confirm} data-testid="block-confirm" trailing={<Kbd>Enter</Kbd>}>{blocks.length ? `Block with ${blocks.length}` : 'No blocks'}</Button>
          {blocks.length > 0 && <Button size="sm" variant="ghost" onClick={ix.noBlocks}>No blocks</Button>}
        </div>
      </div>
    );
  }
  return null;
}
