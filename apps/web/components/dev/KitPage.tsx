'use client';
import { useState } from 'react';
import { Bookmark, Filter, Plus, Trash2 } from 'lucide-react';
import { Badge, Button, Callout, Chip, Dialog, Drawer, EmptyState, IconButton, Input, Kbd, LegalityBadge, ManaChip, Meter, Popover, RangeSlider, RarityBadge, SearchInput, Segmented, Select, Skeleton, Stat, Tabs, Tooltip } from '@/components/ui';
import { ColorPips, LegalityMatrix, ManaCost, ManaSymbol, OracleText, SetIcon } from '@/components/text';
import { CardRef } from '@/components/shell/CardRef';
import { toast } from '@/lib/stores/ui';
import styles from './kit.module.css';

const SAMPLE_ORACLE = `Flying (This creature can't be blocked except by creatures with flying or reach.)\n{T}: Add {G}. Activate only if you control a Forest.\n+1: You gain 2 life.\n−3: Destroy target creature with mana value 3 or less.\n{2}{W/U}{U/P}: Return target creature to its owner's hand.`;

export function KitPage() {
  const [pressed, setPressed] = useState<Record<string, boolean>>({ W: true, U: false, B: false, R: true, G: false, C: false });
  const [seg, setSeg] = useState<'grid' | 'list'>('grid');
  const [tab, setTab] = useState<'main' | 'side'>('main');
  const [range, setRange] = useState<[number, number]>([1, 6]);
  const [q, setQ] = useState('');
  const [dialog, setDialog] = useState(false);
  const [drawer, setDrawer] = useState(false);
  return (
    <div className={`container ${styles.kit}`}>
      <h1>Vault kit</h1>
      <p className="muted">Every control in the design system, on one page, for eyeballing.</p>

      <section className={styles.section}><h2>Type</h2>
        <div className={styles.typeRow}>
          <span className="display" style={{ fontSize: 56, fontVariationSettings: "'opsz' 144, 'SOFT' 100, 'WONK' 1" }}>Ragavan, Nimble Pilferer</span>
          <span className="display" style={{ fontSize: 22 }}>Fraunces at 22 for names in lists</span>
          <span>Instrument Sans carries the interface. It is quiet and slightly wide.</span>
          <span className="mono">JetBrains Mono 0.587930 ±1.2% #0042 $12.40</span>
        </div>
      </section>

      <section className={styles.section}><h2>Buttons</h2>
        <div className={styles.row}>
          <Button variant="primary" icon={<Plus />}>Add to deck</Button>
          <Button>Quiet</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger" icon={<Trash2 />}>Delete deck</Button>
          <Button size="sm" variant="primary">Small primary</Button>
          <Button size="sm">Small</Button>
          <Button disabled>Disabled</Button>
          <IconButton label="Filters"><Filter /></IconButton>
          <IconButton label="Bookmark" variant="quiet"><Bookmark /></IconButton>
        </div>
      </section>

      <section className={styles.section}><h2>Chips</h2>
        <div className={styles.row}>
          {(['W', 'U', 'B', 'R', 'G', 'C'] as const).map(c => (
            <ManaChip key={c} color={c} pressed={pressed[c]} label={c} onClick={() => setPressed(p => ({ ...p, [c]: !p[c] }))}><ManaSymbol sym={c} size={20} /></ManaChip>
          ))}
          <Chip pressed>Creature</Chip>
          <Chip>Instant</Chip>
          <Chip size="sm" pressed onRemove={() => {}}>Modern</Chip>
          <Chip size="sm">Legendary</Chip>
        </div>
      </section>

      <section className={styles.section}><h2>Inputs</h2>
        <div className={styles.grid2}>
          <SearchInput value={q} onChange={setQ} placeholder="Search  o:draw  t:elf  n:llanowar" />
          <Input label="Deck name" placeholder="Untitled deck" hint="Shown on the play table." />
          <Select label="Sort" aria-label="Sort" options={[{ value: 'name', label: 'Name' }, { value: 'released', label: 'Newest' }, { value: 'price', label: 'Price' }]} />
          <Segmented value={seg} onChange={setSeg} label="View" options={[{ value: 'grid', label: 'Grid' }, { value: 'list', label: 'List' }]} />
          <RangeSlider min={0} max={16} value={range} onChange={setRange} label="Mana value" format={(v, e) => (e === 'hi' && v === 16 ? '16+' : String(v))} />
          <Tabs value={tab} onChange={setTab} label="Boards" items={[{ value: 'main', label: 'Main', count: 60 }, { value: 'side', label: 'Sideboard', count: 15 }]} />
        </div>
      </section>

      <section className={styles.section}><h2>Overlays</h2>
        <div className={styles.row}>
          <Popover trigger={<Button>Popover</Button>}>{(close) => <div style={{ padding: 8, display: 'grid', gap: 8 }}><span>Anchored with floating-ui.</span><Button size="sm" onClick={close}>Done</Button></div>}</Popover>
          <Tooltip content="Decks are coming next"><Button disabled aria-disabled>Add to deck</Button></Tooltip>
          <Tooltip content="A tooltip on a live button"><Button>Hover me</Button></Tooltip>
          <Button onClick={() => setDialog(true)}>Dialog</Button>
          <Button onClick={() => setDrawer(true)}>Drawer</Button>
          <Button onClick={() => toast({ title: 'Saved', body: 'Your deck was written to user.db.', kind: 'ok' })}>Toast</Button>
          <Button onClick={() => toast({ title: 'Unsimulated text', body: '3 cards in this deck have abilities the engine does not model yet.', kind: 'warn' })}>Warn toast</Button>
        </div>
        <Dialog open={dialog} onClose={() => setDialog(false)} title="Discard changes?" footer={<><Button onClick={() => setDialog(false)}>Keep editing</Button><Button variant="danger" onClick={() => setDialog(false)}>Discard</Button></>}>
          <p className="muted">The deck has edits that were not saved. Discarding closes the builder without writing them.</p>
        </Dialog>
        <Drawer open={drawer} onClose={() => setDrawer(false)} title="Filters" side="bottom"><p className="muted">The filter rail becomes this sheet on narrow screens.</p></Drawer>
      </section>

      <section className={styles.section}><h2>Callouts and badges</h2>
        <div className={styles.stack}>
          <Callout title="Note">Plain information, brass rule.</Callout>
          <Callout variant="warn" title="Index is stale">master.db was rebuilt after the last <code>npm run web:index</code>.</Callout>
          <Callout variant="danger" title="Illegal in Modern">Ragavan, Nimble Pilferer is banned.</Callout>
          <Callout variant="engine" title="Unsimulated text">The engine does not model “Cascade” yet; this card resolves without it.</Callout>
        </div>
        <div className={styles.row} style={{ marginTop: 12 }}>
          <RarityBadge rarity="common" /><RarityBadge rarity="uncommon" /><RarityBadge rarity="rare" /><RarityBadge rarity="mythic" />
          <LegalityBadge status="legal" /><LegalityBadge status="restricted" /><LegalityBadge status="banned" /><LegalityBadge status="not_legal" />
          <Badge tone="brass">Foil</Badge><Badge>Showcase</Badge><Badge tone="mute">Reprint</Badge><Badge tone="info" dot>Live</Badge>
          <Kbd>Ctrl</Kbd><Kbd>K</Kbd><Kbd>/</Kbd>
        </div>
      </section>

      <section className={styles.section}><h2>Numbers</h2>
        <div className={styles.grid2}>
          <div className={styles.row} style={{ gap: 32 }}>
            <Stat label="Cards" value="38,630" />
            <Stat label="Printings" value="117,621" />
            <Stat label="Win" value="61.4" unit="%" size="lg" />
          </div>
          <div className={styles.stack}>
            <Meter value={0.12} label="Draw a land" />
            <Meter value={0.46} label="Hit lethal" />
            <Meter value={0.87} label="Survive crack-back" />
          </div>
        </div>
      </section>

      <section className={styles.section}><h2>Text</h2>
        <div className={styles.grid2}>
          <div className={styles.stack}>
            <ManaCost cost="{2}{W}{W}" size={18} />
            <ManaCost cost="{X}{U/P}{B/R}{2/G}{C}{S}" size={18} />
            <ManaCost cost="{1}{R} // {2}{U}" size={18} />
            <div className={styles.row}><ColorPips colors={['W', 'U']} /> <ColorPips colors={[]} /> <ColorPips colors={['B', 'R', 'G']} size={18} /></div>
            <div className={styles.row}><SetIcon code="lea" size={22} /><SetIcon code="mh2" rarity="mythic" size={22} /><SetIcon code="one" rarity="rare" size={22} /><SetIcon code="dsk" rarity="uncommon" size={22} /><SetIcon code="zzz" size={22} /></div>
            <p>Hover <CardRef name="Lightning Bolt" /> or <CardRef name="Ragavan, Nimble Pilferer" /> to preview it.</p>
          </div>
          <div className="surface" style={{ padding: 16 }}><OracleText text={SAMPLE_ORACLE} /></div>
        </div>
        <div style={{ marginTop: 16 }}>
          <LegalityMatrix legalities={{ standard: 'not_legal', pioneer: 'legal', modern: 'banned', legacy: 'legal', vintage: 'restricted', commander: 'legal', pauper: 'not_legal', historic: 'legal' }} />
        </div>
      </section>

      <section className={styles.section}><h2>Skeleton and empty</h2>
        <div className={styles.grid2}>
          <div className={styles.row}><Skeleton kind="card" width={120} /><div className={styles.stack} style={{ flex: 1 }}><Skeleton kind="text" width="60%" /><Skeleton kind="text" width="40%" /><Skeleton kind="text" width="80%" /></div></div>
          <EmptyState title="No cards match" actions={<Button size="sm">Clear filters</Button>}>Try fewer filters, or search by rules text with <Kbd>o:</Kbd>.</EmptyState>
        </div>
      </section>
    </div>
  );
}
