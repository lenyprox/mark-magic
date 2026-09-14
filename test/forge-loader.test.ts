// src/cards/forge/loader.ts, the reader of Forge's card-script format, on SYNTHETIC fixtures written here (no file
// is copied from the Forge checkout): the fields, the ALTERNATE split and the joined-name key, SVar chain resolution
// through Execute$ and SubAbility$, Charm modes, token resolution against a fixture tokenscripts/, the cycle guard,
// the deck-building and AI keys left out; `FORGE_RES()`'s resolution; scripts/forge-diff.ts's copy of the snapshot
// hash pinned against the committed snapshot; and the real checkout, only when it exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { forgeCardFor, forgeColors, loadForge, parseForgeCard, parseParams, splitForgeTypes, TokenReader } from '../src/cards/forge/loader.js';
import { FORGE_CLONE_RECIPE, FORGE_RES, MASTER_DB, projectRoot } from '../src/config/paths.js';
import { changedIds, snapshotHash } from '../scripts/forge-diff.js';
import { parseRow } from '../src/cards/scriptState.js';
import { CardDB } from '../src/cards/db.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'forge-loader-'));

/** A synthetic res directory: cardsfolder/<letter>/<file> and tokenscripts/<id>.txt, LF, written from the strings given. */
function fixtureRes(cards: Record<string, string>, tokens: Record<string, string> = {}): string {
  const res = tmp();
  for (const [file, text] of Object.entries(cards)) { const p = path.join(res, 'cardsfolder', file[0], file); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }
  for (const [id, text] of Object.entries(tokens)) { const p = path.join(res, 'tokenscripts', `${id}.txt`); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }
  return res;
}

const PROBE = [
  'Name:Probe Pillager',
  'ManaCost:2 R',
  'Types:Legendary Creature Goblin Pirate',
  'PT:3/3',
  'K:First Strike',
  'K:Ward:2',
  'T:Mode$ Attacks | ValidCard$ Pirate.YouCtrl | TriggerZones$ Battlefield | Execute$ TrigCharm | TriggerDescription$ Whenever a Pirate you control attacks, ABILITY',
  'SVar:TrigCharm:DB$ Charm | Choices$ DBToken,DBUnblockable,DBExileTop',
  'SVar:DBToken:DB$ Token | TokenScript$ probe_treasure | SpellDescription$ Create a Treasure token.',
  'SVar:DBUnblockable:DB$ Pump | ValidTgts$ Creature | KW$ HIDDEN CARDNAME can\'t block. | SpellDescription$ Target creature can\'t block this turn.',
  'SVar:DBExileTop:DB$ Dig | DigNum$ 1 | ChangeNum$ All | DestinationZone$ Exile | SubAbility$ DBCleanup | SpellDescription$ Exile the top card of your library.',
  'SVar:DBCleanup:DB$ Cleanup | ClearRemembered$ True',
  'A:AB$ Draw | Cost$ 2 T | NumCards$ 2 | SubAbility$ DBLoop | SpellDescription$ Draw two cards.',
  'SVar:DBLoop:DB$ Discard | NumCards$ 1 | Mode$ TgtChoose | SubAbility$ DBLoop2',
  'SVar:DBLoop2:DB$ GainLife | LifeAmount$ 1 | SubAbility$ DBLoop',
  'SVar:PlayMain1:TRUE',
  'SVar:AIPreference:SacCost$Creature',
  'SVar:BuffedBy:Pirate',
  'DeckHas:Ability$Token & Type$Treasure',
  'DeckHints:Type$Pirate',
  'AI:RemoveDeck:Random',
  'Oracle:First strike\\nWard {2}\\nWhenever a Pirate you control attacks, choose one —\\n• Create a Treasure token.\\n• Target creature can\'t block this turn.\\n• Exile the top card of your library.\\n{2}, {T}: Draw two cards.',
].join('\n') + '\n';

const DFC = [
  'Name:Probe Researcher', 'ManaCost:3 U', 'Types:Creature Human Insect', 'PT:3/2', 'K:Flying',
  'T:Mode$ Phase | Phase$ Upkeep | ValidPlayer$ You | TriggerZones$ Battlefield | Execute$ TrigMill | TriggerDescription$ At the beginning of your upkeep, mill a card.',
  'SVar:TrigMill:DB$ Mill | Defined$ You | NumCards$ 1',
  'AlternateMode:DoubleFaced',
  'Oracle:Flying\\nAt the beginning of your upkeep, mill a card.',
  '', 'ALTERNATE', '',
  'Name:Probe Perfected Form', 'ManaCost:no cost', 'Colors:blue', 'Types:Creature Insect Horror', 'PT:5/4', 'K:Flying', 'Oracle:Flying',
].join('\n') + '\n';

