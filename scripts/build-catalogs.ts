// build-catalogs.ts — fetch the offering tree once, then build every sport's catalog into
// catalogData/<slug>-scope-index.json. Per-sport intermediates land in .catalog-build/ and are
// deleted after that sport builds; groups.json is kept, so a single-sport rebuild can reuse it.
//
//   npx tsx scripts/build-catalogs.ts            → every sport in the tree (the daily job)
//   npx tsx scripts/build-catalogs.ts baseball   → just one (reuses the kept groups.json)
//   npx tsx scripts/build-catalogs.ts --fresh    → force a fresh groups.json first
//
// Nothing is excluded at the catalog level: a thin subtree just yields a thin catalog, and live
// queries return nothing because the API has nothing. Sports needing individual/NT/tour handling
// are tuned via SPORT_OVERRIDES in sports.ts; everything else builds as a team sport, NT off.
//
// ponytail: shells the existing fetch/normalize/build scripts per sport — simplest, reuses them as-is.
// It's a daily batch, so sequential + tsx-startup cost is fine; import them in-process if speed matters.

import { execFileSync } from "node:child_process";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { GROUPS_PATH, BUILD_DIR, allSportConfigs, getSport, type SportConfig } from "../src/resolver/sports";

const NORMALIZER = "scripts/football/refactor_participants.py";
const sh = (cmd: string, args: string[], capture = false): string =>
  execFileSync(cmd, args, capture ? { encoding: "utf8" } : { stdio: "inherit" }) ?? "";

function buildOne(cfg: SportConfig): { teams: number; players: number } {
  const raw = join(BUILD_DIR, `${cfg.slug}_participants_raw.json`);
  const norm = join(BUILD_DIR, cfg.participantsFile);

  sh("npx", ["tsx", "scripts/fetch-participants.ts", cfg.slug]);

  const nArgs = ["--sport-label", cfg.label, "--sport-slug", cfg.slug, "--groups", GROUPS_PATH, "--participants", raw, "--out", norm];
  if (cfg.individual) nArgs.push("--individual");
  if (cfg.nationalTeams) nArgs.push("--national-teams");
  sh("python3", [NORMALIZER, ...nArgs]);

  const out = sh("npx", ["tsx", "src/resolver/build-scope-index.ts", cfg.slug], true);
  process.stdout.write(out);

  // Cleanup on success only (a throw above skips this, leaving the evidence). Keep groups.json;
  // drop this sport's raw + normalized feeds and any tour feeds.
  const tourFeeds = Object.values(cfg.tourFeeds ?? {}).map((code) => join(BUILD_DIR, `${code}_participants.json`));
  for (const f of [raw, norm, ...tourFeeds]) rmSync(f, { force: true });

  const m = out.match(/teams=(\d+).*?players=(\d+)/s);
  return { teams: Number(m?.[1] ?? 0), players: Number(m?.[2] ?? 0) };
}

function main(): void {
  const arg = process.argv[2];
  const only = arg && !arg.startsWith("-") ? arg : undefined;
  const fresh = process.argv.includes("--fresh");

  // Full run always fetches a fresh tree; single-sport reuses the kept one unless --fresh (or none exists).
  if (!only || fresh || !existsSync(GROUPS_PATH)) sh("npx", ["tsx", "scripts/fetch-groups.ts"]);

  const configs = only ? [getSport(only)].filter((c): c is SportConfig => !!c) : allSportConfigs();
  if (only && !configs.length) throw new Error(`Unknown sport "${only}" — not a top-level node in the offering tree.`);

  const summary: string[] = [];
  for (const cfg of configs) {
    try {
      const { teams, players } = buildOne(cfg);
      summary.push(`ok    ${cfg.slug.padEnd(22)} teams=${String(teams).padStart(6)} players=${String(players).padStart(7)}`);
    } catch (e) {
      summary.push(`FAIL  ${cfg.slug.padEnd(22)} ${(e as Error).message.split("\n")[0]} (intermediates kept)`);
    }
  }
  console.log(`\n=== build-catalogs: ${configs.length} sport(s) ===\n${summary.join("\n")}`);
  console.log(`review deltas: git diff --stat catalogData/`);
}

main();
