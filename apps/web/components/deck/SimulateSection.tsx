'use client';
// "Simulate N games vs deck X": plays whole games between the draft and a chosen opponent in the batch workers and
// shows win rates with Wilson intervals, seat/play-draw splits, mulligan rates and (for Commander) commander cast
// turns. Every number carries a derivation; "Replay to verify" runs the same seeds again and compares the win count.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Play, RefreshCw, Square } from 'lucide-react';
import type { DeckList } from '@cards/db';
import type { MatchResult, MatchSpec, BatchAgent } from '@sim/types';
import { useDeckStore } from '@/lib/stores/deck';
import { fetchAdhocPayload, fetchBundledDecks, fetchDeckPayload, fetchDecks } from '@/lib/game/api';
import { getBatchPool } from '@/lib/sim/batchClient';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Segmented } from '@/components/ui/Segmented';
import { Input } from '@/components/ui/Input';
import { Badge, Meter } from '@/components/ui/Display';
import { DerivationView } from '@/components/analysis/DerivationView';
import styles from './deck.module.css';

const GAME_OPTIONS = [{ value: '50', label: '50' }, { value: '200', label: '200' }, { value: '500', label: '500' }, { value: '1000', label: '1,000' }];
type OppKey = string; // `saved:<id>` | `bundled:<file>`

