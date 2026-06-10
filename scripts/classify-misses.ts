// Reason breakdown over the captured misses (/tmp/miss-evidence.json). Reuses the shared tagger in
// miss-reasons.ts. Prints reason counts over the rank>8 misses + the per-query shallow band (rank 9–32).

import { readFileSync } from "node:fs";
import { type Miss, classify, topName } from "./miss-reasons";

const data = JSON.parse(readFileSync("/tmp/miss-evidence.json", "utf8")) as Miss[];

const rgt8 = data.filter((m) => m.rank > 8 && Number.isFinite(m.rank));
const shallow = data.filter((m) => m.rank > 8 && m.rank <= 32);

const byReason = new Map<string, { fix: string; shallow: number; deep: number }>();
for (const m of rgt8) {
  const { reason, fix } = classify(m);
  const e = byReason.get(reason) ?? { fix, shallow: 0, deep: 0 };
  if (m.rank <= 32) e.shallow++; else e.deep++;
  byReason.set(reason, e);
}

console.log(`\n=== Reason breakdown of the ${rgt8.length} reachable-but-rank>8 misses (shallow 9–32 | deep >32) ===\n`);
for (const [reason, e] of [...byReason].sort((a, b) => b[1].shallow + b[1].deep - (a[1].shallow + a[1].deep))) {
  console.log(`• ${e.shallow + e.deep}  (${e.shallow} shallow / ${e.deep} deep) — ${reason}`);
  console.log(`     fix: ${e.fix}\n`);
}

console.log(`\n=== Shallow band (rank 9–32), ${shallow.length} queries ===\n`);
for (const m of shallow.sort((a, b) => a.rank - b.rank)) {
  console.log(`[r${m.rank}] "${m.q}"  →  ${m.gold}  |  top: ${topName(m)}\n   why: ${classify(m).reason}\n`);
}
