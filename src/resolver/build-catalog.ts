// build-catalog.ts — build-time catalog rebuild (Sprint 3, Stage A). Run: `npm run build:catalog`.
//
// Joins the FULL raw criterion feed ⋈ category feed into the runtime catalog artifact,
// recovering the 553 criterions the trimmed snapshot dropped (incl. g001's `2100015085`). Then:
//   - tags each criterion with a `subject` bucket (the load-bearing pre-filter cut, decision 20),
//   - quarantines per-player pre-baked rows by participant-name match (guarded, fails toward keeping),
//   - stamps a content `version` so a stale vector index vs a rebuilt catalog is detectable (E11).
//
// Pure local join — NO API calls. Output overwrites data/football/football_criterions.json, which is
// source data (safe to commit). The vector index is rebuilt separately by `npm run build:index`
// against this artifact's post-quarantine `criterions` list.

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "..", "..", "data", "football");
const read = (f: string): any => JSON.parse(readFileSync(join(DATA, f), "utf8"));

// ---- input feed shapes (only the fields we read) ----
type RawCriterion = { id: number; names: { name: string; locale: string }[]; shownInLive?: boolean; shownInPreMatch?: boolean };
type Category = { id: number; name: string; mappings: { criterionId: number; boTypeName?: string }[] };

type Subject = "player" | "team_or_match";
type Side = "home" | "away" | null;
type OutCriterion = {
  id: number;
  sport: string;
  name: string;
  categoryNames: string[];
  boTypeNames: string[];
  shownInLive: boolean;
  shownInPreMatch: boolean;
  subject: Subject;
  side: Side; // per-side ownership of a team_or_match market, for the named-team divert (decision 20)
};

// ---- subject tagging (decision 20) ----
// Player-meaning categories = every `Player*` category PLUS four that name player markets without the
// prefix (verified against the feed: Goal Scorer = "To Score"/first/last scorer; Either Player; Man of
// the Match; Goalkeeper Saves). A criterion in ANY of these is `player` — EXCEPT an explicit team-side
// row ("... - Home Team"/"- Away Team") in the mixed Goalkeeper Saves category, demoted to team_or_match.
const EXTRA_PLAYER_CATEGORIES = new Set(["Goal Scorer", "Either Player", "Man of the Match", "Goalkeeper Saves"]);
const TEAM_SIDE_SUFFIX = /-\s*(home|away)\s+team$/i;

// ---- per-side tag (decision 20, Option 1) ----
// A team_or_match market "owned" by one side reads "... by (the) Home/Away Team" / "Home Team ...".
// This is the ONLY reliable per-side signal (the category feed has no general team-vs-match flag),
// so we tag just these; the grounder uses it to divert a named-team query ("Arsenal total goals")
// from a match total to its per-side twins. "both teams" is plural (a match market) — never matched.
// Both sides present (or neither) -> null: ambiguous ownership imposes no divert.
function sideOf(name: string): Side {
  const t = name.toLowerCase();
  const home = /\bhome\s+team\b/.test(t);
  const away = /\baway\s+team\b/.test(t);
  if (home === away) return null; // both or neither
  return home ? "home" : "away";
}

// ---- quarantine ----
// Diacritic-FOLDING normalize. en_GB criterion names ASCII-flatten player names ("Thomas Muller",
// "Luka Modric") while the participant feed keeps diacritics ("Müller", "Modrić"); NFD + stripping the
// combining marks folds both to the same ASCII so the names match. (Deliberately distinct from the
// runtime `normalize`, which maps non-ascii to spaces — right for the query path, wrong for this match.)
function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// Multi-token phrases that look like participant names but are football vocabulary — never match on these.
const QUARANTINE_STOPLIST = new Set(
  ["home team", "away team", "both teams", "extra time", "first half", "second half", "total goals", "own goal", "the draw"].map(fold),
);
const MAX_NAME_TOKENS = 6; // longest participant name we'll try to match as a window

// Participant match-set: only names with >=2 ORIGINAL tokens (the single-token guard — 345 one-word
// names are dropped as common-word risk), folded, still >=2 tokens after folding, minus the stop-list.
function buildParticipantSet(players: { name?: string }[]): Set<string> {
  const set = new Set<string>();
  for (const p of players) {
    const orig = String(p.name ?? "").trim();
    if (orig.split(/\s+/).length < 2) continue;
    const f = fold(orig);
    if (!f || f.split(" ").length < 2) continue;
    if (QUARANTINE_STOPLIST.has(f)) continue;
    set.add(f);
  }
  return set;
}

// Return the matched participant name if any 2..MAX_NAME_TOKENS window of the (folded) criterion name
// is a known participant, else null. Window scan keeps this near-linear instead of 1151×32k substring.
function participantMatch(name: string, pset: Set<string>): string | null {
  const toks = fold(name).split(" ").filter(Boolean);
  for (let w = 2; w <= MAX_NAME_TOKENS && w <= toks.length; w++) {
    for (let i = 0; i + w <= toks.length; i++) {
      const gram = toks.slice(i, i + w).join(" ");
      if (pset.has(gram)) return gram;
    }
  }
  return null;
}

