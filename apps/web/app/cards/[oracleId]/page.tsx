import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DataNotReadyError, dataStatus, getQuery } from '@/lib/db';
import { CardDetailView } from '@/components/detail/CardDetailView';
import { SetupBanner } from '@/components/shell/SetupBanner';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ oracleId: string }>; searchParams: Promise<{ p?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { oracleId } = await params;
  try { const d = getQuery().detail(oracleId); return { title: d ? `${d.name}` : 'Card' }; } catch { return { title: 'Card' }; }
}

export default async function CardPage({ params, searchParams }: Props) {
  const { oracleId } = await params;
  const { p } = await searchParams;
  let detail;
  try { detail = getQuery().detail(oracleId); } catch (e) {
    if (e instanceof DataNotReadyError) return <div className="container"><SetupBanner status={dataStatus()} /></div>;
    throw e;
  }
  if (!detail) notFound();
  return <div className="container"><CardDetailView detail={detail} initialPrinting={p} /></div>;
}
