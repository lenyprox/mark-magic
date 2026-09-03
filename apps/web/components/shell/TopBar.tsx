'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Search } from 'lucide-react';
import { Kbd } from '@/components/ui/Display';
import { useUi } from '@/lib/stores/ui';
import styles from './shell.module.css';

const NAV = [
  { href: '/cards', label: 'Cards' },
  { href: '/sets', label: 'Sets' },
  { href: '/decks', label: 'Decks' },
  { href: '/play', label: 'Play' },
];

export function TopBar() {
  const path = usePathname();
  const openPalette = useUi(s => s.setPaletteOpen);
  return (
    <header className={styles.topbar}>
      <Link href="/" className={styles.brand} aria-label="Vault, home"><span className={styles.brandMark} aria-hidden />Vault</Link>
      <nav className={styles.nav} aria-label="Primary">
        {NAV.map(n => {
          const active = path === n.href || path.startsWith(n.href + '/');
          return <Link key={n.href} href={n.href} className={styles.navLink} aria-current={active ? 'page' : undefined}>{n.label}</Link>;
        })}
      </nav>
      <div className={styles.spacer} />
      <button type="button" className={styles.searchBtn} onClick={() => openPalette(true)} aria-label="Search cards, sets and actions">
        <Search aria-hidden />
        <span className={styles.label}>Find a card…</span>
        <span className={styles.kbds} aria-hidden><Kbd>Ctrl</Kbd><Kbd>K</Kbd></span>
      </button>
    </header>
  );
}
