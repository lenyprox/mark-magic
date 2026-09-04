// CSV reader, format detection and name helpers for the collection importer (pure; no database).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseCountNameCsv, toCountNameCsv } from '../src/collection/csv.js';
import { detectCollectionFormat, parseCollectionText } from '../src/collection/formats.js';
import { deckNameFromFile, inferCommander, levenshtein } from '../src/collection/names.js';

test('parseCsv: quotes, escaped quotes, embedded commas/newlines, CRLF, BOM, blank lines', () => {
  const rows = parseCsv('﻿1,Arcane Signet\r\n1,"Betor, Kin to All"\r\n\r\n2,"Say ""hi"", friend"\n1,"Multi\nline"\n');
  assert.deepEqual(rows.map(r => r.fields), [['1', 'Arcane Signet'], ['1', 'Betor, Kin to All'], ['2', 'Say "hi", friend'], ['1', 'Multi\nline']]);
  assert.deepEqual(rows.map(r => r.line), [1, 2, 4, 5]);
});

test('parseCountNameCsv: headerless count,name; duplicates kept; bad rows reported', () => {
  const s = parseCountNameCsv('1,Arcane Signet\n7,Forest\n2,Forest\nx,Broken\n,\n3,\n2x,Sol Ring\n1,"Grist, Voracious Larva // Grist, the Plague Swarm"\n');
  assert.equal(s.header, null); assert.equal(s.dialect, 'plain');
  assert.deepEqual(s.rows.map(r => [r.count, r.name]), [[1, 'Arcane Signet'], [7, 'Forest'], [2, 'Forest'], [2, 'Sol Ring'], [1, 'Grist, Voracious Larva // Grist, the Plague Swarm']]);
  assert.equal(s.errors.length, 2); assert.equal(s.errors[0].line, 4); assert.match(s.errors[0].reason, /bad count/); assert.equal(s.errors[1].line, 6); assert.match(s.errors[1].reason, /empty name/);
});

test('parseCountNameCsv: name,count order and "3 Name" single-column lines', () => {
  const s = parseCountNameCsv('Lightning Bolt,4\nMountain,20\n');
  assert.deepEqual(s.rows.map(r => [r.count, r.name]), [[4, 'Lightning Bolt'], [20, 'Mountain']]);
  const t = parseCountNameCsv('3 Lightning Bolt\nMountain\n');
  assert.deepEqual(t.rows.map(r => [r.count, r.name]), [[3, 'Lightning Bolt'], [1, 'Mountain']]);
});

test('parseCountNameCsv: Moxfield and Archidekt headers map count/name/set/number/finish', () => {
  const mox = parseCountNameCsv('"Count","Tradelist Count","Name","Edition","Condition","Language","Foil","Tags","Last Modified","Collector Number","Alter","Proxy","Purchase Price"\n"2","0","Sol Ring","c21","Near Mint","English","foil","","2024-01-01","263","False","False",""\n');
  assert.equal(mox.dialect, 'moxfield');
  assert.deepEqual(mox.rows, [{ count: 2, name: 'Sol Ring', line: 2, set: 'c21', number: '263', finish: 'foil' }]);
  const arch = parseCountNameCsv('Quantity,Name,Finish,Condition,Date Added,Language,Purchase Price,Tags,Edition Name,Edition Code,Multiverse Id,Scryfall ID,Collector Number\n1,Arcane Signet,Non-foil,NM,2024,EN,,,Commander Legends,cmr,1,abc,299\n');
  assert.equal(arch.dialect, 'archidekt');
  assert.equal(arch.rows[0].set, 'cmr'); assert.equal(arch.rows[0].number, '299'); assert.equal(arch.rows[0].finish, 'nonfoil');
  const noCount = parseCountNameCsv('Name,Set\nSol Ring,c21\n');
  assert.deepEqual(noCount.rows.map(r => [r.count, r.name, r.set]), [[1, 'Sol Ring', 'c21']]);
});

test('toCountNameCsv quotes names with commas and round-trips', () => {
  const text = toCountNameCsv([{ count: 1, name: 'Betor, Kin to All' }, { count: 7, name: 'Forest' }]);
  assert.equal(text, '1,"Betor, Kin to All"\n7,Forest\n');
  assert.deepEqual(parseCountNameCsv(text).rows.map(r => [r.count, r.name]), [[1, 'Betor, Kin to All'], [7, 'Forest']]);
});

