'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Copy, Layers, MoreHorizontal, Trash2 } from 'lucide-react';
import type { DeckTileData } from '@/lib/deck/server';
import { formatInfo } from '@/lib/deck/formats';
import { imgUrl } from '@/lib/img';
import { IconButton } from '@/components/ui/Button';
import { Popover } from '@/components/ui/Popover';
import { Badge } from '@/components/ui/Display';
import { ColorPips } from '@/components/text/ManaSymbol';
import styles from '@/app/decks/decks.module.css';

export function timeAgo(iso: string): string {
  const t = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z').getTime();
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 14) return `${Math.floor(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export interface DeckTileProps { deck: DeckTileData; onDuplicate: (deck: DeckTileData) => void; onDelete: (deck: DeckTileData) => void }

export function DeckTile({ deck, onDuplicate, onDelete }: DeckTileProps) {
  const [menu, setMenu] = useState(false);
  const f = formatInfo(deck.format);
  return (
    <article className={styles.tile} aria-label={deck.name}>
      <Link href={`/decks/${deck.id}`} className={styles.tileLink}>
        <div className={styles.tileArt}>
          {deck.cover ? <img src={imgUrl(deck.cover, 'art_crop')} alt="" loading="lazy" decoding="async" /> : <div className={`${styles.tileArtEmpty} ${styles.tileArt}`}><Layers /></div>}
          <div className={styles.tileFade} />
        </div>
        <div className={styles.tileBody}>
          <div className={styles.tileName}>{deck.name}</div>
          <div className={styles.tileMeta}>
            <Badge tone={deck.role === 'opponent' ? 'info' : 'brass'}>{f.label}</Badge>
            <ColorPips colors={deck.colors} size={13} label="Colour identity" />
            <span className={styles.tileCounts}>{deck.mainCount}{deck.sideCount > 0 && <span className="faint"> + {deck.sideCount}</span>}</span>
            {deck.archetype && <span className="truncate">{deck.archetype}</span>}
            <time className={styles.tileTime} dateTime={deck.updatedAt} suppressHydrationWarning title={new Date(deck.updatedAt).toLocaleString()}>{timeAgo(deck.updatedAt)}</time>
          </div>
        </div>
      </Link>
      <div className={styles.tileMenu} data-open={menu || undefined}>
        <Popover open={menu} onOpenChange={setMenu} placement="bottom-end" trigger={<IconButton label={`More actions for ${deck.name}`} size="sm"><MoreHorizontal /></IconButton>}>
          {(close) => (
            <div className={styles.menu} role="menu">
              <button type="button" role="menuitem" className={styles.menuItem} onClick={() => { close(); onDuplicate(deck); }}><Copy />Duplicate</button>
              <div className={styles.menuSep} />
              <button type="button" role="menuitem" className={styles.menuItem} data-danger onClick={() => { close(); onDelete(deck); }}><Trash2 />Delete…</button>
            </div>
          )}
        </Popover>
      </div>
    </article>
  );
}
