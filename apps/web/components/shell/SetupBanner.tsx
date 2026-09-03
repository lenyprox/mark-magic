// Shown when the local data pipeline has not run yet. Server-safe.
import { Callout } from '@/components/ui/Display';
import styles from './shell.module.css';

export interface SetupStatus { master: boolean; index: boolean; indexStale?: boolean; manaSprite: boolean }

export function SetupBanner({ status, className }: { status: SetupStatus; className?: string }) {
  const steps: { cmd: string; done: boolean; why: string }[] = [
    { cmd: 'npm run data:all', done: status.master, why: 'downloads Scryfall bulk data and builds master.db' },
    { cmd: 'npm run web:index', done: status.index && !status.indexStale, why: status.indexStale ? 'master.db was rebuilt after the last index; re-run' : 'adds the search index the app reads' },
    { cmd: 'npm run data:mana', done: status.manaSprite, why: 'fetches mana symbols and set icons' },
  ];
  const todo = steps.filter(s => !s.done);
  if (!todo.length) return null;
  const blocking = !status.master || !status.index;
  return (
    <Callout variant={blocking ? 'warn' : 'note'} title={blocking ? 'The vault is empty until the data pipeline runs' : 'One more step to finish setup'} className={`${styles.setup} ${className ?? ''}`}>
      Run from the repository root, in order:
      <ol>
        {todo.map(s => <li key={s.cmd}><code>{s.cmd}</code> — {s.why}</li>)}
      </ol>
    </Callout>
  );
}
