// Interaction classes of a card: from the parsed AST when available, with an oracle-text regex fallback so
// classification covers the whole card pool and not only the fully parsed part.
import type { CardDef, Effect, TargetSpec } from '../cards/types.js';
import type { InteractionClass } from './types.js';

const CREATURE_TARGET: TargetSpec['kind'][] = ['creature', 'any', 'permanent', 'creature-or-player', 'creature-or-planeswalker', 'nonland-permanent', 'attacking-creature', 'blocking-creature', 'tapped-creature'];

function walk(effects: Effect[], f: (e: Effect) => void) {
  for (const e of effects) {
    f(e);
    if (e.op === 'choose-mode') for (const m of e.modes) walk(m, f);
    if (e.op === 'conditional') { walk(e.then, f); if (e.else) walk(e.else, f); }
  }
}

function fromAst(def: CardDef, out: Set<InteractionClass>) {
  const instantSpeed = def.types.includes('Instant') || def.keywords.includes('flash');
  const spellEffects = def.abilities.flatMap(a => a.kind === 'spell' ? a.effects : []);
  const allEffects = def.abilities.flatMap(a => 'effects' in a ? a.effects : []);
  walk(allEffects, e => {
    switch (e.op) {
      case 'counter': out.add('counterspell'); break;
      case 'damage': {
        const amount = typeof e.amount === 'number' ? e.amount : 2;
        if (typeof e.target === 'string') { if (/creature/.test(e.target)) out.add('sweeper'); if (/player|opponent/.test(e.target)) out.add('burn'); }
        else { if (['any', 'player', 'creature-or-player', 'opponent'].includes(e.target.kind)) out.add('burn'); if (CREATURE_TARGET.includes(e.target.kind) && amount >= 1) out.add('removal'); }
        break;
      }
      case 'destroy': case 'exile': {
        if (typeof e.target === 'string') { if (/creature|nonland|all-/.test(e.target)) out.add('sweeper'); }
        else if (!e.target.self && CREATURE_TARGET.includes(e.target.kind)) out.add('removal');
        break;
      }
      case 'bounce': { if (typeof e.target === 'string') { if (e.target !== 'self') out.add('sweeper'); } else out.add('bounce'); break; }
      case 'pump': {
        if (typeof e.target === 'string') { if (typeof e.power === 'number' && e.power < 0 && /all/.test(e.target)) out.add('sweeper'); else if (e.target !== 'self' && instantSpeed) out.add('combat-trick'); }
        else if (typeof e.power === 'number' && e.power < 0 && typeof e.toughness === 'number' && e.toughness < 0) out.add('removal');
        else if (instantSpeed) out.add('combat-trick');
        break;
      }
      case 'grant-keyword': if (instantSpeed && typeof e.target !== 'string') out.add('combat-trick'); break;
      case 'counters': if (e.counter === '-1/-1' && typeof e.target !== 'string') out.add('removal'); break;
      case 'discard': if (e.who !== 'you') out.add('discard'); break;
      case 'draw': if (e.who !== 'opponent' && spellEffects.includes(e)) out.add('card-draw'); break;
      case 'loot': out.add('card-draw'); break;
      case 'gain-life': if (e.who !== 'target-player') out.add('lifegain'); break;
      case 'search-land': out.add('ramp'); break;
      case 'add-mana': if (spellEffects.includes(e)) out.add('ramp'); break;
      case 'fight': case 'bite': out.add('removal'); break;
      case 'prevent-damage': if (instantSpeed) out.add('combat-trick'); break;
    }
  });
}

const RX: [RegExp, InteractionClass][] = [
  [/counter target [^.]*spell/i, 'counterspell'],
  [/(destroy|exile) (all|each) (creature|nonland|permanent|artifact|enchantment)|deals? \d+ damage to each creature|(all|each) creatures? gets? -\d|return (all|each) (creature|nonland)/i, 'sweeper'],
  [/(destroy|exile) target (creature|permanent|nonland|artifact|enchantment|planeswalker)|deals? (\d+|x) damage to (any target|target creature)|target creature gets -\d+\/-\d+|fights? (target|another target)/i, 'removal'],
  [/deals? (\d+|x) damage to (any target|target player|each opponent|target opponent|that player'?s controller|player or planeswalker)/i, 'burn'],
  [/return target (creature|nonland permanent|permanent) to its owner'?s hand/i, 'bounce'],
  [/target (player|opponent) discards|each opponent discards/i, 'discard'],
  [/draw (a|two|three|four|x) cards?/i, 'card-draw'],
  [/search your library for (a|up to \w+) (basic )?lands?|add \{[wubrgc]\}/i, 'ramp'],
  [/you gain \d+ life/i, 'lifegain'],
];

/** Interaction classes of a card (AST first, regex on the oracle text as a fallback and for unparsed clauses). */
export function classify(def: CardDef): InteractionClass[] {
  const out = new Set<InteractionClass>();
  fromAst(def, out);
  const text = def.oracleText || '';
  const instantSpeed = def.types.includes('Instant') || def.keywords.includes('flash');
  for (const [rx, cls] of RX) if (rx.test(text)) {
    if (cls === 'card-draw' && /whenever|when|at the beginning/i.test(text) && !def.types.includes('Instant') && !def.types.includes('Sorcery')) continue;
    out.add(cls);
  }
  if (instantSpeed && /target creature (you control )?gets \+\d+\/\+\d+|gains? (first strike|indestructible|hexproof|flying|double strike|trample) until end of turn|prevent all (combat )?damage/i.test(text)) out.add('combat-trick');
  if (def.types.includes('Creature')) out.add('creature');
  if (def.types.includes('Land')) out.add('land');
  return [...out];
}

/** Which risk classes a class list covers, for building risks. */
export function hasClass(def: CardDef, cls: InteractionClass): boolean { return classify(def).includes(cls); }
