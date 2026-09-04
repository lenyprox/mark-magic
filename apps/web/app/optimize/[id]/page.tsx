import type { Metadata } from 'next';
import { RunPage } from '@/components/optimizer/RunPage';

export const metadata: Metadata = { title: 'Optimiser run' };
export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <div className="container"><RunPage id={id} /></div>;
}
