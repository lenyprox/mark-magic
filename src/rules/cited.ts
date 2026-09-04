// Every Comprehensive Rules number the app can cite: whatever `citation()` in the engine's event pipeline returns,
// the client-side "why can't I play this" heuristics (src/play/drag.ts), and a hand-picked set of rules the explain
// layer links to. `scripts/build-cr.mjs` reads this list (as quoted numbers) to build the bundled excerpt file.

/** Numbers `citation()` in src/engine/events.ts can return. */
export const EVENT_CITED = [
  '504.1', '121.1', '502.1', '503.1', '505.1', '507.1', '508.1', '509.1', '510.4', '510.1', '511.1', '513.1', '514.1',
  '601.2', '602.2', '603.2', '608.2', '608.2b', '701.5a', '510.2', '120.3', '119.3',
  '704.5g', '704.5f', '704.5i', '704.5m', '704.5j', '714.4', '704.5a', '704.5c', '704.5q', '704.5b', '704.6c',
  '104.3', '104.4', '104.2', '701.19', '702.12b', '702.16', '702.88', '702.52', '903.9a', '614.1', '615.1', '103.5', '712.1', '108.4', '111.1', '500.7', '106.4',
  '701.22', '701.42', '701.20', '400.7', '701.7', '701.17', '701.8', '701.13', '406.1', '701.21a', '701.21b', '122.1',
] as const;

/** Numbers the drag planner's illegal-reason heuristics cite. */
export const DRAG_CITED = [
  '117.3', '117.1', '305.2', '305.1', '505.1a', '117.1a', '307.1', '601.2g', '602.2', '602.1', '302.6', '602.5a', '602.2b', '405.6', '601.2c', '508.1', '508.1c', '509.1a', '115.1',
] as const;

/** Rules the explain layer, tutorial and inspector link to beyond the event citations. */
export const EXTRA_CITED = [
  '100.2', '103.4', '104.3a', '104.3b', '104.3c', '115.1', '117.1', '117.1a', '117.3c', '117.4', '117.5', '119.3', '120.3', '120.4',
  '302.1', '302.6', '305.1', '305.2', '307.1', '400.7', '405.2', '405.5', '500.4', '500.5', '502.3', '504.1', '505.1a', '506.4', '508.1', '509.1', '510.1c', '510.2',
  '601.2', '601.2c', '601.2g', '603.2', '603.3', '603.3b', '605.3a', '608.2b', '702.2', '702.4', '702.9', '702.15', '702.19', '702.37a',
  '704.3', '704.5a', '704.5c', '704.5g', '704.5j', '704.5m', '704.6c', '903.6', '903.8', '903.9a', '903.10a',
] as const;

/** Section 701 keyword actions as renumbered in the August 2026 CR (src/rules/cite.ts corrects the engine's citations to these). */
export const KEYWORD_CITED = [
  '701.3a', '701.6a', '701.8a', '701.9a', '701.13', '701.17a', '701.18', '701.19a', '701.20', '701.21a', '701.22a', '701.23a', '701.24a', '701.25a', '701.26a', '701.26b', '701.27a',
  '305.1', '601.2a', '704.3', '103.5',
] as const;

export const CITED: readonly string[] = [...new Set<string>([...EVENT_CITED, ...DRAG_CITED, ...EXTRA_CITED, ...KEYWORD_CITED])].sort(compareRuleNumbers);

/** Sort rule numbers numerically (100.2 < 100.10 < 100.10a). */
export function compareRuleNumbers(a: string, b: string): number {
  const pa = parseRuleNumber(a); const pb = parseRuleNumber(b);
  return pa.section - pb.section || pa.rule - pb.rule || pa.letter.localeCompare(pb.letter);
}

export function parseRuleNumber(n: string): { section: number; rule: number; letter: string } {
  const m = /^(\d{3})\.(\d+)([a-z]?)$/.exec(n.trim());
  if (!m) return { section: 0, rule: 0, letter: '' };
  return { section: Number(m[1]), rule: Number(m[2]), letter: m[3] };
}

export const isRuleNumber = (n: string): boolean => /^\d{3}\.\d+[a-z]?$/.test(n);
