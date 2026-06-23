// EXECUTE — build plan Phase 4. The THIN final step. RECALL already fetched, and FILTER / RESOLVE / SELECT
// already decided, so execute just ASSEMBLES the answer from the picked outcomes in the live data — no
// fetching, no market decision here. It consumes an ExecuteInput (resolved legs + the data they were resolved
// against) and produces a LiveAnswer: exact legs are the answer, close legs are labelled suggestions, none
// legs clarify (theory §1, §4). Wired to nothing yet — the Phase-6 cut points the orchestrator at it.

import { marketLabelOf, variantOf } from "./recall";
import type { BetOffer, KEvent, KOutcome } from "./offering-client";
import type { ExecuteInput, ResolvedLeg, Clarification, MatchLabel } from "./live-menu-types";

// One resolved leg's answer: the picked market, the selected outcome with its REAL odds, and how well it fits.
// `fallback`/`note` carry the honest degrade (closest market, nearest line, subject not offered).
export type LegResult = {
  phrase: string;
  match: MatchLabel;
  market?: string;
  event?: string;
  outcome?: { label: string; odds?: number; line?: number; participant?: string };
  fallback?: NonNullable<ResolvedLeg["selection"]>["fallback"];
  note?: string;
};

export type LiveAnswer =
  | { kind: "clarify"; clarifications: Clarification[]; legs: LegResult[] }
  | { kind: "results"; legs: LegResult[]; clarifications: Clarification[]; notes: string[] };

// odds and line arrive as integer millis (1800 = 1.80, 2500 = 2.5); to decimal for display.
const dec = (n?: number): number | undefined => (n != null ? n / 1000 : undefined);

export function execute(input: ExecuteInput): LiveAnswer {
  const { data } = input;
  const clarifications = input.clarifications ?? [];

  // index the live data once: outcomeId -> (outcome, its offer); (criterion|variant) -> label; eventId -> name
  const outcomeById = new Map<number, { o: KOutcome; b: BetOffer }>();
  const labelByMarket = new Map<string, string>();
  const eventName = new Map<number, string>();
  for (const e of data.events) if (e.id != null) eventName.set(e.id, e.name ?? "");
  for (const b of data.betOffers) {
    if (b.criterion?.id != null) {
      const key = `${b.criterion.id}|${variantOf(b)}`;
      if (!labelByMarket.has(key)) labelByMarket.set(key, marketLabelOf(b));
    }
    for (const o of b.outcomes ?? []) if (o.id != null) outcomeById.set(o.id, { o, b });
  }

  const legs = input.legs.map((leg) => assembleLeg(leg, outcomeById, labelByMarket, eventName));

  // Clarify ONLY when NO leg mapped to a market (every pick `none`). A leg that picked a market but whose
  // outcome degraded (subject-absent / nearest-line) is still a RESULT — it shows the market with an honest
  // note, never a silent empty clarify.
  const anyMarket = legs.some((r) => r.match !== "none");
  if (!anyMarket) {
    const fromNone = legs.map<Clarification>((r) => ({ ref: "market", question: `No market is offered for "${r.phrase}".` }));
    return { kind: "clarify", clarifications: [...clarifications, ...fromNone], legs };
  }

  // 2+ legs are independent markets, not a joint bet -> caveat (same discipline as the old union note).
  const notes: string[] = [];
  if (legs.length >= 2) notes.push("showing each market on its own — not only the games that have all of these together");
  return { kind: "results", legs, clarifications, notes };
}

function assembleLeg(
  leg: ResolvedLeg,
  outcomeById: Map<number, { o: KOutcome; b: BetOffer }>,
  labelByMarket: Map<string, string>,
  eventName: Map<number, string>,
): LegResult {
  const { phrase, pick, selection } = leg;
  if (pick.match === "none" || pick.criterionId == null) return { phrase, match: "none", note: `not offered: "${phrase}"` };

  const market = labelByMarket.get(`${pick.criterionId}|${pick.variant ?? ""}`);
  const base: LegResult = { phrase, match: pick.match, ...(market ? { market } : {}) };
  if (!selection) return base; // market picked, no outcome constraint (just surface the market itself)

  // honest degrades that produced no outcome
  if (selection.fallback === "subject-absent") return { ...base, fallback: "subject-absent", note: `${selection.subject ?? "that selection"} is not offered for this market` };
  if (selection.fallback === "line-absent") return { ...base, fallback: "line-absent", note: "that line isn't offered for this market" };
  if (selection.fallback === "odds-absent") return { ...base, fallback: "odds-absent", note: "no outcome is offered in that price range" };

  const found = selection.outcomeId != null ? outcomeById.get(selection.outcomeId) : undefined;
  if (!found) return { ...base, note: "selected outcome not found in the live data" };

  const { o, b } = found;
  const outcome = {
    label: o.label ?? "",
    ...(dec(o.odds) != null ? { odds: dec(o.odds) } : {}),
    ...(dec(o.line) != null ? { line: dec(o.line) } : {}),
    ...(o.participant ? { participant: o.participant } : {}),
  };
  const ev = b.eventId != null ? eventName.get(b.eventId) : undefined;
  const noteParts: string[] = [];
  if (pick.match === "close") noteParts.push("closest market — not an exact settle");
  if (selection.fallback === "nearest-line") noteParts.push(`nearest offered line (${dec(o.line)})`);
  return {
    ...base,
    ...(ev ? { event: ev } : {}),
    outcome,
    ...(selection.fallback ? { fallback: selection.fallback } : {}),
    ...(noteParts.length ? { note: noteParts.join("; ") } : {}),
  };
}
