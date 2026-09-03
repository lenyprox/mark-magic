// Card model + ability AST used by the engine. The parser turns Scryfall oracle text into this.

export type Color = 'W' | 'U' | 'B' | 'R' | 'G';
export const COLORS: Color[] = ['W', 'U', 'B', 'R', 'G'];
export type ManaSymbol = Color | 'C';

export type CardType = 'Creature' | 'Instant' | 'Sorcery' | 'Artifact' | 'Enchantment' | 'Land' | 'Planeswalker' | 'Battle' | 'Kindred' | 'Tribal';

export interface ManaCost {
  generic: number;
  x: number;                     // number of {X} pips
  pips: ManaSymbol[];            // coloured pips (one entry per pip)
  hybrid: ManaSymbol[][];        // each entry = options for that pip
  phyrexian: Color[];            // pay colour or 2 life
  raw: string;
}

export type Keyword =
  | 'flying' | 'first strike' | 'double strike' | 'deathtouch' | 'lifelink' | 'trample' | 'haste' | 'vigilance'
  | 'reach' | 'defender' | 'flash' | 'hexproof' | 'indestructible' | 'menace' | 'unblockable' | 'cant block'
  | 'shroud' | 'protection' | 'prowess' | 'ward' | 'fear' | 'intimidate' | 'skulk' | 'cant attack' | 'ward';

/** Who / what an effect can target */
export interface TargetSpec {
  kind: 'creature' | 'player' | 'any' | 'permanent' | 'spell' | 'creature-or-player' | 'creature-or-planeswalker' | 'planeswalker' | 'opponent' | 'artifact' | 'enchantment' | 'land' | 'nonland-permanent' | 'artifact-or-enchantment' | 'creature-spell' | 'noncreature-spell' | 'attacking-creature' | 'blocking-creature' | 'tapped-creature';
  controller?: 'you' | 'opponent';         // "target creature you control" / "an opponent controls"
  filter?: Filter;
  optional?: boolean;                      // "up to one"
  count?: number;                          // "up to two target creatures"
  self?: boolean;                          // targets not needed; refers to this object
}

export interface Filter {
  types?: CardType[];
  notTypes?: CardType[];
  subtypes?: string[];
  colors?: Color[];
  notColors?: Color[];
  colorless?: boolean;
  powerLE?: number; powerGE?: number; toughnessLE?: number; mvLE?: number; mvGE?: number;
  tapped?: boolean; untapped?: boolean; token?: boolean; nontoken?: boolean; attacking?: boolean; blocking?: boolean; flying?: boolean; nonbasic?: boolean;
  other?: boolean;                          // "another" / "other"
}

/** Amount expression */
export type Amount = number | 'X' | { count: 'creatures-you-control' | 'cards-in-hand' | 'lands-you-control' | 'power-of-source' | 'creatures-attacking' | 'opponent-creatures' | 'life-lost-this-turn', filter?: Filter, plus?: number };

