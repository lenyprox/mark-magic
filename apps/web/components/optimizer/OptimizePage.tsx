'use client';
// /optimize: the list of optimiser runs and the "new run" form (seed deck, field, preset, pool, constraints).
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, Plus, Trash2 } from 'lucide-react';
import type { DeckSummary } from '@user/decks';
import type { FieldEntry } from '@optimizer/types';
import { deckApi } from '@/lib/deck/api';
import { optimizerApi, type CreateRunRequest, type Preset, type RunListItem } from '@/lib/optimizer/api';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Segmented } from '@/components/ui/Segmented';
import { Input } from '@/components/ui/Input';
import { Badge, Callout, EmptyState } from '@/components/ui/Display';
import styles from './optimizer.module.css';

const PRESET_TEXT: Record<Preset, string> = { quick: '3,000 games · about the coffee-break size', standard: '15,000 games · an evening', deep: '60,000 games · overnight' };

export function statusTone(s: RunListItem['status'], stale: boolean): 'ok' | 'warn' | 'danger' | 'info' | 'neutral' {
  if (stale) return 'warn';
  return s === 'done' ? 'ok' : s === 'failed' ? 'danger' : s === 'running' || s === 'queued' ? 'info' : s === 'cancelled' ? 'neutral' : 'warn';
}

export function OptimizePage({ initialDeckId }: { initialDeckId: string | null }) {
  const qc = useQueryClient();
  const runs = useQuery({ queryKey: ['optimizer', 'runs'], queryFn: () => optimizerApi.list(), refetchInterval: 4000 });
  const [creating, setCreating] = useState(!!initialDeckId);
  const list = runs.data?.runs ?? [];
  return (
    <div className={styles.page} data-testid="optimize-page">
      <div className={styles.head}>
        <div><h1>Optimise</h1><p className="faint">Simulated deck search over the cards you own: thousands of seeded games, paired swaps, and a report whose every number can be replayed.</p></div>
        <Button variant="primary" onClick={() => setCreating(c => !c)} data-testid="optimize-new"><Plus size={14} aria-hidden /> New run</Button>
      </div>
      {creating && <NewRunForm initialDeckId={initialDeckId} onDone={() => { setCreating(false); void qc.invalidateQueries({ queryKey: ['optimizer', 'runs'] }); }} />}
      {list.length === 0 && !runs.isLoading ? <EmptyState title="No runs yet">Pick a deck and a field of opponents to start one.</EmptyState> : (
        <div className={styles.runs}>
          {list.map(r => <RunCard key={r.id} run={r} onRemove={async () => { await optimizerApi.remove(r.id); void qc.invalidateQueries({ queryKey: ['optimizer', 'runs'] }); }} />)}
        </div>
      )}
    </div>
  );
}

function RunCard({ run, onRemove }: { run: RunListItem; onRemove: () => void }) {
  const p = run.progress; const pct = (x: number | null) => x === null ? '–' : `${(x * 100).toFixed(1)}%`;
  return (
    <div className={styles.runCard} data-testid="optimize-run-card">
      <div>
        <Link href={`/optimize/${run.id}`} className={styles.runTitle}>{run.name}</Link>
        <div className={styles.runMeta}>
          <Badge tone={statusTone(run.status, run.stale)}>{run.stale ? 'stalled' : run.status}</Badge>
          <span>{run.deckName ?? run.deckId}</span>
          <span>{run.spec.players}-player · {run.spec.format}</span>
          <span>iteration {p.iteration}/{p.maxIterations}</span>
          <span>{p.gamesSimulated.toLocaleString()} games simulated{p.gamesReused ? `, ${p.gamesReused.toLocaleString()} reused` : ''}</span>
          <span className="faint">{new Date(run.createdAt).toLocaleString()}</span>
        </div>
        {p.message && <div className={styles.small}>{p.message}</div>}
      </div>
      <div className={styles.runRight}>
        <div className={styles.big} title="best win rate so far">{pct(p.bestWinRate)}</div>
        <div className={styles.small}>baseline {pct(p.baselineWinRate)}</div>
        <button type="button" className={styles.linkBtn} onClick={onRemove} aria-label={`Delete run ${run.name}`}><Trash2 size={13} aria-hidden /> delete</button>
      </div>
    </div>
  );
}

