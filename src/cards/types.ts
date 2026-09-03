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
  kind: 'creature' | 'player' | 'any' | 'permanent' | 'spell' | 'creature-or-player' | 'creature-or-planeswalker' | 'planeswalker' | 'opponent' | 'artifact' | 'enchantment' | 'land' | 'nonland-permanent' | 'artifact-or-enchantment' | 'creature-spell' | 'noncreature-spell' | 'attacking-creature' | 'blocking-creature' | 'tapped-creature' | 'ability' | 'artifact-enchantment-or-nonbasic-land' | 'spell-or-nonland-permanent' | 'graveyard-card';
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
  powerLE?: number; powerGE?: number; toughnessLE?: number; mvLE?: number | Amount; mvGE?: number; mvEQ?: number | Amount;
  tapped?: boolean; untapped?: boolean; token?: boolean; nontoken?: boolean; attacking?: boolean; blocking?: boolean; flying?: boolean; nonbasic?: boolean; basic?: boolean;
  other?: boolean;                          // "another" / "other"
}

/** Amount expression */
export type Amount = number | 'X' | {
  count: 'creatures-you-control' | 'cards-in-hand' | 'lands-you-control' | 'power-of-source' | 'creatures-attacking' | 'opponent-creatures' | 'life-lost-this-turn'
    | 'permanents-you-control' | 'domain' | 'exiled-with' | 'cards-in-graveyard' | 'power-of-that' | 'mv-of-that' | 'colors-spent' | 'card-types-in-graveyard' | 'card-types-in-all-graveyards' | 'counters-on-source';
  filter?: Filter; plus?: number; times?: number; counter?: string;
};

/** A non-mana (or mixed) cost: shared by activated abilities, alternative costs, additional costs and Crew/Saddle. */
export interface AbilityCost {
  mana?: ManaCost;
  tap?: boolean;
  untap?: boolean;
  sacrificeSelf?: boolean;
  sacrifice?: Filter;
  discard?: number;
  discardSelf?: boolean;                                                 // Channel ("Discard this card:"), activated from hand
  discardHand?: boolean;                                                 // Lion's Eye Diamond
  payLife?: number;
  removeCounters?: { counter: string; amount: number };
  exileFromGraveyard?: number;
  exileOtherFromGraveyard?: { count: number | 'any'; minCardTypes?: number }; // Escape
  exileFromHand?: { filter: Filter; count: number };                     // Force of Will, evoke, Force of Negation
  returnToHand?: Filter;                                                 // Daze
  tapUntappedCreature?: Filter;
  tapCreaturesTotalPower?: { power: number; other?: boolean };           // Crew N / Saddle N
}

/** An alternative way to cast a spell (CR 118.9). `from` is the zone the card is cast from. */
export interface AltCost {
  id: 'pitch' | 'life' | 'evoke' | 'warp' | 'impending' | 'flashback' | 'escape' | 'jump-start';
  label: string;
  cost: AbilityCost;              // cost.mana undefined => free
  condition?: Condition;
  from: 'hand' | 'graveyard';
  exileAfter?: boolean;           // flashback / jump-start: exile instead of graveyard when the spell leaves the stack
  timeCounters?: number;          // impending N
}

export type CostModifier =
  | { kind: 'delve' } | { kind: 'convoke' } | { kind: 'improvise' }
  | { kind: 'reduce'; amount: Amount };                                  // affinity, domain, "costs {1} less for each ..."

/** Replacement / as-enters effects applied when the permanent enters the battlefield (CR 614.1c). */
export type AsEnters =
  | { kind: 'tapped' }
  | { kind: 'tapped-unless'; condition: Condition }                      // fastlands, slowlands, checklands, Starting Town
  | { kind: 'pay-life-or-tapped'; life: number }                         // shocklands
  | { kind: 'counters'; counter: string; amount: Amount }                // Chalice X, Ballista X, Moonshadow, Murktide
  | { kind: 'choose'; what: 'creature-type' | 'color' }                  // Cavern of Souls
  | { kind: 'discard-or-graveyard'; filter: Filter };                    // Mox Diamond

