'use client';
// Right pane: header, legality + engine callouts, board tabs, grouped rows, analysis charts, import/export.
import { useMemo, useState } from 'react';
import type { DeckBoard } from '@cards/db';
import type { DeckRecord } from '@user/decks';
import { useDeckStore } from '@/lib/stores/deck';
import { useCardInfo } from '@/lib/deck/useCardInfo';
import { countOf, entriesOf, groupEntries, MAIN_BOARDS, type GroupMode } from '@/lib/deck/stats';
import { Tabs } from '@/components/ui/Tabs';
import { Segmented } from '@/components/ui/Segmented';
import { EmptyState } from '@/components/ui/Display';
import { useBuilder } from './context';
import { DeckHeader } from './DeckHeader';
import { LegalityCheck } from './LegalityCheck';
import { EngineCoverage } from './EngineCoverage';
import { ChooseCommander } from './ChooseCommander';
import { CollectionCoverage } from '@/components/collection/CollectionCoverage';
import { DeckGroups } from './DeckGroups';
import { ManaCurve } from './ManaCurve';
import { ColorPie } from './ColorPie';
import { ManaSourceCheck } from './ManaSourceCheck';
import { ImportExport } from './ImportExport';
import styles from './deck.module.css';

type Tab = 'main' | 'side' | 'maybe';

export function DeckPane({ deck }: { deck: DeckRecord }) {
  const draft = useDeckStore(s => s.draft)!;
  const { board, setBoard, mobile, openPicker } = useBuilder();
  const [mode, setMode] = useState<GroupMode>('type');
  const oracleIds = useMemo(() => draft.cards.map(c => c.oracleId), [draft.cards]);
  const info = useCardInfo(oracleIds);
  const entries = useMemo(() => entriesOf(draft.cards, info.map), [draft.cards, info.map]);
  const mainEntries = useMemo(() => entries.filter(e => MAIN_BOARDS.includes(e.card.board)), [entries]);
  const tab: Tab = board === 'side' ? 'side' : board === 'maybe' ? 'maybe' : 'main';
  const shown = useMemo(() => entries.filter(e => tab === 'main' ? MAIN_BOARDS.includes(e.card.board) : e.card.board === tab), [entries, tab]);
  const groups = useMemo(() => groupEntries(shown, mode), [shown, mode]);
  const counts = { main: countOf(draft.cards.filter(c => MAIN_BOARDS.includes(c.board))), side: countOf(draft.cards, 'side'), maybe: countOf(draft.cards, 'maybe') };

  return (
    <div className={styles.deckPane}>
      <DeckHeader deck={deck} entries={mainEntries} info={info} />
      <LegalityCheck format={draft.format} cards={draft.cards} info={info} />
      <ChooseCommander format={draft.format} entries={entries} />
      <EngineCoverage entries={mainEntries} />
      <CollectionCoverage deckId={deck.id} cards={draft.cards} />
      <div className={styles.tabsRow}>
        <Tabs<Tab> label="Board" value={tab} onChange={(v) => setBoard(v as DeckBoard)} items={[{ value: 'main', label: 'Main', count: counts.main }, { value: 'side', label: 'Sideboard', count: counts.side }, { value: 'maybe', label: 'Maybe', count: counts.maybe }]} />
        <Segmented size="sm" label="Group by" value={mode} onChange={setMode} options={[{ value: 'type', label: 'Type' }, { value: 'mv', label: 'Mana value' }, { value: 'color', label: 'Colour' }]} />
      </div>
      {shown.length === 0 ? (
        <EmptyState title={tab === 'main' ? 'No cards yet' : tab === 'side' ? 'Sideboard is empty' : 'Nothing on the maybeboard'} className={styles.deckEmpty}
          actions={mobile ? <button type="button" className="link" onClick={openPicker}>Add cards</button> : undefined}>
          {mobile ? 'Tap "Add cards" to search.' : <>Search on the left and click a card to add it here — or press <kbd>[</kbd> to jump to the picker.</>}
        </EmptyState>
      ) : (
        <DeckGroups groups={groups} board={tab} loading={!info.ready} />
      )}
      <section className={styles.section} aria-label="Analysis">
        <div className={styles.sectionHead}><h3>Analysis</h3><span className="faint small">main deck{info.ready ? '' : ' · loading card data'}</span></div>
        <div className={styles.analysis}>
          <ManaCurve entries={mainEntries} />
          <ColorPie entries={mainEntries} />
        </div>
        <ManaSourceCheck entries={mainEntries} />
      </section>
      <ImportExport />
    </div>
  );
}
