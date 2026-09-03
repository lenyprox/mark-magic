import type { Metadata } from 'next';
import { DataNotReadyError, dataStatus, getQuery } from '@/lib/db';
import { SetTimeline } from '@/components/sets/SetTimeline';
import { SetupBanner } from '@/components/shell/SetupBanner';

export const metadata: Metadata = { title: 'Sets' };
export const dynamic = 'force-dynamic';

export default function SetsPage() {
  try {
    const sets = getQuery().sets();
    return <div className="container"><SetTimeline sets={sets} /></div>;
  } catch (e) {
    if (e instanceof DataNotReadyError) return <div className="container"><SetupBanner status={dataStatus()} /></div>;
    throw e;
  }
}
