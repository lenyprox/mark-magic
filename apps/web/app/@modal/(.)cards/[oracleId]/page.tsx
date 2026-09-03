import { DataNotReadyError, getQuery } from '@/lib/db';
import { QuickLook } from '@/components/detail/QuickLook';

export const dynamic = 'force-dynamic';

export default async function QuickLookPage({ params, searchParams }: { params: Promise<{ oracleId: string }>; searchParams: Promise<{ p?: string }> }) {
  const { oracleId } = await params;
  const { p } = await searchParams;
  let detail = null;
  try { detail = getQuery().detail(oracleId); } catch (e) { if (!(e instanceof DataNotReadyError)) throw e; }
  if (!detail) return null;
  return <QuickLook detail={detail} printingId={p} />;
}
