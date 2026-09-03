'use client';
// A card name that previews the card on hover (350 ms intent) and links to its page.
import Link from 'next/link';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { api } from '@/lib/api';
import { useUi } from '@/lib/stores/ui';
import styles from './shell.module.css';

const nameCache = new Map<string, Promise<{ oracleId: string; printingId: string } | null>>();
function resolveName(name: string) {
  let p = nameCache.get(name);
  if (!p) {
    p = api.autocomplete(name, 1).then(hits => { const h = hits.find(x => x.name.toLowerCase() === name.toLowerCase()) ?? hits[0]; return h ? { oracleId: h.oracleId, printingId: h.printingId } : null; }).catch(() => null);
    nameCache.set(name, p);
  }
  return p;
}

export interface CardRefProps { name: string; printingId?: string; oracleId?: string; face?: 0 | 1; children?: ReactNode; className?: string; delay?: number }

export function CardRef({ name, printingId, oracleId, face, children, className, delay = 350 }: CardRefProps) {
  const setPreview = useUi(s => s.setPreview);
  const [resolved, setResolved] = useState<{ oracleId: string; printingId: string } | null>(printingId && oracleId ? { oracleId, printingId } : null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const el = useRef<HTMLElement>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const show = async () => {
    let r = resolved;
    if (!r?.printingId) { r = printingId ? { oracleId: oracleId ?? '', printingId } : await resolveName(name); if (r) setResolved(r); }
    const rect = el.current?.getBoundingClientRect();
    if (r && rect && el.current?.matches(':hover, :focus-visible')) setPreview({ printingId: r.printingId, face, name, anchor: rect });
  };
  const arm = () => { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(show, delay); };
  const disarm = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; setPreview(null); };
  const href = resolved?.oracleId ? `/cards/${resolved.oracleId}` : oracleId ? `/cards/${oracleId}` : `/cards?q=${encodeURIComponent(`n:"${name}"`)}`;
  return (
    <Link ref={el as React.RefObject<HTMLAnchorElement>} href={href} className={clsx(styles.ref, className)} onMouseEnter={arm} onMouseLeave={disarm} onFocus={arm} onBlur={disarm}>
      {children ?? name}
    </Link>
  );
}
