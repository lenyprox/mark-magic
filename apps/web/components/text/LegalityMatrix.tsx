import clsx from 'clsx';
import { LegalityBadge } from '@/components/ui/Display';
import styles from './text.module.css';

const ORDER = ['standard', 'pioneer', 'modern', 'legacy', 'vintage', 'commander', 'pauper', 'alchemy', 'historic', 'timeless', 'brawl', 'standardbrawl', 'oathbreaker', 'paupercommander', 'duel', 'predh', 'premodern', 'oldschool', 'penny', 'explorer', 'gladiator', 'future'];
const LABEL: Record<string, string> = { standardbrawl: 'Standard Brawl', paupercommander: 'Pauper Commander', predh: 'PreDH', oldschool: 'Old School', penny: 'Penny Dreadful', duel: 'Duel Commander' };

export function LegalityMatrix({ legalities, className, compact }: { legalities: Record<string, string>; className?: string; compact?: boolean }) {
  const keys = Object.keys(legalities).sort((a, b) => (ORDER.indexOf(a) === -1 ? 99 : ORDER.indexOf(a)) - (ORDER.indexOf(b) === -1 ? 99 : ORDER.indexOf(b)));
  const shown = compact ? keys.filter(k => ORDER.indexOf(k) > -1 && ORDER.indexOf(k) < 8) : keys;
  return (
    <dl className={clsx(styles.legal, className)}>
      {shown.map(k => (
        <div key={k} className={styles.legalRow}>
          <dt className={styles.legalName}>{LABEL[k] ?? k}</dt>
          <dd><LegalityBadge status={legalities[k]} /></dd>
        </div>
      ))}
    </dl>
  );
}
