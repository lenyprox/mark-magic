import type { Metadata } from 'next';
import { DataNotReadyError, dataStatus, getQuery } from '@/lib/db';
import { parseCardQuery } from '@/lib/query-params';
import type { CardPage } from '@/lib/api';
import { Browse } from '@/components/browse/Browse';
import { SetupBanner } from '@/components/shell/SetupBanner';
import styles from './cards.module.css';

export const metadata: Metadata = { title: 'Cards' };
export const dynamic = 'force-dynamic';

export default async function CardsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const query = parseCardQuery(sp);
  let initial: CardPage | null = null;
  try {
    initial = { ...getQuery().search(query), query };
  } catch (e) {
    if (!(e instanceof DataNotReadyError)) throw e;
    return <div className="container"><SetupBanner status={dataStatus()} /></div>;
  }
  return (
    <div className={`container ${styles.page}`}>
      <Browse initial={initial} />
    </div>
  );
}
