// RESOLVE(market) — ONE Jev request per query. Every BET is a phrase plus its own FILTERED live menu; Jev answers
// `choice` questions per bet: which menu item settles it (`pick`), which other market this bettor would add next
// (`next`), and which listed outcome the bet names (`outcome`, only when the bet's menu carries outcomes). A
// committed pick is always `exact`: the exact/close label reached no consumer (the envelope echoes `matched`
// from select), so the question that produced it was dropped (spec Decisions, 2026-09-23). The rulebook (resolve-market-prompt.md) rides ONCE
// in `state.rules`; the union of all bets' menus rides once in `state.menu`, and each bet's questions list only ITS
// refs, so bets with different menus share one round-trip. A pick counts at or above JEV_MARKET_THRESHOLD on the
// chosen option's probability; below it, on `none`, or when Jev does not answer, the bet is `{ match: "none" }` —
// the "no market" leg (abstain over wrong). The ref maps back to the menu item's LABEL (the market identity); the
// model sees labels only, never odds. No Bedrock call is made here; a missing JEV_ACCESS_KEY fails the query by
// name (jev-call.ts). `resolveMarket` (singular) is a thin wrapper kept for the offline gates.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { jevChoice, envNumber, type JevQuestion, type JevReply } from "./jev-call";
import type { Menu, MarketPick, MatchLabel } from "./live-menu-types";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL_NAME = "pick";
const OPTION_CAP = 254; // Jev takes 255 options per question; one slot is `none`
const NONE_PICK = "No market on the menu settles this bet";
const NONE_OUTCOME = "The bet names no listed outcome";

let cachedRules: string | undefined;
const rules = (): string => (cachedRules ??= readFileSync(join(HERE, "resolve-market-prompt.md"), "utf8"));

// The raw model output for one bet (a ref into the bet's OWN menu + labels), before we map it back to the market identity.
export type RawPick = { ref: number | null; match: string; outcome?: string | null; related?: number[] };
export type Bet = { phrase: string; menu: Menu };
// Batched decider — one call for every bet of the query, each with its own menu. Injectable so the gates can replay.
export type DecideManyFn = (bets: Bet[], query?: string) => Promise<RawPick[]>;
// Singular decider — kept for the offline gates' per-phrase replay.
export type DecideFn = (phrase: string, menu: Menu) => Promise<RawPick>;

// Map one raw pick -> MarketPick. `none` (or a ref the menu doesn't carry, or a missing answer) collapses to an
// abstain with no market identity, so a hallucinated/absent pick can never become a confident wrong answer.
// `outcomeLabel` is only accepted when it appears verbatim in the item's outcomes list (anti-hallucination) and is
// not a result market's SIDE code: buildMenu writes "1"/"2" next to "Draw" so the 1X2 market is recognisable, but a
// side is chosen by the grounded subject in select — a code here would bind the HOME side to any bet (the 2026-09-10
// "Arsenal to win → Sunderland" chain). "Draw" is a real outcome and stays.
const SIDE_CODES = new Set(["1", "2"]);
const toPick = (raw: RawPick | undefined, menu: Menu): MarketPick => {
  const match = (raw?.match ?? "none") as MatchLabel;
  if (!raw || match === "none" || raw.ref == null || !menu[raw.ref]) return { match: "none" };
  const item = menu[raw.ref]!;
  const outcomeLabel = raw.outcome && item.outcomes?.includes(raw.outcome) && !SIDE_CODES.has(raw.outcome) ? raw.outcome : undefined;
  // related: the model's suggested refs (deduped, self dropped, capped 3). No same-event filter here — execute
  // attaches a related market only if a betoffer with that label exists on the pick's OWN event, so the real
  // event guard is downstream; filtering here on the menu's example eventId only dropped valid same-event markets.
  const related = [...new Set(
    (raw.related ?? []).filter((r): r is number => typeof r === "number" && r !== raw.ref && menu[r] != null)
  )].slice(0, 3).map((r) => menu[r]!.label);
  return { label: item.label, match, ...(outcomeLabel ? { outcomeLabel } : {}), ...(related.length ? { related } : {}) };
};

// Pick + label a market for EACH bet against its own menu, in a single model call. A bet with an empty menu is
// `none` without asking (a choice between `none` and nothing).
export async function resolveMarkets(bets: Bet[], decideFn: DecideManyFn = decideWithJev, query?: string): Promise<MarketPick[]> {
  const asked = bets.filter((b) => b.menu.length);
  const raws = asked.length ? await decideFn(asked, query) : [];
  let i = 0;
  return bets.map((b) => (b.menu.length ? toPick(raws[i++], b.menu) : { match: "none" }));
}

