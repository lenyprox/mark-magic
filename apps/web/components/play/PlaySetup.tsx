'use client';
// /play setup: pick decks for two to four seats, seed and settings, then deal. The game is started here (payloads
// fetched, store started) and the setup is persisted so a hard reload of /play/<gameId> can re-create it. The
// human always sits at seat 0; every other seat is an AI (or "AI vs AI" spectates every seat).
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Dices, Cpu, FlaskConical, Layers, Swords } from 'lucide-react';
import { DEFAULT_START_OPTIONS, type StartOptions } from '@play/protocol';
import { META_FORMATS, type ArchetypeSummary } from '@meta/types';
import type { ArchetypeProfile } from '@analysis/types';
import { Button, Callout, Input, Segmented, Select, type SelectOption } from '@/components/ui';
import { toast } from '@/lib/stores/ui';
import { deckRefKey, fetchBundledDecks, fetchDecks, makeGameId, payloadFor, type DeckRef } from '@/lib/game/api';
import { useGameStore } from '@/lib/game/store';
import { loadLastSetup, randomSeed, saveSetup, seatsOf } from '@/lib/game/ui';
import styles from './setup.module.css';

type Strength = '100' | '300' | '600';
type Trials = '100' | '200' | '400';
type SeatCount = '2' | '3' | '4';

const refKey = deckRefKey;

async function fetchArchetypes(): Promise<{ format: string; archetypes: ArchetypeSummary[] }[]> {
  const out: { format: string; archetypes: ArchetypeSummary[] }[] = [];
  await Promise.all(META_FORMATS.map(async f => {
    try {
      const r = await fetch(`/api/meta/${f}?limit=1`); if (!r.ok) return;
      const j = (await r.json()) as { archetypes: ArchetypeSummary[] };
      if (j.archetypes?.length) out.push({ format: f, archetypes: j.archetypes });
    } catch { /* meta not configured */ }
  }));
  return out.sort((a, b) => META_FORMATS.indexOf(a.format as typeof META_FORMATS[number]) - META_FORMATS.indexOf(b.format as typeof META_FORMATS[number]));
}

