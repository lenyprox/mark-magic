// src/cards/taxonomy.ts: the family classifier that decides which vocabulary wave a card is waiting for, and which
// batch `scripts:queue` puts it in. Pinned on real cards (the owner-deck examples of docs/plans/owner-decks-needs.md
// plus a spread of the pool) and on the two over-tags the regex heuristic this replaces was known to make.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CardDB } from '../src/cards/db.js';
import { parseCard } from '../src/cards/parse.js';
import {
  addToHistogram, BASE_FAMILIES, DEFAULT_FAMILY_RANK, emptyFamilyHistogram, familiesOf, familyOfLine, FAMILY_RULES,
  canonicalKeyword, histogramRows, isNamedKeyword, KEYWORD_ALIAS, namedKeywordOfLine, NAMED_KEYWORDS, type Family,
} from '../src/cards/taxonomy.js';

const db = CardDB.shared();

/** The PARSER-ALONE def of a card (CardDB.get would apply a script and hide the unparsed lines). */
function alone(name: string) {
  const row = db.db.prepare('SELECT json FROM oracle_cards WHERE name = ? ORDER BY first_printed LIMIT 1').get(name) as { json: string } | undefined;
  assert.ok(row, `no such card in master.db: ${name}`);
  const o = JSON.parse(row!.json) as Record<string, any>;
  const def = parseCard({ ...(o as any), representative_id: o.representative_id ?? o.id ?? null });
  return { def, keywords: (o.keywords as string[] | undefined) ?? [] };
}

function tax(name: string) {
  const { def, keywords } = alone(name);
  return familiesOf({ unparsed: def.unparsed, backFace: def.backFace ?? null, scryfallKeywords: keywords });
}

/**
 * 66 real cards and the family the queue must file each under. `null` means "the parser finishes this card, so it
 * has no family at all" — the classifier must not invent work for a card that needs none.
 */
const CARDS: [name: string, primary: Family | null][] = [
  // --- the owner's decks (the examples docs/plans/owner-decks-needs.md names)
  ["Teferi's Protection", 'named-keyword:phasing'],
  ['Multiversal Passage', 'layers'],
  ['Pick Your Poison', 'piles-choices'],
  ['Crackle with Power', 'generic'],
  ['Bow of Nylea', 'generic'],
  ['Roaming Throne', 'layers'],
  ['Darksteel Garrison', 'named-keyword:fortify'],
  ['Angel of Indemnity', 'named-keyword:encore'],
  ['Lure', null],                        // 9.1: the combat-restr parser rules finish it, so it is never queued
  ["Innkeeper's Talent", 'named-keyword:level up'],
  ['Comet Storm', 'named-keyword:multikicker'],
  ['Leyline of Anticipation', 'other'],
  ['Toxic Deluge', 'generic'],
  ['Questing Beast', 'replacement'],
  ['Bloodline Bidding', 'generic'],
  ['Skyclave Apparition', 'generic'],
  ['Urborg, Tomb of Yawgmoth', 'layers'],
  ['Deflecting Palm', 'replacement'],
  ['Gandalf the Grey', 'piles-choices'],
  ['Horizon Explorer', 'replacement'],
  ['Archetype of Finality', 'layers'],
  ['Ochran Assassin', null],             // 9.1: likewise — "All creatures able to block ~ do so." now parses
  ['Kindred Dominance', 'generic'],
  ['Unstoppable Slasher', 'generic'],
  ['Wand of Orcus', 'generic'],

  // --- control CHANGES (the heuristic's loudest over-tag is the negative case below)
  ['Threaten', 'control'],
  ['Ray of Command', 'control'],

  // --- copy / clone
  ['Clone', 'copy-clone'],
  ['Fork', 'copy-clone'],
  ['Reverberate', 'copy-clone'],
  ['Phantasmal Image', 'copy-clone'],
  ['Twinflame', 'copy-clone'],

  // --- layers
  ["Kenrith's Transformation", 'layers'],
  ['Song of the Dryads', 'layers'],
  ['Blood Moon', 'layers'],
  ['Turn to Frog', 'layers'],
  ["Sea's Claim", 'layers'],

  // --- replacement / prevention
  ['Rest in Peace', 'replacement'],
  ['Platinum Angel', 'replacement'],
  ['Torpor Orb', 'replacement'],

  // --- combat restrictions
  ['Propaganda', 'combat-restr'],
  ['Ghostly Prison', 'combat-restr'],
  ['Peacekeeper', 'combat-restr'],

  // --- cost alteration and free casts
  ['Omniscience', 'cost-alter'],

  // --- structural families
  ['Chandra, Torch of Defiance', 'planeswalker'],
  ["Krark's Thumb", 'dice-coin'],

  // --- named keywords
  ['Snapcaster Mage', 'named-keyword:flashback'],
  ['Ancestral Vision', 'named-keyword:suspend'],

  // --- piles / votes
  ['Fact or Fiction', 'piles-choices'],
  ["Council's Judgment", 'piles-choices'],
  ['Browbeat', 'generic'],

  // --- generic composition
  ['History of Benalia', 'generic'],
  ['Tireless Tracker', 'generic'],

  // --- cards the parser finishes: no family, no queue entry
  ['Grizzly Bears', null],
  ['Lightning Bolt', null],
  ['Llanowar Elves', null],
  ['Giant Growth', null],
  ['Doom Blade', null],
  ['Divination', null],
  ['Shock', null],
  ['Serra Angel', null],
  ['Wrath of God', null],
  ['Counterspell', null],
  ['Dark Ritual', null],
  ['Overrun', null],
  ['Fog', null],
  ['Thought Scour', null],
];

