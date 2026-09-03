// Oracle text tokeniser: mana/tap symbols in braces, reminder text in parentheses, loyalty prefixes, paragraphs.
export type Token =
  | { kind: 'text'; text: string }
  | { kind: 'symbol'; symbol: string }
  | { kind: 'reminder'; text: string };

export interface OracleParagraph { loyalty: string | null; tokens: Token[] }

const SYMBOL_RE = /\{[^}]+\}/g;

/** Split one paragraph into text / symbol / reminder tokens. */
export function tokenizeLine(line: string): Token[] {
  const out: Token[] = [];
  // Split reminder text first (balanced single-level parentheses that contain a lowercase word — avoids "(1/1)" style false positives).
  const chunks = line.split(/(\([^()]*[a-z][^()]*\))/g);
  for (const chunk of chunks) {
    if (!chunk) continue;
    if (chunk.startsWith('(') && chunk.endsWith(')')) { out.push({ kind: 'reminder', text: chunk }); continue; }
    let last = 0;
    for (const m of chunk.matchAll(SYMBOL_RE)) {
      if (m.index! > last) out.push({ kind: 'text', text: chunk.slice(last, m.index) });
      out.push({ kind: 'symbol', symbol: m[0] });
      last = m.index! + m[0].length;
    }
    if (last < chunk.length) out.push({ kind: 'text', text: chunk.slice(last) });
  }
  return out;
}

const LOYALTY_RE = /^([+−–-]?(?:\d+|X)|0):\s*/;

export function tokenizeOracle(text: string): OracleParagraph[] {
  return text.split(/\n+/).filter(l => l.trim()).map(line => {
    const m = line.match(LOYALTY_RE);
    if (m) return { loyalty: m[1].replace(/^[−–]/, '−').replace(/^-/, '−'), tokens: tokenizeLine(line.slice(m[0].length)) };
    return { loyalty: null, tokens: tokenizeLine(line) };
  });
}

/** All `{…}` symbols in a mana cost string, in order. `{2}{W}{W}` → ['{2}','{W}','{W}']. */
export function splitCost(cost: string | null | undefined): string[] {
  if (!cost) return [];
  return cost.match(SYMBOL_RE) ?? [];
}
