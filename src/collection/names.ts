// Deck names from collection file names, and a commander guess from the name plus the deck's legendary creatures.

/** "varina,_lich queen.csv" -> "Varina, Lich Queen"; "big_booty doran" -> "Big Booty Doran". */
export function deckNameFromFile(file: string): string {
  let s = file.replace(/\\/g, '/').split('/').pop() ?? file;
  s = s.replace(/\.(csv|txt|dec|dek)$/i, '');
  s = s.replace(/_/g, ' ').replace(/\s*,\s*/g, ', ').replace(/\s+/g, ' ').trim();
  return s.split(' ').map(w => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

export interface CommanderCandidate { oracleId: string; name: string; typeLine: string; oracleText: string }
export interface CommanderGuess { oracleId: string; name: string; score: number }
export interface CommanderInference { candidates: CommanderGuess[]; pick: CommanderGuess | null; confidence: 'high' | 'ambiguous' | 'low' | 'none' }

const STOP = new Set(['the', 'of', 'and', 'a', 'an', 'deck', 'edh', 'commander', 'big', 'booty', 'society', 'lord', 'king', 'queen', 'master', 'lich', 'fire', 'girthbending']);

/** Cards that may lead a Commander deck: legendary creatures, or anything whose text says it can be your commander. */
export function canBeCommander(c: { typeLine: string; oracleText: string }): boolean {
  const front = c.typeLine.split(' // ')[0];
  if (/\bLegendary\b/.test(front) && /\bCreature\b/.test(front)) return true;
  return /can be your commander/i.test(c.oracleText);
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

const tokens = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(t => t.length >= 3);

/**
 * Score each commander-capable card by how many display-name tokens match its name (exact, or within edit distance 2 for
 * tokens of 5+ letters, so "goph" -> "toph" and "girthbending" -> "earthbending" still hit). A unique best score is
 * `high`; a tie is `ambiguous`; no token match falls back to the only candidate (`low`) or nothing (`none`).
 */
export function inferCommander(displayName: string, cards: CommanderCandidate[]): CommanderInference {
  const cands = cards.filter(canBeCommander);
  const want = tokens(displayName).filter(t => !STOP.has(t) || t.length >= 6);
  const scored: CommanderGuess[] = cands.map(c => {
    const have = tokens(c.name.split(' // ')[0]);
    let score = 0;
    for (const w of want) {
      if (have.includes(w)) score += 2;
      else if (w.length >= 5 && have.some(h => Math.abs(h.length - w.length) <= 2 && levenshtein(h, w) <= 2)) score += 1;
      else if (w.length >= 4 && have.some(h => h.startsWith(w) || w.startsWith(h) && h.length >= 4)) score += 1;
    }
    return { oracleId: c.oracleId, name: c.name, score };
  }).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  if (!scored.length) return { candidates: [], pick: null, confidence: 'none' };
  const best = scored[0];
  if (best.score > 0) {
    const tied = scored.filter(s => s.score === best.score);
    if (tied.length === 1) return { candidates: scored, pick: best, confidence: 'high' };
    return { candidates: scored, pick: null, confidence: 'ambiguous' };
  }
  if (scored.length === 1) return { candidates: scored, pick: best, confidence: 'low' };
  return { candidates: scored, pick: null, confidence: 'none' };
}
