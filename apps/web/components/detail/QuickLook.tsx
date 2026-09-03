'use client';
// Quick-look dialog for the intercepting route. Esc / close returns to the grid; "Open full page" is a hard link
// so the intercept does not apply.
import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ExternalLink, RefreshCw } from 'lucide-react';
import type { CardDetail } from '@cards/query';
import { CardImage } from '@/components/card/CardImage';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { RarityBadge } from '@/components/ui/Display';
import { ColorPips, LegalityMatrix, ManaCost, OracleText, SetIcon } from '@/components/text';
import { cardTransitionName } from '@/lib/nav/viewTransition';
import { formatPrice } from '@/lib/text/format';
import styles from '@/app/cards/cards.module.css';

export function QuickLook({ detail, printingId }: { detail: CardDetail; printingId?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(true);
  const [face, setFace] = useState<0 | 1>(0);
  const close = useCallback(() => { setOpen(false); router.back(); }, [router]);
  const printing = detail.printings.find(p => p.id === printingId) ?? detail.printings.find(p => p.id === detail.representativePrintingId) ?? detail.printings[0];
  const f = detail.hasBack ? printing?.faces[face] : undefined;
  const fullHref = `/cards/${detail.oracleId}${printing && printing.id !== detail.representativePrintingId ? `?p=${printing.id}` : ''}`;
  return (
    <Dialog open={open} onClose={close} plain width={760} labelledBy="ql-name" closeLabel="Close quick look">
      <div className={styles.quick}>
        <div data-card-hero>
          <CardImage key={`${printing?.id}-${face}`} printingId={printing?.id ?? detail.representativePrintingId} face={face} size="normal" priority alt={`${detail.name}, ${detail.typeLine}`}
            imgProps={{ style: { viewTransitionName: cardTransitionName(printing?.id ?? detail.representativePrintingId) } }} />
        </div>
        <div className={styles.quickFacts}>
          <div>
            <div className={styles.titleRow}><h2 id="ql-name" className={styles.quickName}>{f?.name ?? detail.name}</h2><ManaCost cost={f?.manaCost ?? detail.manaCost} size={18} /></div>
            <div className={styles.typeLine}><span>{f?.typeLine ?? detail.typeLine}</span><ColorPips colors={detail.colorIdentity} size={12} label="Colour identity" /></div>
          </div>
          <OracleText text={f?.oracleText ?? detail.oracleText} />
          {(detail.power != null || detail.loyalty != null) && <div className={styles.ptRow}>{detail.power != null && <span>{detail.power}/{detail.toughness}</span>}{detail.loyalty != null && <span>{detail.loyalty}<small> loyalty</small></span>}</div>}
          <div className={styles.metaItem}>
            <dd><SetIcon code={printing?.setCode ?? ''} rarity={printing?.rarity} size={16} /><span>{printing?.setName}</span><span className="mono faint">{printing?.setCode.toUpperCase()} {printing?.collectorNumber}</span><RarityBadge rarity={printing?.rarity ?? 'common'} /><span className="mono">{formatPrice(printing?.prices.usd)}</span></dd>
          </div>
          <LegalityMatrix legalities={detail.legalities} compact />
          <div className={styles.quickFoot}>
            <a href={fullHref} className={undefined}><Button variant="primary" trailing={<ExternalLink />}>Open full page</Button></a>
            {detail.hasBack && <Button icon={<RefreshCw />} onClick={() => setFace(x => (x === 0 ? 1 : 0))}>{face === 0 ? 'Show back' : 'Show front'}</Button>}
            <Button variant="ghost" onClick={close}>Back to results</Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