export function SimulateSection({ deckId }: { deckId: string }) {
  const draft = useDeckStore(s => s.draft)!;
  const decks = useQuery({ queryKey: ['decks', 'all'], queryFn: () => fetchDecks() });
  const bundled = useQuery({ queryKey: ['decks', 'bundled'], queryFn: fetchBundledDecks });
  const [opp, setOpp] = useState<OppKey>('');
  const [games, setGames] = useState('200');
  const [seed, setSeed] = useState('1');
  const [agent, setAgent] = useState<BatchAgent>('rollout');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<MatchResult | null>(null);
  const [verify, setVerify] = useState<{ state: 'running' } | { state: 'done'; identical: boolean; successes: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  const specRef = useRef<MatchSpec | null>(null);

  const options = useMemo(() => {
    const mine = (decks.data ?? []).filter(d => d.id !== deckId).map(d => ({ value: `saved:${d.id}`, label: `${d.name} (${d.format}${d.role === 'opponent' ? ', opponent' : ''})` }));
    const files = (bundled.data ?? []).map(b => ({ value: `bundled:${b.file}`, label: `${b.name} (bundled)` }));
    return [...mine, ...files];
  }, [decks.data, bundled.data, deckId]);
  useEffect(() => { if (!opp && options.length) setOpp(options[0].value); }, [opp, options]);
  useEffect(() => () => { cancelRef.current?.(); }, []);

  const isCommander = draft.format === 'commander' || draft.cards.some(c => c.board === 'commander');

  async function run() {
    if (!opp || running) return;
    setRunning(true); setError(null); setResult(null); setVerify(null); setProgress({ done: 0, total: Number(games) });
    try {
      const list: DeckList = { name: draft.name, cards: draft.cards.filter(c => c.board === 'main' || c.board === 'commander').map(c => ({ name: c.name, count: c.count, board: c.board })) };
      const mine = await fetchAdhocPayload({ list, name: draft.name });
      const theirs = opp.startsWith('saved:') ? await fetchDeckPayload(opp.slice(6)) : await fetchAdhocPayload({ bundled: opp.slice(8), name: options.find(o => o.value === opp)?.label.replace(/ \(bundled\)$/, '') });
      const format = isCommander || theirs.commander.length ? 'commander' : 'freeform';
      const spec: MatchSpec = { id: `deck-${deckId}-${seed}`, decks: [mine, theirs], games: Number(games), baseSeed: Number(seed) || 1, seating: 'rotate', agent, aiSims: 30, format, maxTurns: format === 'commander' ? 40 : 30, mulligans: 'lands', record: 'summary' };
      specRef.current = spec;
      const pool = getBatchPool(); await pool.ready();
      const handle = pool.run(spec, { onProgress: p => { setProgress({ done: p.done, total: p.total }); setResult(p.partial); } });
      cancelRef.current = handle.cancel;
      const r = await handle.result;
      setResult(r); setProgress({ done: r.games.length, total: r.games.length });
    } catch (e) { setError((e as Error).message); }
    finally { setRunning(false); cancelRef.current = null; }
  }

  async function replay() {
    const spec = specRef.current; const r = result; if (!spec || !r || running) return;
    setVerify({ state: 'running' });
    try {
      const pool = getBatchPool(); await pool.ready();
      const again = await pool.run({ ...spec, games: r.games.length }).result;
      const d = again.aggregate.byDeck[0]; const successes = d.wins + d.draws / 2;
      setVerify({ state: 'done', identical: Math.abs(successes - (r.derivation.sim?.successes ?? -1)) < 1e-9 && d.games === r.derivation.sim?.n, successes });
    } catch (e) { setError((e as Error).message); setVerify(null); }
  }

  const agg = result?.aggregate;
  return (
    <section className={styles.section} aria-label="Simulate" data-testid="simulate-section">
      <div className={styles.sectionHead}><h3>Simulate</h3><span className="faint small">whole games in the background, seeded and reproducible</span></div>
      <div className={styles.simControls}>
        <Select label="Opponent" size="sm" options={options} value={opp} onChange={e => setOpp(e.target.value)} disabled={running || !options.length} placeholder={options.length ? undefined : 'No other decks yet'} data-testid="simulate-opponent" />
        <Segmented size="sm" label="Games" value={games} onChange={setGames} options={GAME_OPTIONS} />
        <Segmented<BatchAgent> size="sm" label="Policy" value={agent} onChange={setAgent} options={[{ value: 'rollout', label: 'Rollout' }, { value: 'ai', label: 'AI (slow)' }]} />
        <Input label="Seed" size="sm" value={seed} onChange={e => setSeed(e.target.value.replace(/\D/g, ''))} inputMode="numeric" wrapClassName={styles.simSeed} />
        {running
          ? <Button variant="quiet" onClick={() => cancelRef.current?.()} data-testid="simulate-cancel"><Square size={14} aria-hidden /> Stop</Button>
          : <Button variant="primary" onClick={run} disabled={!opp} data-testid="simulate-run"><Play size={14} aria-hidden /> Simulate</Button>}
      </div>
      {progress && (running || !result) && <Meter value={progress.total ? progress.done / progress.total : 0} label="Games played" />}
      {error && <p className={styles.simError} role="alert">{error}</p>}
      {agg && agg.games > 0 && (
        <div className={styles.simResults} data-testid="simulate-results">
          <table className={styles.simTable}>
            <thead><tr><th scope="col">Deck</th><th scope="col">Win rate</th><th scope="col">95% CI</th><th scope="col">W / L / D</th><th scope="col">Play</th><th scope="col">Draw</th><th scope="col">Mull</th>{isCommander && <th scope="col">Cmdr by T3 / T5</th>}</tr></thead>
            <tbody>
              {agg.byDeck.map(d => (
                <tr key={d.deck} className={result?.best === d.deck ? styles.simBest : undefined}>
                  <th scope="row">{d.name}{result?.best === d.deck && <Badge tone="ok" className={styles.simBadge}>ahead</Badge>}</th>
                  <td className="mono" data-testid={`simulate-win-${d.deck}`}>{(d.winRate.value * 100).toFixed(1)}%</td>
                  <td className="mono faint">[{((d.winRate.ci95?.[0] ?? 0) * 100).toFixed(1)}, {((d.winRate.ci95?.[1] ?? 1) * 100).toFixed(1)}]</td>
                  <td className="mono">{d.wins} / {d.losses} / {d.draws}</td>
                  <td className="mono">{d.onThePlay.wins}/{d.onThePlay.games}</td>
                  <td className="mono">{d.onTheDraw.wins}/{d.onTheDraw.games}</td>
                  <td className="mono">{(d.mulliganRate * 100).toFixed(0)}%</td>
                  {isCommander && <td className="mono">{d.commanderCastTurn ? `${(d.commanderCastTurn.byTurn3 * 100).toFixed(0)}% / ${(d.commanderCastTurn.byTurn5 * 100).toFixed(0)}%` : '—'}</td>}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="faint small">
            {agg.games} games{running ? ' so far' : ''} · {agg.draws} draw{agg.draws === 1 ? '' : 's'} (turn limit) · avg {agg.avgTurns} turns · {agg.gamesPerSecond} games/s
            {agg.unsimulated > 0 && <> · <span className={styles.simWarn}>{agg.unsimulated} unsimulated text hits</span></>}
            {agg.errors > 0 && <> · <span className={styles.simWarn}>{agg.errors} engine error{agg.errors === 1 ? '' : 's'}</span></>}
          </p>
          {result && !running && (
            <div className={styles.simDerivation}>
              <DerivationView d={result.derivation} reruns={{}} onRerun={() => undefined} />
              <div className={styles.simVerify}>
                <Button size="sm" variant="quiet" onClick={replay} disabled={verify?.state === 'running'} data-testid="simulate-replay"><RefreshCw size={13} aria-hidden /> {verify?.state === 'running' ? 'Replaying…' : 'Replay to verify'}</Button>
                {verify?.state === 'done' && <span data-testid="simulate-verify"><Badge tone={verify.identical ? 'ok' : 'danger'}>{verify.identical ? `identical ✓ (${verify.successes} successes)` : `differs (${verify.successes} successes)`}</Badge></span>}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