export type Effect =
  | { op: 'damage'; amount: Amount; target: TargetSpec | 'each-opponent' | 'each-player' | 'each-creature' | 'each-other-creature' | 'each-opponent-creature' | 'each-creature-and-player' | 'each-flying-creature' | 'each-nonflying-creature' | 'each-creature-you-dont-control' ; divided?: boolean }
  | { op: 'destroy'; target: TargetSpec | 'all-creatures' | 'all-artifacts' | 'all-enchantments' | 'all-lands' | 'all-nonland' | 'all-opponent-creatures' | 'all-tapped-creatures'; noRegenerate?: boolean; filter?: Filter }
  | { op: 'exile'; target: TargetSpec | 'all-creatures'; from?: 'graveyard' | 'battlefield'; until?: 'leaves' }
  | { op: 'counter'; target: TargetSpec; unlessPay?: number }
  | { op: 'draw'; amount: Amount; who: 'you' | 'target-player' | 'each-player' | 'opponent' | 'controller' }
  | { op: 'discard'; amount: Amount | 'hand'; who: 'you' | 'target-player' | 'each-opponent' | 'each-player'; random?: boolean }
  | { op: 'gain-life'; amount: Amount; who: 'you' | 'target-player' | 'each-player' }
  | { op: 'lose-life'; amount: Amount; who: 'you' | 'target-player' | 'each-opponent' | 'each-player' | 'opponent' }
  | { op: 'pump'; target: TargetSpec | 'creatures-you-control' | 'self' | 'all-creatures' | 'other-creatures-you-control' | 'attacking-creatures'; power: Amount; toughness: Amount; keywords?: Keyword[]; duration: 'eot' | 'permanent' }
  | { op: 'grant-keyword'; target: TargetSpec | 'self' | 'creatures-you-control'; keywords: Keyword[]; duration: 'eot' | 'permanent' }
  | { op: 'bounce'; target: TargetSpec | 'all-creatures' | 'all-nonland' | 'self'; to: 'hand' | 'library-top' | 'library-bottom' }
  | { op: 'token'; count: Amount; power: number; toughness: number; colors: Color[]; types: CardType[]; subtypes: string[]; keywords: Keyword[]; tapped?: boolean; attacking?: boolean; name?: string; text?: string; treasure?: boolean }
  | { op: 'counters'; target: TargetSpec | 'self' | 'creatures-you-control' | 'each-other-creature-you-control'; counter: '+1/+1' | '-1/-1' | 'loyalty' | 'charge'; amount: Amount }
  | { op: 'tap'; target: TargetSpec | 'all-opponent-creatures' | 'all-creatures' ; noUntap?: boolean }
  | { op: 'untap'; target: TargetSpec | 'self' | 'all-you-control' | 'lands-you-control' }
  | { op: 'sacrifice'; who: 'you' | 'target-player' | 'each-opponent' | 'each-player'; what: Filter; amount: number }
  | { op: 'sacrifice-self' }
  | { op: 'mill'; amount: Amount; who: 'you' | 'target-player' | 'each-opponent' }
  | { op: 'search-land'; toBattlefield: boolean; tapped: boolean; basic: boolean; count: number; subtypes?: string[] }
  | { op: 'add-mana'; mana: ManaSymbol[] | 'any' | 'any-one' ; amount?: number }
  | { op: 'scry'; amount: number }
  | { op: 'surveil'; amount: number }
  | { op: 'return-from-graveyard'; what: Filter; to: 'hand' | 'battlefield'; target?: boolean }
  | { op: 'fight'; target: TargetSpec; self: boolean }
  | { op: 'bite'; target: TargetSpec }
  | { op: 'set-life'; amount: number; who: 'you' | 'each-player' }
  | { op: 'gain-control'; target: TargetSpec; duration: 'eot' | 'permanent'; untapHaste?: boolean }
  | { op: 'copy-spell'; target: TargetSpec }
  | { op: 'transform-self' }
  | { op: 'choose-mode'; modes: Effect[][]; count: number }
  | { op: 'conditional'; condition: Condition; then: Effect[]; else?: Effect[] }
  | { op: 'attach-self'; target: TargetSpec }   // equipment equip / aura attach
  | { op: 'regenerate'; target: TargetSpec | 'self' }
  | { op: 'prevent-damage'; target: TargetSpec | 'self' | 'you'; amount: Amount | 'all'; duration: 'eot' }
  | { op: 'cant-attack-or-block'; target: TargetSpec; duration: 'eot' }
  | { op: 'extra-turn' }
  | { op: 'loot'; draw: number; discard: number }
  | { op: 'unknown'; text: string };

export type Condition =
  | { kind: 'life-le'; who: 'you' | 'opponent'; value: number }
  | { kind: 'controls'; who: 'you' | 'opponent'; filter: Filter; atLeast: number }
  | { kind: 'cards-in-hand-ge'; who: 'you' | 'opponent'; value: number }
  | { kind: 'threshold' } | { kind: 'metalcraft' } | { kind: 'delirium' } | { kind: 'kicked' } | { kind: 'raid' } | { kind: 'morbid' } | { kind: 'revolt' } | { kind: 'spell-mastery' } | { kind: 'ferocious' } | { kind: 'formidable' } | { kind: 'hellbent' } | { kind: 'landfall-this-turn' } | { kind: 'domain-ge'; value: number } | { kind: 'unknown'; text: string };

