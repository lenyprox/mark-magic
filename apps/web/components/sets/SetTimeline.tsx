'use client';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SetSummary } from '@cards/query';
import { SetIcon } from '@/components/text/SetIcon';
import { SearchInput } from '@/components/ui/Input';
import { Chip } from '@/components/ui/Chip';
import { Badge } from '@/components/ui/Display';
import { formatDate, setTypeLabel, yearOf } from '@/lib/text/format';
import styles from './sets.module.css';

const PRIMARY = ['expansion', 'core', 'masters', 'commander', 'draft_innovation', 'funny', 'starter', 'promo', 'alchemy', 'box', 'duel_deck'];
const HIDDEN_DEFAULT = new Set(['token', 'memorabilia', 'minigame', 'vanguard', 'planechase', 'archenemy', 'treasure_chest', 'spellbook', 'arsenal']);

export function SetTimeline({ sets }: { sets: SetSummary[] }) {
  const [q, setQ] = useState('');
  const [types, setTypes] = useState<Set<string>>(() => new Set());
  const [current, setCurrent] = useState<string | null>(null);
  const typeCounts = useMemo(() => { const m = new Map<string, number>(); for (const s of sets) m.set(s.setType, (m.get(s.setType) ?? 0) + 1); return m; }, [sets]);
  const typeList = useMemo(() => [...typeCounts.keys()].sort((a, b) => (PRIMARY.indexOf(a) === -1 ? 99 : PRIMARY.indexOf(a)) - (PRIMARY.indexOf(b) === -1 ? 99 : PRIMARY.indexOf(b)) || (typeCounts.get(b)! - typeCounts.get(a)!)), [typeCounts]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return sets.filter(x => (types.size ? types.has(x.setType) : !HIDDEN_DEFAULT.has(x.setType)) && (!s || x.name.toLowerCase().includes(s) || x.code.includes(s) || (x.block ?? '').toLowerCase().includes(s)));
  }, [sets, q, types]);
  const groups = useMemo(() => {
    const m = new Map<string, SetSummary[]>();
    for (const s of shown) { const y = yearOf(s.releasedAt); (m.get(y) ?? m.set(y, []).get(y)!).push(s); }
    return [...m.entries()];
  }, [shown]);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const blocks = wrap.current?.querySelectorAll<HTMLElement>('[data-year]'); if (!blocks?.length) return;
    const io = new IntersectionObserver((entries) => { const hit = entries.filter(e => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]; if (hit) setCurrent((hit.target as HTMLElement).dataset.year!); }, { rootMargin: '-70px 0px -70% 0px' });
    blocks.forEach(b => io.observe(b));
    return () => io.disconnect();
  }, [groups]);
  const toggleType = (t: string) => setTypes(prev => { const n = new Set(prev); n.has(t) ? n.delete(t) : n.add(t); return n; });
  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <h1>Sets</h1>
          <p>{sets.length.toLocaleString()} releases from Alpha to the newest preview, grouped by year. Open a set to see it in collector order.</p>
        </div>
        <div className={styles.tools}>
          <SearchInput value={q} onChange={setQ} placeholder="Set name, code or block" aria-label="Search sets" />
        </div>
      </div>
      <div className={styles.typeChips} role="group" aria-label="Set types">
        {typeList.map(t => <Chip key={t} size="sm" pressed={types.has(t)} onClick={() => toggleType(t)}>{setTypeLabel(t)}<span className="mono faint" style={{ fontSize: 10 }}>{typeCounts.get(t)}</span></Chip>)}
      </div>
      <div className={styles.body}>
        <nav className={styles.yearRail} aria-label="Years">
          {groups.map(([y]) => <a key={y} href={`#y-${y}`} className={styles.yearLink} aria-current={current === y ? 'true' : undefined}>{y}</a>)}
        </nav>
        <div ref={wrap} className={styles.timeline}>
          {groups.length === 0 && <div className={styles.empty}>No set matches that.</div>}
          {groups.map(([y, list]) => (
            <section key={y} id={`y-${y}`} data-year={y} className={styles.yearBlock} aria-labelledby={`yh-${y}`}>
              <div className={styles.yearHead}><h2 id={`yh-${y}`}>{y}</h2><span>{list.length} {list.length === 1 ? 'set' : 'sets'}</span></div>
              <div className={styles.setList}>
                {list.map(s => (
                  <Link key={s.code} href={`/sets/${s.code}`} className={styles.set}>
                    <span className={styles.setIcon}><SetIcon code={s.code} size={26} /></span>
                    <span className={styles.setName}>
                      <b>{s.name}</b>
                      <span className={styles.setMeta}><span className={styles.code}>{s.code}</span><span>{formatDate(s.releasedAt)}</span>{s.digital && <Badge tone="mute">Digital</Badge>}</span>
                    </span>
                    <span className={styles.setRight}><span className={styles.setCount}>{s.cardCount.toLocaleString()}</span><Badge tone="mute">{setTypeLabel(s.setType)}</Badge></span>
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