test('detectCollectionFormat / parseCollectionText: csv vs arena vs plain text', () => {
  assert.equal(detectCollectionFormat('1,Arcane Signet\n1,Forest\n'), 'csv');
  assert.equal(detectCollectionFormat('whatever', 'x.CSV'), 'csv');
  assert.equal(detectCollectionFormat('Deck\n4 Lightning Bolt (M10) 146\n20 Mountain\n\nSideboard\n2 Smash to Smithereens\n'), 'arena');
  assert.equal(detectCollectionFormat('4 Lightning Bolt\n20 Mountain\n'), 'text');
  const arena = parseCollectionText('Deck\n4 Lightning Bolt (M10) 146\n20 Mountain\n\nSideboard\n2 Smash to Smithereens\n\nMaybeboard\n1 Shock\n');
  assert.equal(arena.format, 'arena');
  assert.deepEqual(arena.rows.map(r => [r.count, r.name]), [[4, 'Lightning Bolt'], [20, 'Mountain'], [2, 'Smash to Smithereens']]);
  assert.equal(arena.rows[0].set, 'm10');
  const csv = parseCollectionText('1,"Betor, Kin to All"\n', 'deck.csv');
  assert.equal(csv.format, 'csv'); assert.equal(csv.rows[0].name, 'Betor, Kin to All');
});

test('deckNameFromFile', () => {
  assert.equal(deckNameFromFile('varina,_lich queen.csv'), 'Varina, Lich Queen');
  assert.equal(deckNameFromFile('decks/goph,_girthbending master.csv'), 'Goph, Girthbending Master');
  assert.equal(deckNameFromFile('big_booty doran.csv'), 'Big Booty Doran');
  assert.equal(deckNameFromFile('quintorius.csv'), 'Quintorius');
});

test('levenshtein and inferCommander (exact, fuzzy, ambiguous, none)', () => {
  assert.equal(levenshtein('goph', 'toph'), 1); assert.equal(levenshtein('girthbending', 'earthbending'), 2);
  const L = (name: string, extra = '') => ({ oracleId: name, name, typeLine: 'Legendary Creature — Human', oracleText: extra });
  const N = (name: string) => ({ oracleId: name, name, typeLine: 'Creature — Elf', oracleText: '' });
  const doran = inferCommander('Big Booty Doran', [L('Doran, Besieged by Time'), L('Captain Sisay'), N('Llanowar Elves')]);
  assert.equal(doran.confidence, 'high'); assert.equal(doran.pick?.name, 'Doran, Besieged by Time');
  const toph = inferCommander('Goph, Girthbending Master', [L('Toph, Earthbending Master'), L('Toph, the Blind Bandit'), L('The Earth King')]);
  assert.equal(toph.confidence, 'high'); assert.equal(toph.pick?.name, 'Toph, Earthbending Master');
  const quint = inferCommander('Quintorius', [L('Quintorius, Field Historian'), L('Quintorius, Loremaster'), L('Squee, Goblin Nabob')]);
  assert.equal(quint.confidence, 'ambiguous'); assert.equal(quint.pick, null); assert.equal(quint.candidates[0].score, quint.candidates[1].score);
  const none = inferCommander('The Slurpin Society', [L('Fynn, the Fangbearer'), L('Questing Beast')]);
  assert.equal(none.confidence, 'none'); assert.equal(none.pick, null); assert.equal(none.candidates.length, 2);
  const only = inferCommander('Random Pile', [L('Fynn, the Fangbearer'), N('Grizzly Bears')]);
  assert.equal(only.confidence, 'low'); assert.equal(only.pick?.name, 'Fynn, the Fangbearer');
  const pw = inferCommander('Tevesh', [{ oracleId: 't', name: 'Tevesh Szat, Doom of Fools', typeLine: 'Legendary Planeswalker — Tevesh', oracleText: 'Partner\nTevesh Szat, Doom of Fools can be your commander.' }]);
  assert.equal(pw.pick?.name, 'Tevesh Szat, Doom of Fools');
});
