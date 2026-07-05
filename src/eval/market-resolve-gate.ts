// Market-resolution gate (build plan Phase 7) — the LIVE rebuild of the old criterion-id market grading.
// The old grounder (ground-market.ts) was deleted at the Phase 6 cut; market is now resolved AFTER the fetch
// by resolve-market against the live menu. This gate replays that resolution over the gold deck: for each
// gold `id` market cell it asks resolve-market to pick a market from the CAPTURED snapshot menu by the cell's
// canonical concept phrase, and passes iff the pick is `exact` and lands on one of the gold criterion ids.
//
// SCOPE — market-TYPE resolution only (concept -> criterion id), subject-agnostic. The captured snapshot
// (scripts/capture-live-menu.ts) is ONE fixture (USA) + the WC26 outright menu, so it cannot bind the gold
// queries' OWN subjects (Vitinha, Bruno, ...). Subject-dependent `offer`/`none` cells are therefore NOT graded
// here — their abstain behavior is covered by the offline Phase 5 gate (live-menu-gate.ts) and resolve-market's
// contract probe. A side-split `id` cell lists both side criteria; picking EITHER is a correct type resolution.
//
// LIVE — calls the resolve-market LLM (needs ANTHROPIC_API_KEY), like run.ts's extractor gate. Wired into the
// `npm run eval` exit code (run.ts); no standalone main (mirrors disambig-replay's old structure).

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { filterBySubject } from "../resolver/filter";
import { marketLabelOf } from "../resolver/recall";
import { resolveMarket } from "../resolver/resolve-market";
import type { BetOffer, KEvent } from "../resolver/offering-client";
import type { Menu } from "../resolver/live-menu-types";
import { loadGold, type GoldRecord } from "./gold-record";

type Grain = { betOffers: BetOffer[]; events: KEvent[] };
type Snapshot = {
  captured: string;
  competition: { groupId: number } & Grain;
  match: { fixtureEventId: number; home: string; away: string } & Grain;
};

const HERE = dirname(fileURLToPath(import.meta.url));
const loadSnapshot = (): Snapshot => JSON.parse(readFileSync(join(HERE, "live-menu.snapshot.json"), "utf8"));
const menuOf = (g: Grain): Menu => filterBySubject(g.betOffers, g.events).menu; // no subject -> full menu

export type GateResult = { pass: boolean; lines: string[] };

// One gradeable id-cell lifted from a gold row: the gold's accept phrasings + subject kind + the criterion
// id(s) any of which is a correct resolution (a side-split cell lists both sides; picking either passes).
type IdCase = { id: string; subjectKind: string; accept: string[]; level: "fixture" | "competition"; wantIds: number[] };

function idCases(gold: GoldRecord[]): IdCase[] {
  const out: IdCase[] = [];
  for (const rec of gold) {
    if (rec.gradeMarket === false) continue; // pure-scope rows: entity gate only
    for (const sel of rec.expect.selectors) {
      const mc = sel.market_concept;
      if (!("id" in mc)) continue; // only EXACT id cells (offer/none/main are subject-bound or sentinels)
      if (!mc.accept.length) continue; // no canonical phrasing to resolve against — skip (gold-authoring gap)
      out.push({ id: rec.id, subjectKind: sel.subject.kind, accept: mc.accept, level: sel.scope.level, wantIds: Array.isArray(mc.id) ? mc.id : [mc.id] });
    }
  }
  return out;
}

const uniq = (xs: string[]): string[] => [...new Set(xs)];

// Build the subject-aware phrasings to try. The captured snapshot can't supply the gold's OWN subjects, so the
// phrase must carry the context the live subject-filter normally provides: a player prop reads as "player X", a
// team-total binds to a concrete FIXTURE team (the abstract team/either_match_team subject maps, in this match,
// to one of its two teams). An `event` subject needs no owner — the bare concept is enough.
function phrasings(subjectKind: string, accept: string[], teams: string[]): string[] {
  if (subjectKind === "player") return uniq([...accept, ...accept.map((a) => (/\bplayer\b/i.test(a) ? a : `player ${a}`))]);
  if (subjectKind === "team" || subjectKind === "either_match_team") return uniq(teams.flatMap((t) => accept.map((a) => `${t} ${a}`)));
  return accept; // event
}