export type Effect =
  | { op: 'damage'; amount: Amount; target: TargetSpec | 'each-opponent' | 'each-player' | 'each-creature' | 'each-other-creature' | 'each-opponent-creature' | 'each-creature-and-player' | 'each-flying-creature' | 'each-nonflying-creature' | 'each-creature-you-dont-control' ; divided?: boolean; kickedAmount?: Amount }
  | { op: 'destroy'; target: TargetSpec | 'all-creatures' | 'all-artifacts' | 'all-enchantments' | 'all-lands' | 'all-nonland' | 'all-opponent-creatures' | 'all-tapped-creatures'; noRegenerate?: boolean; filter?: Filter; ifTarget?: Filter; ifTargetAlt?: { condition: Condition; filter: Filter } }
  | { op: 'exile'; target: TargetSpec | 'all-creatures'; from?: 'graveyard' | 'battlefield'; until?: 'leaves'; ifTarget?: Filter; ifTargetAlt?: { condition: Condition; filter: Filter } }
  | { op: 'counter'; target: TargetSpec; unlessPay?: number; toExile?: boolean }
  | { op: 'draw'; amount: Amount; who: 'you' | 'target-player' | 'each-player' | 'opponent' | 'controller' }
  | { op: 'discard'; amount: Amount | 'hand'; who: 'you' | 'target-player' | 'each-opponent' | 'each-player'; random?: boolean }
  | { op: 'gain-life'; amount: Amount; who: 'you' | 'target-player' | 'each-player' | 'that-controller' }
  | { op: 'lose-life'; amount: Amount; who: 'you' | 'target-player' | 'each-opponent' | 'each-player' | 'opponent' | 'that-controller' }
  /** Look at the top `look` cards, put `take` of them into your hand (or none, Ponder-style), the rest to `rest`. */
  | { op: 'dig'; look: Amount; take: number; rest: 'bottom' | 'top' | 'graveyard'; order: 'any' | 'random'; reveal?: boolean; filter?: Filter; optional?: boolean; altTake?: { condition: Condition; take: number } }
  | { op: 'put-from-hand'; amount: Amount; to: 'library-top' | 'library-bottom' | 'battlefield'; filter?: Filter; optional?: boolean; who?: 'you' | 'each-player' }
  | { op: 'shuffle'; optional?: boolean }
  | { op: 'shuffle-self-into-library' }
  | { op: 'reveal-hand-discard'; who: 'target-player' | 'target-opponent'; filter: Filter; count: 1 | 'all-named' }
  | { op: 'look-top'; who: 'target-player' | 'you'; amount: number }
  | { op: 'search'; filter: Filter; to: 'hand' | 'battlefield'; tapped?: boolean; count: number; optional?: boolean; who?: 'you' | 'that-controller'; reveal?: boolean; mvLE?: Amount }
  | { op: 'delayed-trigger'; at: 'next-upkeep' | 'next-end-step' | 'your-next-end-step'; effects: Effect[]; bind?: 'that' }
  | { op: 'return-to-battlefield'; target: 'that'; underControlOf: 'owner' | 'you'; counterIfYours?: 'that' | 'self' }
  | { op: 'amass'; subtype: string; amount: Amount }
  | { op: 'gain-ability'; ability: Ability }
  | { op: 'crew-self' } | { op: 'saddle-self' }
  | { op: 'damage-you'; amount: Amount }
  // parser-internal markers folded into the previous effect (never reach the engine)
  | { op: 'alt-if-target'; condition: Condition; filter: Filter }
  | { op: 'alt-take'; condition: Condition; take: number }
  | { op: 'fold-counter-if-yours'; on: 'that' | 'self' }
  | { op: 'alt-kicked-amount'; amount: Amount; text: string }
  | { op: 'fold-restriction'; restriction: 'creature-spell' | 'instant-sorcery' | 'chosen-type-creature' | 'colorless-eldrazi'; text: string }
  | { op: 'fold-alt-mana'; condition: Condition; mana: ManaSymbol[]; text: string }
  | { op: 'exile-from-hand'; filter: Filter; imprint?: boolean }
  | { op: 'exile-graveyard'; who: 'target-player' | 'each-opponent' | 'each-player' }
  | { op: 'attach-to-that' }
  | { op: 'counter-triggering' }
  | { op: 'pump'; target: TargetSpec | 'creatures-you-control' | 'self' | 'all-creatures' | 'other-creatures-you-control' | 'attacking-creatures'; power: Amount; toughness: Amount; keywords?: Keyword[]; duration: 'eot' | 'permanent' }
  | { op: 'grant-keyword'; target: TargetSpec | 'self' | 'creatures-you-control' | 'permanents-you-control'; keywords: Keyword[]; duration: 'eot' | 'permanent' }
  | { op: 'bounce'; target: TargetSpec | 'all-creatures' | 'all-nonland' | 'self'; to: 'hand' | 'library-top' | 'library-bottom' }
  | { op: 'token'; count: Amount; power: number; toughness: number; colors: Color[]; types: CardType[]; subtypes: string[]; keywords: Keyword[]; tapped?: boolean; attacking?: boolean; name?: string; text?: string; treasure?: boolean; clue?: boolean; spawn?: boolean; dynamicPT?: Amount }
  | { op: 'counters'; target: TargetSpec | 'self' | 'creatures-you-control' | 'each-other-creature-you-control'; counter: string; amount: Amount; optional?: boolean }
  | { op: 'tap'; target: TargetSpec | 'all-opponent-creatures' | 'all-creatures' ; noUntap?: boolean }
  | { op: 'untap'; target: TargetSpec | 'self' | 'all-you-control' | 'lands-you-control' }
  | { op: 'sacrifice'; who: 'you' | 'target-player' | 'each-opponent' | 'each-player'; what: Filter; amount: number }
  | { op: 'sacrifice-self' }
  | { op: 'mill'; amount: Amount; who: 'you' | 'target-player' | 'each-opponent' }
  | { op: 'search-land'; toBattlefield: boolean; tapped: boolean; basic: boolean; count: number; subtypes?: string[] }
  | { op: 'add-mana'; mana: ManaSymbol[] | 'any' | 'any-one' ; amount?: number; options?: ManaSymbol[] | 'exiled-with-colors'; restriction?: 'creature-spell' | 'instant-sorcery' | 'chosen-type-creature' | 'colorless-eldrazi'; altIf?: { condition: Condition; mana: ManaSymbol[] } }
  | { op: 'scry'; amount: number }
  | { op: 'surveil'; amount: number }
  | { op: 'return-from-graveyard'; what: Filter; to: 'hand' | 'battlefield'; target?: boolean; anyGraveyard?: boolean }
  | { op: 'fight'; target: TargetSpec; self: boolean }
  | { op: 'bite'; target: TargetSpec }
  | { op: 'set-life'; amount: number; who: 'you' | 'each-player' }
  | { op: 'gain-control'; target: TargetSpec; duration: 'eot' | 'permanent'; untapHaste?: boolean }
  | { op: 'copy-spell'; target: TargetSpec }
  | { op: 'transform-self'; viaExile?: boolean }
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
  | { kind: 'threshold' } | { kind: 'metalcraft' } | { kind: 'delirium' } | { kind: 'kicked' } | { kind: 'raid' } | { kind: 'morbid' } | { kind: 'revolt' } | { kind: 'spell-mastery' } | { kind: 'ferocious' } | { kind: 'formidable' } | { kind: 'hellbent' } | { kind: 'landfall-this-turn' } | { kind: 'domain-ge'; value: number }
  | { kind: 'not-your-turn' } | { kind: 'your-turn' }
  | { kind: 'lands-le'; value: number; other?: boolean } | { kind: 'lands-ge'; value: number; other?: boolean }   // "you control two or fewer other lands"
  | { kind: 'turn-le'; value: number }                                                                          // "it's your first, second, or third turn"
  | { kind: 'escaped' } | { kind: 'evoked' } | { kind: 'cast-from-hand' }
  | { kind: 'graveyard-has-each'; filters: Filter[] }
  | { kind: 'controls-each'; filters: Filter[] }
  | { kind: 'self-no-counters'; counter: string }
  | { kind: 'life-gained-this-turn' }
  | { kind: 'unknown'; text: string };

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
  | { on: 'cast'; filter: Filter; who: 'you' | 'opponent' | 'any'; nth?: number; mvEqualsCounter?: string }   // "Whenever you cast a noncreature spell" / "your second spell each turn" / Chalice
  | { on: 'landfall'; played?: boolean; other?: boolean }                     // "Whenever you play another land" (City of Traitors)
  | { on: 'draw'; who: 'you' | 'opponent'; exceptFirstInDrawStep?: boolean; nth?: number }   // Orcish Bowmasters, Tamiyo
  | { on: 'chapter'; chapters: number[] }                                     // Sagas
  | { on: 'leaves-graveyard'; filter?: Filter }                               // Murktide Regent
  | { on: 'or'; events: TriggerEvent[] }                                      // "When ~ enters and whenever ..."
  | { on: 'life-gain' } | { on: 'life-loss-opponent' }
  | { on: 'sacrifice'; filter?: Filter }
  | { on: 'tapped'; self: boolean }
  | { on: 'discard' }
  | { on: 'end-of-turn' }
  | { on: 'unknown'; text: string };