function NewRunForm({ initialDeckId, onDone }: { initialDeckId: string | null; onDone: () => void }) {
  const router = useRouter();
  const decks = useQuery({ queryKey: ['decks', 'all'], queryFn: () => deckApi.list() });
  const all: DeckSummary[] = useMemo(() => decks.data ?? [], [decks.data]);
  const [deckId, setDeckId] = useState(initialDeckId ?? '');
  const [field, setField] = useState<string[]>([]);
  const [preset, setPreset] = useState<Preset>('quick');
  const [players, setPlayers] = useState<'2' | '4'>('2');
  const [pool, setPool] = useState<'owned' | 'owned+bulk'>('owned');
  const [maxUnowned, setMaxUnowned] = useState('5');
  const [seed, setSeed] = useState('');
  const [lockIn, setLockIn] = useState('');
  const [ban, setBan] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (!deckId && all.length) setDeckId(all[0].id); }, [all, deckId]);
  const seedDeck = all.find(d => d.id === deckId);
  const others = all.filter(d => d.id !== deckId);
  const need = players === '4' ? 3 : 1;
  useEffect(() => { setField(f => { const kept = f.filter(id => others.some(d => d.id === id)); const out = [...kept]; for (const d of others) { if (out.length >= need) break; if (!out.includes(d.id)) out.push(d.id); } return out.slice(0, Math.max(need, kept.length)); }); }, [deckId, players, all.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const deckOptions = all.map(d => ({ value: d.id, label: `${d.name} (${d.format}${d.role === 'opponent' ? ', opponent' : ''})` }));
  const oppOptions = others.map(d => ({ value: d.id, label: `${d.name} (${d.format})` }));
  const commanderish = seedDeck && /^(commander|edh|cedh|brawl)$/i.test(seedDeck.format);

  async function submit() {
    if (!deckId || !field.length) return;
    setBusy(true); setError(null);
    try {
      const body: CreateRunRequest = { deckId, name: name || undefined, preset, field: field.map(id => ({ kind: 'deck', deckId: id, name: all.find(d => d.id === id)?.name ?? id, weight: 1 } as FieldEntry)), players: players === '4' ? 4 : 2, pool, maxUnowned: Number(maxUnowned) || 0, seed: seed ? Number(seed) : undefined, lockIn: lockIn.split(/\n|;/).map(s => s.trim()).filter(Boolean), ban: ban.split(/\n|;/).map(s => s.trim()).filter(Boolean) };
      const { run } = await optimizerApi.create(body);
      onDone(); router.push(`/optimize/${run.id}`);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className={styles.form} data-testid="optimize-form">
      <div className={styles.row}>
        <Select label="Deck to optimise" options={deckOptions} value={deckId} onChange={e => setDeckId(e.target.value)} wrapClassName={styles.field} data-testid="optimize-deck" />
        <Segmented<'2' | '4'> label="Table" value={players} onChange={setPlayers} options={[{ value: '2', label: 'Duel' }, { value: '4', label: '4-player pod' }]} />
        <Segmented<Preset> label="Budget" value={preset} onChange={setPreset} options={[{ value: 'quick', label: 'Quick' }, { value: 'standard', label: 'Standard' }, { value: 'deep', label: 'Deep' }]} />
        <span className={styles.small}>{PRESET_TEXT[preset]}</span>
      </div>
      <div className={styles.fieldList}>
        <span className={styles.small}>Field ({need === 1 ? 'the opponent' : `${need} opponents per game, rotating seats`})</span>
        {field.map((id, i) => (
          <div className={styles.fieldRow} key={i}>
            <Select options={oppOptions} value={id} onChange={e => setField(f => f.map((x, k) => (k === i ? e.target.value : x)))} size="sm" data-testid={`optimize-field-${i}`} />
            {field.length > need && <button type="button" className={styles.linkBtn} onClick={() => setField(f => f.filter((_, k) => k !== i))}>remove</button>}
          </div>
        ))}
        {others.length > field.length && <button type="button" className={styles.linkBtn} onClick={() => setField(f => [...f, others.find(d => !f.includes(d.id))!.id])}>+ add an opponent</button>}
      </div>
      <div className={styles.row}>
        <Segmented<'owned' | 'owned+bulk'> label="Card pool" value={pool} onChange={setPool} options={[{ value: 'owned', label: 'Registered cards' }, { value: 'owned+bulk', label: '+ popular unregistered' }]} />
        {pool === 'owned+bulk' && <Input label="Max unregistered swaps" size="sm" value={maxUnowned} onChange={e => setMaxUnowned(e.target.value.replace(/\D/g, ''))} wrapClassName={styles.field} />}
        <Input label="Seed (blank = random)" size="sm" value={seed} onChange={e => setSeed(e.target.value.replace(/\D/g, ''))} wrapClassName={styles.field} />
        <Input label="Run name" size="sm" value={name} onChange={e => setName(e.target.value)} wrapClassName={styles.field} placeholder={seedDeck ? `${seedDeck.name} vs …` : ''} />
      </div>
      <div className={styles.row}>
        <Input label="Never swap out (names, ; separated)" size="sm" value={lockIn} onChange={e => setLockIn(e.target.value)} wrapClassName={styles.field} />
        <Input label="Never swap in (names, ; separated)" size="sm" value={ban} onChange={e => setBan(e.target.value)} wrapClassName={styles.field} />
      </div>
      {commanderish && <Callout variant="info" title="Commander run">Games use the command zone, the tax and 40 life; swap-ins stay inside the commander&apos;s colour identity and singleton.</Callout>}
      {error && <p className={styles.err} role="alert">{error}</p>}
      <div className={styles.actions}>
        <Button variant="primary" onClick={submit} disabled={busy || !deckId || field.length < need} data-testid="optimize-start"><Play size={14} aria-hidden /> {busy ? 'Starting…' : 'Start the run'}</Button>
        <span className={styles.small}>Runs in a background process; you can close this page and come back.</span>
      </div>
    </div>
  );
}