test(`${CARDS.length} real cards land in the family the queue expects`, () => {
  assert.ok(CARDS.length >= 60, 'the plan asks for at least 60 pinned cards');
  const wrong: string[] = [];
  for (const [name, want] of CARDS) {
    const t = tax(name);
    const got = t.families.length ? t.primary : null;
    if (got !== want) wrong.push(`${name}: expected ${want}, got ${got} [${t.families.join(', ')}] — ${t.lines.map(l => l.line).slice(0, 1).join('')}`);
  }
  assert.deepEqual(wrong, [], wrong.join('\n'));
});

// ---------------------------------------------------------------------------
// The heuristic's known over-tags (docs/plans/owner-decks-needs.md)
// ---------------------------------------------------------------------------

test('"creatures you control gain … until end of turn" is generic, not control', () => {
  for (const line of [
    'Creatures you control gain trample until end of turn.',
    'Creatures you control get +1/+1 and gain vigilance until end of turn.',
    'Permanents you control gain hexproof until end of turn.',
  ]) assert.equal(familyOfLine(line)?.family, 'generic', line);
});

test('a real control change is still control', () => {
  for (const line of [
    'Gain control of target creature until end of turn.',
    'Exchange control of two target permanents.',
    'Put target creature card onto the battlefield under your control.',
  ]) assert.equal(familyOfLine(line)?.family, 'control', line);
});

test('"return it to the battlefield under its owner\'s control" is a zone move, not a control change', () => {
  const line = 'When ~ dies, return it to the battlefield tapped under its owner\'s control with two stun counters on it.';
  assert.equal(familyOfLine(line)?.family, 'generic');
});

test('"becomes blocked / tapped / the target" is not a layers change', () => {
  for (const line of [
    'Whenever ~ becomes blocked, it gets +2/+0 until end of turn.',
    'Whenever ~ becomes tapped, draw a card.',
    'Whenever ~ becomes the target of a spell, sacrifice it.',
  ]) assert.notEqual(familyOfLine(line)?.family, 'layers', line);
});

test('the bare word "instead" is not a replacement effect', () => {
  assert.notEqual(familyOfLine('Draw two cards instead of one card if you control a Sliver.')?.family, 'replacement');
  assert.equal(familyOfLine('If a creature would die this turn, exile it instead.')?.family, 'replacement');
});

