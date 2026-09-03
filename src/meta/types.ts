// Shared types for the metagame research layer (TopDeck.gg, MTGGoldfish, 17lands).

export type MetaFormat = 'Standard' | 'Modern' | 'Pioneer' | 'Legacy' | 'Vintage' | 'Pauper' | 'EDH';
export const META_FORMATS: readonly MetaFormat[] = ['Standard', 'Modern', 'Pioneer', 'Legacy', 'Vintage', 'Pauper', 'EDH'];
export type MetaSource = 'topdeck' | 'goldfish' | '17lands';
export type MetaBoard = 'main' | 'side' | 'commander';

/** Canonical format name from loose user input ("modern", "commander", "cEDH"). */
export function canonicalFormat(input: string): MetaFormat | null {
  const k = input.trim().toLowerCase();
  const map: Record<string, MetaFormat> = { standard: 'Standard', modern: 'Modern', pioneer: 'Pioneer', legacy: 'Legacy', vintage: 'Vintage', pauper: 'Pauper', edh: 'EDH', commander: 'EDH', cedh: 'EDH' };
  return map[k] ?? null;
}

export interface NormalizedCard { name: string; oracleId: string | null; count: number; board: MetaBoard }

export interface NormalizedEvent { source: MetaSource; sourceId: string; name: string | null; format: string; date: string | null; players: number | null; url: string | null }

export interface NormalizedDecklist {
  source: MetaSource; sourceId: string; eventSourceId: string | null; format: string; archetype: string | null;
  player: string | null; placement: number | null; wins: number | null; losses: number | null; draws: number | null;
  date: string | null; url: string | null; deckSize: number; cards: NormalizedCard[];
}

export interface DecklistRecord extends Omit<NormalizedDecklist, 'eventSourceId'> { id: string; eventId: string | null; eventName: string | null; archetypeId: string | null; fetchedAt: string }

export interface GoldfishArchetype { name: string; slug: string; url: string; share: number | null; deckCount: number | null; sampleList?: { name: string; count: number; board: MetaBoard }[] }

/** Per-card statistics of an archetype (one row per board+card). */
export interface ArchetypeCardStat { name: string; oracleId: string | null; board: MetaBoard; pIn: number; expectedCount: number; countDist: number[] }

/** The shape the analysis layer consumes (a copy lives in src/analysis; keep them identical). */
export interface ArchetypeProfile {
  id: string; format: string; name: string; signature: string[];
  metaShare: number; winRate: number | null; deckCount: number; deckSize: 60 | 100;
  cards: { name: string; pIn: number; expectedCount: number; countDist: number[]; board: MetaBoard }[];
  sampleLists?: { name: string; count: number }[][];
}

export interface ArchetypeSummary {
  id: string; format: string; name: string; signature: string[]; share: number; deckCount: number; wins: number; losses: number;
  winRate: number | null; deckSize: 60 | 100; goldfishName: string | null; goldfishShare: number | null; url: string | null; windowDays: number | null; computedAt: string;
}

export interface CardRating {
  name: string; oracleId: string | null; gameCount: number | null; everDrawnWinRate: number | null; openingHandWinRate: number | null;
  drawnWinRate: number | null; gihWinRate: number | null; avgSeen: number | null; avgPick: number | null; color: string | null; rarity: string | null;
}

export interface SourceCounts { events?: number; decklists?: number; skippedUrlOnly?: number; skippedEmpty?: number; archetypes?: number; goldfishArchetypes?: number; cardRatings?: number; requests?: number }
export interface SourceReport { source: MetaSource | 'cluster'; format: string; ok: boolean; skipped?: boolean; message: string; counts: SourceCounts }
export interface SyncReport { format: string; ok: boolean; reports: SourceReport[] }
