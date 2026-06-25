// Post-fetch market gate (build plan Phase 5) — the OFFLINE, deterministic safety net that lands BEFORE the
// cut. It replays the post-fetch half (FILTER -> RESOLVE mapping -> SELECT -> EXECUTE) against a CAPTURED live
// menu (scripts/capture-live-menu.ts -> live-menu.snapshot.json), so it needs no network and no LLM: the
// resolver's model JUDGMENT was validated live (Phase 2, 6/6); here we REPLAY captured decisions to assert the
// deterministic pipeline around them never regresses. Folds in the Phase 1-4 module checks (filter / resolve
// mapping / select / execute). Mirrors disambig-replay.ts (captured decisions, no model call).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildMenu, marketLabelOf } from "../resolver/recall";
import { filterBySubject } from "../resolver/filter";
import { resolveMarket, resolveMarkets, type DecideFn, type DecideManyFn } from "../resolver/resolve-market";
import { select, type SelectSpec } from "../resolver/select";
import { execute } from "../resolver/execute";
import type { BetOffer, KEvent, KOutcome } from "../resolver/offering-client";
import type { MatchLabel, ResolvedLeg } from "../resolver/live-menu-types";

type Grain = { betOffers: BetOffer[]; events: KEvent[] };
type Snapshot = {
  captured: string;
  competition: { groupId: number } & Grain;
  match: { fixtureEventId: number; home: string; away: string } & Grain;
};

const HERE = dirname(fileURLToPath(import.meta.url));
const loadSnapshot = (): Snapshot => JSON.parse(readFileSync(join(HERE, "live-menu.snapshot.json"), "utf8"));

export type GateResult = { pass: boolean; lines: string[] };

// A replay decider: returns the gold market's ref in the live menu (or none). Deterministic — no model call.
const replay = (gold: { label: string; match: MatchLabel } | null): DecideFn => async (_phrase, menu) => {
  if (gold == null) return { ref: null, match: "none", reason: "replay none" };
  const ref = menu.findIndex((m) => m.label.toLowerCase() === gold.label.toLowerCase());
  return ref >= 0 ? { ref, match: gold.match, reason: "replay" } : { ref: null, match: "none", reason: "gold not in menu" };
};

