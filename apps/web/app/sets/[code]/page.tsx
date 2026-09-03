import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import type { CardQuery } from '@cards/query';
import { DataNotReadyError, dataStatus, getQuery } from '@/lib/db';
import { parseCardQuery } from '@/lib/query-params';
import type { CardPage } from '@/lib/api';
import { Browse } from '@/components/browse/Browse';
import { SetupBanner } from '@/components/shell/SetupBanner';
import { SetIcon } from '@/components/text/SetIcon';
import { Badge } from '@/components/ui/Display';
import { formatDate, setTypeLabel } from '@/lib/text/format';
import styles from '@/components/sets/sets.module.css';

export const dynamic = 'force-dynamic';
type Props = { params: Promise<{ code: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { code } = await params;
  try { return { title: getQuery().set(code)?.name ?? code.toUpperCase() }; } catch { return { title: code.toUpperCase() }; }
}

export default async function SetPage({ params, searchParams }: Props) {
  const { code } = await params;
  const sp = await searchParams;
  let set, initial: CardPage;
  const lock: Partial<CardQuery> = { set: code.toLowerCase(), mode: 'printing', sort: 'collector', dir: 'asc' };
  try {
    const q = getQuery();
    set = q.set(code);
    if (!set) notFound();
    const query: CardQuery = { ...parseCardQuery(sp), ...lock };
    initial = { ...q.search(query), query };
  } catch (e) {
    if (e instanceof DataNotReadyError) return <div className="container"><SetupBanner status={dataStatus()} /></div>;
    throw e;
  }
  return (
    <div className="container">
      <Link href="/sets" className={styles.back}><ChevronLeft size={14} />All sets</Link>
      <header className={styles.setHead}>
        <span className={styles.setHeadIcon}><SetIcon code={set.code} size={44} title={set.name} /></span>
        <div className={styles.setHeadText}>
          <h1>{set.name}</h1>
          <div className={styles.setHeadMeta}>
            <span className={styles.code}>{set.code}</span>
            <span>{formatDate(set.releasedAt)}</span>
            <span className="mono">{set.cardCount.toLocaleString()} cards</span>
            <Badge tone="mute">{setTypeLabel(set.setType)}</Badge>
            {set.block && <span>{set.block}</span>}
            {set.digital && <Badge tone="mute">Digital</Badge>}
          </div>
        </div>
      </header>
      <Browse initial={initial} lock={lock} lockedKeys={['set', 'mode', 'sort', 'dir']} />
    </div>
  );
}
