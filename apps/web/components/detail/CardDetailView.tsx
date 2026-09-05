'use client';
// Card page body: sticky hero (static image; the 3D renderer replaces the <div data-card-hero>), printing carousel,
// facts, legality, prices, rulings and related cards. Printing selection lives in ?p= (shallow).
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { ExternalLink, Layers, Plus, RefreshCw } from 'lucide-react';
import type { CardDetail, PrintingDetail } from '@cards/query';
import { Card3D } from '@/components/card/Card3D';
import { FinishToggle, type FinishName } from '@/components/card';
import { defaultFinish } from '@/lib/gl/frames';
import { hasSceneToggle } from '@/lib/gl/scene-cards';
import { Button } from '@/components/ui/Button';
import { Tooltip } from '@/components/ui/Tooltip';
import { Badge, RarityBadge } from '@/components/ui/Display';
import { ColorPips, LegalityMatrix, ManaCost, OracleText, SetIcon } from '@/components/text';
import { cardTransitionName } from '@/lib/nav/viewTransition';
import { formatDate, formatPrice, FRAME_EFFECT_LABEL, yearOf } from '@/lib/text/format';
import { CollectionRow } from '@/components/collection/CollectionRow';
import { PrintingsCarousel } from './PrintingsCarousel';
import { RelatedCards } from './RelatedCards';
import styles from '@/app/cards/cards.module.css';

