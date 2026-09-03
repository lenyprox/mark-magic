'use client';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { NewDeckForm } from './NewDeckDialog';
import styles from '@/app/decks/decks.module.css';

export function NewDeckPage() {
  return (
    <div className={styles.newPage}>
      <Link href="/decks" className="link small"><ArrowLeft size={14} style={{ verticalAlign: '-2px' }} /> All decks</Link>
      <h1>New deck</h1>
      <p className="muted small">Name it, pick a format, and start adding cards. Everything saves as you go.</p>
      <NewDeckForm />
    </div>
  );
}
