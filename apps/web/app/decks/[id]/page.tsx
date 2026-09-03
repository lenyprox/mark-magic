import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DataNotReadyError, dataStatus, getDecks } from '@/lib/db';
import { Builder } from '@/components/deck/Builder';
import { SetupBanner } from '@/components/shell/SetupBanner';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  try { const d = getDecks().get(id); return { title: d ? d.name : 'Deck' }; } catch { return { title: 'Deck' }; }
}

export default async function DeckPage({ params }: Props) {
  const { id } = await params;
  let deck;
  try { deck = getDecks().get(id); }
  catch (e) {
    if (e instanceof DataNotReadyError) return <div className="container"><SetupBanner status={dataStatus()} /></div>;
    throw e;
  }
  if (!deck) notFound();
  return <Builder deck={deck} />;
}
