'use client';
import { Dialog } from '@/components/ui/Dialog';
import { Kbd } from '@/components/ui/Display';
import styles from './table.module.css';

const ROWS: [string, string][] = [
  ['Drag', 'Drag a card onto your battlefield to play it, onto a target to aim it, onto the opponent to attack, onto an attacker to block'],
  ['Hover', 'Rest on any card for a moment to inspect it: oracle text, rulings, and why it cannot be played right now'],
  ['Space', 'Pass priority / resolve the top of the stack'],
  ['1 – 9', 'Pick the nth legal action (or target, when targeting)'],
  ['Enter', 'Confirm the current declaration or armed play'],
  ['Esc', 'Cancel targeting / clear the declaration'],
  ['Ctrl+Z', 'Undo the last action (only while nothing hidden was revealed and no opponent acted since)'],
  ['Phase strip', 'Click a later step of your turn to pass until it'],
  ['E', 'Explain: inline rule chips next to every animation, at half speed'],
  ['L', 'Toggle the log rail'],
  ['P', 'Toggle the right rail (Analysis · Explain · Timeline)'],
  ['F', 'Flip a focused double-faced card'],
  ['Arrows', 'Tilt a focused card'],
  ['?', 'This sheet'],
];

export function ShortcutsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" width={420}>
      <dl className={styles.shortcuts}>
        {ROWS.map(([k, d]) => <div key={k} className={styles.shortcutRow}><dt><Kbd>{k}</Kbd></dt><dd>{d}</dd></div>)}
      </dl>
    </Dialog>
  );
}
