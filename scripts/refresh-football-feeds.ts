// scripts/refresh-football-feeds.ts — one-job football catalog refresh. Run: `npm run refresh:feeds`.
//
// Streamlines the 4-step manual chore (curl ×2 + build:categories + build:catalog) into one command:
//   1. GET the category feed  → overwrite data/football/football_categories.raw.json
//   2. GET the criterion feed → overwrite data/football/football_criterions.raw.json
//   3. npm run build:categories   (decorate raw category feed → football_categories.json)
//   4. npm run build:catalog      (join criterions.raw ⋈ categories → football_criterions.json)
//
// Steps 3 and 4 are the EXISTING build scripts run verbatim (we shell out so their logic + reports
// stay untouched); order matters because build-catalog joins the DECORATED categories from step 3.
//
// Raws are overwritten unconditionally — a non-200 response aborts before any write (curl -f), so
// we never persist an error body, but no response-shape validation is done.
//
// Fetched via `curl`, not node fetch: the feeds-eu criterion host TLS-fingerprints the client and
// returns 410 to node/undici (and node's https module) while serving curl normally. curl is the
// original manual method and is already a hard dependency of this ops flow.
//
// Network: public-CDN GETs, no auth. Needs the Bash sandbox DISABLED to reach the network.
// Stops at football_criterions.json — the vector index + doc-views go stale (the build-catalog
// version hash flags it); rebuild them explicitly with `npm run build:index` + `npm run gen:doc-views`.

import { statSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data", "football");

const CATEGORY_URL =
  "https://eu.offering-api.kambicdn.com/offering/v2018/kambi/category/" +
  "combined_layout,combined_layout_us,digital_signage_cards,digital_signage_live," +
  "digital_signage_outrights,digital_signage_prematch,digital_signage_props,ds_pre_match_group," +
  "instant_betting,list_view,list_view_competitions,list_view_us,live_display_groups,live_event," +
  "main_live_bet_offer,main_pre_match_bet_offer,olg_paper_coupons,player_props,pre_match_event," +
  "pre_match_league,pre_rl_landing_pg_playerprops,retail_landing_page,retail_landing_page_outrights," +
  "retail_printout,retail_printout_sandbox,selected_live,top_screen_instant_betting,unibet_default" +
  "/sport/FOOTBALL.json?lang=en_GB";

const CRITERION_URL =
  "https://feeds-eu.offering-api.kambicdn.com/feeds/api/kambi/criterion/sport/FOOTBALL.json";

// curl -f aborts (non-zero exit) on HTTP >= 400 without writing the file, so a dead feed never
// clobbers the committed snapshot. The server returns compact JSON, matching the existing raws.
function fetchTo(file: string, url: string): void {
  const dest = join(DATA, file);
  process.stderr.write(`fetching ${url}\n`);
  execFileSync("curl", ["-fsS", url, "-o", dest], { stdio: ["ignore", "ignore", "inherit"] });
  process.stderr.write(`  wrote data/football/${file} (${statSync(dest).size.toLocaleString()} bytes)\n`);
}

async function main(): Promise<void> {
  fetchTo("football_categories.raw.json", CATEGORY_URL);
  fetchTo("football_criterions.raw.json", CRITERION_URL);

  process.stderr.write(`\n--- build:categories ---\n`);
  execSync("npm run build:categories", { cwd: ROOT, stdio: "inherit" });
  process.stderr.write(`\n--- build:catalog ---\n`);
  execSync("npm run build:catalog", { cwd: ROOT, stdio: "inherit" });

  process.stderr.write(
    `\n✅ feeds refreshed + catalog rebuilt.\n` +
      `   Vector index + doc-views are now STALE — rebuild explicitly when ready:\n` +
      `     npm run build:index   (paid Voyage embeddings)\n` +
      `     npm run gen:doc-views\n`,
  );
}

main().catch((e) => {
  process.stderr.write(`refresh failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