export interface TriggeredAbility { kind: 'triggered'; event: TriggerEvent; effects: Effect[]; condition?: Condition; optional?: boolean; text: string; intervening?: Condition }
export interface ActivatedAbility { kind: 'activated'; cost: AbilityCost; effects: Effect[]; text: string; sorcerySpeed?: boolean; loyalty?: number; oncePerTurn?: boolean; manaAbility?: boolean; activateOnlyIf?: Condition; instantSpeed?: boolean }
export interface StaticAbility { kind: 'static'; effect: StaticEffect; text: string }
export interface SpellAbility { kind: 'spell'; effects: Effect[]; text: string }
export type Ability = TriggeredAbility | ActivatedAbility | StaticAbility | SpellAbility;

export type StaticEffect =
  | { kind: 'anthem'; power: number; toughness: number; filter: Filter; scope: 'you-control' | 'all' | 'other-you-control'; keywords?: Keyword[] }
  | { kind: 'self-pt'; power: Amount; toughness: Amount }                                 // "~ gets +1/+1 for each ..."
  | { kind: 'self-keywords'; keywords: Keyword[]; condition?: Condition }
  | { kind: 'aura'; power: number; toughness: number; keywords?: Keyword[]; cantAttackOrBlock?: boolean; cantAttack?: boolean; cantBlock?: boolean; doesntUntap?: boolean; enchant: TargetSpec; controlEnchanted?: boolean; text?: string }
  | { kind: 'equipment'; power: number; toughness: number; keywords?: Keyword[]; equipCost: ManaCost }
  /** Signed generic-mana adjustment to spells matching `filter`: positive = cheaper. `who` = whose spells; `from` restricts to non-hand casts (Bilbo). */
  | { kind: 'cost-adjust'; filter: Filter; amount: number; who: 'you' | 'opponent' | 'any'; from?: 'non-hand' }
  | { kind: 'opponent-creatures-etb-tapped' }
  | { kind: 'extra-land'; amount: number }
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
  /** Per-face image URLs (Scryfall `normal` size); index 1 is the back face of a double-faced card. */
  faceImageUris?: (string | null)[];
  /** Scryfall's representative printing for this oracle card. */
  representativePrintingId?: string | null;
  /** The specific printing chosen for this copy (deck builder); overrides the representative for images. */
  printingId?: string | null;
  kicker?: ManaCost;              // optional extra cost; parser records kicked effects in abilities with condition kicked
  cycling?: ManaCost;
  /** Typecycling: cycling searches for a card matching this filter instead of drawing. */
  cyclingSearch?: Filter;
  entersTapped?: boolean;
  /** Alternative costs (pitch, evoke, flashback, escape, warp, impending, ...). */
  altCosts?: AltCost[];
  /** Mandatory additional costs ("As an additional cost to cast ~, sacrifice a creature"). */
  additionalCosts?: AbilityCost[];
  /** Delve / convoke / improvise / affinity-style reductions. */
  costModifiers?: CostModifier[];
  /** As-enters replacement effects (shocklands, enters-with-counters, choose a type, ...). */
  asEnters?: AsEnters[];
  rebound?: boolean;
  dredge?: number;
  /** Parsed back face of a modal or transforming double-faced card. */
  backFace?: CardDef;
  /** Sagas: the number of the final chapter. */
  finalChapter?: number;
}
