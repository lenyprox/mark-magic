'use client';
// First-time spotlights: one small coach mark at a time for the first priority, first drag, first stack item, first
// combat, first trigger and first state-based death. Seen steps persist in localStorage (`vault.play.tutorial`);
// the settings popover resets them. Tips are pointer-transparent except for their buttons and hide during drags.
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import clsx from 'clsx';
import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';
import { RuleChip } from '@/components/rules/RuleChip';
import { readLocal, writeLocal } from '@/lib/hooks/useLocalStorage';
import styles from './table.module.css';

export const TUTORIAL_KEY = 'vault.play.tutorial';
export type TutorialStep = 'priority' | 'drag' | 'stack' | 'combat' | 'trigger' | 'sba';
export interface TutorialState { seen: TutorialStep[]; off: boolean }

const STEPS: Record<TutorialStep, { title: string; body: string; cr: string; anchor: string | null; placement: 'top' | 'bottom' | 'banner' }> = {
  priority: { title: 'You have priority', body: 'Drag a card from your hand onto your battlefield to play it, click it for its actions, or press Space to pass.', cr: '117.1', anchor: '[data-testid="priority-bar"]', placement: 'top' },
  drag: { title: 'Drop it on a glowing zone', body: 'Anywhere else snaps the card back and tells you which rule stops it.', cr: '601.2', anchor: null, placement: 'banner' },
  stack: { title: 'The stack', body: 'Spells and abilities wait here until every player passes in turn. The top item resolves first.', cr: '405.5', anchor: '[data-testid="stack"]', placement: 'bottom' },
  combat: { title: 'Combat', body: 'Drag your creatures onto the opponent to attack, or onto an attacker to block; Enter confirms.', cr: '508.1', anchor: '[data-testid="priority-bar"]', placement: 'top' },
  trigger: { title: 'A triggered ability', body: 'Something that happened put an ability on the stack. The chip names the rule it follows.', cr: '603.2', anchor: '[data-testid="stack"]', placement: 'bottom' },
  sba: { title: 'State-based actions', body: 'A creature with lethal damage is destroyed the moment a player would receive priority — no one has to say so.', cr: '704.5g', anchor: '[data-testid="plate-opp"]', placement: 'bottom' },
};

export function readTutorial(): TutorialState { return { seen: [], off: false, ...readLocal<Partial<TutorialState>>(TUTORIAL_KEY, {}) }; }

export function useTutorial() {
  const [state, setState] = useState<TutorialState>({ seen: [], off: false });
  const [active, setActive] = useState<TutorialStep | null>(null);
  const stateRef = useRef<TutorialState>({ seen: [], off: false });
  const activeRef = useRef<TutorialStep | null>(null);
  const loaded = useRef(false);
  const queue = useRef<TutorialStep[]>([]);
  useEffect(() => { const s = readTutorial(); stateRef.current = s; loaded.current = true; setState(s); }, []);
  const persist = useCallback((next: TutorialState) => { stateRef.current = next; writeLocal(TUTORIAL_KEY, next); setState(next); }, []);
  const show = useCallback((step: TutorialStep | null) => { activeRef.current = step; setActive(step); }, []);
  /** Ask to show a step; ignored when seen, off, or shown before in this session. */
  const trigger = useCallback((step: TutorialStep) => {
    const s = loaded.current ? stateRef.current : readTutorial();
    if (s.off || s.seen.includes(step)) return;
    persist({ ...s, seen: [...s.seen, step] });
    if (activeRef.current) queue.current.push(step); else show(step);
  }, [persist, show]);
  const dismiss = useCallback(() => { show(queue.current.shift() ?? null); }, [show]);
  const reset = useCallback(() => { queue.current = []; show(null); persist({ seen: [], off: false }); }, [persist, show]);
  const setOff = useCallback((off: boolean) => { if (off) { queue.current = []; show(null); } persist({ ...stateRef.current, off }); }, [persist, show]);
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(dismiss, 16_000);
    return () => clearTimeout(t);
  }, [active, dismiss]);
  return { state, active, trigger, dismiss, reset, setOff };
}

export function TutorialTip({ step, rootRef, hidden, onDismiss, onOff }: { step: TutorialStep | null; rootRef: RefObject<HTMLElement | null>; hidden: boolean; onDismiss: () => void; onOff: () => void }) {
  const spec = step ? STEPS[step] : null;
  const [pos, setPos] = useState<{ x: number; y: number; placement: 'top' | 'bottom' } | null>(null);
  useEffect(() => {
    if (!spec || spec.placement === 'banner' || !rootRef.current) { setPos(null); return; }
    const root = rootRef.current;
    const measure = () => {
      const el = spec.anchor ? root.querySelector<HTMLElement>(spec.anchor) : null;
      if (!el) { setPos(null); return; }
      const r = el.getBoundingClientRect(); const rr = root.getBoundingClientRect();
      const placement: 'top' | 'bottom' = spec.placement === 'top' ? 'top' : 'bottom';
      setPos({ x: r.left - rr.left + r.width / 2, y: placement === 'top' ? r.top - rr.top - 10 : r.bottom - rr.top + 10, placement });
    };
    const t = setTimeout(measure, 60);
    const iv = setInterval(measure, 400); // the anchor moves as the mid row grows / shrinks
    window.addEventListener('resize', measure);
    return () => { clearTimeout(t); clearInterval(iv); window.removeEventListener('resize', measure); };
  }, [spec, rootRef]);
  // Positioned with the standalone `translate` property: motion owns `transform` while it animates the tip in.
  const style = useMemo(() => {
    if (!spec) return {};
    if (spec.placement === 'banner' || !pos) return { left: '50%', top: 12, translate: '-50% 0' } as const;
    return pos.placement === 'top' ? { left: pos.x, top: pos.y, translate: '-50% -100%' } as const : { left: pos.x, top: pos.y, translate: '-50% 0' } as const;
  }, [spec, pos]);
  return (
    <AnimatePresence>
      {spec && step && !hidden && (
        <motion.div key={step} className={clsx(styles.tip, spec.placement === 'banner' && styles.tipBanner)} style={style} data-testid="tutorial-tip" data-step={step} role="note"
          initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0.15 } }} transition={{ duration: 0.22 }}>
          <div className={styles.tipHead}>
            <span className={styles.tipTitle}>{spec.title}</span>
            <RuleChip cr={spec.cr} size="sm" />
            <button type="button" className={styles.tipClose} aria-label="Dismiss tip" onClick={onDismiss} data-testid="tutorial-dismiss"><X size={12} /></button>
          </div>
          <p className={styles.tipBody}>{spec.body}</p>
          <div className={styles.tipFoot}>
            <button type="button" className={styles.tipLink} onClick={onDismiss}>Got it</button>
            <button type="button" className={styles.tipLink} onClick={onOff}>Don't show tips</button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
