// verify-normalize — deterministic check of normalize-plan: the post-extract repair pass (per-leg-scope
// Phase 2.5). No network. Crafts a raw plan carrying each known defect, runs normalizePlan, and asserts both
// the per-field repair AND that the result parses against the per-leg QueryPlan.
//   tsx scripts/verify-normalize.ts
import { normalizePlan } from "../src/resolver/normalize-plan";
import { QueryPlan } from "../src/resolver/schema";

let pass = 0, fail = 0;
function check(desc: string, got: unknown, expect: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${desc}  -> ${JSON.stringify(got)}${ok ? "" : ` (expect ${JSON.stringify(expect)})`}`);
  ok ? pass++ : fail++;
}

const okScope = { level: "fixture", competition: null, region: null, teams: [], players: [], stage: null, time: null, play_state: null };

// One selector per defect class.
const raw: any = {
  status: "resolved",
  sport: "football",
  selectors: [
    // (1) per-leg scope: all-null time + all-null stage -> null; absent region/play_state -> null.
    {
      subject: { kind: "event" },
      market_concept: "scope cleanups",
      scope: {
        level: "fixture",
        competition: null,
        teams: [],
        players: [],
        stage: { round: null, ordinal: null, conditional: false },
        time: { date_window: null, kickoff_time_of_day: null, fixture_pick: null },
      },
    },
    // (2) leaf repairs: blank line/odds omitted; garbage bo_types dropped; nameless team -> event.
    { subject: { kind: "team", name: "" }, market_concept: "leaf repairs", scope: { ...okScope }, line: {}, odds: null, bo_types: ["__garbage__"] },
    // (3) odds {min:0} removed; garbage odds_sort dropped.
    { subject: { kind: "event" }, market_concept: "odds repairs", scope: { ...okScope }, odds: { min: 0 }, odds_sort: "nope" },
  ],
};

normalizePlan(raw);

console.log("\nper-leg scope cleanups:");
check("all-null time -> null", raw.selectors[0].scope.time, null);
check("all-null stage -> null", raw.selectors[0].scope.stage, null);
check("absent region -> null", raw.selectors[0].scope.region, null);
check("absent play_state -> null", raw.selectors[0].scope.play_state, null);

console.log("\nper-selector leaf repairs:");
check("blank line omitted", "line" in raw.selectors[1], false);
check("blank odds omitted", "odds" in raw.selectors[1], false);
check("garbage bo_types dropped", "bo_types" in raw.selectors[1], false);
check("nameless team -> event", raw.selectors[1].subject, { kind: "event" });
check("odds {min:0} removed", "odds" in raw.selectors[2], false);
check("garbage odds_sort dropped", "odds_sort" in raw.selectors[2], false);

console.log("\nfull-plan validity:");
const parsed = QueryPlan.safeParse(raw);
check("normalized plan parses against QueryPlan", parsed.success, true);
if (!parsed.success) console.log(JSON.stringify(parsed.error.issues, null, 2));

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
