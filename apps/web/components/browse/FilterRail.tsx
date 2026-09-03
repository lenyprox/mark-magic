'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownAZ, ArrowUpAZ, X } from 'lucide-react';
import type { SetSummary } from '@cards/query';
import { api } from '@/lib/api';
import { activeFilterCount, COLOR_MODES, EMPTY_SEARCH, FORMATS, type SearchState } from '@/lib/search/params';
import { useDebouncedCallback } from '@/lib/hooks/useDebounced';
import { Button, IconButton } from '@/components/ui/Button';
import { Chip, ManaChip } from '@/components/ui/Chip';
import { SearchInput } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Segmented } from '@/components/ui/Segmented';
import { RangeSlider } from '@/components/ui/RangeSlider';
import { ManaSymbol } from '@/components/text/ManaSymbol';
import { SetIcon } from '@/components/text/SetIcon';
import { Typeahead, type TypeaheadItem } from './Typeahead';
import styles from './browse.module.css';

export type Patch = Partial<SearchState>;
export interface FilterRailProps {
  state: SearchState;
  onChange: (patch: Patch) => void;
  /** Keys that are fixed by the page (e.g. set on /sets/[code]) and hidden from the rail. */
  locked?: (keyof SearchState)[];
  searchRef?: React.RefObject<HTMLInputElement | null>;
}

const MODE_LABEL: Record<(typeof COLOR_MODES)[number], string> = { any: 'Any of these', exact: 'Exactly these', subset: 'At most these', superset: 'At least these', identity: 'Identity fits' };
const PRICE_STOPS = [0, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];
const MV_MAX = 16;
const fmtPrice = (v: number) => (v >= 1000 ? '$1000+' : v === 0 ? '$0' : `$${v}`);
const priceIdx = (v: number | null, edge: 'lo' | 'hi') => v == null ? (edge === 'lo' ? 0 : PRICE_STOPS.length - 1) : Math.max(0, PRICE_STOPS.findIndex(s => s >= v));
const formatLabel = (f: string) => f === 'paupercommander' ? 'Pauper Commander' : f === 'predh' ? 'PreDH' : f === 'duel' ? 'Duel Commander' : f === 'oldschool' ? 'Old School' : f === 'penny' ? 'Penny Dreadful' : f.charAt(0).toUpperCase() + f.slice(1);

