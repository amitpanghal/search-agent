// probe-select — drive the DETERMINISTIC tail of the pipeline (SELECT -> EXECUTE) in isolation, no LLM, no
// network. The post-fetch half is extract -> ... -> recall(fetch) -> FILTER -> RESOLVE(LLM) -> SELECT -> EXECUTE;
// SELECT and EXECUTE are pure functions over the picked market's REAL offers, so they need only filtered data.
// This probe supplies that data from the CAPTURED snapshot (scripts/capture-live-menu.ts -> live-menu.snapshot.json)
// and lets YOU stand in for the one LLM step it skips — RESOLVE — by naming the market label to slice to. The
// SelectSpec (subject / line / dir / selection) comes from flags, exactly the shape resolve.ts hands select().
//
//   tsx scripts/probe-select.ts --list                         # show market labels in each captured grain
//   tsx scripts/probe-select.ts --market "Total Goals" --dir under --line 4.5
//   tsx scripts/probe-select.ts --grain competition --market "Finishing Position — Winner" --subject-id 1003666473
//   tsx scripts/probe-select.ts --market "Correct Score" --selection 2-1
//   # multi-leg: each --leg is one "k=v;k=v" spec; they assemble into ONE execute() call (like resolve.ts)
//   tsx scripts/probe-select.ts --leg "market=Total Goals;dir=under;line=4.5" --leg "market=Both Teams To Score;dir=yes"
//
// Flags: --grain competition|match (default match) · --market "<label>" · --subject "<name>|home|away" ·
//        --subject-id <n> · --line <n> · --dir over|under|yes|no · --selection "<combo>" · --tier exact|close
// A --leg string takes the SAME keys (market, grain, subject, subject-id, line, dir, selection, tier).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { marketLabelOf, variantOf } from "../src/resolver/recall";
import { select, type SelectSpec } from "../src/resolver/select";
import { execute } from "../src/resolver/execute";
import type { BetOffer, KEvent } from "../src/resolver/offering-client";
import type { MatchLabel, ResolvedLeg } from "../src/resolver/live-menu-types";

type Grain = { betOffers: BetOffer[]; events: KEvent[] };
type Snapshot = {
  captured: string;
  competition: { groupId: number } & Grain;
  match: { fixtureEventId: number; home: string; away: string } & Grain;
};
type Fields = Record<string, string | boolean>;

const HERE = dirname(fileURLToPath(import.meta.url));
const snap: Snapshot = JSON.parse(readFileSync(join(HERE, "..", "src", "eval", "live-menu.snapshot.json"), "utf8"));

