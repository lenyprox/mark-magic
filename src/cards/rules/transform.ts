// Parser rules for the `transform` family (Phase 9.1; docs/vocabulary/transform.md).
//
// The wordings that produce this family's ops: the transform trigger heads ("Whenever ~ transforms into ~", "…
// enters or transforms into …", "When equipped creature transforms"), the day/night vocabulary (the `Daybound` /
// `Nightbound` keyword lines, "If it's neither day nor night, it becomes day as ~ enters", "It becomes night",
// "Whenever day becomes night or night becomes day"), the "at the beginning of your first main phase" trigger head
// that every "you may pay {R}; if you do, transform ~" werewolf hangs off, descend (CR 207.2c) as an intervening-if
// or an "Activate only if" condition, "turn it face up", and "return it to the battlefield tapped and transformed".
//
// Every CR number below was checked against data/rules/cr.json (version August 7, 2026): day and night is 731 (726 is
// The Initiative), transform is 701.27 (701.28 is Convert), daybound AND nightbound are both 702.145 (702.146 is
// Disturb), and descend is the ability word of CR 207.2c counting permanent cards as CR 110.4a defines them (701.51
// is Open an Attraction).
//
// Every rule here is offered the text only after every built-in stage of parse.ts declined it (src/cards/rules/types.ts),
// so nothing that already parsed can be claimed here. Two disciplines on top of that, the same ones composition.ts
// keeps: a rule declines rather than claim what it cannot express (every sub-parse is checked for `unknown`), and a
// rule returns ONE effect — a sequence is wrapped in `{ op: 'scoped', who: 'you', do: [...] }`, the controller's own
// block, which is semantically a no-op container.
import type { Effect, TriggerEvent } from '../types.js';
import type { ConditionRule, EffectRule, LineRule, RuleFamily, TriggerRule } from './types.js';

