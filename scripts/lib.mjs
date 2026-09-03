import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';

export async function* readJsonl(file) {
  const src = fs.createReadStream(file);
  const stream = file.endsWith('.gz') ? src.pipe(zlib.createGunzip()) : src;
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) { if (line.trim()) yield JSON.parse(line); }
}

// Parse a Scryfall mana cost like "{2}{W}{U/B}{X}" into pips.
export function parseManaCost(cost) {
  const pips = [];
  if (!cost) return pips;
  const re = /\{([^}]+)\}/g; let m;
  while ((m = re.exec(cost))) pips.push(m[1]);
  return pips;
}

// Mana value per CR 202.3 (X = 0, hybrid {2/W} = 2, phyrexian = 1, half-pips = 0.5).
export function manaValueOf(cost) {
  let mv = 0;
  for (const p of parseManaCost(cost)) {
    if (/^\d+$/.test(p)) mv += Number(p);
    else if (p === 'X' || p === 'Y' || p === 'Z') mv += 0;
    else if (/^\d+\/[WUBRGC]$/.test(p)) mv += Number(p.split('/')[0]);
    else if (p === 'HW' || p === 'HR') mv += 0.5;
    else if (p === 'S' || p === 'C' || /^[WUBRG]$/.test(p) || /^[WUBRGC]\/[WUBRGCP]$/.test(p) || /^[WUBRG]\/[WUBRG]\/P$/.test(p)) mv += 1;
    else mv += 0; // {P}, {CHAOS}, {T}, {Q}, {E}, unknown -> 0; the audit flags unknown pips
  }
  return mv;
}

export const KNOWN_PIP = /^(\d+|X|Y|Z|[WUBRGC]|S|P|HW|HR|[WUBRGC]\/[WUBRGCP]|[WUBRG]\/[WUBRG]\/P|\d+\/[WUBRGC]|CHAOS|T|Q|E|L|D|A|TK|PW)$/;

export function colorsOfCost(cost) {
  const s = new Set();
  for (const p of parseManaCost(cost)) { if (p === 'HW') s.add('W'); else if (p === 'HR') s.add('R'); else for (const ch of p.split('/')) if (ch.length === 1 && 'WUBRG'.includes(ch)) s.add(ch); }
  return sortColors([...s]);
}

export const COLOR_ORDER = ['W', 'U', 'B', 'R', 'G'];
export function sortColors(a) { return [...a].sort((x, y) => COLOR_ORDER.indexOf(x) - COLOR_ORDER.indexOf(y)); }

export const SUPERTYPES = new Set(['Basic', 'Legendary', 'Snow', 'World', 'Ongoing', 'Host', 'Elite']);

// Multi-word subtypes that exist in the Comprehensive Rules / Scryfall catalogs.
export const MULTIWORD_SUBTYPES = ['Time Lord', "Bolas's Meditation Realm", "Serra's Realm", 'New Phyrexia'];
export function splitSubtypes(s) {
  const out = []; let rest = s.trim();
  while (rest) {
    const mw = MULTIWORD_SUBTYPES.find(m => rest.startsWith(m + ' ') || rest === m);
    if (mw) { out.push(mw); rest = rest.slice(mw.length).trim(); continue; }
    const sp = rest.indexOf(' ');
    if (sp < 0) { out.push(rest); break; }
    out.push(rest.slice(0, sp)); rest = rest.slice(sp + 1).trim();
  }
  return out;
}
export function splitTypeLine(tl) {
  const first = (tl ?? '').split(' // ')[0];
  const [left, right] = first.split(' — ');
  const words = left.trim().split(/\s+/).filter(Boolean);
  return {
    supertypes: words.filter(w => SUPERTYPES.has(w)),
    types: words.filter(w => !SUPERTYPES.has(w)),
    subtypes: right ? splitSubtypes(right) : [],
  };
}
