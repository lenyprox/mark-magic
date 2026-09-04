'use client';
// Winner banner with save / rematch / new game.
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RotateCcw, Save, Trophy, Plus } from 'lucide-react';
import { Button } from '@/components/ui';
import { toast } from '@/lib/stores/ui';
import { saveGame } from '@/lib/game/api';
import { useGameStore } from '@/lib/game/store';
import styles from './table.module.css';

export function GameOver({ onRematch }: { onRematch: () => void }) {
  const router = useRouter();
  const winner = useGameStore(s => s.winner);
  const view = useGameStore(s => s.view);
  const decks = useGameStore(s => s.decks);
  const options = useGameStore(s => s.options);
  const finished = useGameStore(s => s.finished);
  const gameId = useGameStore(s => s.gameId);
  const [saved, setSaved] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The banner covers the table, so keep focus inside it (the table itself is finished and has nothing to do).
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !ref.current) return;
      const items = [...ref.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]')];
      if (!items.length) return;
      const first = items[0]; const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !ref.current.contains(active))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);
  if (!view || !decks || !options) return null;
  const meWon = winner === (view.viewer ?? 0);
  const name = winner === null ? 'Draw' : view.players[winner].name;
  const reason = winner !== null ? view.players[winner === 0 ? 1 : 0].lossReason : null;

  const save = async () => {
    if (saving || saved) return; setSaving(true);
    try {
      const r = await saveGame({
        seed: options.seed, myDeckId: decks[0].deckId, oppDeckId: decks[1].deckId, myDeckName: decks[0].name, oppDeckName: decks[1].name,
        myDeckSnapshot: decks[0].list, oppDeckSnapshot: decks[1].list, options: { ...options, analysis: { ...options.analysis, opponentProfile: undefined }, gameId },
        finishedAt: new Date().toISOString(), winner, turns: finished?.turns ?? view.turn, log: finished?.log, actions: finished?.actions, reasoning: finished?.reasoning,
      });
      setSaved(r.id); toast({ title: 'Game saved', body: `Seed ${options.seed} · ${finished?.turns ?? view.turn} turns`, kind: 'ok' });
    } catch (e) { toast({ title: 'Could not save', body: (e as Error).message, kind: 'danger' }); }
    finally { setSaving(false); }
  };

  return (
    <div ref={ref} className={styles.gameOver} role="alertdialog" aria-modal="true" aria-labelledby="gameover-title" data-testid="game-over">
      <div className={styles.gameOverPanel}>
        <Trophy size={28} aria-hidden className={meWon ? styles.trophyWin : styles.trophyLoss} />
        <h2 id="gameover-title">{winner === null ? 'Draw' : meWon ? 'You win' : `${name} wins`}</h2>
        <p className="muted">{reason ? reason : winner === null ? 'The game ended without a winner.' : `${view.players[winner === 0 ? 1 : 0].name} lost.`} Turn <span className="mono">{finished?.turns ?? view.turn}</span> · seed <span className="mono">{options.seed}</span>.</p>
        <div className={styles.gameOverActions}>
          <Button variant="primary" icon={<Save size={14} />} onClick={save} disabled={saving || !!saved}>{saved ? 'Saved' : saving ? 'Saving…' : 'Save game'}</Button>
          <Button variant="quiet" icon={<RotateCcw size={14} />} onClick={onRematch}>Rematch</Button>
          <Button variant="ghost" icon={<Plus size={14} />} onClick={() => router.push('/play')}>New game</Button>
        </div>
      </div>
    </div>
  );
}
