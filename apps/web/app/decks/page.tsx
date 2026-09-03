import type { Metadata } from 'next';
import { DataNotReadyError, dataStatus } from '@/lib/db';
import { deckTiles } from '@/lib/deck/server';
import { DeckLibrary } from '@/components/deck/DeckLibrary';
import { SetupBanner } from '@/components/shell/SetupBanner';

export const metadata: Metadata = { title: 'Decks' };
export const dynamic = 'force-dynamic';

export default function DecksPage() {
  try {
    const decks = deckTiles();
    return <div className="container"><DeckLibrary decks={decks} /></div>;
  } catch (e) {
    if (e instanceof DataNotReadyError) return <div className="container"><SetupBanner status={dataStatus()} /></div>;
    throw e;
  }
}
