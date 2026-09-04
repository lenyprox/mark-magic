import type { Metadata } from 'next';
import { DataNotReadyError, dataStatus } from '@/lib/db';
import { OptimizePage } from '@/components/optimizer/OptimizePage';
import { SetupBanner } from '@/components/shell/SetupBanner';

export const metadata: Metadata = { title: 'Optimise' };
export const dynamic = 'force-dynamic';

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const deck = typeof sp.deck === 'string' ? sp.deck : null;
  try {
    const status = dataStatus();
    if (!status.master || !status.index) return <div className="container"><SetupBanner status={status} /></div>;
    return <div className="container"><OptimizePage initialDeckId={deck} /></div>;
  } catch (e) {
    if (e instanceof DataNotReadyError) return <div className="container"><SetupBanner status={dataStatus()} /></div>;
    throw e;
  }
}
