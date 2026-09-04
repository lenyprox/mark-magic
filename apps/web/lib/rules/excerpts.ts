// The bundled Comprehensive Rules excerpt (numbers listed in src/rules/cited.ts) and a lookup that falls back to
// the parent rule when a lettered sub-rule is absent. Shared by the API route and the client-side RulePopover.
// Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC.
import excerpts from './cr-excerpts.json';

export interface RuleText { num: string; text: string; version: string; exact: boolean; source: 'excerpt' | 'full' }

const data = excerpts as { version: string; rules: Record<string, string> };

export const CR_VERSION = data.version;
export const isRuleNumber = (n: string): boolean => /^\d{3}\.\d+[a-z]?$/.test(n);

/** The bundled text for a rule number (or its parent rule when only the letter is missing). */
export function lookupExcerpt(num: string): RuleText | null {
  const n = num.trim();
  if (data.rules[n]) return { num: n, text: data.rules[n], version: data.version, exact: true, source: 'excerpt' };
  const parent = n.replace(/[a-z]$/, '');
  if (parent !== n && data.rules[parent]) return { num: n, text: data.rules[parent], version: data.version, exact: false, source: 'excerpt' };
  return null;
}

/** A one-line title for a rule number: its section name when the CR has one. */
export const SECTION_TITLES: Record<string, string> = {
  '100': 'General', '103': 'Starting the Game', '104': 'Ending the Game', '106': 'Mana', '108': 'Cards', '111': 'Tokens', '115': 'Targets', '117': 'Timing and Priority', '119': 'Life', '120': 'Damage', '121': 'Drawing a Card', '122': 'Counters',
  '302': 'Creatures', '305': 'Lands', '307': 'Sorceries', '400': 'Zones (General)', '405': 'Stack', '406': 'Exile', '500': 'Turn Structure', '502': 'Untap Step', '503': 'Upkeep Step', '504': 'Draw Step', '505': 'Main Phase', '506': 'Combat Phase',
  '507': 'Beginning of Combat Step', '508': 'Declare Attackers Step', '509': 'Declare Blockers Step', '510': 'Combat Damage Step', '511': 'End of Combat Step', '513': 'End Step', '514': 'Cleanup Step',
  '601': 'Casting Spells', '602': 'Activating Activated Abilities', '603': 'Handling Triggered Abilities', '605': 'Mana Abilities', '608': 'Resolving Spells and Abilities', '614': 'Replacement Effects', '615': 'Prevention Effects',
  '701': 'Keyword Actions', '702': 'Keyword Abilities', '704': 'State-Based Actions', '712': 'Double-Faced Cards', '714': 'Saga Cards', '903': 'Commander',
};
export const sectionTitle = (num: string): string => SECTION_TITLES[num.slice(0, 3)] ?? 'Comprehensive Rules';