const TREASURE = 'Name:Treasure Token\nManaCost:no cost\nTypes:Artifact Treasure\nA:AB$ Mana | Cost$ T Sac<1/CARDNAME> | Produced$ Any | SpellDescription$ Add one mana of any color.\nOracle:{T}, Sacrifice this token: Add one mana of any color.\n';
const SOLDIER = 'Name:Soldier Token\nManaCost:no cost\nColors:white\nTypes:Creature Soldier\nPT:1/1\nK:Vigilance\nOracle:Vigilance\n';

test('parseParams splits `Key$ value` pairs on " | " and keeps the values\' inner spaces', () => {
  assert.deepEqual(parseParams('AB$ Mana | Cost$ T Sac<1/CARDNAME> | Produced$ Any | SpellDescription$ Add one mana of any color.'),
    { AB: 'Mana', Cost: 'T Sac<1/CARDNAME>', Produced: 'Any', SpellDescription: 'Add one mana of any color.' });
  assert.deepEqual(splitForgeTypes('Legendary Creature Goblin Pirate'), { types: ['Creature'], subtypes: ['Goblin', 'Pirate'] });
  assert.deepEqual(forgeColors('red,white'), ['R', 'W']); assert.deepEqual(forgeColors('all'), ['W', 'U', 'B', 'R', 'G']); assert.deepEqual(forgeColors(null), []);
});

test('a face: fields, keywords verbatim, chains through Execute$ / SubAbility$, Charm modes, Cleanup dropped, the cycle guard, tokens resolved, AI/deck keys ignored', () => {
  const res = fixtureRes({}, { probe_treasure: TREASURE });
  const card = parseForgeCard(PROBE, 'cardsfolder/p/probe_pillager.txt', new TokenReader(path.join(res, 'tokenscripts')));
  assert.equal(card.faces.length, 1);
  const f = card.faces[0];
  assert.equal(f.name, 'Probe Pillager'); assert.equal(f.manaCost, '2 R'); assert.equal(f.pt, '3/3'); assert.equal(f.types, 'Legendary Creature Goblin Pirate');
  assert.deepEqual(f.keywords, ['First Strike', 'Ward:2']);
  assert.equal(f.oracle.split('\n').length, 7);
  assert.equal(f.file, 'cardsfolder/p/probe_pillager.txt');
  // the trigger: description with CARDNAME → ~, the chain from Execute$, Charm's Choices$ resolved into modes
  const trig = f.abilities.find(a => a.cls === 'triggered')!;
  assert.equal(trig.params.Mode, 'Attacks'); assert.equal(trig.description, 'Whenever a Pirate you control attacks, ABILITY');
  assert.deepEqual(trig.chain.map(e => e.api), ['Charm']);
  const charm = trig.chain[0];
  assert.deepEqual(charm.modes!.map(m => m.map(e => e.api)), [['Token'], ['Pump'], ['Dig']]);   // DBCleanup after Dig is dropped
  assert.deepEqual(charm.modes![0][0].tokens!.map(t => ({ id: t.id, types: t.types, subtypes: t.subtypes, pt: t.pt })), [{ id: 'probe_treasure', types: ['Artifact'], subtypes: ['Treasure'], pt: null }]);
  assert.equal(charm.modes![1][0].params.ValidTgts, 'Creature');
  // the activated ability: the A line itself is the head; a SubAbility$ loop ends at the first repeat
  const act = f.abilities.find(a => a.cls === 'activated')!;
  assert.equal(act.params.Cost, '2 T'); assert.equal(act.description, 'Draw two cards.');
  assert.deepEqual(act.chain.map(e => e.api), ['Draw', 'Discard', 'GainLife']);
  assert.deepEqual(act.chain[0].params, { Cost: '2 T', NumCards: '2', SubAbility: 'DBLoop', SpellDescription: 'Draw two cards.' });
  // AI-only SVars and deck hints never reach the face
  assert.deepEqual(Object.keys(f.svars).sort(), ['DBCleanup', 'DBExileTop', 'DBLoop', 'DBLoop2', 'DBToken', 'DBUnblockable', 'TrigCharm']);
  assert.ok(!JSON.stringify(f).includes('DeckHints') && !JSON.stringify(f).includes('PlayMain1') && !JSON.stringify(f).includes('RemoveDeck'));
});