function main(): void {
  const rawList = read("football_criterions.raw.json") as RawCriterion[];
  const catFeed = read("football_categories.json") as { sport: string; categories: Category[] };
  const participants = read("football_participants.json") as { players: { name?: string }[] };

  const rawById = new Map<number, RawCriterion>();
  for (const c of rawList) rawById.set(c.id, c);

  const playerCategoryNames = new Set<string>();
  for (const cat of catFeed.categories) {
    if (/^player/i.test(cat.name) || EXTRA_PLAYER_CATEGORIES.has(cat.name)) playerCategoryNames.add(cat.name);
  }

  // Join the category feed: criterionId -> distinct category names + distinct boType names.
  // The key set of `cats` IS the population (every category-referenced criterion id).
  const cats = new Map<number, Set<string>>();
  const botypes = new Map<number, Set<string>>();
  for (const cat of catFeed.categories) {
    for (const m of cat.mappings) {
      if (!cats.has(m.criterionId)) cats.set(m.criterionId, new Set());
      cats.get(m.criterionId)!.add(cat.name);
      if (m.boTypeName) {
        if (!botypes.has(m.criterionId)) botypes.set(m.criterionId, new Set());
        botypes.get(m.criterionId)!.add(m.boTypeName);
      }
    }
  }

  const pset = buildParticipantSet(participants.players);

  const kept: OutCriterion[] = [];
  const quarantined: { id: number; name: string; matched: string }[] = [];
  const missingEnGb: number[] = [];
  let player = 0;
  let teamOrMatch = 0;
  let perSide = 0;

  for (const [id, categorySet] of cats) {
    const raw = rawById.get(id);
    const en = raw?.names.find((n) => n.locale === "en_GB");
    if (!en) {
      missingEnGb.push(id); // verified 0 today; keep as a loud guard against a future feed drift
      continue;
    }
    const name = en.name;

    const matched = participantMatch(name, pset);
    if (matched) {
      quarantined.push({ id, name, matched });
      continue;
    }

    const categoryNames = [...categorySet].sort();
    const isPlayer = categoryNames.some((c) => playerCategoryNames.has(c)) && !TEAM_SIDE_SUFFIX.test(name);
    const subject: Subject = isPlayer ? "player" : "team_or_match";
    if (isPlayer) player++;
    else teamOrMatch++;

    // per-side only applies within team_or_match (a player market is never a "home/away team" market)
    const side: Side = subject === "team_or_match" ? sideOf(name) : null;
    if (side) perSide++;

    kept.push({
      id,
      sport: "football",
      name,
      categoryNames,
      boTypeNames: [...(botypes.get(id) ?? [])].sort(),
      shownInLive: !!raw?.shownInLive,
      shownInPreMatch: !!raw?.shownInPreMatch,
      subject,
      side,
    });
  }

  kept.sort((a, b) => a.id - b.id);
  quarantined.sort((a, b) => a.id - b.id);

  // Content version: hash the kept (id, name) pairs. Stable across reruns; changes iff the kept set or
  // any name changes — so build-market-index can stamp it and detect a stale index at load.
  const version = createHash("sha256")
    .update(kept.map((c) => `${c.id}\t${c.name}`).join("\n"))
    .digest("hex")
    .slice(0, 12);

  const out = {
    version,
    builtAt: new Date().toISOString(),
    source: {
      sport: "football",
      sportLabel: catFeed.sport,
      feed: "football_criterions.raw.json ⋈ football_categories.json",
    },
    counts: {
      referenced: cats.size,
      kept: kept.length,
      quarantined: quarantined.length,
      player,
      teamOrMatch,
      perSide,
      shownInLive: kept.filter((c) => c.shownInLive).length,
      shownInPreMatch: kept.filter((c) => c.shownInPreMatch).length,
    },
    criterions: kept,
    quarantined,
  };

  writeFileSync(join(DATA, "football_criterions.json"), JSON.stringify(out, null, 2) + "\n");

  // ---- report (eyeball the rebuild + the quarantine guard) ----
  const g001 = kept.find((c) => c.id === 2100015085);
  console.log(`catalog rebuilt — version ${version}`);
  console.log(`  referenced=${cats.size}  kept=${kept.length}  quarantined=${quarantined.length}`);
  console.log(`  subject: player=${player}  team_or_match=${teamOrMatch}  (per-side=${perSide})`);
  console.log(`  g001 target 2100015085: ${g001 ? `PRESENT (subject=${g001.subject}, name="${g001.name}")` : "MISSING ❌"}`);
  if (missingEnGb.length) {
    console.log(`  ⚠ ${missingEnGb.length} referenced ids had no en_GB name and were dropped: ${missingEnGb.slice(0, 10).join(", ")}${missingEnGb.length > 10 ? " …" : ""}`);
  }
  console.log(`\n  quarantine guard — drops per-player pre-baked rows by participant-name match.`);
  console.log(`  Eyeball: every line below should be a real full player name, never a common word.`);
  for (const q of quarantined.slice(0, 20)) console.log(`    ${q.id}  "${q.name}"  [matched: ${q.matched}]`);
  if (quarantined.length > 20) console.log(`    … and ${quarantined.length - 20} more (full list in the artifact's "quarantined" key).`);
  console.log(`\n  Note: per-player rows whose player is absent from football_participants.json leak through`);
  console.log(`  (fail-toward-keeping). They are long multi-player combos and won't out-cosine the clean generic market.`);
  console.log(`\n  wrote data/football/football_criterions.json`);
}

main();
