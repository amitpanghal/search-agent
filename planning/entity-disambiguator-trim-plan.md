# Entity-disambiguator trim — refactor plan

> **Date:** 2026-06-21
> **Depends on:** [live-menu-resolution-theory.md](live-menu-resolution-theory.md) (markets resolve from the live menu *after* fetch).
> **One line:** [disambiguate.ts](../src/resolver/disambiguate.ts) does two jobs — entity resolution and
> market resolution/rewriting. The redesign keeps the entity half (it already is the pre-recall entity gate
> we want) and **deletes the market half**, including the line/subject rewriter.

---

## 1. Why

`disambiguate.ts` today settles both the grounder's non-confident **entities** (region / competition / team /
player / subject-player) **and** its non-confident **markets** (the `market:i` cells, `groundMarket`,
`marketIds`, combos), and it can **rewrite the selector's line and subject** to fit a market it picked
(`applyCorrection`). That rewrite is the exact fragility we're removing: nothing about the market, line, or
subject should be committed before we see live data.

In the new pipeline the market decision moves *after* recall (pick from the live menu), and line/subject become
deterministic SELECT lookups against the real outcomes. So this file should keep only its entity work, which
already does what we want: **deterministic grounder first → LLM only on doubtful tiers → clarify on genuine
collision → recall fetches only confident ids.**

The cut is along the entity/market seam. The two-pass loop, `decide()`, the clarify machinery, and the entity
cells all stay; everything market-shaped comes out. File goes ~490 → ~180 lines.

---

## 2. Pipeline shape (before → after)

```
before:  extract → ground (groundScope + groundMarket) → disambiguate (entities + markets + rewrites) → planFetch → executor
after:   extract → ground (groundScope only)           → resolveEntities (entities only)              → RECALL → filter → resolve(market) → select(line/subject)
```

`resolveEntities` is the renamed, trimmed `disambiguate`. Market resolution + line/subject selection live in
the post-fetch stages of the live-menu design.

---

## 3. Output type shrinks

`SettledScope` loses its three market sidecars:

```ts
// before
export type SettledScope = ResolvedScope & { marketIds: (number[] | null)[]; clarifications: ...; combos: ... };
// after
export type SettledEntities = ResolvedScope & {
  clarifications: { ref: CellRef; question: string; suggest?: number[] }[];
};
```

`ResolvedScope` already carries `region`, `competition`, and `units[].teams / players / subjectPlayers` as
`EntityResolution` cells. After this stage each is collapsed to `confident` (picked) or left non-confident with
a clarification raised. That is the entire output — **no `marketIds`, no `combos`.**

---

## 4. Cell & Decision types lose their market fields

```ts
type CellRef = "region" | "competition" | `team:${number}` | `player:${number}` | `subject:${number}`;
// gone: "market:i"

type Cell = {
  ref: CellRef; text: string; tier: ScopeTier;
  ids: number[]; candidates: { id: number; name: string }[];
  entity: EntityResolution;                 // never null now
  reground: (phrase: string) => EntityResolution;
};                                          // dropped: line, subject, side

type Decision =
  | { ref: CellRef; action: "pick"; id: number }          // dropped: line?, subject? corrections
  | { ref: CellRef; action: "reexpress"; phrase: string } // Pass 1
  | { ref: CellRef; action: "clarify"; question: string; suggest?: number[] }; // Pass 2
```

`zPick` collapses to `{ ref, action:"pick", id }`. The optional `line` / `subject` correction fields (the
rewrite hooks) are removed from the schema.

---

## 5. Trimmed flow

