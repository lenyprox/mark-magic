import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import type { CardSummary } from '@cards/query';
import { DataNotReadyError, dataStatus, getDecks, getQuery } from '@/lib/db';
import { CardImage } from '@/components/card/CardImage';
import { Card3D } from '@/components/card/Card3D';
import { QuickSearch } from '@/components/home/QuickSearch';
import { SetupBanner } from '@/components/shell/SetupBanner';
import { formatCount } from '@/lib/text/format';
import styles from './page.module.css';

export const dynamic = 'force-dynamic';

function todaySeed(): number {
  const d = new Date();
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

export default function Home() {
  let featured: CardSummary[] = [];
  let vault: CardSummary[] = [];
  let counts: { cards: number; printings: number; sets: number } | null = null;
  let deckCount: number | null = null;
  try { deckCount = getDecks().list().length; } catch { deckCount = null; }
  let error: DataNotReadyError | null = null;
  try {
    const q = getQuery();
    featured = q.random(3, { rarity: ['mythic', 'rare'] });
    vault = q.random(12, { seed: todaySeed() });
    counts = q.counts();
  } catch (e) {
    if (e instanceof DataNotReadyError) error = e; else throw e;
  }
  const status = dataStatus();
  const tiles = [
    { href: '/cards', name: 'Cards', body: 'Every card ever printed, searchable by rules text, colour, type, set and legality.', count: counts ? `${formatCount(counts.cards)} cards` : null },
    { href: '/sets', name: 'Sets', body: 'Thirty years of releases on one timeline, each set opened to its collector order.', count: counts ? `${formatCount(counts.sets)} sets` : null },
    { href: '/decks', name: 'Decks', body: 'Build and keep your lists; assemble opponents from live tournament data.', count: deckCount == null ? 'Your decks' : deckCount === 1 ? '1 deck' : `${deckCount} decks` },
    { href: '/play', name: 'Play', body: 'Sit down against the AI with a live panel of your plays and their odds.', count: 'Deal a game' },
  ];
  return (
    <div className={`container ${styles.home}`}>
      {(error || !status.manaSprite) && <SetupBanner status={status} />}

      <section className={styles.hero} aria-labelledby="hero-h">
        <div className={styles.heroText}>
          <h1 id="hero-h">The whole card file, opened.</h1>
          <p className={styles.heroSub}>Every Magic card ever printed, catalogued and ready to be searched, sleeved into a deck and played against an opponent that explains its odds.</p>
          <QuickSearch />
          {counts && <span className={styles.heroCount}>{formatCount(counts.printings)} printings across {formatCount(counts.sets)} sets</span>}
        </div>
        <div className={styles.fan} data-card-hero aria-label="Three featured cards">
          <div className={styles.fanGlow} aria-hidden />
          {featured.map((c, i) => (
            <div key={c.printingId} className={styles.fanCard} data-i={i}>
              <Link href={`/cards/${c.oracleId}`} aria-label={`${c.name}, ${c.typeLine}, ${c.setName}`}>
                {/* The GL layer draws into an element's axis-aligned box, so only the upright centre card is live; the rotated companions stay static. */}
                {i === 1
                  ? <Card3D embedded live="always" tilt="hero" priority printing={{ printingId: c.printingId, name: c.name, layout: c.layout, frame: c.frame, frameEffects: c.frameEffects, finishes: c.finishes, fullArt: c.fullArt, borderColor: c.borderColor, hasBack: c.hasBack }} />
                  : <CardImage printingId={c.printingId} size="normal" alt="" priority />}
              </Link>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.section} aria-label="Sections">
        <div className={styles.tiles}>
          {tiles.map(t => (
            <Link key={t.href} href={t.href} className={styles.tile}>
              <span className={styles.tileName}>{t.name}</span>
              <span className={styles.tileBody}>{t.body}</span>
              <span className={styles.tileFoot}><span className={styles.tileCount}>{t.count}</span><ArrowRight size={16} className={styles.tileArrow} aria-hidden /></span>
            </Link>
          ))}
        </div>
      </section>

      {vault.length > 0 && (
        <section className={styles.section} aria-labelledby="vault-h">
          <div className={styles.sectionHead}>
            <h2 id="vault-h">Today’s vault</h2>
            <p>Twelve cards drawn for {new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}. A new dozen tomorrow.</p>
          </div>
          <div className={styles.vault}>
            {vault.map(c => (
              <Link key={c.printingId} href={`/cards/${c.oracleId}?p=${c.printingId}`} className={styles.vaultCard} aria-label={`${c.name}, ${c.typeLine}, ${c.setName}`}>
                <CardImage printingId={c.printingId} size="normal" alt="" />
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