export async function runMarketResolveGate(gold: GoldRecord[]): Promise<GateResult> {
  const snap = loadSnapshot();
  const compMenu = menuOf(snap.competition);
  const matchMenu = menuOf(snap.match);
  const fixtureTeams = [snap.match.home, snap.match.away].filter(Boolean);

  // The pick now carries a LABEL, not a criterion id (the menu identity is the englishLabel-based label). Map it
  // back to criterion id(s) via the snapshot betoffers — a label can front >1 id only if two criteria share it
  // (none observed), so the intersection with wantIds is the robust check.
  const idsForLabel = (offers: BetOffer[], label: string): number[] =>
    [...new Set(offers.filter((b) => marketLabelOf(b) === label).map((b) => b.criterion?.id).filter((id): id is number => id != null))];

  const cases = idCases(gold);
  const fails: string[] = [];
  let passed = 0;
  for (const c of cases) {
    const menu = c.level === "competition" ? compMenu : matchMenu;
    const grainOffers = c.level === "competition" ? snap.competition.betOffers : snap.match.betOffers;
    const teams = c.level === "competition" ? [] : fixtureTeams; // team-binding only meaningful at fixture grain
    const tries = phrasings(c.subjectKind, c.accept, teams);
    // Reachability: the gold market passes if ANY natural phrasing resolves EXACT onto a gold criterion id.
    let hit: string | undefined;
    let lastMiss = "no phrasing tried";
    for (const phrase of tries) {
      const pick = await resolveMarket(phrase, menu); // LIVE LLM (default decider)
      const gotIds = pick.match === "exact" && pick.label != null ? idsForLabel(grainOffers, pick.label) : [];
      if (gotIds.some((id) => c.wantIds.includes(id))) { hit = phrase; break; }
      lastMiss = `"${phrase}" -> ${pick.match} ${pick.label ?? "—"}`;
    }
    if (hit) passed++;
    else fails.push(`   x ${c.id} (${c.subjectKind}) — want exact ∈ ${JSON.stringify(c.wantIds)}; no phrasing hit (tried ${tries.length}, last ${lastMiss})`);
  }

  const lines = [`Market-resolve gate (live resolve vs captured snapshot ${snap.captured.slice(0, 10)}): ${passed}/${cases.length}`, ...fails];
  return { pass: passed === cases.length, lines };
}

// Dev eyeball for the `npm run eval -- --ground "<concept>" [--grain match|competition]` CLI: resolve one
// concept against the snapshot menu and print the pick (replaces the old groundMarket eyeball).
export async function resolveEyeball(concept: string, grain: "match" | "competition"): Promise<void> {
  const snap = loadSnapshot();
  const menu = menuOf(grain === "competition" ? snap.competition : snap.match);
  const pick = await resolveMarket(concept, menu);
  const label = pick.match === "none" ? "—" : pick.label ?? "?";
  console.log(`resolve "${concept}" [${grain}, menu=${menu.length}] -> ${pick.match}  ${label}`);
}

// CLI: `npx tsx src/eval/market-resolve-gate.ts` — run the live gate standalone (mirrors live-menu-gate.ts).
// Needs ANTHROPIC_API_KEY (loaded from .env if present). Also run as part of `npm run eval`.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const envPath = join(HERE, "..", "..", ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && m[1] && !process.env[m[1]]) process.env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
    }
  }
  runMarketResolveGate(loadGold()).then((r) => { console.log(r.lines.join("\n")); process.exit(r.pass ? 0 : 1); });
}
