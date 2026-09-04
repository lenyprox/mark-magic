import type { Metadata } from 'next';
import { DataNotReadyError, dataStatus } from '@/lib/db';
import { CollectionPage } from '@/components/collection/CollectionPage';
import { SetupBanner } from '@/components/shell/SetupBanner';

export const metadata: Metadata = { title: 'Collection' };
export const dynamic = 'force-dynamic';

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const missing = typeof sp.missing === 'string' ? sp.missing : null;
  try {
    const status = dataStatus();
    if (!status.master || !status.index) return <div className="container"><SetupBanner status={status} /></div>;
    return <div className="container"><CollectionPage initialSummary={status.collection} missingDeckId={missing} /></div>;
  } catch (e) {
    if (e instanceof DataNotReadyError) return <div className="container"><SetupBanner status={dataStatus()} /></div>;
    throw e;
  }
}
