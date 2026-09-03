// A redacted, JSON-safe view of a game for the UI. The viewer sees their own hand; the opponent's hand is a count;
// library contents are never included.
import type { CardDef, Color, Keyword, ManaSymbol } from '../cards/types.js';
import { canAttack, hasKeyword, isCreature, keywords, name, power, toughness, types } from '../engine/characteristics.js';
import type { Game } from '../engine/game.js';
import type { GameObject, GameState, PlayerId, StackItem, Step, TargetRef, TokenSpec } from '../engine/state.js';

export interface CardView {
  id: number; name: string; oracleId: string | null; printingId: string | null; face: 0 | 1;
  manaCost: string | null; manaValue: number; typeLine: string; text: string; power: string | null; toughness: string | null; loyalty: number | null;
  colors: Color[]; types: string[]; keywords: Keyword[]; fullyParsed: boolean; unparsed: string[]; isToken: boolean; token?: TokenSpec; hasBack: boolean; layout: string;
}
export interface PermanentView extends CardView {
  controller: PlayerId; owner: PlayerId; tapped: boolean; damage: number; counters: Record<string, number>;
  curPower: number; curToughness: number; curKeywords: Keyword[]; isCreature: boolean; isLand: boolean;
  summoningSick: boolean; canAttack: boolean; attacking: PlayerId | null; blocking: number[]; blockedBy: number[]; attachedTo: number | null; transformed: boolean; enteredTurn: number;
}
export interface PlayerView {
  id: PlayerId; name: string; life: number; poison: number; librarySize: number; handSize: number;
  hand: CardView[] | null; battlefield: PermanentView[]; graveyard: CardView[]; exile: CardView[];
  manaPool: ManaSymbol[]; landsPlayedThisTurn: number; lost: boolean; lossReason?: string;
}
export interface StackItemView { id: number; kind: StackItem['kind']; name: string; controller: PlayerId; text: string; sourceId: number; source: CardView; targets: TargetRef[]; targetLabels: string[]; countered: boolean }
export interface ViewState {
  gameId: string; viewer: PlayerId | null; turn: number; activePlayer: PlayerId; step: Step; priority: PlayerId; winner: PlayerId | null;
  players: [PlayerView, PlayerView]; stack: StackItemView[]; attackers: number[]; logLength: number; passesInRow: number;
}

function defOf(o: GameObject): CardDef { return o.def; }

export function cardView(s: GameState, o: GameObject): CardView {
  const d = defOf(o);
  const faceIdx: 0 | 1 = o.transformed && d.faces && d.faces.length > 1 ? 1 : 0;
  const face = d.faces?.[faceIdx];
  return {
    id: o.id, name: name(o), oracleId: o.token ? null : d.oracleId, printingId: o.token ? null : (d.printingId ?? d.representativePrintingId ?? null), face: faceIdx,
    manaCost: o.token ? null : (face?.manaCost?.raw ?? d.manaCost?.raw ?? null), manaValue: o.token ? 0 : d.manaValue,
    typeLine: o.token ? [...o.token.types, ...(o.token.subtypes.length ? ['—', ...o.token.subtypes] : [])].join(' ') : (face?.typeLine ?? d.typeLine),
    text: o.token ? (o.token.keywords.join(', ')) : (face?.oracleText ?? d.oracleText),
    power: o.token ? String(o.token.power) : (face?.power ?? d.power), toughness: o.token ? String(o.token.toughness) : (face?.toughness ?? d.toughness), loyalty: d.loyalty,
    colors: o.token ? o.token.colors : d.colors, types: types(o), keywords: o.token ? o.token.keywords : d.keywords,
    fullyParsed: d.fullyParsed, unparsed: d.unparsed, isToken: !!o.token, token: o.token ?? undefined, hasBack: !!(d.faceImageUris && d.faceImageUris.length > 1 && d.faceImageUris[1]), layout: d.layout,
  };
}

export function permanentView(s: GameState, o: GameObject): PermanentView {
  const cr = isCreature(o);
  return {
    ...cardView(s, o), controller: o.controller, owner: o.owner, tapped: o.tapped, damage: o.damage, counters: { ...o.counters },
    curPower: cr ? power(s, o) : 0, curToughness: cr ? toughness(s, o) : 0, curKeywords: cr ? keywords(s, o) : [], isCreature: cr, isLand: types(o).includes('Land'),
    summoningSick: cr && o.enteredTurn === s.turn && !hasKeyword(s, o, 'haste'), canAttack: cr && canAttack(s, o),
    attacking: o.attacking, blocking: [...o.blocking], blockedBy: [...o.blockedBy], attachedTo: o.attachedTo, transformed: o.transformed, enteredTurn: o.enteredTurn,
  };
}

export function buildView(g: Game, viewer: PlayerId | null, gameId = ''): ViewState {
  const s = g.state;
  const players = s.players.map(p => {
    const show = viewer === null || p.id === viewer;
    const pv: PlayerView = {
      id: p.id, name: p.name, life: p.life, poison: p.poison, librarySize: p.library.length, handSize: p.hand.length,
      hand: show ? p.hand.map(o => cardView(s, o)) : null,
      battlefield: p.battlefield.map(o => permanentView(s, o)), graveyard: p.graveyard.map(o => cardView(s, o)), exile: p.exile.map(o => cardView(s, o)),
      manaPool: [...p.manaPool], landsPlayedThisTurn: p.landsPlayedThisTurn, lost: p.lost, lossReason: p.lossReason,
    };
    return pv;
  }) as [PlayerView, PlayerView];
  const stack = s.stack.map(it => {
    const targets = [...it.targetsByEffect.values()].flat();
    return { id: it.id, kind: it.kind, name: it.name, controller: it.controller, text: it.text, sourceId: it.source.id, source: cardView(s, it.source), targets, targetLabels: targets.map(t => g.refName(t)), countered: !!it.countered } satisfies StackItemView;
  });
  return { gameId, viewer, turn: s.turn, activePlayer: s.activePlayer, step: s.step, priority: s.priority, winner: s.winner, players, stack, attackers: [...s.attackers], logLength: s.log.length, passesInRow: s.passesInRow };
}
