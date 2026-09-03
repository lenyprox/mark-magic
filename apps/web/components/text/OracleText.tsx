import clsx from 'clsx';
import { tokenizeOracle } from '@/lib/text/tokenize';
import { ManaSymbol } from './ManaSymbol';
import styles from './text.module.css';

/** Oracle text with inline symbols, italic reminder text, paragraphs and loyalty-ability badges. */
export function OracleText({ text, className, symbolSize }: { text: string | null | undefined; className?: string; symbolSize?: number }) {
  if (!text) return null;
  const paras = tokenizeOracle(text);
  return (
    <div className={clsx(styles.oracle, className)}>
      {paras.map((p, i) => (
        <p key={i}>
          {p.loyalty && <span className={styles.loyalty} data-sign={p.loyalty.startsWith('+') ? '+' : p.loyalty.startsWith('−') ? '−' : '0'} aria-label={`Loyalty ${p.loyalty}`}>{p.loyalty}</span>}
          {p.tokens.map((t, k) => {
            if (t.kind === 'symbol') return <ManaSymbol key={k} sym={t.symbol} size={symbolSize} />;
            if (t.kind === 'reminder') return <span key={k} className={styles.reminder}>{t.text}</span>;
            return <span key={k}>{t.text}</span>;
          })}
        </p>
      ))}
    </div>
  );
}