/** "eight" / "8" → 8 (the number words descend and "N or more permanent types" are printed with). */
const WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
function count(w: string): number | null {
  const t = w.trim().toLowerCase();
  if (/^\d+$/.test(t)) return Number(t);
  return WORDS[t] ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// Trigger heads
// ---------------------------------------------------------------------------------------------------------------

const triggers: TriggerRule[] = [
  // "Whenever ~ transforms into ~" — both faces normalise to `~`, so the head names no face; `into: 'back'` is not
  // assumed: the same printed line appears on the back face, where the transformation is into the FRONT face.
  { name: 'transforms-self', make: (head) => /^whenever (?:~|this (?:creature|permanent|artifact|enchantment|land)) transforms(?: into ~)?$/i.test(head.trim()) ? { on: 'transforms', self: true } : null },
  // "Whenever ~ enters or transforms into ~" — one ability with two firing conditions (CR 603.2)
  { name: 'transforms-or-enters', make: (head) => /^whenever (?:~|this (?:creature|permanent|artifact|enchantment|land)) enters or transforms into ~$/i.test(head.trim()) ? { on: 'transforms', self: true, orEnters: true } : null },
  // "When equipped creature transforms" / "When enchanted creature transforms" (CR 702.6a: the attached permanent)
  { name: 'transforms-attached', make: (head) => /^when(?:ever)? (?:equipped|enchanted) (?:creature|permanent) transforms$/i.test(head.trim()) ? { on: 'transforms', attached: true } : null },
  // "Whenever another creature you control transforms"
  { name: 'transforms-another', make: (head) => {
    const m = head.trim().match(/^whenever another (creature|permanent) you control transforms$/i);
    if (!m) return null;
    return { on: 'transforms', self: false, filter: { ...(m[1].toLowerCase() === 'creature' ? { types: ['Creature' as const] } : {}), other: true }, controller: 'you' };
  } },
  // "Whenever day becomes night or night becomes day" (CR 731.1a), and each half on its own
  { name: 'day-night-change', make: (head) => {
    const t = head.trim().toLowerCase();
    if (/^whenever day becomes night or night becomes day$/.test(t)) return { on: 'day-night' };
    if (/^whenever day becomes night$/.test(t)) return { on: 'day-night', to: 'night' };
    if (/^whenever night becomes day$/.test(t)) return { on: 'day-night', to: 'day' };
    return null;
  } },
  // "At the beginning of your first main phase" (CR 505.1) — the head of every "you may pay {R}. If you do, transform ~."
  // `TriggerRule.make` is handed the head alone, so this rule cannot see whether the BODY parses; the 33 cards whose
  // body still holds an `unknown` clause would otherwise put an inert ability on the stack every single turn. The
  // family's engine-side trigger declines those (src/engine/ops/transform.ts:bodySimulable), so the head is safe to
  // claim here and the fidelity ratchet does not move.
  { name: 'first-main-phase', make: (head) => {
    const t = head.trim().toLowerCase();
    if (/^at the beginning of your (?:first |precombat )?main phase$/.test(t)) return { on: 'first-main-phase', whose: 'your' };
    if (/^at the beginning of each player's (?:first |precombat )?main phase$/.test(t)) return { on: 'first-main-phase', whose: 'each' };
    return null;
  } },
  // "Whenever ~ transforms into ~ and at the beginning of your first main phase" — one ability, two firing conditions
  { name: 'transforms-and-first-main', make: (head) => /^whenever ~ transforms into ~ and at the beginning of your first main phase$/i.test(head.trim())
    ? { on: 'or', events: [{ on: 'transforms', self: true } as TriggerEvent, { on: 'first-main-phase', whose: 'your' } as TriggerEvent] } : null },
];

// ---------------------------------------------------------------------------------------------------------------
// Conditions (intervening-if clauses, "Activate only if …", "as long as …")
// ---------------------------------------------------------------------------------------------------------------

const conditions: ConditionRule[] = [
  // The "descend 8" ability word (CR 207.2c) is printed as "eight or more cards are in your graveyard"
  { name: 'descend-cards', make: (text) => {
    const m = text.trim().replace(/\.$/, '').match(/^(?:there are )?(\w+) or more cards (?:are )?in your graveyard$/i);
    const n = m && count(m[1]); return n ? { kind: 'descend', count: n, among: 'cards' } : null;
  } },
  // "Descend N" (CR 207.2c) is printed as "N or more permanent cards in your graveyard" (CR 110.4a: a permanent card)
  { name: 'descend-permanent-cards', make: (text) => {
    const m = text.trim().replace(/\.$/, '').match(/^(?:there are )?(\w+) or more permanent cards (?:are )?in your graveyard$/i);
    const n = m && count(m[1]); return n ? { kind: 'descend', count: n, among: 'permanent-cards' } : null;
  } },
  // "there are four or more permanent types among cards in your graveyard"
  { name: 'descend-permanent-types', make: (text) => {
    const m = text.trim().replace(/\.$/, '').match(/^(?:there are )?(\w+) or more permanent types among cards in your graveyard$/i);
    const n = m && count(m[1]); return n ? { kind: 'descend', count: n, among: 'permanent-types' } : null;
  } },
  // CR 731.1: the day/night state
  { name: 'day-night', make: (text) => {
    const t = text.trim().replace(/\.$/, '').toLowerCase();
    if (/^it's neither day nor night$/.test(t)) return { kind: 'day-night', is: 'neither' };
    if (/^it's (day|night)$/.test(t)) return { kind: 'day-night', is: /night/.test(t) ? 'night' : 'day' };
    return null;
  } },
  // "if it entered from your graveyard" (CR 400.7: the zone it came from)
  { name: 'entered-from-graveyard', make: (text) => {
    const m = text.trim().replace(/\.$/, '').match(/^(?:it|~) entered (?:the battlefield )?from (your|a) (graveyard|exile)$/i);
    if (!m) return null;
    return { kind: 'entered-from', zone: m[2].toLowerCase() === 'exile' ? 'exile' : 'graveyard', ...(m[1].toLowerCase() === 'your' ? { who: 'you' as const } : {}) };
  } },
];

// ---------------------------------------------------------------------------------------------------------------
// Effect sentences
// ---------------------------------------------------------------------------------------------------------------

/** The controller's own block: the container composition.ts uses when a sentence is really a sequence. */
const seq = (effects: Effect[]): Effect => ({ op: 'scoped', who: 'you', do: effects });

const effects: EffectRule[] = [
  // "It becomes day." / "It becomes night." (CR 731.1). The built-ins rewrite a leading "it" to `~` on some lines,
  // so both spellings are accepted; "~ becomes a 4/4" and friends never reach here (a built-in claims them).
  { re: /^(?:it|~) becomes (day|night)$/i, make: (m) => ({ op: 'set-day-night', to: m[1].toLowerCase() as 'day' | 'night' }) },

  // "Transform ~, then untap it" (Westvale Abbey; CR 701.27a) — one effect, so the untap cannot be lost to a decomposition
  { re: /^transform ~, then untap (?:it|~)$/i, make: () => ({ op: 'transform', target: 'self', untap: true }) },
  // "Transform target creature you control" — the built-in table only knows "transform ~"
  { re: /^transform ((?:up to (?:one|two) )?target .+)$/i, make: (m, ctx) => { const t = ctx.parseTarget(m[1]); return t ? { op: 'transform', target: t } : null; } },
  // "… return it to the battlefield tapped and transformed under its owner's control" (the four Ojer / Aclazotz gods).
  // CR 712.14a: a card put onto the battlefield "transformed" ENTERS with its back face up — it does not enter front
  // face up and flip afterwards. The order below is therefore transform-then-move, and `asItEnters` is what says so:
  // the op records the face while the card is still in the graveyard and the family's `zoneMove` hook applies it
  // before the permanent enters, so the front face's own enters-the-battlefield abilities never trigger and neither
  // does any other permanent's "whenever a creature you control enters" (Impact Tremors saw a creature enter before).
  { re: /^return (?:it|~) to the battlefield( tapped)? and transformed under (?:its owner's|your) control$/i, make: (m) => seq([
    { op: 'transform', target: 'self', to: 'back', asItEnters: true },
    { op: 'move', what: 'self', to: 'battlefield', controller: /owner/i.test(m[0]) ? 'owner' : 'you', ...(m[1] ? { tapped: true } : {}) },
  ]) },

  // "Turn it face up." / "You may turn it face up." (CR 708.7; parse.ts wraps a leading "You may " in a `may` itself)
  { re: /^turn (?:it|that (?:card|permanent|creature)) face up$/i, make: () => ({ op: 'turn-face-up', target: 'that' }) },
  // "If it's a creature card, you may turn it face up." — the second sentence of the reveal-a-face-down-permanent shape
  { re: /^if it's a creature card, you may turn it face up$/i, make: () => ({ op: 'may', effects: [{ op: 'turn-face-up', target: 'that', onlyIf: 'creature-card' }] }) },
  // "Turn target face-down creature you control face up"
  { re: /^turn target face-down (creature|permanent)( you control)? face up$/i, make: (m) => ({ op: 'turn-face-up', target: { kind: 'face-down-permanent', ...(m[2] ? { controller: 'you' as const } : {}) } }) },

  // NOT here: "~ becomes prepared." / "~ enters prepared." The engine tracks the prepared state (op `become-prepared`,
  // as-enters `prepared`, condition `prepared`), but the half that matters — casting a copy of the card's SECOND face —
  // needs a `CardDef` for that face, and parse.ts builds none for the `prepare` layout (`SECOND_FACE_LAYOUTS` in
  // src/cards/oracle-lines.ts lists split / adventure / flip only, so `secondFaceLines` is empty and those lines are
  // not even accounted for). Claiming these lines would make 26 cards read `fullyParsed` while doing nothing, so they
  // stay unparsed until the core change lands — see docs/vocabulary/transform.md, "Open issues".
];

// ---------------------------------------------------------------------------------------------------------------
// Whole lines
// ---------------------------------------------------------------------------------------------------------------

const lines: LineRule[] = [
  // "Daybound" / "Nightbound" (both CR 702.145 — b and e). Both are claimed inside the keyword bail-out (the line starts
  // with a keyword the built-ins know of but do not implement). The marker is a family static, not a `Keyword` — see
  // the note on `DayboundStatic` in src/engine/ops/transform.ts — and the day/night switch reads it off whichever face
  // is up. The as-enters carries CR 702.145d / 702.145g ("if it's neither day nor night, it becomes day/night") and
  // CR 702.145b ("if it is night ... it enters transformed"), which src/engine/ops/transform.ts applies together.
  { name: 'daybound-nightbound', match: (line, ctx) => {
    const m = line.trim().replace(/\.$/, '').match(/^(daybound|nightbound)$/i);
    if (!m || ctx.isSpell) return false;
    const kw = m[1].toLowerCase() as 'daybound' | 'nightbound';
    ctx.addAbility({ kind: 'static', effect: { kind: kw }, text: line });
    ctx.addAsEnters({ kind: 'day-night-enters', to: kw === 'daybound' ? 'day' : 'night' });
    return true;
  } },
  // "If it's neither day nor night, it becomes day as ~ enters." (CR 731.1 / 614.1) — an as-enters replacement, not a static
  { name: 'day-night-as-enters', match: (line, ctx) => {
    const m = line.trim().replace(/\.$/, '').match(/^if it's neither day nor night, it becomes (day|night) as (?:~|this (?:creature|permanent|artifact|enchantment|land)) enters$/i);
    if (!m || ctx.isSpell) return false;
    ctx.addAsEnters({ kind: 'day-night-enters', to: m[1].toLowerCase() as 'day' | 'night' });
    return true;
  } },
];

const transform: RuleFamily = { name: 'transform', effects, lines, triggers, conditions };
export default transform;
