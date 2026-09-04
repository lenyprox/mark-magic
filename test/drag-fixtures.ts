// Hand-built ViewState / LegalAction fixtures for the drag planner tests (no engine involved).
import type { LegalAction, PlayerId } from '../src/engine/state.js';
import type { CardView, PermanentView, PlayerView, ViewState } from '../src/play/view.js';
import type { DragContext, DragMode } from '../src/play/drag.js';

let nextId = 100;
export const card = (name: string, over: Partial<CardView> = {}): CardView => ({
  id: over.id ?? nextId++, name, oracleId: null, printingId: null, face: 0, manaCost: null, manaValue: 0, typeLine: '', text: '', power: null, toughness: null, loyalty: null,
  colors: [], types: [], keywords: [], fullyParsed: true, unparsed: [], isToken: false, hasBack: false, layout: 'normal', ...over,
});
export const land = (name = 'Mountain', over: Partial<CardView> = {}) => card(name, { types: ['Land'], typeLine: 'Basic Land — Mountain', ...over });
export const bolt = (over: Partial<CardView> = {}) => card('Lightning Bolt', { types: ['Instant'], manaCost: '{R}', manaValue: 1, text: 'Lightning Bolt deals 3 damage to any target.', ...over });
export const bears = (over: Partial<CardView> = {}) => card('Grizzly Bears', { types: ['Creature'], manaCost: '{1}{G}', manaValue: 2, power: '2', toughness: '2', ...over });
export const sorcery = (over: Partial<CardView> = {}) => card('Lava Spike', { types: ['Sorcery'], manaCost: '{R}', manaValue: 1, ...over });

export const perm = (c: CardView, controller: PlayerId, over: Partial<PermanentView> = {}): PermanentView => ({
  ...c, controller, owner: controller, tapped: false, damage: 0, counters: {}, curPower: Number(c.power ?? 0), curToughness: Number(c.toughness ?? 0), curKeywords: [],
  isCreature: c.types.includes('Creature'), isLand: c.types.includes('Land'), summoningSick: false, canAttack: c.types.includes('Creature'), attacking: null, blocking: [], blockedBy: [], attachedTo: null, transformed: false, enteredTurn: 1, ...over,
});

export const player = (id: PlayerId, over: Partial<PlayerView> = {}): PlayerView => ({
  id, name: id === 0 ? 'You' : 'Opp', life: 20, poison: 0, librarySize: 50, handSize: over.hand?.length ?? 0, hand: id === 0 ? [] : null, battlefield: [], graveyard: [], exile: [], manaPool: [], landsPlayedThisTurn: 0, lost: false, ...over,
});

export const view = (over: Partial<ViewState> = {}, p0: Partial<PlayerView> = {}, p1: Partial<PlayerView> = {}): ViewState => ({
  gameId: 'g', viewer: 0, turn: 3, activePlayer: 0, step: 'main1', priority: 0, winner: null, players: [player(0, p0), player(1, p1)], stack: [], attackers: [], logLength: 0, passesInRow: 0, ...over,
});

export const ctx = (v: ViewState, mode: Partial<DragMode> & { legal?: LegalAction[] } = {}): DragContext => ({ mode: { kind: 'idle', legal: [], ...mode }, view: v, me: 0 });

export const playLand = (cardId: number): LegalAction => ({ action: { type: 'play-land', cardId }, label: 'Play Mountain' });
export const cast = (cardId: number, targets?: LegalAction['targetOptions']): LegalAction => ({ action: { type: 'cast', cardId }, label: 'Cast', manaValue: 1, ...(targets ? { targetOptions: targets } : {}) });
export const activate = (objectId: number, abilityIndex = 0, targets?: LegalAction['targetOptions']): LegalAction => ({ action: { type: 'activate', objectId, abilityIndex }, label: `Activate ${abilityIndex}`, ...(targets ? { targetOptions: targets } : {}) });
export const pass: LegalAction = { action: { type: 'pass' }, label: 'Pass' };