// ---------------------------------------------------------------------------
// Structure of the table
// ---------------------------------------------------------------------------

test('every rule names a base family and carries a reason', () => {
  for (const r of FAMILY_RULES) {
    assert.ok(BASE_FAMILIES.includes(r.family), `unknown family ${r.family}`);
    assert.ok(r.why.length > 5, `rule for ${r.family} has no reason`);
    assert.ok(!r.re.global, 'a global regex would carry lastIndex between lines');
  }
  // `generic` is the catch-all and must be last, or it would eat the specific families
  assert.equal(FAMILY_RULES[FAMILY_RULES.length - 1].family, 'generic');
});

test('the rarity table covers every base family and ranks generic last', () => {
  for (const f of BASE_FAMILIES) assert.equal(typeof DEFAULT_FAMILY_RANK[f], 'number', f);
  for (const f of BASE_FAMILIES) if (f !== 'generic') assert.ok(DEFAULT_FAMILY_RANK[f] < DEFAULT_FAMILY_RANK.generic, f);
});

test('named keywords are lower case, unique, and matched on word boundaries', () => {
  assert.deepEqual([...NAMED_KEYWORDS], [...new Set(NAMED_KEYWORDS)]);
  for (const k of NAMED_KEYWORDS) assert.equal(k, k.toLowerCase(), k);
  assert.equal(namedKeywordOfLine('Suspend 4—{U}'), 'suspend');
  assert.equal(namedKeywordOfLine('~ enters prepared.'), 'prepare');       // the alias folds the inflection back
  assert.equal(namedKeywordOfLine('Fortified land has indestructible.'), 'fortify');
  assert.equal(namedKeywordOfLine('All permanents you control phase out.'), 'phasing');
  assert.equal(namedKeywordOfLine('Draw a card.'), null);
  assert.equal(namedKeywordOfLine('Whenever equipped creature attacks, draw a card.'), null);
});

test('a structural family outranks a keyword the same line happens to mention', () => {
  const t = familiesOf({ unparsed: ['+1: Target creature gains flashback until end of turn.'] });
  assert.equal(t.primary, 'planeswalker');
});

test('the primary family is the rarest one, and a measured frequency map overrides the default order', () => {
  const card = { unparsed: ['Gain control of target creature until end of turn.', 'Draw a card.'] };
  assert.equal(familiesOf(card).primary, 'control');                                    // generic is the commonest
  const freq = new Map<string, number>([['control', 900], ['generic', 3]]);             // pretend generic is the rare one here
  assert.equal(familiesOf(card, { frequencies: freq }).primary, 'generic');
});

test('a named keyword outranks every rules family by default', () => {
  const t = familiesOf({ unparsed: ['Suspend 4—{U}', 'Draw three cards.'] });
  assert.ok(isNamedKeyword(t.primary));
  assert.equal(t.primary, 'named-keyword:suspend');
});

test('Scryfall keywords only add a family when the card still has unparsed text', () => {
  assert.deepEqual(familiesOf({ unparsed: [], scryfallKeywords: ['Flashback'] }).families, []);
  const t = familiesOf({ unparsed: ['Flashback {2}{R}'], scryfallKeywords: ['Flashback'] });
  assert.deepEqual(t.families, ['named-keyword:flashback']);
});

