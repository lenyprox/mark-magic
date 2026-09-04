'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { Clock, Layers, LayoutGrid, Library, Package, Play, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { imgUrl } from '@/lib/img';
import { useDebouncedValue } from '@/lib/hooks/useDebounced';
import { useLocalStorage } from '@/lib/hooks/useLocalStorage';
import { useUi } from '@/lib/stores/ui';
import { Dialog } from '@/components/ui/Dialog';
import { Kbd } from '@/components/ui/Display';
import { ManaCost } from '@/components/text/ManaSymbol';
import { SetIcon } from '@/components/text/SetIcon';
import styles from './shell.module.css';

interface Recent { kind: 'card' | 'set'; id: string; label: string; sub?: string; printingId?: string }
const ACTIONS = [
  { id: 'cards', label: 'Browse cards', href: '/cards', icon: <LayoutGrid /> },
  { id: 'sets', label: 'Sets', href: '/sets', icon: <Layers /> },
  { id: 'decks', label: 'Decks', href: '/decks', icon: <Library /> },
  { id: 'collection', label: 'Collection', href: '/collection', icon: <Package /> },
  { id: 'optimize', label: 'Optimise a deck', href: '/optimize', icon: <Package /> },
  { id: 'owned', label: 'Browse owned cards', href: '/cards?own=1', icon: <Package /> },
  { id: 'play', label: 'Play', href: '/play', icon: <Play /> },
];

export function CommandPalette() {
  const open = useUi(s => s.paletteOpen);
  const setOpen = useUi(s => s.setPaletteOpen);
  const router = useRouter();
  const [q, setQ] = useState('');
  const dq = useDebouncedValue(q, 120);
  const [recent, setRecent] = useLocalStorage<Recent[]>('vault.recent', []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen(!useUi.getState().paletteOpen); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);
  useEffect(() => { if (!open) setQ(''); }, [open]);

  const cards = useQuery({ queryKey: ['autocomplete', dq], queryFn: ({ signal }) => api.autocomplete(dq, 8, signal), enabled: open && dq.trim().length >= 2, staleTime: 5 * 60_000 });
  const sets = useQuery({ queryKey: ['sets'], queryFn: ({ signal }) => api.sets(signal), enabled: open, staleTime: Infinity });
  const setHits = useMemo(() => {
    const s = dq.trim().toLowerCase(); if (!s || !sets.data) return [];
    return sets.data.filter(x => x.code.startsWith(s) || x.name.toLowerCase().includes(s)).slice(0, 5);
  }, [dq, sets.data]);

  const close = useCallback(() => setOpen(false), [setOpen]);
  const go = (href: string, r?: Recent) => {
    if (r) setRecent(prev => [r, ...prev.filter(p => !(p.kind === r.kind && p.id === r.id))].slice(0, 8));
    close(); router.push(href);
  };

  return (
    <Dialog open={open} onClose={close} plain width={640} className={styles.palette} closeLabel="Close search">
      <Command label="Search cards, sets and actions" shouldFilter={false} loop>
        <div className={styles.paletteInputRow}>
          <Search aria-hidden />
          <Command.Input autoFocus value={q} onValueChange={setQ} placeholder="Card name, set, or action…" className={styles.paletteInput} />
        </div>
        <Command.List className={styles.paletteList}>
          <Command.Empty className={styles.paletteEmpty}>{dq.trim().length < 2 ? 'Type a card name, or pick a place to go.' : cards.isFetching ? 'Searching…' : 'No cards or sets match that.'}</Command.Empty>
          {cards.data && cards.data.length > 0 && (
            <Command.Group heading="Cards" className={styles.paletteGroup}>
              {cards.data.map(c => (
                <Command.Item key={c.oracleId} value={`card:${c.oracleId}`} className={styles.paletteItem} onSelect={() => go(`/cards/${c.oracleId}`, { kind: 'card', id: c.oracleId, label: c.name, sub: c.typeLine, printingId: c.printingId })}>
                  <span className={styles.paletteThumb}><img src={imgUrl(c.printingId, 'small')} alt="" loading="lazy" /></span>
                  <span><span className={styles.paletteName}>{c.name}</span><div className={styles.paletteSub}>{c.typeLine}</div></span>
                  <ManaCost cost={c.manaCost} size={14} />
                </Command.Item>
              ))}
            </Command.Group>
          )}
          {setHits.length > 0 && (
            <Command.Group heading="Sets" className={styles.paletteGroup}>
              {setHits.map(s => (
                <Command.Item key={s.code} value={`set:${s.code}`} className={styles.paletteItem} onSelect={() => go(`/sets/${s.code}`, { kind: 'set', id: s.code, label: s.name, sub: s.code.toUpperCase() })}>
                  <span className={styles.paletteIcon}><SetIcon code={s.code} size={18} /></span>
                  <span><span className={styles.paletteName}>{s.name}</span><div className={styles.paletteSub}>{s.cardCount} cards in {s.code.toUpperCase()}</div></span>
                  <span className={styles.paletteSub}>{s.releasedAt?.slice(0, 4)}</span>
                </Command.Item>
              ))}
            </Command.Group>
          )}
          {dq.trim().length < 2 && recent.length > 0 && (
            <Command.Group heading="Recent" className={styles.paletteGroup}>
              {recent.map(r => (
                <Command.Item key={`${r.kind}:${r.id}`} value={`recent:${r.kind}:${r.id}`} className={styles.paletteItem} onSelect={() => go(r.kind === 'card' ? `/cards/${r.id}` : `/sets/${r.id}`, r)}>
                  {r.kind === 'card' && r.printingId ? <span className={styles.paletteThumb}><img src={imgUrl(r.printingId, 'small')} alt="" loading="lazy" /></span> : <span className={styles.paletteIcon}><Clock /></span>}
                  <span><span className={styles.paletteName}>{r.label}</span>{r.sub && <div className={styles.paletteSub}>{r.sub}</div>}</span>
                  <span />
                </Command.Item>
              ))}
            </Command.Group>
          )}
          <Command.Group heading="Go to" className={styles.paletteGroup}>
            {ACTIONS.filter(a => !dq.trim() || a.label.toLowerCase().includes(dq.trim().toLowerCase())).map(a => (
              <Command.Item key={a.id} value={`action:${a.id}`} className={styles.paletteItem} onSelect={() => go(a.href)}>
                <span className={styles.paletteIcon}>{a.icon}</span>
                <span>{a.label}</span>
                <span />
              </Command.Item>
            ))}
          </Command.Group>
        </Command.List>
        <div className={styles.paletteFoot}>
          <span><Kbd>↑</Kbd><Kbd>↓</Kbd> move</span>
          <span><Kbd>Enter</Kbd> open</span>
          <span><Kbd>Esc</Kbd> close</span>
        </div>
      </Command>
    </Dialog>
  );
}