```ts
function buildEntityCells(scope: ResolvedScope): Cell[] {
  const scat = loadScopeCatalog();
  const u = scope.units[0]!;
  const regionBranch = scope.region?.tier === "confident" ? scope.region.candidates[0]!.id : null;
  const compId       = scope.competition?.tier === "confident" ? scope.competition.candidates[0]!.id : null;
  const teamIds      = u.teams.filter(t => t.tier === "confident").flatMap(t => t.candidates.map(c => c.id));

  const cells: Cell[] = [];
  const push = (ref, res, ground) => { if (res && SENT_TIERS.has(res.tier)) cells.push(buildEntityCell(ref, res, ground)); };
  push("region", scope.region, p => groundRegion(p, scat));
  push("competition", scope.competition, p => groundCompetition(p, regionBranch, scat));
  u.teams.forEach((t, i)           => push(`team:${i}`,    t,  p => groundTeam(p, scat)));
  u.players.forEach((pl, i)        => push(`player:${i}`,  pl, p => groundPlayer(p, { compId, teamIds }, scat)));
  u.subjectPlayers.forEach((sp, i) => push(`subject:${i}`, sp, p => groundPlayer(p, { compId, teamIds }, scat)));
  return cells;
}

function settleOutcome(cell: Cell, ids: number[]): Outcome {       // no side/twins, no corrections
  const picked = cell.entity.candidates.filter(c => ids.includes(c.id));
  return { kind: "settle-entity", ref: cell.ref, resolution: { text: cell.text, tier: "confident", candidates: picked } };
}

function applyOutcomes(s: SettledEntities, outcomes: Outcome[]) {  // only two branches left
  for (const o of outcomes) {
    if (o.kind === "settle-entity") setEntity(s, o.ref, o.resolution);
    else s.clarifications.push({ ref: o.ref, question: o.question, ...(o.suggest?.length ? { suggest: o.suggest } : {}) });
  }
}

export async function resolveEntities(query: string, scope: ResolvedScope, decideFn: DecideFn = decide): Promise<SettledEntities> {
  const settled = structuredClone(scope) as SettledEntities;
  settled.clarifications = [];
  const cells = buildEntityCells(scope);
  if (cells.length) applyOutcomes(settled, await runPasses(query, cells, decideFn));
  return settled;                                                 // no marketIds seed, no combos tail
}
```

`runPasses` stays almost verbatim: Pass 1 = pick → settle, or reexpress → reground (now sync, entity-only) →
direct-settle if the re-ground lands `confident`/`variants`, else ride to Pass 2; Pass 2 = pick or clarify on
evidence; bad/undecided → fallback clarify, never a silent guess. Only `settleOutcome` changes (no
corrections).

---

## 6. Delete list

| Symbol(s) | Reason |
|---|---|
| `buildMarketCell`, `marketCandidates`, `marketOpts`, `groundScopeMarkets` | market cells gone |
| `groundMarketRelevel`, `FLIP`, `isSolidGrounding` | event-grain relevel was market-only |
| `applyCorrection`, `isScopeTeam`, the price-echo guard | **the line/subject rewriter** — replaced by SELECT |
| `sideTwins` import + the `side` per-twin expansion in `settleOutcome` | per-side market twins, post-fetch now |
| `assembleCombos` import, `combos`, the combos tail of `disambiguate` | combos resolve from the live menu |
| `marketIds` field + its seeding | markets resolved post-fetch |
| `loadCatalog` import + all of ground-market: `groundMarket`, `GroundResult`, `GroundOpts`, `sideTwins`, `assembleCombos` | file no longer touches the market catalog |
| `markets: GroundResult[]` param | `disambiguate(query, scope, markets)` → `resolveEntities(query, scope)` |
| `isMarketRef`, `mIdx` | no market refs |
| `zPick.line`, `zPick.subject`, `TeamSubjectCorrection`, `SelLineCorrection` | correction schema removed |

Keep: `buildEntityCell`, `pushEntity` pattern, `SENT_TIERS`, `ENTITY_CAP`, `SUGGEST_CAP`, `decide()`, the
Pass1/Pass2 schemas, `runPasses`, `setEntity`, `defaultQuestion`, the ground-scope imports + `scope-catalog`.

---

## 7. Siblings that shrink with it

- **planFetch** ([plan-fetch.ts](../src/resolver/plan-fetch.ts)) drops `criterion`, `outcomes`, `combos`,
  `playerOutcomeIds` (all market / line / subject filters move post-fetch). It becomes "pick endpoint + ids
  from the confident entities." Its `unsettled` / `clarifications` carry-forward stays.
- **disambiguator-prompt.md** ([src/resolver/disambiguator-prompt.md](../src/resolver/disambiguator-prompt.md))
  — keep the entity pick / reexpress / clarify rules; delete the market-selection, line re-typing, and
  subject re-bind rules.
- **eval replay** — `decide()` and the injectable `DecideFn` stay, so captured-decision replay still works;
  fixtures that asserted `marketIds` move to the post-fetch market tests.

---

## 8. Open / sequencing

1. This trim is **subtractive** and can land before the post-fetch market stages exist, as long as a temporary
   shim provides the market ids recall→executor needs (or the cut lands together with the live-menu resolve).
2. **Index freshness** (separate axis): the entity grounder reads a build-time `scope-index.json` snapshot of
   groups⋈participants. Keep it fresh against the live feed so the candidate set doesn't drift; out of scope
   for this trim but tracked.
3. Rename `disambiguate.ts` → `resolve-entities.ts`? Optional; keep the filename if it reduces churn, rename
   the export only.