test('an inflected keyword is ONE family on both paths, not two', () => {
  // KEYWORD_ALIAS used to be applied only on the line path, so "enters prepared" + Scryfall's "Prepared" produced
  // `named-keyword:prepare` AND `named-keyword:prepared` for one card, and counted the same line twice in every
  // histogram `scripts:needs --taxonomy` prints.
  const t = familiesOf({ unparsed: ['~ enters prepared.'], scryfallKeywords: ['Prepared'] });
  assert.deepEqual(t.families, ['named-keyword:prepare']);
  assert.equal(t.lines.length, 1, 'the same line must not be filed twice');
  assert.equal(canonicalKeyword('Prepared'), 'prepare');
  assert.equal(canonicalKeyword('Fortified'), 'fortify');
  assert.equal(canonicalKeyword('Phases out'), 'phasing');
  assert.equal(canonicalKeyword('cascade'), 'cascade', 'a keyword with no alias is itself');
  // every alias target is a real family name the line path can also produce
  for (const [from, to] of Object.entries(KEYWORD_ALIAS)) {
    assert.notEqual(from, to);
    assert.equal(canonicalKeyword(to), to, `${to} must be a fixed point`);
  }
  // and the histogram sees one card, one line, one family
  const h = emptyFamilyHistogram();
  addToHistogram(h, t);
  assert.equal(h.totalLines, 1);
  assert.deepEqual(histogramRows(h), [{ family: 'named-keyword:prepare', cards: 1, lines: 1 }]);
});

test('no card in the pool touches two families that are the same keyword', () => {
  // 57 pool cards carry Scryfall's "Prepared" while their lines say "becomes prepared"; before the fix each of them
  // produced named-keyword:prepare AND named-keyword:prepared, inflating every histogram row and splitting the queue
  // group in two. Scanned over every card that carries an aliased keyword, not a hand-picked list.
  const aliased = new Set(Object.keys(KEYWORD_ALIAS));
  const bad: string[] = [];
  let scanned = 0;
  for (const row of db.db.prepare('SELECT name, json FROM oracle_cards').iterate() as Iterable<{ name: string; json: string }>) {
    const o = JSON.parse(row.json) as Record<string, any>;
    const kws: string[] = (o.keywords ?? []).map(String);
    if (!kws.some(k => aliased.has(k.toLowerCase()))) continue;
    scanned++;
    const def = parseCard({ ...(o as any), representative_id: o.representative_id ?? o.id ?? null });
    const t = familiesOf({ unparsed: def.unparsed, backFace: def.backFace ?? null, scryfallKeywords: kws });
    const named = t.families.filter(isNamedKeyword).map(f => f.slice('named-keyword:'.length));
    if (new Set(named.map(canonicalKeyword)).size < named.length) bad.push(`${row.name}: ${named.join(' + ')}`);
    // and the same line is never filed twice
    const lines = t.lines.map(l => `${l.family} ${l.line}`);
    assert.deepEqual(lines, [...new Set(lines)], row.name);
  }
  assert.ok(scanned > 20, `expected the pool to hold aliased-keyword cards, scanned ${scanned}`);
  assert.deepEqual(bad, [], bad.slice(0, 5).join('\n'));
  // one of them, concretely
  assert.deepEqual(tax('Adventurous Eater // Have a Bite').families, ['named-keyword:prepare']);
});

test('the histogram counts a card once per family and every line once', () => {
  const h = emptyFamilyHistogram();
  addToHistogram(h, familiesOf({ unparsed: ['Draw a card.', 'Destroy target creature.', 'Gain control of target creature.'] }));
  addToHistogram(h, familiesOf({ unparsed: ['Draw a card.'] }));
  addToHistogram(h, familiesOf({ unparsed: [] }));       // a parsed card contributes nothing
  assert.equal(h.totalCards, 2);
  assert.equal(h.totalLines, 4);
  const rows = histogramRows(h);
  assert.deepEqual(rows.find(r => r.family === 'generic'), { family: 'generic', cards: 2, lines: 3 });
  assert.deepEqual(rows.find(r => r.family === 'control'), { family: 'control', cards: 1, lines: 1 });
});

test('back-face lines are classified too, with their parser marker', () => {
  const t = familiesOf({ unparsed: [], backFace: { unparsed: ['Gain control of target creature.'] } });
  assert.deepEqual(t.families, ['control']);
  assert.equal(t.lines[0].line, '// Gain control of target creature.');
});