export type TriggerEvent =
  | { on: 'etb'; self: boolean; filter?: Filter; controller?: 'you' | 'any' }          // "When ~ enters" / "Whenever a creature enters under your control"
  | { on: 'dies'; self: boolean; filter?: Filter; controller?: 'you' | 'any' }
  | { on: 'ltb'; self: boolean }
  | { on: 'attacks'; self: boolean; filter?: Filter }
  | { on: 'blocks'; self: boolean } | { on: 'becomes-blocked'; self: boolean }
  | { on: 'combat-damage-player'; self: boolean }
  | { on: 'deals-damage'; self: boolean }
  | { on: 'upkeep'; whose: 'your' | 'each' | 'opponent' }
  | { on: 'end-step'; whose: 'your' | 'each' }
  | { on: 'draw-step'; whose: 'your' }
  | { on: 'combat-begin'; whose: 'your' }
  | { on: 'cast'; filter: Filter; who: 'you' | 'opponent' | 'any' }          // "Whenever you cast a noncreature spell"
  | { on: 'landfall' }
  | { on: 'life-gain' } | { on: 'life-loss-opponent' }
  | { on: 'sacrifice'; filter?: Filter }
  | { on: 'tapped'; self: boolean }
  | { on: 'discard' }
  | { on: 'end-of-turn' }
  | { on: 'unknown'; text: string };

export interface TriggeredAbility { kind: 'triggered'; event: TriggerEvent; effects: Effect[]; condition?: Condition; optional?: boolean; text: string; intervening?: Condition }
export interface ActivatedAbility { kind: 'activated'; cost: AbilityCost; effects: Effect[]; text: string; sorcerySpeed?: boolean; loyalty?: number; oncePerTurn?: boolean; manaAbility?: boolean }
export interface StaticAbility { kind: 'static'; effect: StaticEffect; text: string }
export interface SpellAbility { kind: 'spell'; effects: Effect[]; text: string }
export type Ability = TriggeredAbility | ActivatedAbility | StaticAbility | SpellAbility;

export interface AbilityCost {
  mana?: ManaCost;
  tap?: boolean;
  untap?: boolean;
  sacrificeSelf?: boolean;
  sacrifice?: Filter;
  discard?: number;
  payLife?: number;
  removeCounters?: { counter: string; amount: number };
  exileFromGraveyard?: number;
  tapUntappedCreature?: Filter;
}

export type StaticEffect =
  | { kind: 'anthem'; power: number; toughness: number; filter: Filter; scope: 'you-control' | 'all' | 'other-you-control'; keywords?: Keyword[] }
  | { kind: 'self-pt'; power: Amount; toughness: Amount }                                 // "~ gets +1/+1 for each ..."
  | { kind: 'self-keywords'; keywords: Keyword[]; condition?: Condition }
  | { kind: 'aura'; power: number; toughness: number; keywords?: Keyword[]; cantAttackOrBlock?: boolean; cantAttack?: boolean; cantBlock?: boolean; doesntUntap?: boolean; enchant: TargetSpec; controlEnchanted?: boolean; text?: string }
  | { kind: 'equipment'; power: number; toughness: number; keywords?: Keyword[]; equipCost: ManaCost }
  | { kind: 'cost-reduction'; filter: Filter; amount: number }
  | { kind: 'opponent-creatures-etb-tapped' }
  | { kind: 'cant-be-countered' }
  | { kind: 'lifegain-multiplier' }
  | { kind: 'unknown'; text: string };

export interface CardDef {
  name: string;
  oracleId: string;
  manaCost: ManaCost | null;
  manaValue: number;
  colors: Color[];
  colorIdentity: Color[];
  types: CardType[];
  supertypes: string[];
  subtypes: string[];
  typeLine: string;
  oracleText: string;
  power: string | null;
  toughness: string | null;
  loyalty: number | null;
  keywords: Keyword[];
  protectionFrom?: string[];
  wardCost?: number;
  abilities: Ability[];
  /** true if every clause of the oracle text was understood by the parser */
  fullyParsed: boolean;
  unparsed: string[];
  layout: string;
  faces?: { name: string; typeLine: string; oracleText: string; power: string | null; toughness: string | null; manaCost: ManaCost | null }[];
  producesMana: ManaSymbol[];     // for lands: what tapping produces
  isBasicLandType?: string;
  imageUri?: string | null;
  kicker?: ManaCost;              // optional extra cost; parser records kicked effects in abilities with condition kicked
  cycling?: ManaCost;
  entersTapped?: boolean;
}