export function CardDetailView({ detail, initialPrinting }: { detail: CardDetail; initialPrinting?: string }) {
  const [p, setP] = useQueryState('p', parseAsString.withOptions({ shallow: true, history: 'replace' }));
  const [face, setFace] = useState<0 | 1>(0);
  const [finish, setFinish] = useState<FinishName | null>(null);
  const [scene, setScene] = useState(false);
  const byId = useMemo(() => new Map(detail.printings.map(x => [x.id, x])), [detail.printings]);
  const printing: PrintingDetail = byId.get(p ?? initialPrinting ?? '') ?? byId.get(detail.representativePrintingId) ?? detail.printings[0];
  const faces = printing?.faces?.length ? printing.faces : [];
  const shownFace = detail.hasBack && faces[face] ? faces[face] : null;
  const name = shownFace?.name ?? detail.name;
  const oracle = shownFace?.oracleText ?? (faces.length > 1 && !detail.hasBack ? faces.map(f => f.oracleText).filter(Boolean).join('\n—\n') : detail.oracleText);
  const typeLine = shownFace?.typeLine ?? detail.typeLine;
  const manaCost = shownFace?.manaCost ?? detail.manaCost;
  const pt = shownFace ? { power: shownFace.power, toughness: shownFace.toughness, loyalty: shownFace.loyalty, defense: shownFace.defense } : detail;
  const effects = [...(printing?.frameEffects ?? []), ...(printing?.fullArt ? ['fullart'] : []), ...(printing?.textless ? ['textless'] : []), ...(printing?.borderColor === 'borderless' ? ['borderless'] : [])];
  const finishes = printing?.finishes ?? [];

  return (
    <div className={styles.detail}>
      <div className={styles.heroCol}>
        <div className={styles.hero} data-card-hero data-printing={printing?.id} data-face={face}>
          <Card3D key={printing?.id ?? detail.representativePrintingId} live="always" size="large" tilt="hero" priority face={face} onFaceChange={setFace} finish={finish ?? undefined} scene={scene && hasSceneToggle(printing?.id)}
            printing={{ printingId: printing?.id ?? detail.representativePrintingId, name, layout: printing?.layout ?? detail.layout, frame: printing?.frame, frameEffects: printing?.frameEffects, finishes: printing?.finishes, fullArt: printing?.fullArt, textless: printing?.textless, borderColor: printing?.borderColor, hasBack: printing ? printing.hasBack : detail.hasBack }}
            aria-label={`${name}, ${typeLine}`}
            imgProps={{ style: { viewTransitionName: cardTransitionName(printing?.id ?? detail.representativePrintingId) }, 'data-card-anchor': printing?.id } as React.ImgHTMLAttributes<HTMLImageElement>} />
        </div>
        <div className={styles.heroTools}>
          {finishes.length > 1 && <FinishToggle finishes={finishes} value={finish ?? defaultFinish(finishes)} onChange={setFinish} size="sm" />}
          {detail.hasBack && <Button size="sm" icon={<RefreshCw />} onClick={() => setFace(f => (f === 0 ? 1 : 0))} aria-pressed={face === 1} aria-keyshortcuts="f">{face === 0 ? 'Show back' : 'Show front'}</Button>}
          {printing?.scryfallUri && <Button size="sm" variant="ghost" trailing={<ExternalLink />} onClick={() => window.open(printing.scryfallUri!, '_blank', 'noopener')}>Scryfall</Button>}
        </div>
        {hasSceneToggle(printing?.id) && (
          <div className={styles.heroTools}>
            <Button size="sm" icon={<Layers />} onClick={() => setScene(v => !v)} aria-pressed={scene}>{scene ? '2.5D scene: on' : '2.5D scene: off'}</Button>
          </div>
        )}
      </div>

      <div className={styles.facts}>
        <div>
          <div className={styles.titleRow}>
            <h1 className={styles.name}>{name}</h1>
            <ManaCost cost={manaCost} size={24} />
          </div>
          <div className={styles.typeLine}>
            <span>{typeLine}</span>
            <ColorPips colors={detail.colorIdentity} label="Colour identity" />
          </div>
        </div>

        <div className={styles.oracleBox}>
          <OracleText text={oracle} />
          {(pt.power != null || pt.loyalty != null || pt.defense != null) && (
            <div className={styles.ptRow}>
              {pt.power != null && <span>{pt.power}/{pt.toughness}<small> power / toughness</small></span>}
              {pt.loyalty != null && <span>{pt.loyalty}<small> loyalty</small></span>}
              {pt.defense != null && <span>{pt.defense}<small> defense</small></span>}
            </div>
          )}
          {printing?.flavorText && <p className={styles.flavor}>{printing.flavorText}</p>}
        </div>

        <div className={styles.actions}>
          <Tooltip content="Decks are coming next"><span><Button variant="primary" icon={<Plus />} disabled aria-disabled>Add to deck</Button></span></Tooltip>
          <Link href={`/cards?q=${encodeURIComponent(`n:"${detail.name}"`)}&mode=printing`} className="link small">All {detail.printingCount} printings in the grid</Link>
        </div>

        <dl className={styles.metaGrid}>
          <div className={styles.metaItem}><dt>Set</dt><dd><SetIcon code={printing?.setCode ?? ''} rarity={printing?.rarity} size={18} /><Link href={`/sets/${printing?.setCode}`} className="link">{printing?.setName}</Link></dd></div>
          <div className={styles.metaItem}><dt>Collector number</dt><dd className="mono">{printing?.setCode.toUpperCase()} {printing?.collectorNumber}</dd></div>
          <div className={styles.metaItem}><dt>Rarity</dt><dd><RarityBadge rarity={printing?.rarity ?? 'common'} /></dd></div>
          <div className={styles.metaItem}><dt>Released</dt><dd className="mono">{formatDate(printing?.releasedAt)}</dd></div>
          <div className={styles.metaItem}><dt>Artist</dt><dd>{printing?.artist ? <Link href={`/cards?q=${encodeURIComponent(printing.artist)}`} className="link">{printing.artist}</Link> : '—'}</dd></div>
          <div className={styles.metaItem}><dt>Frame</dt><dd className={styles.badges}>{printing?.frame && <Badge tone="mute">{printing.frame}</Badge>}{effects.map(e => <Badge key={e}>{FRAME_EFFECT_LABEL[e] ?? e}</Badge>)}{finishes.map(f => <Badge key={f} tone={f === 'nonfoil' ? 'mute' : 'brass'}>{f}</Badge>)}</dd></div>
          {detail.keywords.length > 0 && <div className={styles.metaItem}><dt>Keywords</dt><dd>{detail.keywords.join(', ')}</dd></div>}
          {detail.edhrecRank != null && <div className={styles.metaItem}><dt>EDHREC rank</dt><dd className="mono">#{detail.edhrecRank.toLocaleString()}</dd></div>}
          {detail.reserved && <div className={styles.metaItem}><dt>Reserved list</dt><dd><Badge tone="warn">Reserved</Badge></dd></div>}
          <div className={styles.metaItem}><dt>Engine</dt><dd>{detail.def.unparsed?.length ? <Badge tone="warn" title={detail.def.unparsed.join('\n')}>Partly simulated</Badge> : <Badge tone="ok">Fully simulated</Badge>}</dd></div>
          <CollectionRow oracleId={detail.oracleId} name={detail.name} initial={detail.owned} className={styles.metaItem} />
        </dl>

        <section aria-labelledby="printings-h">
          <h2 id="printings-h" className={styles.sectionTitle}>Printings <small>{detail.printings.length}</small></h2>
          <PrintingsCarousel printings={detail.printings} selected={printing?.id} onSelect={(id) => { setFace(0); void setP(id === detail.representativePrintingId ? null : id); }} />
        </section>

        <section aria-labelledby="price-h">
          <h2 id="price-h" className={styles.sectionTitle}>Prices <small>{printing?.setCode.toUpperCase()} {printing?.collectorNumber}, {yearOf(printing?.releasedAt)}</small></h2>
          <div className={styles.prices}>
            <PriceStat label="Nonfoil" value={printing?.prices.usd} />
            <PriceStat label="Foil" value={printing?.prices.usdFoil} />
            {printing?.prices.usdEtched != null && <PriceStat label="Etched" value={printing.prices.usdEtched} />}
            <PriceStat label="EUR" value={printing?.prices.eur} prefix="€" />
            <PriceStat label="MTGO" value={printing?.prices.tix} suffix=" tix" />
          </div>
        </section>

        <section aria-labelledby="legal-h">
          <h2 id="legal-h" className={styles.sectionTitle}>Legality</h2>
          <LegalityMatrix legalities={detail.legalities} />
        </section>

        {detail.rulings.length > 0 && (
          <section aria-labelledby="rulings-h">
            <h2 id="rulings-h" className={styles.sectionTitle}>Rulings <small>{detail.rulings.length}</small></h2>
            <div className={styles.rulings}>
              {detail.rulings.map((r, i) => <div key={i} className={styles.ruling}><time dateTime={r.publishedAt}>{r.publishedAt}</time><div>{r.comment}</div></div>)}
            </div>
          </section>
        )}

        <RelatedCards detail={detail} printing={printing} />
      </div>
    </div>
  );
}

function PriceStat({ label, value, prefix = '$', suffix = '' }: { label: string; value: number | null | undefined; prefix?: string; suffix?: string }) {
  return (
    <div className={styles.metaItem}>
      <dt>{label}</dt>
      <dd className="mono">{value == null ? '—' : prefix === '$' ? `${formatPrice(value)}${suffix}` : `${prefix}${value.toFixed(2)}${suffix}`}</dd>
    </div>
  );
}