test('ALTERNATE splits the faces; the index keys every face name and the joined name; forgeCardFor falls back to the front name and case', () => {
  const res = fixtureRes({ 'probe_pillager.txt': PROBE, 'probe_researcher_probe_perfected_form.txt': DFC }, { probe_treasure: TREASURE, probe_soldier: SOLDIER });
  const idx = loadForge(res, { cache: false });
  assert.equal(idx.files, 4); assert.equal(idx.cards.length, 2); assert.ok(idx.head.length > 0);
  const dfc = idx.byName.get('Probe Researcher // Probe Perfected Form')!;
  assert.equal(dfc.faces.length, 2);
  assert.equal(dfc.faces[0].alternateMode, 'DoubleFaced'); assert.equal(dfc.faces[1].name, 'Probe Perfected Form'); assert.equal(dfc.faces[1].colors, 'blue'); assert.deepEqual(dfc.faces[1].keywords, ['Flying']);
  assert.equal(dfc.faces[0].abilities[0].chain[0].api, 'Mill');
  assert.equal(idx.byName.get('Probe Perfected Form'), dfc);
  assert.equal(forgeCardFor(idx, 'Probe Researcher // Something Else'), dfc);   // front-face name
  assert.equal(forgeCardFor(idx, 'probe pillager')!.faces[0].name, 'Probe Pillager');
  assert.equal(forgeCardFor(idx, 'No Such Card'), null);
  // a JSON cache keyed by head + file count + loader version is honoured and rebuilt when the key moves
  const cache = path.join(res, 'cache.json');
  const first = loadForge(res, { cache });
  assert.ok(fs.existsSync(cache)); assert.ok(!fs.readFileSync(cache, 'utf8').includes(res.replace(/\\/g, '/')) && !fs.readFileSync(cache, 'utf8').includes(res), 'the cache carries no absolute path');
  const again = loadForge(res, { cache });
  assert.deepEqual(again.cards, first.cards);
  fs.writeFileSync(path.join(res, 'tokenscripts', 'extra.txt'), SOLDIER);
  assert.equal(loadForge(res, { cache }).files, 5);   // file count moved: rebuilt, not served stale
});

test('FORGE_RES: MTG_FORGE_RES wins when it holds a cardsfolder; a missing checkout throws the two-line clone recipe', () => {
  const saved = process.env.MTG_FORGE_RES;
  try {
    const res = fixtureRes({ 'probe_pillager.txt': PROBE });
    process.env.MTG_FORGE_RES = res;
    assert.equal(FORGE_RES(), path.resolve(res));
    process.env.MTG_FORGE_RES = path.join(res, 'nowhere');
    const real = fs.existsSync(path.resolve(projectRoot(), '..', 'forge', 'forge-gui', 'res', 'cardsfolder'));
    if (!real) assert.throws(() => FORGE_RES(), /git clone --depth 1 --filter=blob:none --sparse https:\/\/github\.com\/Card-Forge\/forge\.git/);
    assert.match(FORGE_CLONE_RECIPE('X'), /^git clone .* X\ncd X && git sparse-checkout set forge-gui\/res\/cardsfolder forge-gui\/res\/tokenscripts$/);
  } finally { if (saved === undefined) delete process.env.MTG_FORGE_RES; else process.env.MTG_FORGE_RES = saved; }
});

test('changedIds: the ids whose hash moved, plus ids the snapshot never saw, sorted', () => {
  const snap = { cards: { a: '1', b: '2', c: '3' } };
  assert.deepEqual(changedIds(new Map([['c', '3'], ['b', 'x'], ['a', '1'], ['d', '9']]), snap), ['b', 'd']);
  assert.deepEqual(changedIds(new Map([['a', '1']]), snap), []);
});

// ---------------------------------------------------------------------------
// Against the real data (skipped cleanly when absent)
// ---------------------------------------------------------------------------

const SNAPSHOT = path.join(projectRoot(), 'data', 'master', 'parse-snapshot.json');
const hasDb = fs.existsSync(MASTER_DB()) && fs.existsSync(SNAPSHOT);

test('forge-diff.ts\'s snapshotHash is parse-snapshot.ts\'s hash: the first 40 playable cards of the committed snapshot hash identically', { skip: !hasDb }, () => {
  const snap = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')) as { cards: Record<string, string> };
  const db = new CardDB();
  const ids = Object.keys(snap.cards).sort().slice(0, 40);
  const stmt = db.db.prepare('SELECT json FROM oracle_cards WHERE oracle_id = ?');
  let checked = 0;
  for (const id of ids) {
    const row = stmt.get(id) as { json: string } | undefined;
    if (!row) continue;
    assert.equal(snapshotHash(parseRow(JSON.parse(row.json) as Record<string, unknown>).def), snap.cards[id], id);
    checked++;
  }
  db.close();
  assert.ok(checked >= 30, `only ${checked} of the first 40 ids are in master.db`);
});

const realRes = (() => { try { return FORGE_RES(); } catch { return null; } })();

test('the real checkout loads (from its cache) and reads the plan\'s reference card the way the audit described it', { skip: !realRes }, () => {
  const idx = loadForge(realRes!);
  assert.ok(idx.files > 30000, `${idx.files} files`);
  const card = forgeCardFor(idx, 'Breeches, Eager Pillager');
  assert.ok(card, 'Breeches has a Forge file');
  const trig = card!.faces[0].abilities.find(a => a.cls === 'triggered')!;
  assert.equal(trig.params.Mode, 'Attacks');
  const charm = trig.chain[0];
  assert.equal(charm.api, 'Charm'); assert.equal(charm.modes!.length, 3);
  assert.equal(charm.modes![1].find(e => e.params.ValidTgts)?.params.ValidTgts, 'Creature');   // the "target creature can't block" mode targets
});