export async function runLiveMenuGate(): Promise<GateResult> {
  const snap = loadSnapshot();
  const lines: string[] = [];
  let passed = 0, total = 0;
  const check = (name: string, ok: boolean, detail = "") => { total++; if (ok) passed++; else lines.push(`   x ${name}${detail ? `  — ${detail}` : ""}`); };

  const comp = snap.competition;
  const match = snap.match;
  const ctx = { home: match.home, away: match.away };
  const compMenu = (subject?: string) => filterBySubject(comp.betOffers, comp.events, subject).menu;
  const matchMenu = (subject?: string) => filterBySubject(match.betOffers, match.events, subject).menu;
  const has = (menu: { label: string }[], label: string) => menu.some((m) => m.label.toLowerCase() === label.toLowerCase());

  // ---- (A) FILTER coverage (deterministic) ----
  const fullComp = compMenu().length;
  const spain = compMenu("Spain");
  // robust to snapshot growth: keep the Spain-priced markets, drop the generic ones, shrink vs the full menu
  check("filter: Spain keeps Winner+Top4, drops generic daily markets, shrinks", has(spain, "Finishing Position — Winner") && has(spain, "Finishing Position — Top 4") && !has(spain, "Total Daily Goals") && spain.length < fullComp, `menu=${spain.length}/${fullComp}`);
  const mbappe = compMenu("Mbappe"); // accent fold — feed stores "Kylian Mbappé"
  check("filter: Mbappe (accent-fold) keeps top-scorer + assists", has(mbappe, "To score most goals in the Competition") && has(mbappe, "Number of assists by the player in the Competition"), `menu=${mbappe.length}`);
  check("filter: no subject -> passthrough", compMenu().length === buildMenu(comp.betOffers).length);
  check("filter: USA match keeps non-lexical maps", has(matchMenu("USA"), "Full Time") && has(matchMenu("USA"), "Both Teams To Score"));

  // ---- (B) RESOLVE mapping replay (captured decisions, no model) ----
  type RCase = { phrase: string; subject?: string; grain: "competition" | "match"; gold: { label: string; match: MatchLabel } | null };
  const RDECK: RCase[] = [
    { phrase: "Spain to win the World Cup", subject: "Spain", grain: "competition", gold: { label: "Finishing Position — Winner", match: "exact" } },
    { phrase: "Spain to finish in the top 4", subject: "Spain", grain: "competition", gold: { label: "Finishing Position — Top 4", match: "exact" } },
    { phrase: "Mbappe to win the golden boot", subject: "Mbappe", grain: "competition", gold: { label: "To score most goals in the Competition", match: "exact" } },
    { phrase: "Japan to be eliminated in the quarter final", subject: "Japan", grain: "competition", gold: null },
    { phrase: "home team to win", subject: "USA", grain: "match", gold: { label: "Full Time", match: "exact" } },
    { phrase: "both teams to score", subject: "USA", grain: "match", gold: { label: "Both Teams To Score", match: "exact" } },
  ];
  for (const c of RDECK) {
    const menu = c.grain === "competition" ? compMenu(c.subject) : matchMenu(c.subject);
    const pick = await resolveMarket(c.phrase, menu, replay(c.gold));
    const gotLabel = pick.match === "none" ? null : pick.label ?? null;
    const ok = c.gold == null ? pick.match === "none" : pick.match === c.gold.match && (gotLabel ?? "").toLowerCase() === c.gold.label.toLowerCase();
    check(`resolve: "${c.phrase}"`, ok, `want ${c.gold ? c.gold.match + " " + c.gold.label : "none"} -> got ${pick.match} ${gotLabel ?? "—"}`);
  }

  // ---- (B2) RESOLVE batched: many legs sharing ONE menu resolve in a single call (Q2) ----
  const replayMany = (golds: ({ label: string; match: MatchLabel } | null)[]): DecideManyFn => async (_phrases, menu) =>
    golds.map((g) => {
      if (g == null) return { ref: null, match: "none", reason: "replay none" };
      const ref = menu.findIndex((m) => m.label.toLowerCase() === g.label.toLowerCase());
      return ref >= 0 ? { ref, match: g.match, reason: "replay" } : { ref: null, match: "none", reason: "gold not in menu" };
    });
  {
    const menu = compMenu("Spain");
    const golds: { label: string; match: MatchLabel }[] = [
      { label: "Finishing Position — Winner", match: "exact" },
      { label: "Finishing Position — Top 4", match: "exact" },
    ];
    const picks = await resolveMarkets(["Spain to win the World Cup", "Spain to finish in the top 4"], menu, replayMany(golds));
    const labelOf = (p: (typeof picks)[number]) => (p.match === "none" ? null : p.label ?? null);
    const ok = picks.length === golds.length && picks.every((p, i) => p.match === golds[i]!.match && (labelOf(p) ?? "").toLowerCase() === golds[i]!.label.toLowerCase());
    check("resolve batched: 2 legs share one menu -> 2 correct picks", ok, picks.map((p) => `${p.match} ${labelOf(p) ?? "—"}`).join(" | "));
  }

  // ---- (C) SELECT against the captured fixture (deterministic) ----
  // The picked market as a SELECT slice (the market's betoffers + their events), mirroring resolve.ts.
  const sliceFor = (label: string, grain: Grain = match) => ({
    events: grain.events,
    betOffers: grain.betOffers.filter((b) => marketLabelOf(b).toLowerCase() === label.toLowerCase()),
  });
  type SCase = { phrase: string; market: string; sel: SelectSpec; want: "exact" | "subject-absent" };
  const SDECK: SCase[] = [
    { phrase: "under 4.5 total goals", market: "Total Goals", sel: { dir: "under", line: 4.5 }, want: "exact" },
    // nearest line is now just the SELECTED outcome (no `nearest-line` flag) — 2.25 -> 2.5, a concrete pick.
    { phrase: "over 2.25 total goals", market: "Total Goals", sel: { dir: "over", line: 2.25 }, want: "exact" },
    { phrase: "USA over 0.5 goals", market: "Total Goals by USA", sel: { dir: "over", line: 0.5 }, want: "exact" },
    { phrase: "Çalhanoglu to score 2+", market: "To score at least 2 goals", sel: { subject: "Çalhanoglu", dir: "yes", line: 2 }, want: "exact" },
    { phrase: "Turkey -0.5 handicap", market: "Asian Handicap", sel: { subject: "Turkey", line: -0.5 }, want: "exact" },
    { phrase: "home team to win", market: "Full Time", sel: { subject: "home" }, want: "exact" },
    { phrase: "Messi over 2.5 shots", market: "Player's shots (Settled using Opta data)", sel: { subject: "Messi", dir: "over", line: 2.5 }, want: "subject-absent" },
  ];
  for (const c of SDECK) {
    const r = select(sliceFor(c.market), c.sel, ctx);
    const got = r.fallback ?? (r.outcomeId != null ? "exact" : "empty");
    check(`select: "${c.phrase}"`, got === c.want, `want ${c.want} -> got ${got}`);
  }

  // ---- (D) EXECUTE assembly (deterministic) ----
  const pickOf = (label: string): { label: string } => {
    if (!match.betOffers.some((x) => marketLabelOf(x).toLowerCase() === label.toLowerCase())) throw new Error(`pickOf: "${label}" not in snapshot`);
    return { label };
  };
  const legExact = (phrase: string, label: string, sel: SelectSpec): ResolvedLeg => ({ phrase, pick: { ...pickOf(label), match: "exact" }, selection: select(sliceFor(label), sel, ctx) });
  const ex = { betOffers: match.betOffers, events: match.events };

  const a1 = execute({ legs: [legExact("home team to win", "Full Time", { subject: "home" })], data: ex });
  const hl1 = a1.results[0]?.highlighted[0];
  check("execute: home win -> Full Time '1' with odds + event", a1.results.length === 1 && hl1?.outcomes[0]?.label === "1" && !!hl1?.outcomes[0]?.odds && hl1?.betOffer.criterion.label === "Full Time" && !!a1.results[0]?.event.id);
  const a2 = execute({ legs: [{ phrase: "team to receive most red cards", pick: { match: "none" } }], data: ex });
  check("execute: none -> clarify", a2.results.length === 0 && a2.clarificationNeeded != null);
  const a3 = execute({ legs: [legExact("home team to win", "Full Time", { subject: "home" }), legExact("both teams to score", "Both Teams To Score", { dir: "yes" })], data: ex });
  const hl3 = a3.results[0]?.highlighted ?? [];
  check("execute: multi-leg -> 2 resolved (same event) + caveat note", a3.results.length === 1 && hl3.length === 2 && hl3.every((h) => !!h.outcomes[0]) && a3.notes.length >= 1);

  // ---- (E) SELECT by subjectId — the PREFERRED id-path (select.ts:46). (C) covers the name-path; this locks
  // the id-branch deterministically (no network/LLM) across the four cases it splits into: outright (one named
  // outcome, returned directly), 1X2 (home/away by participant id), owner-bound (id absent but a "Yes" exists ->
  // the team's affirmative), and honest subject-absent (id absent, no "Yes"). Ids are the grounded participant
  // ids from the captured menu (== outcome.participantId on named markets).
  const SPAIN = 1003666473, TURKEY = 1000000185;
  const labelOfOutcome = (outs: KOutcome[], id?: number) => outs.find((o) => o.id === id)?.label ?? null;
  type ICase = { name: string; grain: "competition" | "match"; market: string; sel: SelectSpec; want: "exact" | "subject-absent"; wantLabel?: string };
  const IDECK: ICase[] = [
    { name: "outright by id (Spain -> Winner)", grain: "competition", market: "Finishing Position — Winner", sel: { subjectId: SPAIN }, want: "exact", wantLabel: "Spain" },
    { name: "1X2 by id (Turkey home -> '1')", grain: "match", market: "Full Time", sel: { subjectId: TURKEY }, want: "exact", wantLabel: "1" },
    { name: "owner-bound by id -> Yes (Spain -> Win The Trophy)", grain: "competition", market: "To Win The Trophy", sel: { subjectId: SPAIN }, want: "exact", wantLabel: "Yes" },
    { name: "subject-absent by id (Spain not in Turkey-USA Full Time)", grain: "match", market: "Full Time", sel: { subjectId: SPAIN }, want: "subject-absent" },
  ];
  for (const c of IDECK) {
    const grain = c.grain === "competition" ? comp : match;
    const betOffers = grain.betOffers.filter((b) => marketLabelOf(b).toLowerCase() === c.market.toLowerCase());
    const outs = betOffers.flatMap((b) => b.outcomes ?? []);
    const r = select({ events: grain.events, betOffers }, c.sel, ctx);
    const got = r.fallback ?? (r.outcomeId != null ? "exact" : "empty");
    const gotLabel = labelOfOutcome(outs, r.outcomeId);
    const ok = got === c.want && (c.wantLabel == null || gotLabel === c.wantLabel);
    check(`select-id: ${c.name}`, ok, `want ${c.want}${c.wantLabel ? " " + c.wantLabel : ""} -> got ${got}${gotLabel ? ` ${gotLabel}` : ""}`);
  }

  // ---- (F) SELECT — bet-offer-aware shapes (the funnel rewrite: type-keyed, combo, OT_UNTYPED fallback) ----
  const outOf = (sl: Grain) => sl.betOffers.flatMap((b) => b.outcomes ?? []);
  const idByEng = (sl: Grain, eng: string) => outOf(sl).find((o) => (o.englishLabel ?? o.label) === eng)?.id;

  // (F1) OT_UNTYPED direction fallback — the LOAD-BEARING fix: type-4 outright Yes/No are OT_UNTYPED, so a
  // {dir:"yes"} must fall back to the label or the affirmative is dropped (would have been "subject-absent").
  {
    const sl = sliceFor("To Win The Trophy", comp);
    const r = select(sl, { dir: "yes" }, ctx);
    const lab = outOf(sl).find((o) => o.id === r.outcomeId)?.label ?? null;
    check("select F: untyped dir=yes -> Yes (label fallback on OT_UNTYPED)", lab === "Yes", `got ${r.fallback ?? lab}`);
  }

  // (F2) Correct Score — match numeric homeScore/awayScore + englishLabel; reversal-immune (2-1 != 1-2).
  {
    const sl = sliceFor("Correct Score");
    const r1 = select(sl, { selection: "2-1" }, ctx);
    const r2 = select(sl, { selection: "1-2" }, ctx);
    check("select F: correct score 2-1 picks hs2/as1 (not 1-2)", r1.outcomeId === idByEng(sl, "2-1") && r1.outcomeId !== idByEng(sl, "1-2"), `got ${r1.outcomeId}`);
    check("select F: correct score 1-2 picks hs1/as2 (no AWAY_HOME reversal)", r2.outcomeId === idByEng(sl, "1-2"), `got ${r2.outcomeId}`);
  }

  // (F3) HT/FT — combo via outcome.type / englishLabel (OT_ONE_TWO == "1/2").
  {
    const sl = sliceFor("Half Time/Full Time");
    const r = select(sl, { selection: "1/2" }, ctx);
    check("select F: HT/FT 1/2 -> OT_ONE_TWO outcome", r.outcomeId === idByEng(sl, "1/2"), `got ${r.outcomeId}`);
  }

  // (F4) Double Chance — combo via englishLabel (OT_CROSS_OR_TWO == "X2").
  {
    const sl = sliceFor("Double Chance");
    const r = select(sl, { selection: "X2" }, ctx);
    check("select F: double chance X2 -> OT_CROSS_OR_TWO outcome", r.outcomeId === idByEng(sl, "X2"), `got ${r.outcomeId}`);
  }

  // (F5) Type-11 3-Way Handicap — both sides store the SAME line (home perspective); the AWAY side negates.
  // USA(away) -1.0 must hit the +1.0 betoffer's away outcome, NOT the -1.0 betoffer's — locks the sign rule.
  {
    const parts = match.events[0]?.participants ?? [];
    const homeId = parts.find((p) => p.home)?.participantId;
    const awayId = parts.find((p) => p.home === false)?.participantId;
    const sl = sliceFor("3-Way Handicap");
    const plus1 = sl.betOffers.find((b) => (b.outcomes ?? []).some((o) => o.type === "OT_ONE" && o.line === 1000));
    const wantAway = plus1?.outcomes?.find((o) => o.type === "OT_TWO")?.id;
    const wantHome = plus1?.outcomes?.find((o) => o.type === "OT_ONE")?.id;
    const ra = select(sl, { subjectId: awayId, line: -1.0 }, ctx);
    const rh = select(sl, { subjectId: homeId, line: 1.0 }, ctx);
    check("select F: type-11 away -1.0 negates onto the +1.0 betoffer", ra.outcomeId === wantAway && ra.fallback == null, `got ${ra.outcomeId} want ${wantAway}`);
    check("select F: type-11 home +1.0 (no negation)", rh.outcomeId === wantHome && rh.fallback == null, `got ${rh.outcomeId} want ${wantHome}`);
  }

  lines.unshift(`Live-menu post-fetch gate (captured snapshot ${snap.captured.slice(0, 10)}, no network/LLM): ${passed}/${total}`);
  return { pass: passed === total, lines };
}

// CLI: `npx tsx src/eval/live-menu-gate.ts`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runLiveMenuGate().then((r) => { console.log(r.lines.join("\n")); process.exit(r.pass ? 0 : 1); });
}