export function PlaySetup() {
  const router = useRouter();
  const start = useGameStore(s => s.start);
  const last = useMemo(() => (typeof window === 'undefined' ? null : loadLastSetup()), []);
  const lastSeats = useMemo(() => (last ? seatsOf(last) : []), [last]);

  const bundled = useQuery({ queryKey: ['bundled-decks'], queryFn: fetchBundledDecks });
  const mine = useQuery({ queryKey: ['decks', 'mine'], queryFn: () => fetchDecks('mine') });
  const opps = useQuery({ queryKey: ['decks', 'opponent'], queryFn: () => fetchDecks('opponent') });
  const meta = useQuery({ queryKey: ['meta-archetypes'], queryFn: fetchArchetypes, staleTime: 60_000 });

  const myRefs = useMemo<DeckRef[]>(() => [
    ...(mine.data ?? []).map(d => ({ kind: 'saved', id: d.id, name: d.name } as DeckRef)),
    ...(bundled.data ?? []).map(d => ({ kind: 'bundled', file: d.file, name: d.name } as DeckRef)),
  ], [mine.data, bundled.data]);
  const oppRefs = useMemo<DeckRef[]>(() => [
    ...(opps.data ?? []).map(d => ({ kind: 'saved', id: d.id, name: d.name } as DeckRef)),
    ...(bundled.data ?? []).map(d => ({ kind: 'bundled', file: d.file, name: d.name } as DeckRef)),
    ...(meta.data ?? []).flatMap(g => g.archetypes.map(a => ({ kind: 'archetype', id: a.id, name: a.name, format: g.format } as DeckRef))),
  ], [opps.data, bundled.data, meta.data]);

  const [seatCount, setSeatCount] = useState<SeatCount>(() => (lastSeats.length >= 2 && lastSeats.length <= 4 ? String(lastSeats.length) : '2') as SeatCount);
  const [myKey, setMyKey] = useState('');
  const [oppKey, setOppKey] = useState('');
  const [seat2Key, setSeat2Key] = useState('');
  const [seat3Key, setSeat3Key] = useState('');
  const [spectate, setSpectate] = useState<boolean>(last?.options.humanSeat === null);
  useEffect(() => { if (!myKey && myRefs.length) setMyKey(last?.a ? refKey(last.a) : refKey(myRefs[0])); }, [myRefs, myKey, last]);
  useEffect(() => { if (!oppKey && oppRefs.length) setOppKey(last?.b ? refKey(last.b) : refKey(oppRefs[Math.min(1, oppRefs.length - 1)])); }, [oppRefs, oppKey, last]);
  useEffect(() => { if (!seat2Key && oppRefs.length) setSeat2Key(lastSeats[2] ? refKey(lastSeats[2]) : refKey(oppRefs[Math.min(2, oppRefs.length - 1)])); }, [oppRefs, seat2Key, lastSeats]);
  useEffect(() => { if (!seat3Key && oppRefs.length) setSeat3Key(lastSeats[3] ? refKey(lastSeats[3]) : refKey(oppRefs[Math.min(3, oppRefs.length - 1)])); }, [oppRefs, seat3Key, lastSeats]);

  const [seed, setSeed] = useState<string>(() => String(last?.options.seed ?? randomSeed()));
  const [life, setLife] = useState<number>(last?.options.startingLife ?? DEFAULT_START_OPTIONS.startingLife);
  const [lifeTouched, setLifeTouched] = useState(false);
  const [mulligans, setMulligans] = useState<boolean>(last?.options.mulligans ?? DEFAULT_START_OPTIONS.mulligans);
  const [strength, setStrength] = useState<Strength>(String(last?.options.ai.maxSims ?? 300) as Strength);
  const [aiSearch, setAiSearch] = useState<'oneply' | 'mcts'>(last?.options.ai.policy ?? 'oneply');
  const [knowsList, setKnowsList] = useState<boolean>(last?.options.ai.knowsOpponentList ?? false);
  const [cheat, setCheat] = useState<boolean>(last?.options.ai.cheat ?? false);
  const [anEnabled, setAnEnabled] = useState<boolean>(last?.options.analysis.enabled ?? true);
  const [trials, setTrials] = useState<Trials>(String(last?.options.analysis.trials ?? 200) as Trials);
  const [policy, setPolicy] = useState<'rollout' | 'ai30'>(last?.options.analysis.policy ?? 'rollout');
  const [oppModel, setOppModel] = useState<'exact' | 'archetype' | 'none'>(last?.options.analysis.opponentModel ?? 'exact');
  const [name, setName] = useState<string>(last?.playerName ?? 'You');
  const [dealing, setDealing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const n = Number(seatCount);
  const myRef = myRefs.find(r => refKey(r) === myKey) ?? null;
  const oppRef = oppRefs.find(r => refKey(r) === oppKey) ?? null;
  const seat2Ref = oppRefs.find(r => refKey(r) === seat2Key) ?? null;
  const seat3Ref = oppRefs.find(r => refKey(r) === seat3Key) ?? null;
  const seatRefs: (DeckRef | null)[] = [myRef, oppRef, ...(n >= 3 ? [seat2Ref] : []), ...(n >= 4 ? [seat3Ref] : [])];
  const allChosen = seatRefs.every((r): r is DeckRef => !!r);
  const formatOf = (r: DeckRef | null) => r?.kind === 'saved' ? ([...(mine.data ?? []), ...(opps.data ?? [])].find(d => d.id === r.id)?.format ?? null) : null;
  const commanderDecks = seatRefs.filter(r => /^(commander|edh|cedh|brawl)$/i.test(formatOf(r) ?? '')).map(r => r!.name);
  useEffect(() => { if (!lifeTouched) setLife(commanderDecks.length ? 40 : DEFAULT_START_OPTIONS.startingLife); }, [commanderDecks.length, lifeTouched]);
  const seedNum = Number(seed);
  const seedOk = Number.isInteger(seedNum) && seedNum >= 0;

  const myOptions: SelectOption[] = myRefs.map(r => ({ value: refKey(r), label: r.kind === 'saved' ? `${r.name} · saved` : `${r.name} · bundled` }));
  const oppOptions: SelectOption[] = oppRefs.map(r => ({ value: refKey(r), label: r.kind === 'saved' ? `${r.name} · opponent deck` : r.kind === 'bundled' ? `${r.name} · bundled` : `${r.name} · ${r.format} archetype` }));

  const deal = async () => {
    if (!allChosen || !seedOk || dealing) return;
    const refs = seatRefs as DeckRef[];
    setDealing(true); setError(null);
    try {
      const payloads = await Promise.all(refs.map(r => payloadFor(r, seedNum)));
      const b = payloads[1];
      let profile: ArchetypeProfile | null = null;
      const wantArchetype = oppModel === 'archetype' && refs[1].kind === 'archetype';
      if (wantArchetype) {
        try { const r = await fetch(`/api/meta/archetypes/${(refs[1] as { id: string }).id}`); if (r.ok) profile = ((await r.json()) as { profile: ArchetypeProfile | null }).profile ?? null; } catch { profile = null; }
      }
      const options: StartOptions = {
        ...DEFAULT_START_OPTIONS, seed: seedNum, startingLife: life, mulligans, humanSeat: spectate ? null : 0,
        ai: { ...DEFAULT_START_OPTIONS.ai, maxSims: Number(strength), knowsOpponentList: knowsList, cheat, policy: aiSearch, iterations: aiSearch === 'mcts' ? Math.round(Number(strength) / 2.5) : undefined },
        analysis: { ...DEFAULT_START_OPTIONS.analysis, enabled: anEnabled && refs.length === 2, trials: Number(trials), policy, opponentModel: wantArchetype && profile ? 'archetype' : oppModel === 'archetype' ? 'exact' : oppModel, opponentProfile: profile },
        playerName: name.trim() || 'You', aiName: b.archetype?.name ?? refs[1].name,
      };
      const gameId = makeGameId(seedNum, refs);
      saveSetup(gameId, { a: refs[0], b: refs[1], seats: refs, options, playerName: options.playerName });
      void start(gameId, payloads, options);
      router.push(`/play/${encodeURIComponent(gameId)}`);
    } catch (e) {
      setError((e as Error).message);
      toast({ title: 'Could not deal', body: (e as Error).message, kind: 'danger' });
      setDealing(false);
    }
  };

  const loading = bundled.isLoading || mine.isLoading;
  const seatSelect = (label: string, testId: string, value: string, onChange: (v: string) => void) => (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <Select data-testid={testId} aria-label={label} value={value} onChange={e => onChange(e.target.value)} options={oppOptions} disabled={loading || !oppOptions.length} placeholder={loading ? 'Loading decks…' : undefined} />
    </div>
  );

  return (
    <div className={`container ${styles.page}`}>
      <div className={styles.head}>
        <div>
          <h1>Play</h1>
          <p className={styles.lede}>Sit down against the reactive AI, or a pod of them. Every game is reproducible from its seed; the analysis panel shows the odds behind each play and how they were derived.</p>
        </div>
        {last && <div className={styles.lastGame}>Last table: {lastSeats.map(r => r.name).join(' vs ')} · seed <span className="mono">{last.options.seed}</span></div>}
      </div>

      <div className={styles.grid}>
        <section className={styles.card} aria-labelledby="setup-decks">
          <h2 id="setup-decks"><Layers aria-hidden /> Decks</h2>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>Players</span>
            <Segmented<SeatCount> label="Players" value={seatCount} onChange={setSeatCount} options={[{ value: '2', label: 'Duel · 2' }, { value: '3', label: 'Pod · 3' }, { value: '4', label: 'Pod · 4' }]} size="sm" />
            <span className={styles.deckMeta}>{n > 2 ? 'You sit at seat 1; the others are AIs. Play analysis is available in duels only.' : 'Heads-up against one AI.'}</span>
          </div>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>My deck</span>
            <Select data-testid="play-my-deck" aria-label="My deck" value={myKey} onChange={e => setMyKey(e.target.value)} options={myOptions} disabled={loading || !myOptions.length} placeholder={loading ? 'Loading decks…' : myOptions.length ? undefined : 'No decks yet'} />
            <span className={styles.deckMeta}>{mine.data?.length ? `${mine.data.length} saved` : 'No saved decks'} · {bundled.data?.length ?? 0} bundled</span>
          </div>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>{n > 2 ? 'Seat 2 (AI)' : 'Opponent'}</span>
            <Select data-testid="play-opp-deck" aria-label="Opponent deck" value={oppKey} onChange={e => setOppKey(e.target.value)} options={oppOptions} disabled={loading || !oppOptions.length} placeholder={loading ? 'Loading decks…' : undefined} />
            <span className={styles.deckMeta}>
              {opps.data?.length ? `${opps.data.length} opponent decks` : 'No opponent decks'}
              {meta.data?.length ? ` · ${meta.data.reduce((acc, g) => acc + g.archetypes.length, 0)} metagame archetypes` : ' · metagame not synced'}
            </span>
          </div>
          {n >= 3 && seatSelect('Seat 3 (AI)', 'play-seat-deck-2', seat2Key, setSeat2Key)}
          {n >= 4 && seatSelect('Seat 4 (AI)', 'play-seat-deck-3', seat3Key, setSeat3Key)}
          <div className={styles.field}>
            <span className={styles.fieldLabel}>Your name</span>
            <Input aria-label="Your name" value={name} onChange={e => setName(e.target.value)} maxLength={24} />
          </div>
          <label className={styles.toggle}>
            <input type="checkbox" checked={spectate} onChange={e => setSpectate(e.target.checked)} data-testid="play-spectate" />
            <span><b>AI vs AI</b><br /><span className={styles.toggleHint}>Spectate: every seat is played by the AI</span></span>
          </label>
          {commanderDecks.length > 0 && (
            <Callout variant="info" title="Commander rules are on">
              {commanderDecks.join(' and ')}: commanders start in the command zone (drag yours onto the battlefield to cast it; the tax adds {'{2}'} per previous cast), a commander that would leave the battlefield returns to the command zone, and 21 combat damage from one commander loses the game. Starting life defaults to 40.
            </Callout>
          )}
        </section>

        <section className={styles.card} aria-labelledby="setup-table">
          <h2 id="setup-table"><Dices aria-hidden /> Table</h2>
          <div className={styles.row}>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Seed</span>
              <div className={styles.row}>
                <Input data-testid="play-seed" aria-label="Seed" className={styles.seed} inputMode="numeric" value={seed} onChange={e => setSeed(e.target.value.replace(/[^\d]/g, ''))} wrapClassName="grow" aria-invalid={!seedOk} />
                <Button variant="quiet" icon={<Dices size={14} />} onClick={() => setSeed(String(randomSeed()))}>Random</Button>
              </div>
            </div>
          </div>
          <div className={styles.row}>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Starting life</span>
              <Segmented label="Starting life" value={String(life)} onChange={v => { setLife(Number(v)); setLifeTouched(true); }} options={[{ value: '20', label: '20' }, { value: '25', label: '25' }, { value: '30', label: '30' }, { value: '40', label: '40' }]} size="sm" />
            </div>
            <label className={styles.toggle}>
              <input type="checkbox" checked={mulligans} onChange={e => setMulligans(e.target.checked)} />
              <span><b>Mulligans</b><br /><span className={styles.toggleHint}>London mulligan for every seat</span></span>
            </label>
          </div>
          <Callout variant="info" title="Who plays first">The engine flips a coin from the seed, so the same seed always yields the same opening. The log's first line tells you who won the toss.</Callout>
        </section>

        <section className={styles.card} aria-labelledby="setup-ai">
          <h2 id="setup-ai"><Cpu aria-hidden /> Opponent AI</h2>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>Strength (simulations per decision)</span>
            <Segmented label="AI strength" value={strength} onChange={setStrength} options={[{ value: '100', label: 'Quick · 100' }, { value: '300', label: 'Standard · 300' }, { value: '600', label: 'Strong · 600' }]} size="sm" />
            <span className={styles.fieldLabel}>Search</span>
            <Segmented<'oneply' | 'mcts'> label="AI search" value={aiSearch} onChange={setAiSearch} options={[{ value: 'oneply', label: 'One ply · fast' }, { value: 'mcts', label: 'Look-ahead · MCTS' }]} size="sm" />
          </div>
          <label className={styles.toggle}>
            <input type="checkbox" checked={knowsList} onChange={e => setKnowsList(e.target.checked)} />
            <span><b>AI knows my decklist</b><br /><span className={styles.toggleHint}>It still never sees your hand or library order</span></span>
          </label>
          <label className={styles.toggle}>
            <input type="checkbox" checked={cheat} onChange={e => setCheat(e.target.checked)} />
            <span><b>AI may peek (cheat)</b><br /><span className={styles.toggleHint}>Off: the AI plays from sampled worlds of hidden information</span></span>
          </label>
        </section>

        <section className={styles.card} aria-labelledby="setup-analysis">
          <h2 id="setup-analysis"><FlaskConical aria-hidden /> Analysis</h2>
          <label className={styles.toggle}>
            <input type="checkbox" checked={anEnabled} onChange={e => setAnEnabled(e.target.checked)} disabled={n > 2} />
            <span><b>Show play analysis</b><br /><span className={styles.toggleHint}>{n > 2 ? 'Duels only for now' : 'Win odds per candidate play with verifiable derivations'}</span></span>
          </label>
          <div className={styles.settings}>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Monte Carlo trials</span>
              <Segmented label="Trials" value={trials} onChange={setTrials} options={[{ value: '100', label: '100' }, { value: '200', label: '200' }, { value: '400', label: '400' }]} size="sm" />
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Rollout policy</span>
              <Segmented label="Policy" value={policy} onChange={setPolicy} options={[{ value: 'rollout', label: 'Rollout', title: 'Fast heuristic rollouts' }, { value: 'ai30', label: 'AI · 30', title: 'Slower: the AI plays each trial with 30 sims' }]} size="sm" />
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Opponent model</span>
              <Segmented label="Opponent model" value={oppModel} onChange={setOppModel} options={[{ value: 'exact', label: 'Exact list' }, { value: 'archetype', label: 'Archetype', title: 'Card inclusion statistics from the metagame (needs an archetype opponent)' }, { value: 'none', label: 'None' }]} size="sm" />
            </div>
          </div>
        </section>
      </div>

      {error && <Callout variant="danger" title="Could not deal" className={styles.wide}>{error}</Callout>}
      <div className={styles.deal}>
        <span className="faint small">Game id is derived from the seed and every seat's deck.</span>
        <Button name="Deal" variant="primary" className={styles.dealBtn} icon={<Swords size={16} />} disabled={!allChosen || !seedOk || dealing} onClick={deal} aria-busy={dealing}>
          {dealing ? 'Dealing…' : 'Deal'}
        </Button>
      </div>
    </div>
  );
}
