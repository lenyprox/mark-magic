// Fixture scripts for `scripts:verify`, shared by test/scripts-verify.test.ts and by the timing measurement in the
// slice report. They are written into a TEMP directory, never into data/scripts: verification writes a
// `verification` block back into every file it reads, and a test must not leave that in the tracked corpus.
//
// The five "good" fixtures are hand-written scripts for five real cards, one per way a line can be claimed:
// a spell ability (Lightning Bolt), a static ability (Glorious Anthem), keywords + `covers` (Serra Angel), a
// `covers` by `morph` plus a triggered ability the probes cannot reach (Ainok Survivalist), and a triggered ability
// with two effects on one line (Blood Artist).
//
// Reproducing the timing measurement by hand:
//   npx tsx -e "import('./test/scripts-verify-fixtures.ts').then(async m => { const d = m.freshDir(); console.log(d, (await m.writeTimingFixtures(d)).join(',')); })"
//   time npm run scripts:verify -- --dir <that dir> --ids <those ids>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CardDB } from '../src/cards/db.js';
import { parseCard } from '../src/cards/parse.js';
import { oracleHash, shardOf, type CardScript } from '../src/cards/scripts.js';
import type { CardDef, ManaCost } from '../src/cards/types.js';

/** A fresh temp directory for a script store. */
export const freshDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'scripts-verify-'));

/** A `ManaCost` from its printed symbols — `{1}{G}` -> generic 1, pips `['G']`. */
export function mana(raw: string): ManaCost {
  const cost: ManaCost = { generic: 0, x: 0, pips: [], hybrid: [], phyrexian: [], raw };
  for (const m of raw.matchAll(/\{([^}]*)\}/g)) {
    const s = m[1].toUpperCase();
    if (/^\d+$/.test(s)) cost.generic += Number(s);
    else if (s === 'X') cost.x += 1;
    else if (['W', 'U', 'B', 'R', 'G', 'C'].includes(s)) cost.pips.push(s as ManaCost['pips'][number]);
  }
  return cost;
}

/** The parser's own def for a card, script NOT applied — what a fixture's `oracleHash` must be taken from. */
export function parsedDef(cards: CardDB, name: string): CardDef {
  const row = cards.db.prepare('SELECT json FROM oracle_cards WHERE name = ? ORDER BY first_printed LIMIT 1').get(name) as { json: string } | undefined;
  if (!row) throw new Error(`fixtures: no card named ${name} in master.db`);
  const raw = JSON.parse(row.json) as Record<string, unknown>;
  return parseCard({ ...raw, representative_id: raw.representative_id ?? raw.id ?? null } as never);
}

/** Write one script into `<dir>/<2-hex>/<oracle id>.json`, LF only. */
export function writeScript(dir: string, script: CardScript): string {
  const file = path.join(dir, shardOf(script.oracleId), `${script.oracleId}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(script, null, 2).replace(/\r\n/g, '\n') + '\n');
  return file;
}

/** The identity fields every fixture shares: a `hand` script written against the card's text as it stands today. */
export function head(def: CardDef, rest: Partial<CardScript> = {}): CardScript {
  return { oracleId: def.oracleId, name: def.name, oracleHash: oracleHash(def.oracleText), source: 'hand', mode: 'replace', ...rest };
}

/** The five hand-written fixtures, keyed by card name. */
export function goodFixtures(cards: CardDB): Record<string, CardScript> {
  const bolt = parsedDef(cards, 'Lightning Bolt');
  const anthem = parsedDef(cards, 'Glorious Anthem');
  const angel = parsedDef(cards, 'Serra Angel');
  const ainok = parsedDef(cards, 'Ainok Survivalist');
  const artist = parsedDef(cards, 'Blood Artist');
  return {
    'Lightning Bolt': head(bolt, {
      abilities: [{ kind: 'spell', effects: [{ op: 'damage', amount: 3, target: { kind: 'any' } }], text: '~ deals 3 damage to any target.' }],
      aiHints: { role: 'removal', value: 5, timing: 'instant' },
    }),
    'Glorious Anthem': head(anthem, {
      abilities: [{ kind: 'static', effect: { kind: 'anthem', power: 1, toughness: 1, filter: { types: ['Creature'] }, scope: 'you-control' }, text: 'Creatures you control get +1/+1.' }],
      aiHints: { role: 'anthem' },
    }),
    'Serra Angel': head(angel, {
      keywords: ['flying', 'vigilance'],
      covers: [{ line: 'Flying', by: 'keywords' }, { line: 'Vigilance', by: 'keywords' }],
      aiHints: { role: 'creature' },
    }),
    // the `turned-face-up` event is raised by `Game.turnFaceUp` but nothing dispatches it (docs/HANDOFF.md item 11),
    // so this ability is UNREACHABLE — the fixture that pins "unreachable is a warning, not a failure"
    'Ainok Survivalist': head(ainok, {
      morph: { cost: mana('{1}{G}'), megamorph: true },
      covers: [{ line: 'Megamorph {1}{G}', by: 'morph' }],
      abilities: [{
        kind: 'triggered', event: { on: 'turned-face-up', self: true },
        effects: [{ op: 'destroy', target: { kind: 'artifact-or-enchantment', controller: 'opponent' } }],
        text: 'When ~ is turned face up, destroy target artifact or enchantment an opponent controls.',
      }],
    }),
    'Blood Artist': head(artist, {
      abilities: [{
        kind: 'triggered', event: { on: 'dies', self: false, filter: { types: ['Creature'] } },
        effects: [{ op: 'lose-life', amount: 1, who: 'target-player' }, { op: 'gain-life', amount: 1, who: 'you' }],
        text: 'Whenever ~ or another creature dies, target player loses 1 life and you gain 1 life.',
      }],
    }),
  };
}

/**
 * Thirty real cards for the timing measurement: each gets a `mode: 'extend'` script that declares nothing, so the
 * parser's own abilities stand and every stage does its full work (schema, freshness, registry, lint, both sandbox
 * seat counts, every reachability probe, the renderer) on a real card. The scores and problems are not the point —
 * the wall clock is (plan 2.2: <= 15 s for a 30-card batch).
 */
export const TIMING_CARDS = [
  'Lightning Bolt', 'Glorious Anthem', 'Serra Angel', 'Blood Artist', 'Ainok Survivalist', 'Llanowar Elves',
  'Mulldrifter', 'Wall of Omens', 'Sakura-Tribe Elder', 'Solemn Simulacrum', 'Rampaging Baloths', 'Sol Ring',
  'Pacifism', 'Grizzly Bears', 'Wrath of God', 'Doran, the Siege Tower', 'Reliquary Tower', 'Birds of Paradise',
  'Prodigal Sorcerer', 'Academy Ruins', 'Grim Monolith', 'Elite Vanguard', 'Hill Giant', 'Shock', 'Divination',
  'Deranged Hermit', 'Fervent Charge', 'Aetherflux Reservoir', 'Nekusar, the Mindrazer', 'Karn Liberated',
] as const;

/** Write the timing fixtures and return their oracle ids, in order. */
export async function writeTimingFixtures(dir: string, cards: CardDB = CardDB.shared()): Promise<string[]> {
  const ids: string[] = [];
  for (const name of TIMING_CARDS) {
    const def = parsedDef(cards, name);
    writeScript(dir, head(def, { source: 'generated', mode: 'extend', confidence: 0.5, notes: 'timing fixture (declares nothing; the parser stands)' }));
    ids.push(def.oracleId);
  }
  return ids;
}
