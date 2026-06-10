# Resolve-queries prompt — Sprint 6 (the extractor / Haiku layer)

> ⚠️ **You probably don't need this — "resolve as it currently does" already exists as code.**
> `scripts/extractor-ground-probe.ts` calls the **real** `extract()` (Haiku `claude-haiku-4-5-20251001`,
> temp 0, forced-tool JSON) for any uncached query and **auto-writes** the result to
> `tier1-extractor-cache.json` ([lines 86–91, 113](../../scripts/extractor-ground-probe.ts)). That is the
> faithful, reproducible path:
>
> 1. Save your generated queries to `data/football/tier1-extractor-queries.json` **under a `"queries"` key**:
>    `{ "queries": [ {"id":…, "q":"…"}, … ] }` — the bare array from the gen step won't load (the probe reads
>    `.queries`).
> 2. `npx tsx scripts/extractor-ground-probe.ts` → resolves the new queries via Haiku (the paid step),
>    caches them, grounds the `market_concept`s, and reports the score in one run.
>
> A hand-pasted prompt **diverges from production** (different model snapshot / temperature / no forced-tool
> validation), which shifts the `market_concept` distribution and undermines the eval. Use the version below
> **only** for an offline/portable spot-check, and run it on the exact snapshot at temperature 0.

## If you still want the paste version

The extractor's system prompt is **`src/resolver/extractor-prompt.md`** (live, ~350 lines, edited often —
**don't retype it; paste it from source** so it can't drift). Use it verbatim as the **system message**, then
add this chat adaptation as the only extra instruction:

````
You normally emit the plan through the emit_query_plan tool. In this chat there is no tool, so output the
plan as JSON directly.

INPUT: a JSON array of { "id": <number>, "q": "<query>" }.
For EACH item, build the query plan for "q" exactly as the rules above specify.

OUTPUT: a single JSON object mapping each query string q -> its plan, and nothing else:
{
  "<q>": { "status": ..., "event_scope": { ... }, "selectors": [ ... ] },
  ...
}
- Omit any absent optional selector leaf (line / odds / attrFilter) entirely — never null, never {}.
- No prose, no markdown fences — only the JSON object (so it saves straight to tier1-extractor-cache.json).
````

### Worked example (matches the real cache shape)

Input:
```
[{ "id": 1001159922, "q": "Germany to win or draw their game" }]
```
Output:
```
{
  "Germany to win or draw their game": {
    "status": "resolved",
    "event_scope": { "level": "fixture" },
    "selectors": [
      { "subject": { "kind": "team", "name": "Germany" }, "market_concept": "to win or draw" }
    ]
  }
}
```

Run on **`claude-haiku-4-5-20251001`, temperature 0** to stay closest to production. The grounder consumes
`market_concept`, `subject.kind`/`name`, `line`, and `event_scope.level` — make sure those are present.