// Singular convenience (one phrase, one menu). Kept so the offline gates' singular replay deciders work unchanged.
export async function resolveMarket(phrase: string, menu: Menu, decideFn?: DecideFn): Promise<MarketPick> {
  const many: DecideManyFn = decideFn ? async (bs) => [await decideFn(bs[0]!.phrase, bs[0]!.menu)] : decideWithJev;
  return (await resolveMarkets([{ phrase, menu }], many))[0]!;
}

const chunk = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) || 1 }, (_, i) => xs.slice(i * n, (i + 1) * n));

// The answers for one question, or for its chunks (`key`, `key:0`, `key:1`, …) when a bet's menu did not fit one question.
const answersFor = (answers: JevReply["answers"], key: string) =>
  Object.entries(answers).filter(([k]) => k === key || k.startsWith(`${key}:`)).map(([, a]) => a);

// The decider: build the union menu + per-bet questions, ONE request, then decode by probability.
export const decideWithJev: DecideManyFn = async (bets, query) => {
  const union: Menu = [];
  const refByLabel = new Map<string, number>();
  const betRefs = bets.map((b) => b.menu.map((m) => {
    let r = refByLabel.get(m.label);
    if (r == null) { r = union.length; refByLabel.set(m.label, r); union.push(m); }
    return r;
  }));
  const labelOf = (refs: number[]): Record<string, string> => Object.fromEntries(refs.map((r) => [String(r), union[r]!.label]));
  const questions: Record<string, JevQuestion> = {};
  bets.forEach((b, i) => {
    const who = `Bet ${i}: "${b.phrase}".`;
    // ponytail: never seen above 128 labels; chunking keeps every item askable instead of dropping any at Jev's 255 cap
    const chunks = chunk(betRefs[i]!, OPTION_CAP);
    chunks.forEach((refs, c) => {
      const key = chunks.length > 1 ? `:${i}:${c}` : `:${i}`;
      questions[`pick${key}`] = { type: "choice", instructions: `${who} Which menu market settles this bet? Apply state.rules. Answer none when no market on the menu settles it.`, criteria: { ...labelOf(refs), none: NONE_PICK } };
      questions[`next${key}`] = { type: "choice", instructions: `${who} Which other market on the same fixture would a bettor who placed this bet most likely add next?`, criteria: labelOf(refs) };
    });
    const outs = [...new Set(b.menu.flatMap((m) => m.outcomes ?? []))];
    if (outs.length) questions[`outcome:${i}`] = { type: "choice", instructions: `${who} Which listed outcome does this bet name? Answer none when it names no listed outcome.`, criteria: { ...Object.fromEntries(outs.map((o) => [o, o])), none: NONE_OUTCOME } };
  });
  const state = { query, rules: rules(), menu: union.map((m, ref) => ({ ref, ...m })), bets: bets.map((b, i) => ({ leg: i, phrase: b.phrase, refs: betRefs[i] })) };
  const res = await jevChoice(TOOL_NAME, state, questions);
  const threshold = envNumber("JEV_MARKET_THRESHOLD", 0.7, 0, 1); // a blank or bad value must never become 0/NaN
  return bets.map((b, i): RawPick => {
    if (!res) return { ref: null, match: "none" }; // Jev did not answer: every bet abstains, the query still answers
    const own = (unionRef: string): number => betRefs[i]!.indexOf(Number(unionRef)); // -1 -> toPick abstains
    // pick: across chunks, the committed option with the highest probability; below the threshold or `none` -> abstain
    const best = answersFor(res.answers, `pick:${i}`)
      .filter((a) => a.choice !== "none" && (a.probabilities[a.choice] ?? 0) >= threshold)
      .sort((x, y) => (y.probabilities[y.choice] ?? 0) - (x.probabilities[x.choice] ?? 0))[0];
    if (!best) return { ref: null, match: "none" };
    const ref = own(best.choice);
    const outcome = res.answers[`outcome:${i}`]?.choice;
    const related = answersFor(res.answers, `next:${i}`)
      .flatMap((a) => Object.entries(a.probabilities))
      .sort((x, y) => y[1] - x[1])
      .map(([k]) => own(k))
      .filter((r) => r >= 0);
    return { ref, match: "exact", outcome: outcome && outcome !== "none" ? outcome : null, related };
  });
};