export function FilterRail({ state, onChange, locked = [], searchRef }: FilterRailProps) {
  const has = (k: keyof SearchState) => !locked.includes(k);
  // Text search is local + debounced so typing never blocks on the URL.
  const [text, setText] = useState(state.q);
  const lastPushed = useRef(state.q);
  useEffect(() => { if (state.q !== lastPushed.current) { setText(state.q); lastPushed.current = state.q; } }, [state.q]);
  const push = useDebouncedCallback((v: string) => { lastPushed.current = v; onChange({ q: v }); }, 280);
  const setQ = (v: string) => { setText(v); push(v); };
  const insertHint = (prefix: string) => { const next = text ? `${text.trim()} ${prefix}` : prefix; setText(next); searchRef?.current?.focus(); };

  const [mv, setMv] = useState<[number, number]>([state.mvmin ?? 0, state.mvmax ?? MV_MAX]);
  useEffect(() => { setMv([state.mvmin ?? 0, state.mvmax ?? MV_MAX]); }, [state.mvmin, state.mvmax]);
  const [price, setPrice] = useState<[number, number]>([priceIdx(state.pmin, 'lo'), priceIdx(state.pmax, 'hi')]);
  useEffect(() => { setPrice([priceIdx(state.pmin, 'lo'), priceIdx(state.pmax, 'hi')]); }, [state.pmin, state.pmax]);

  const sets = useQuery({ queryKey: ['sets'], queryFn: ({ signal }) => api.sets(signal), staleTime: Infinity });
  const setByCode = useMemo(() => new Map((sets.data ?? []).map(s => [s.code, s])), [sets.data]);
  const fetchSets = useCallback(async (q: string): Promise<TypeaheadItem[]> => {
    const list: SetSummary[] = sets.data ?? (await api.sets());
    const s = q.trim().toLowerCase();
    return list.filter(x => !s || x.code.startsWith(s) || x.name.toLowerCase().includes(s)).slice(0, 12).map(x => ({ value: x.code, label: x.name, code: x.code, icon: <SetIcon code={x.code} size={16} /> }));
  }, [sets.data]);
  const fetchCatalog = (kind: 'types' | 'subtypes' | 'supertypes') => async (q: string): Promise<TypeaheadItem[]> => (await api.catalog(kind, q)).slice(0, 12).map(v => ({ value: v, label: v }));
  const fetchTypes = useMemo(() => fetchCatalog('types'), []);
  const fetchSubtypes = useMemo(() => fetchCatalog('subtypes'), []);
  const fetchSupertypes = useMemo(() => fetchCatalog('supertypes'), []);

  const toggle = <K extends 'c' | 'r' | 't' | 'st' | 'sup'>(key: K, v: SearchState[K][number]) => {
    const cur = state[key] as string[];
    onChange({ [key]: cur.includes(v) ? cur.filter(x => x !== v) : [...cur, v] } as Patch);
  };
  const active = activeFilterCount(state);
  const summary: { key: string; label: React.ReactNode; clear: () => void }[] = [];
  if (state.q.trim()) summary.push({ key: 'q', label: `“${state.q.trim()}”`, clear: () => { setText(''); onChange({ q: '' }); } });
  if (has('c') && (state.c.length || state.colorless)) summary.push({ key: 'c', label: state.colorless ? 'Colorless' : `${state.c.join('')} ${state.cm !== 'any' ? MODE_LABEL[state.cm].toLowerCase() : ''}`.trim(), clear: () => onChange({ c: [], colorless: false, cm: 'any' }) });
  for (const t of state.t) summary.push({ key: `t:${t}`, label: t, clear: () => toggle('t', t) });
  for (const t of state.sup) summary.push({ key: `sup:${t}`, label: t, clear: () => toggle('sup', t) });
  for (const t of state.st) summary.push({ key: `st:${t}`, label: t, clear: () => toggle('st', t) });
  if (has('set') && state.set) summary.push({ key: 'set', label: <><SetIcon code={state.set} size={12} />{setByCode.get(state.set)?.name ?? state.set.toUpperCase()}</>, clear: () => onChange({ set: '' }) });
  if (has('r') && state.r.length) summary.push({ key: 'r', label: state.r.join(', '), clear: () => onChange({ r: [] }) });
  if (state.f) summary.push({ key: 'f', label: `${formatLabel(state.f)} ${state.leg}`, clear: () => onChange({ f: '', leg: 'legal' }) });
  if (state.mvmin != null || state.mvmax != null) summary.push({ key: 'mv', label: `MV ${state.mvmin ?? 0}–${state.mvmax ?? `${MV_MAX}+`}`, clear: () => onChange({ mvmin: null, mvmax: null }) });
  if (state.pmin != null || state.pmax != null) summary.push({ key: 'p', label: `${fmtPrice(state.pmin ?? 0)}–${state.pmax == null ? '$1000+' : fmtPrice(state.pmax)}`, clear: () => onChange({ pmin: null, pmax: null }) });

  return (
    <div className={styles.railStack}>
      {active > 0 && (
        <div className={styles.summary} aria-label="Active filters">
          {summary.map(s => <Chip key={s.key} size="sm" pressed onRemove={s.clear}>{s.label}</Chip>)}
          <Button size="sm" variant="ghost" className={styles.summaryClear} icon={<X />} onClick={() => { setText(''); const reset: Patch = { ...EMPTY_SEARCH }; for (const k of locked) delete reset[k]; onChange(reset); }}>Clear</Button>
        </div>
      )}

      <div className={styles.group}>
        <SearchInput ref={searchRef} value={text} onChange={setQ} placeholder="Search name or text" aria-label="Search cards" aria-keyshortcuts="/" />
        <div className={styles.hintRow}>
          <button type="button" onClick={() => insertHint('o:')}><kbd>o:</kbd> rules text</button>
          <button type="button" onClick={() => insertHint('t:')}><kbd>t:</kbd> type line</button>
          <button type="button" onClick={() => insertHint('n:')}><kbd>n:</kbd> name only</button>
        </div>
      </div>

      {has('c') && (
        <fieldset className={styles.group}>
          <legend className={styles.groupHead}><b>Colour</b></legend>
          <div className={styles.manaRow}>
            {(['W', 'U', 'B', 'R', 'G'] as const).map(c => (
              <ManaChip key={c} color={c} pressed={state.c.includes(c)} label={{ W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' }[c]} onClick={() => onChange({ colorless: false, c: state.c.includes(c) ? state.c.filter(x => x !== c) : [...state.c, c] })}>
                <ManaSymbol sym={c} size={20} />
              </ManaChip>
            ))}
            <ManaChip color="C" pressed={state.colorless} label="Colorless only" onClick={() => onChange({ colorless: !state.colorless, c: [] })}><ManaSymbol sym="C" size={20} /></ManaChip>
          </div>
          {state.c.length > 0 && (
            <Select size="sm" aria-label="Colour match" value={state.cm} onChange={(e) => onChange({ cm: e.target.value as SearchState['cm'] })} options={COLOR_MODES.map(m => ({ value: m, label: MODE_LABEL[m] }))} />
          )}
        </fieldset>
      )}

      <div className={styles.group}>
        <div className={styles.groupHead}><b>Type</b></div>
        <Typeahead label="Add a card type" placeholder="Creature, Instant, Land…" fetchItems={fetchTypes} onPick={(it) => { if (!state.t.includes(it.value)) onChange({ t: [...state.t, it.value] }); }} allowFree />
        <Typeahead label="Add a subtype" placeholder="Elf, Equipment, Saga…" fetchItems={fetchSubtypes} onPick={(it) => { if (!state.st.includes(it.value)) onChange({ st: [...state.st, it.value] }); }} allowFree />
        <div className={styles.chips}>
          {['Legendary', 'Basic', 'Snow'].map(s => <Chip key={s} size="sm" pressed={state.sup.includes(s)} onClick={() => toggle('sup', s)}>{s}</Chip>)}
        </div>
        {(state.t.length > 0 || state.st.length > 0) && (
          <div className={styles.chips}>
            {state.t.map(t => <Chip key={`t${t}`} size="sm" pressed onRemove={() => toggle('t', t)}>{t}</Chip>)}
            {state.st.map(t => <Chip key={`s${t}`} size="sm" pressed onRemove={() => toggle('st', t)}>{t}</Chip>)}
          </div>
        )}
      </div>

      {has('set') && (
        <div className={styles.group}>
          <div className={styles.groupHead}><b>Set</b></div>
          {state.set ? (
            <Chip pressed onRemove={() => onChange({ set: '' })} icon={<SetIcon code={state.set} size={14} />}>{setByCode.get(state.set)?.name ?? state.set.toUpperCase()}</Chip>
          ) : (
            <Typeahead label="Filter by set" placeholder="Set name or code" fetchItems={fetchSets} onPick={(it) => onChange({ set: it.value })} />
          )}
        </div>
      )}

      {has('r') && (
        <fieldset className={styles.group}>
          <legend className={styles.groupHead}><b>Rarity</b></legend>
          <div className={styles.chips}>
            {(['common', 'uncommon', 'rare', 'mythic'] as const).map(r => (
              <Chip key={r} size="sm" pressed={state.r.includes(r)} onClick={() => toggle('r', r)} icon={<span className="rarity-dot" data-rarity={r} />}>{r.charAt(0).toUpperCase() + r.slice(1)}</Chip>
            ))}
          </div>
        </fieldset>
      )}

      <div className={styles.group}>
        <div className={styles.groupHead}><b>Format</b></div>
        <Select size="sm" aria-label="Format" value={state.f} placeholder="Any format" onChange={(e) => onChange({ f: e.target.value, leg: 'legal' })} options={FORMATS.map(f => ({ value: f, label: formatLabel(f) }))} />
        {state.f && (
          <Segmented size="sm" label="Legality" value={state.leg} onChange={(leg) => onChange({ leg })} className={styles.legality} options={[{ value: 'legal', label: 'Legal' }, { value: 'restricted', label: 'Restricted' }, { value: 'banned', label: 'Banned' }]} />
        )}
      </div>

      <div className={styles.group}>
        <div className={styles.groupHead}><b>Mana value</b></div>
        <RangeSlider min={0} max={MV_MAX} value={mv} onChange={setMv} label="Mana value" format={(v, e) => (e === 'hi' && v === MV_MAX ? `${MV_MAX}+` : String(v))}
          onCommit={([lo, hi]) => onChange({ mvmin: lo === 0 ? null : lo, mvmax: hi === MV_MAX ? null : hi })} />
      </div>

      <div className={styles.group}>
        <div className={styles.groupHead}><b>Price</b><span className="mono">USD</span></div>
        <RangeSlider min={0} max={PRICE_STOPS.length - 1} value={price} onChange={setPrice} label="Price" format={(i) => fmtPrice(PRICE_STOPS[i])}
          onCommit={([lo, hi]) => onChange({ pmin: lo === 0 ? null : PRICE_STOPS[lo], pmax: hi === PRICE_STOPS.length - 1 ? null : PRICE_STOPS[hi] })} />
      </div>

      {has('sort') && (
        <div className={styles.group}>
          <div className={styles.groupHead}><b>Sort</b></div>
          <div className={styles.inline}>
            <Select size="sm" aria-label="Sort by" value={state.sort ?? (state.q.trim() ? 'relevance' : 'edhrec')} onChange={(e) => onChange({ sort: e.target.value as SearchState['sort'], dir: null })}
              options={[{ value: 'edhrec', label: 'Most played' }, { value: 'relevance', label: 'Relevance', disabled: !state.q.trim() }, { value: 'name', label: 'Name' }, { value: 'released', label: 'Release date' }, { value: 'mv', label: 'Mana value' }, { value: 'price', label: 'Price' }, ...(state.mode === 'printing' ? [{ value: 'collector', label: 'Collector number' }] : [])]} />
            <IconButton size="sm" variant="quiet" className={styles.dirBtn} label={state.dir === 'asc' ? 'Ascending, switch to descending' : 'Descending, switch to ascending'} onClick={() => onChange({ dir: state.dir === 'asc' ? 'desc' : 'asc' })}>
              {state.dir === 'asc' ? <ArrowDownAZ /> : <ArrowUpAZ />}
            </IconButton>
          </div>
        </div>
      )}
    </div>
  );
}
