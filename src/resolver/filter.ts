// FILTER — build plan Phase 2 (deterministic, ZERO LLM, no fallback). Keep only the markets that PRICE the
// subject; drop the rest BEFORE the resolver sees them (theory §3, §6). It can never drop the right answer —
// that property is EARNED by the coverage audit (scripts/.coverage-audit.ts), which established WHERE a
// subject's name lives across every market type. Four homes:
//   (P) outcome `participant`   (Q) outcome `label`   (M) market label / per-team variant   (E) fixture event name
//   (P) is keyed by participant ID when we have the grounded `subjectId` (robust, diacritic-immune); without an
//   id (a named-but-ungrounded subject) it falls back to the folded participant name. Q/M/E are text homes.
// A market is kept if the subject hits ANY home. Findings the audit locked in:
//   - competition grain: a team/player sits in the outcome PARTICIPANT (P) — e.g. "Spain" keeps the 6
//     Finishing-Position variants, drops the 30 generic daily-total markets.
//   - match grain: the fixture event name (E) carries BOTH teams, so a team subject keeps the whole fixture
//     menu (correct — they're its markets); the per-team precision is a SELECT concern, not a filter one.
//   - MATCHING MUST BE DIACRITIC-FOLDED. The feed stores "Kylian Mbappé" / "Müller"; a plain substring of
//     "Mbappe" false-drops every accented name (the audit's main catch). So fold() both sides.
//
// No subject -> passthrough (a generic query like "most red cards in the tournament" has no team to filter on).

import { fold } from "./lexical";
import type { BetOffer, KEvent } from "./offering-client";
import { buildMenu, marketLabelOf } from "./recall";
import type { Menu } from "./live-menu-types";

export type FilterResult = { offers: BetOffer[]; menu: Menu };

// Does betoffer `b` price the subject, via any of the P/Q/M/E homes? P matches the outcome's participant by
// ID when `subjectId` is known (preferred), else by folded name; Q/M/E are folded-name matches on the
// already-folded subject `s`.
function pricesSubject(b: BetOffer, s: string, subjectId: number | undefined, evName: (id?: number) => string): boolean {
  return (
    (b.outcomes ?? []).some(
      (o) =>
        (subjectId != null ? o.participantId === subjectId : fold(o.participant ?? "").includes(s)) || // P (id, else name)
        fold(o.label ?? "").includes(s), // Q
    ) ||
    fold(marketLabelOf(b)).includes(s) || // M
    fold(evName(b.eventId)).includes(s) // E
  );
}

// Keep only the offers that price the subject, then rebuild the menu from them (so menu and offers stay in
// lockstep for SELECT). No subject -> the menu unchanged. Over-keeping (e.g. an opponent's per-team variant at
// match grain) is SAFE; under-dropping is the only danger, and folding + the four homes guard against it.
export function filterBySubject(offers: BetOffer[], events: KEvent[], subject?: string, subjectId?: number, keepTypes?: Set<number>): FilterResult {
  const evName = (id?: number) => events.find((e) => e.id === id)?.name ?? "";
  let kept = offers;
  if (subject && subject.trim()) {
    const s = fold(subject);
    kept = offers.filter((b) => pricesSubject(b, s, subjectId, evName));
  }
  // bo_types prune (the resolver still picks the market — this only shrinks its menu). EMPTY-GUARD: never let
  // a (possibly-wrong) shortlist strand a non-empty menu — skip the prune if it would kill everything.
  if (keepTypes?.size) {
    const typed = kept.filter((b) => b.betOfferType?.id != null && keepTypes.has(b.betOfferType.id));
    if (typed.length) kept = typed;
  }
  return { offers: kept, menu: buildMenu(kept) };
}
