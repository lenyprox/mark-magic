'use client';
// /optimize/[id]: live progress of a run and, when it has one, the report: best list vs baseline (paired), the swap
// table, card contributions, keep guidance, winning patterns, the "check your bulk" list and coverage caveats. Every
// number opens its derivation.
import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Pause, Play, Save, Square } from 'lucide-react';
import type { CardContribution, OptimizerReport, SwapReport } from '@optimizer/types';
import type { Derivation } from '@analysis/types';
import { optimizerApi, type RunDetail } from '@/lib/optimizer/api';
import { Button } from '@/components/ui/Button';
import { Badge, Callout, Meter } from '@/components/ui/Display';
import { DerivationView } from '@/components/analysis/DerivationView';
import { toast } from '@/lib/stores/ui';
import { statusTone } from './OptimizePage';
import styles from './optimizer.module.css';

const pct = (x: number | null | undefined, d = 1) => (x === null || x === undefined ? '–' : `${(x * 100).toFixed(d)}%`);
const signed = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}`;

export function RunPage({ id }: { id: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['optimizer', 'run', id], queryFn: () => optimizerApi.get(id), refetchInterval: d => { const s = d.state.data?.run.status; return s === 'done' || s === 'failed' || s === 'cancelled' ? false : 3000; } });
  const [busy, setBusy] = useState<string | null>(null);
  if (q.isLoading || !q.data) return <div className={styles.page}><p className="faint">Loading run…</p></div>;
  const { run, stale, log, deckName } = q.data as RunDetail;
  const p = run.progress; const live = run.status === 'running' || run.status === 'queued' || run.status === 'cancelling';
  const refresh = () => qc.invalidateQueries({ queryKey: ['optimizer', 'run', id] });
  const act = async (what: string, f: () => Promise<unknown>) => { setBusy(what); try { await f(); await refresh(); } catch (e) { toast({ title: 'Action failed', body: (e as Error).message, kind: 'danger' }); } finally { setBusy(null); } };
  return (
    <div className={styles.page} data-testid="optimize-run">
      <div className={styles.head}>
        <div>
          <p className={styles.small}><Link href="/optimize">Optimise</Link> / {deckName ?? run.deckId}</p>
          <h1>{run.name}</h1>
          <div className={styles.runMeta}>
            <Badge tone={statusTone(run.status, stale)} dot>{stale ? 'stalled (no heartbeat)' : run.status}</Badge>
            <span>{run.spec.players}-player · {run.spec.format} · seed {run.seed} · {run.spec.pool === 'owned' ? 'registered cards' : 'registered + popular unregistered'}</span>
            <span>field: {run.spec.field.map(f => f.name).join(', ')}</span>
          </div>
        </div>
        <div className={styles.actions}>
          {live && !stale && <Button variant="quiet" onClick={() => act('cancel', () => optimizerApi.cancel(id))} disabled={busy !== null}><Square size={14} aria-hidden /> Stop</Button>}
          {(stale || run.status === 'paused' || run.status === 'cancelled') && run.checkpoint && <Button variant="quiet" onClick={() => act('resume', () => optimizerApi.resume(id))} disabled={busy !== null}><Play size={14} aria-hidden /> Resume from checkpoint</Button>}
          {run.report && run.report.best.changes.length > 0 && (
            <>
              <Button variant="primary" onClick={() => act('apply', async () => { const { deck } = await optimizerApi.apply(id, { mode: 'new' }); toast({ title: `Saved as ${deck.name}`, kind: 'ok' }); })} disabled={busy !== null}><Save size={14} aria-hidden /> Save as new deck</Button>
              <Button variant="quiet" onClick={() => act('update', async () => { await optimizerApi.apply(id, { mode: 'update' }); toast({ title: 'Deck updated', kind: 'ok' }); })} disabled={busy !== null}><Check size={14} aria-hidden /> Apply to the deck</Button>
            </>
          )}
        </div>
      </div>

      <section className={styles.section} aria-label="Progress">
        <div className={styles.progressRow}>
          <Meter value={p.gamesBudget ? Math.min(1, p.gamesSimulated / p.gamesBudget) : 0} label="Games simulated" className={styles.field} />
          <span className={styles.small}>iteration {p.iteration}/{p.maxIterations} · {p.gamesSimulated.toLocaleString()} simulated + {p.gamesReused.toLocaleString()} reused of {p.gamesBudget.toLocaleString()}{p.etaSeconds !== null && live ? ` · about ${Math.max(1, Math.round(p.etaSeconds / 60))} min left` : ''}</span>
        </div>
        <div className={styles.stats}>
          <Stat label="Baseline" value={pct(p.baselineWinRate)} note="the deck as it is" />
          <Stat label="Best so far" value={pct(p.bestWinRate)} note={`${p.accepted} accepted swap${p.accepted === 1 ? '' : 's'}`} />
          <Stat label="Status" value={p.message || run.status} />
        </div>
        {run.error && <Callout variant="danger" title="The run failed">{run.error}</Callout>}
        {stale && <Callout variant="warn" title="No heartbeat from the worker"><Pause size={13} aria-hidden /> The background process stopped (closed terminal, sleep, crash). Resume continues from the last checkpoint.</Callout>}
        {log.length > 0 && <details><summary className={styles.small}>worker log</summary><pre className={styles.log}>{log.join('\n')}</pre></details>}
      </section>

      {run.report && <Report r={run.report} runId={id} />}
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return <div className={styles.stat}><div className={styles.statLabel}>{label}</div><div className={styles.statValue}>{value}</div>{note && <div className={styles.statNote}>{note}</div>}</div>;
}

function Report({ r, runId }: { r: OptimizerReport; runId: string }) {
  const derivs = new Map(r.derivations.map(d => [d.id, d]));
  const [open, setOpen] = useState<string | null>(null);
  const D = ({ id }: { id: string }) => { const d = derivs.get(id); if (!d) return null; return <button type="button" className={styles.linkBtn} onClick={() => setOpen(o => (o === id ? null : id))} aria-expanded={open === id}>{open === id ? 'hide' : 'how?'}</button>; };
  const Open = ({ id }: { id: string }) => { const d = derivs.get(id); return open === id && d ? <DerivationView d={d as Derivation} reruns={{}} onRerun={() => undefined} defaultOpen /> : null; };
  const paired = r.best.paired;
  return (
    <>
      <section className={styles.section} aria-label="Result" data-testid="optimize-report">
        <div className={styles.sectionHead}><h2>Result</h2><span className={styles.small}>{r.budget.gamesSimulated.toLocaleString()} games simulated, {r.budget.gamesReused.toLocaleString()} reused, {r.budget.iterations} iterations on {r.budget.blocks} seed block{r.budget.blocks === 1 ? '' : 's'}, {Math.round(r.budget.seconds / 60)} min</span></div>
        <div className={styles.stats}>
          <Stat label="Baseline" value={pct(r.baseline.winRate.value)} note={`[${pct(r.baseline.winRate.ci95?.[0])}, ${pct(r.baseline.winRate.ci95?.[1])}] over ${r.baseline.games} games${r.baseline.draws ? `, ${r.baseline.draws} at the turn limit` : ''}`} />
          <Stat label="Best list" value={pct(r.best.winRate.value)} note={`[${pct(r.best.winRate.ci95?.[0])}, ${pct(r.best.winRate.ci95?.[1])}] over ${r.best.games} games${r.best.draws ? `, ${r.best.draws} at the turn limit` : ''}`} />
          {paired && <Stat label="Paired gain" value={`${signed(paired.delta)} pts`} note={`[${signed(paired.ci95[0])}, ${signed(paired.ci95[1])}] on ${paired.n} shared seeds${paired.accepted ? ' · significant' : ' · within noise'}`} />}
        </div>
        <div className={styles.derivs}><D id={`win-${r.baseline.candidateId}`} /><Open id={`win-${r.baseline.candidateId}`} />{r.best.candidateId !== r.baseline.candidateId && <><D id={`win-${r.best.candidateId}`} /><Open id={`win-${r.best.candidateId}`} /></>}</div>
        {r.best.changes.length ? (
          <div className={styles.changes}>
            {r.best.changes.map((c, i) => <div key={i} className={styles.change}><span className={styles.out}>{c.out}</span><span className={styles.arrow}>→</span><span>{c.in}{c.bulk && <span className={`${styles.tag} ${styles.tagBulk}`}>check your bulk</span>}</span></div>)}
          </div>
        ) : <Callout variant="note" title="No swap beat the deck beyond noise">The seed list held up against every neighbour tried within this budget. A larger budget or a wider pool may find more.</Callout>}
        {r.field.length > 1 && <p className={styles.small}>by opponent: {r.field.map(f => `${f.name} ${f.games ? pct(f.wins / f.games, 0) : '–'} (${f.games})`).join(' · ')}</p>}
      </section>

      <section className={styles.section} aria-label="Swaps tried">
        <div className={styles.sectionHead}><h2>Swaps tried</h2><span className={styles.small}>{r.swaps.length} evaluated on the full block, {r.swaps.filter(s => s.comparison.accepted).length} accepted</span></div>
        <div style={{ overflowX: 'auto' }}>
          <table className={styles.table}>
            <thead><tr><th>It.</th><th>Out</th><th>In</th><th>Δ win rate</th><th>95% CI</th><th>a / b / n</th><th>reused</th><th>Verdict</th><th /></tr></thead>
            <tbody>{r.swaps.map(s => <SwapRow key={s.derivationId} s={s} D={D} Open={Open} />)}</tbody>
          </table>
        </div>
      </section>

      <div className={styles.grid2}>
        <section className={styles.section} aria-label="Card contributions">
          <div className={styles.sectionHead}><h2>Card contributions</h2><span className={styles.small}>correlational: win rate with the card seen vs not</span></div>
          <table className={styles.table}>
            <thead><tr><th>Card</th><th>Seen</th><th>Not seen</th><th>Lift</th><th /></tr></thead>
            <tbody>{[...r.cardContributions.slice(0, 8), ...r.cardContributions.slice(-6)].map(c => <ContribRow key={c.name} c={c} D={D} />)}</tbody>
          </table>
        </section>
        <section className={styles.section} aria-label="Keep guidance">
          <div className={styles.sectionHead}><h2>Opening hands</h2><span className={styles.small}>win rate by what the seven looked like</span></div>
          <table className={styles.table}>
            <thead><tr><th>Hand</th><th>Games</th><th>Win rate</th></tr></thead>
            <tbody>{r.keepGuidance.map(k => <tr key={k.signature}><td>{k.description}</td><td className={styles.num}>{k.games}</td><td className={styles.num}>{pct(k.winRate.value)} <span className="faint">[{pct(k.winRate.ci95?.[0], 0)}, {pct(k.winRate.ci95?.[1], 0)}]</span></td></tr>)}</tbody>
          </table>
        </section>
      </div>

      <div className={styles.grid2}>
        <section className={styles.section} aria-label="Winning patterns">
          <div className={styles.sectionHead}><h2>Winning patterns</h2></div>
          {r.winningPatterns.length ? (
            <table className={styles.table}><thead><tr><th>Pattern</th><th>Games</th><th>Lift</th></tr></thead>
              <tbody>{r.winningPatterns.map(w => <tr key={w.feature}><td>{w.description}</td><td className={styles.num}>{w.games}</td><td className={`${styles.num} ${w.lift >= 0 ? styles.pos : styles.neg}`}>{signed(w.lift)} <span className="faint">[{signed(w.ci95[0])}, {signed(w.ci95[1])}]</span></td></tr>)}</tbody></table>
          ) : <p className={styles.small}>Not enough games for a stable pattern yet.</p>}
        </section>
        <section className={styles.section} aria-label="Check your bulk">
          <div className={styles.sectionHead}><h2>Check your bulk</h2>{r.bulkCheck.length > 0 && <a className={styles.linkBtn} href={optimizerApi.bulkUrl(runId)} target="_blank" rel="noreferrer">plain text</a>}</div>
          {r.bulkCheck.length ? <ul className={styles.list}>{r.bulkCheck.map(b => <li key={b.name}>{b.name} <span className="faint">({b.reason === 'swap-in' ? 'suggested swap-in' : 'in the deck, not registered'})</span></li>)}</ul> : <p className={styles.small}>Every card the best list wants is registered.</p>}
          <p className={styles.small}>Found one? Tick it off on the <Link href="/collection">collection page</Link> and it counts as owned next time.</p>
        </section>
      </div>

      {r.coverageCaveats.length > 0 && (
        <Callout variant="engine" title={`${r.coverageCaveats.length} card${r.coverageCaveats.length === 1 ? '' : 's'} in the best list ${r.coverageCaveats.length === 1 ? 'is' : 'are'} only partly simulated`}>
          <ul className={styles.list}>{r.coverageCaveats.map(c => <li key={c.name}><b>{c.name}</b>: {c.unparsed.join(' · ') || 'unrecognised text'}</li>)}</ul>
        </Callout>
      )}

      <section className={styles.section} aria-label="Best list">
        <div className={styles.sectionHead}><h2>Best list</h2><span className={styles.small}>{r.best.list.reduce((a, e) => a + e.count, 0)} cards</span></div>
        <ul className={styles.list}>{r.best.list.map(e => <li key={e.name}>{e.count > 1 ? `${e.count} ` : ''}{e.name}</li>)}</ul>
      </section>
    </>
  );
}

function SwapRow({ s, D, Open }: { s: SwapReport; D: (p: { id: string }) => React.ReactNode; Open: (p: { id: string }) => React.ReactNode }) {
  const c = s.comparison;
  return (
    <>
      <tr>
        <td className={styles.num}>{s.iteration + 1}</td><td>{s.out}</td><td>{s.in}{s.bulk && <span className={`${styles.tag} ${styles.tagBulk}`}>bulk</span>}</td>
        <td className={`${styles.num} ${c.delta >= 0 ? styles.pos : styles.neg}`}>{signed(c.delta)} pts</td>
        <td className={styles.num}>[{signed(c.ci95[0])}, {signed(c.ci95[1])}]</td>
        <td className={styles.num}>{c.a} / {c.b} / {c.n}</td><td className={styles.num}>{s.reused}</td>
        <td>{c.accepted ? <Badge tone="ok">accepted</Badge> : <Badge tone="neutral">not significant</Badge>}</td>
        <td><D id={s.derivationId} /></td>
      </tr>
      <tr><td colSpan={9} style={{ padding: 0, border: 0 }}><Open id={s.derivationId} /></td></tr>
    </>
  );
}

function ContribRow({ c, D }: { c: CardContribution; D: (p: { id: string }) => React.ReactNode }) {
  return <tr><td>{c.name}</td><td className={styles.num}>{pct(c.withWins / c.withGames, 0)} <span className="faint">({c.withGames})</span></td><td className={styles.num}>{pct(c.withoutWins / c.withoutGames, 0)} <span className="faint">({c.withoutGames})</span></td><td className={`${styles.num} ${c.lift >= 0 ? styles.pos : styles.neg}`}>{signed(c.lift)} <span className="faint">[{signed(c.ci95[0])}, {signed(c.ci95[1])}]</span></td><td><D id={c.derivationId} /></td></tr>;
}
