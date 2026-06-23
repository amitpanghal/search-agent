// verify-select-positional — deterministic check of the SELECT home/away mapping against the captured
// snapshot (Turkey home / USA away). No LLM, no fetch. Exercises the exact code path changed in select.ts.
//   tsx scripts/verify-select-positional.ts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { select, type Slice } from "../src/resolver/select";
import type { BetOffer, KEvent } from "../src/resolver/offering-client";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const snap = JSON.parse(readFileSync(join(ROOT, "src/eval/live-menu.snapshot.json"), "utf8"));
const ev: KEvent = snap.match.events[0];
const offers: BetOffer[] = snap.match.betOffers;
const byName = (n: string) => offers.filter((b) => b.betOfferType?.name === n);

const TURKEY = 1000000185; // home
const USA = 1000000258; // away
console.log(`fixture: ${ev.name}  | home=${ev.participants?.find((p:any)=>p.home)?.name} away=${ev.participants?.find((p:any)=>!p.home)?.name}`);

// englishLabel of the chosen outcome (what we assert on)
function lblOf(slice: Slice, outcomeId?: number): string | undefined {
  for (const b of slice.betOffers) for (const o of b.outcomes ?? []) if (o.id === outcomeId) return o.englishLabel ?? o.label;
  return undefined;
}

let pass = 0, fail = 0;
function check(desc: string, slice: Slice, spec: any, expect: string) {
  const sel = select(slice, spec);
  const got = sel.fallback ? `fallback:${sel.fallback}` : lblOf(slice, sel.outcomeId);
  const ok = got === expect;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${desc}  -> got ${JSON.stringify(got)} (expect ${JSON.stringify(expect)})`);
  ok ? pass++ : fail++;
}

// ---- HT/FT (Turkey home, USA away) ----
const htft: Slice = { events: [ev], betOffers: byName("HT/FT") };
console.log(`\nHT/FT outcomes: ${(byName("HT/FT")[0]?.outcomes ?? []).map((o:any)=>o.englishLabel).join(" ")}`);
check("away USA win/win  -> 2/2", htft, { subjectId: USA, subject: "USA", selection: "win/win" }, "2/2");
check("home Turkey win/win -> 1/1", htft, { subjectId: TURKEY, subject: "Turkey", selection: "win/win" }, "1/1");
check("away USA loss/win  -> 1/2", htft, { subjectId: USA, subject: "USA", selection: "loss/win" }, "1/2");
check("away USA draw/win  -> X/2", htft, { subjectId: USA, subject: "USA", selection: "draw/win" }, "X/2");
check("home Turkey win/draw-> 1/X", htft, { subjectId: TURKEY, subject: "Turkey", selection: "win/draw" }, "1/X");
// no side known (event subject) -> literal token only, won't match win/win -> subject-absent
check("event subj win/win  -> absent", htft, { selection: "win/win" }, "fallback:subject-absent");
// already-positional literal still works
check("literal 2/2 passthru-> 2/2", htft, { selection: "2/2" }, "2/2");

// ---- Correct Score (home-away ordered in feed) ----
const cs: Slice = { events: [ev], betOffers: byName("Correct Score") };
const csLabels = new Set((byName("Correct Score").flatMap((b:any)=>b.outcomes??[]).map((o:any)=>`${o.homeScore}-${o.awayScore}`)));
const has = (s:string)=>csLabels.has(s);
console.log(`\nCorrect Score sample: ${[...csLabels].slice(0,10).join(" ")}`);
// away USA "2-0" (USA scores 2) -> feed home-away "0-2"
if (has("0-2")) check("away USA 2-0 -> 0-2 (reversed)", cs, { subjectId: USA, subject: "USA", selection: "2-0" }, "0-2");
// home Turkey "2-0" -> "2-0" (no reverse)
if (has("2-0")) check("home Turkey 2-0 -> 2-0 (literal)", cs, { subjectId: TURKEY, subject: "Turkey", selection: "2-0" }, "2-0");
// event subject "2-1" -> literal
if (has("2-1")) check("event subj 2-1 -> 2-1 (literal)", cs, { selection: "2-1" }, "2-1");

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
