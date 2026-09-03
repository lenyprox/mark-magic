import type { Metadata } from 'next';
import { Table } from '@/components/play/Table';

export const metadata: Metadata = { title: 'Table' };
export const dynamic = 'force-dynamic';

export default async function TablePage({ params }: { params: Promise<{ gameId: string }> }) {
  const { gameId } = await params;
  return <Table gameId={decodeURIComponent(gameId)} />;
}