// ---- flag parser: top-level --k v / --k=v / --flag, plus repeatable --leg collected into an array ----
function parseArgs(argv: string[]): { flags: Fields; legs: string[] } {
  const flags: Fields = {};
  const legs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    let key: string, val: string | boolean;
    if (eq >= 0) { key = a.slice(2, eq); val = a.slice(eq + 1); }
    else { key = a.slice(2); const next = argv[i + 1]; if (next == null || next.startsWith("--")) val = true; else { val = next; i++; } }
    if (key === "leg" && typeof val === "string") legs.push(val);
    else flags[key] = val;
  }
  return { flags, legs };
}
// parse one --leg "market=Total Goals;dir=under;line=4.5" into the same Fields shape the top-level flags use.
function parseLeg(s: string): Fields {
  const f: Fields = {};
  for (const part of s.split(";")) {
    const t = part.trim();
    if (!t) continue;
    const eq = t.indexOf("=");
    if (eq < 0) { f[t] = true; continue; }
    f[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return f;
}
const { flags, legs: legStrings } = parseArgs(process.argv.slice(2));

const RULE = "=".repeat(92);
const show = (label: string, obj: unknown) => console.log(`\n${label}\n${"-".repeat(label.length)}\n${JSON.stringify(obj, null, 2)}`);

// ---- --list: the markets available to slice in each captured grain -------------------------------
function listMarkets(g: Grain): { criterionId?: number; variant: string; label: string; offers: number; outcomes: number }[] {
  const by = new Map<string, { criterionId?: number; variant: string; label: string; offers: number; outcomes: number }>();
  for (const b of g.betOffers) {
    const key = `${b.criterion?.id}|${variantOf(b)}`;
    const e = by.get(key) ?? { criterionId: b.criterion?.id, variant: variantOf(b), label: marketLabelOf(b), offers: 0, outcomes: 0 };
    e.offers += 1;
    e.outcomes += (b.outcomes ?? []).length;
    by.set(key, e);
  }
  return [...by.values()].sort((a, b) => a.label.localeCompare(b.label));
}

if (flags.list) {
  console.log(`captured snapshot: ${snap.captured.slice(0, 10)}  (no network, no LLM)`);
  for (const grain of ["competition", "match"] as const) {
    const g = snap[grain];
    console.log(`\n${RULE}\nGRAIN "${grain}" — ${grain === "match" ? `${snap.match.home} v ${snap.match.away}` : `group ${snap.competition.groupId}`}\n${RULE}`);
    for (const m of listMarkets(g)) console.log(`  ${m.label.padEnd(52)}  cid=${m.criterionId}  offers=${m.offers}  outcomes=${m.outcomes}`);
  }
  process.exit(0);
}

// ---- shared per-leg build: slice the market (the skipped RESOLVE step) -> spec -> SELECT ----------
const ctx = { home: snap.match.home, away: snap.match.away };
const defaultGrain = (flags.grain as string) ?? "match";
const usedGrains = new Set<"competition" | "match">();
const multi = legStrings.length > 0;

function buildLeg(f: Fields, n: number): ResolvedLeg {
  const tag = multi ? `leg ${n}` : "leg";
  const grainName = (f.grain as string) ?? defaultGrain;
  if (grainName !== "competition" && grainName !== "match") { console.error(`[${tag}] --grain must be competition|match (got "${grainName}")`); process.exit(1); }
  usedGrains.add(grainName);
  const grain: Grain = snap[grainName];

  const market = f.market as string | undefined;
  if (!market) { console.error(`[${tag}] need market=... (run --list to see options)`); process.exit(1); }
  const sliceOffers = grain.betOffers.filter((b) => marketLabelOf(b).toLowerCase() === market.toLowerCase());
  if (!sliceOffers.length) { console.error(`[${tag}] no market "${market}" in grain "${grainName}" (run --list)`); process.exit(1); }
  const pickB = sliceOffers[0]!;

  const spec: SelectSpec = {
    ...(f["subject-id"] != null ? { subjectId: Number(f["subject-id"]) } : {}),
    ...(f.subject != null ? { subject: String(f.subject) } : {}),
    ...(f.line != null ? { line: Number(f.line) } : {}),
    ...(f.dir != null ? { dir: String(f.dir) as SelectSpec["dir"] } : {}),
    ...(f.selection != null ? { selection: String(f.selection) } : {}),
  };

  console.log(`\n${RULE}\n${multi ? `LEG ${n} — ` : ""}grain "${grainName}"  ·  market "${market}"\n${RULE}`);
  show("PICKED MARKET (slice handed to SELECT — stands in for the RESOLVE LLM step)", { label: market, criterionId: pickB.criterion?.id, variant: variantOf(pickB), betOffers: sliceOffers.length });
  show("CANDIDATE OUTCOMES (what SELECT reads from)", sliceOffers.flatMap((b) =>
    (b.outcomes ?? []).map((o) => ({ id: o.id, label: o.label, englishLabel: o.englishLabel, type: o.type, line: o.line, odds: o.odds, participant: o.participant, participantId: o.participantId })),
  ));
  show("SELECT INPUT.spec (SelectSpec)", spec);
  const selection = select({ events: grain.events, betOffers: sliceOffers }, spec, ctx);
  show("STAGE 8 — SELECT OUTPUT (Selection)", selection);

  return { phrase: market, pick: { criterionId: pickB.criterion?.id, variant: variantOf(pickB), match: ((f.tier as string) ?? "exact") as MatchLabel }, selection };
}

// ---- assemble legs (each --leg, else the top-level flags as one leg) and run EXECUTE once ---------
const legFields = multi ? legStrings.map(parseLeg) : [flags];
console.log(`${RULE}\nPROBE: SELECT -> EXECUTE  (deterministic, no LLM, no network)\n${RULE}`);
console.log(`snapshot ${snap.captured.slice(0, 10)} · ${legFields.length} leg(s) · ctx ${ctx.home} v ${ctx.away}`);

const builtLegs = legFields.map((f, i) => buildLeg(f, i));
// EXECUTE indexes outcomes by id off `data`, so hand it the union of every grain the legs drew from.
const data = { betOffers: [...usedGrains].flatMap((g) => snap[g].betOffers), events: [...usedGrains].flatMap((g) => snap[g].events) };
const answer = execute({ legs: builtLegs, data });
show(`STAGE 9 — EXECUTE OUTPUT (LiveAnswer — ${builtLegs.length} leg(s))`, answer);
