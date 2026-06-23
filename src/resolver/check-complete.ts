// Incomplete-query gate (Part A1). A pure, no-LLM check that runs right after extract() and BEFORE
// grounding: if the query named no anchor — no team, no player, no competition, no region — there is nothing
// to scope to ("show me odds tomorrow" → "all of football"), so we stop and ask the user to add one. With no
// model in the loop the message is a FIXED canned string (decided: Option 1), not a model-written one.
//
// Known edge, documented on purpose: this checks PRESENCE, not whether the words are REAL. "odds in Atlantis"
// sets region:"Atlantis", so it PASSES this gate and later abstains during grounding. That's the deferred
// "unsupported region" case, not a gate bug — don't re-file it.

import type { QueryPlan } from "./schema";

// The shared clarification shape — the same one `disambiguate` pushes, so the two sources are interchangeable
// downstream. For this gate `ref` is always "query" and there is no `suggest` (no candidates to offer).
export type Clarification = { ref: string; question: string; suggest?: number[] };

// Two parts: (1) what's wrong, (2) what to do. No example query — the gate has no data to build a valid one.
export const INCOMPLETE_QUESTION =
  "Your search doesn't name a team, player, or league. " +
  "Add a team, player, or league and search again.";

export function checkComplete(plan: QueryPlan): Clarification | null {
  const s = plan.event_scope;
  // A player named ONLY as a market owner (selector subject) is still an anchor — the extractor doesn't always
  // mirror it into event_scope.players, so check the subjects too (else "Cody Gakpo over 1.5 shots" false-clarifies).
  const hasSubjectPlayer = plan.selectors.some((sel) => sel.subject.kind === "player" && !!sel.subject.name);
  const hasAnchor = s.teams.length > 0 || s.players.length > 0 || s.competition !== null || s.region !== null || hasSubjectPlayer;
  return hasAnchor ? null : { ref: "query", question: INCOMPLETE_QUESTION };
}
