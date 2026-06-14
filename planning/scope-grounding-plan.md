# Scope Grounding — resolve participants & groups (sport · region · competition · team · player)

## Context

Today the grounder resolves **only** `market_concept` → catalog criterion id(s)
([`ground-market.ts`](../src/resolver/ground-market.ts)); participants and groups are explicitly
**not loaded** ([`catalog.ts:8`](../src/resolver/catalog.ts)). The extractor hands us scope as free
text — `event_scope.teams[]`, `players[]`, `competition`, plus top-level `sport`
([`schema.ts:84`](../src/resolver/schema.ts)) — but nothing turns that text into ids.

The executor needs those ids to fetch events. There are **two Kambi fetch endpoints**:
`/event/group/{groupId}` and `/event/participant/{id}`. So this sprint adds a **scope-grounding
stage** that maps scope text → ids, returning recall-first **candidates + a tier** (never a forced
guess). A separate downstream **LLM disambiguator** settles ambiguity; a thin **`planFetch`** then
emits the concrete fetch plan. The gold schema already anticipates this — `GoldEventScope` wraps
`teams`/`players`/`competition` as `Grounded` cells ([`gold-record.ts:113`](../src/eval/gold-record.ts)).

**Pipeline:** `extractor → grounder (groundScope) → disambiguator (LLM) → planFetch → executor`

---

## Design decisions (settled in interview)

### Resolution model — adaptive cascade
- Order: **`sport → region → competition → participant`**. Resolving one **scopes** the next.
- Anchor precedence: competition named → anchor; else participant named → anchor; else sport/`main`.
- Conflict (participant ∉ named competition, checked via `competitionIds`) → **flag → disambiguator clarifies**.
- Multi-group / multi-candidate → **disambiguator** (picks or asks). **No liveness signal** in the grounder (catalog is a stale snapshot; the LLM owns "which is in-play").

### Group / competition grounding (Q4 + Q9)
- **Pool = participant-referenced whitelist** — only the **303** group nodes referenced by some
  club/player (`competitionIds` ∪ `groupIds` ∪ `countryTeamId`). This drops every noise branch
  (Esports/Marcatore/Enhanced Accas/Z_Sports = 0 referenced) for free, and is **sport-scoped**.
- **Method = lexical-first**, mirroring the market grounder's layered shape:
  `normalize → exact alias → exact name → token/fuzzy (IDF/BM25)` → ranked top-k + tier.
  **No embeddings** (short proper nouns; embeddings blur the `2026`-vs-`2022` tokens we need).
- **Region** = a new **nullable scope field** on `event_scope`/unit, **populated by the extractor**
  (new prompt work — see Code changes; the region hard-scope rests on it). When present, resolve it to
  a **top-level scope branch** — *usually* a country (`Brazil`/`Italy`, already in the whitelist) but
  sometimes a cross-country competition sitting at the same level (`Champions League`, `International
  Friendly Matches`) — and **hard-scope** competition candidates to that branch's subtree → often
  `confident`, **skipping an LLM call**. Absent/ambiguous → fall through to the disambiguator (which
  reads the region word from the raw query).
- **Region carries a routing decision the EXTRACTOR owns, not the grounder.** A country word can be a
  *place* (region) or a *team* (participant); only the extractor's field choice separates them. The
  grounder never disambiguates this — each field resolves against its own, non-overlapping index
  (region → group whitelist, teams → participant index):
  - `"Italy to win the World Cup"` → `teams:["Italy"]` → participant `1000000146`.
  - `"Italian Serie A"` / `"top scorer in Italy"` → `region:"Italy"` → group `1000461745` (parent of Serie A).
  - Genuinely bare phrasings (`"Italy top scorer"`) stay the extractor's call, revisited later by the disambiguator.
- Paraphrase/translation/marker gaps handled by the **alias lexicon** + **marker normalization**
  (`(W) → women`) + the disambiguator's **re-express** — never by embeddings.

### Participant grounding (Q5)
- **Method = lexical/fuzzy**, diacritic-**folded** (reuse `fold()`), **full-name exact → last-name/
  subset fallback**; **no embeddings**. Routed by the extractor's `teams[]` vs `players[]`.
- Data: team names ~unique (1 collision); 97% of player names unique; collisions are mononyms
  (`Juninho`×7); national-team names never clash with clubs.
- **Scoping = hard under a `confident` competition** (restrict the player pool to that competition's
  roster), **soft otherwise** (full pool, boost in-roster); residual collisions → top-k → disambiguator.
- **ntVariant** = `senior_men` default; markers (`U23`, `women`) pick variants via marker-norm.

### Output shape (Q7)
```ts
type ResolvedScope = { sport; competition; region; /* shared time/stage */ units: ScopeUnit[] };
type ScopeUnit     = { teams: EntityResolution[]; players: EntityResolution[]; selectors: GroundedSelector[] };
type EntityResolution = { text: string; tier: "confident"|"variants"|"ambiguous"|"shortlist"|"none";
                          candidates: Candidate[] };  // no `kind`, no `method`
type Candidate = { id; name; score; /* relation meta: clubId?, countryTeamId?, competitionIds?, groupIds?, ntVariant?, sport? */ };
```
- Relation meta rides on each candidate so `planFetch` needs no second lookup.

### Disambiguator contract (Q7) — built downstream, but the grounder must feed it
- **Tier-gated payload**: raw query + **only `ambiguous`/`shortlist` cells** (any type, incl.
  `market_concept`) with their top-k, in **one call**. Confident/variants never sent.
- Caps: **entity ≤ 5**, **market_concept ≤ 10** candidates.
- **≤ 1 re-express → re-ground**, then clarify. (Re-grounding already works — it just re-calls the
  memoized grounder.) **Out of the automated eval gate.**

### planFetch — Model P, participant-preferred (Q6)
```
participant named?
 ├ NO  → group endpoint /event/group/{groupId}
 └ YES → participant endpoint /event/participant/{ids}
         ├ team               → team id(s)
         ├ player + competition-level → player id (outrights)
         └ player + fixture-level     → player's TEAM ids (club/country, narrowed) + player id for outcome filter
   then post-fetch filters: competition(group-tag) · opponent · time · stage · criterion
```
- Team-id narrowing: named teams override; else competition type picks (international→country, club→club);
  else all the player's teams. **No `groupIds` intersection.**

### Scope-unit / multi-fixture (Q8, revised to option (a))
- Unit shape = **Option 2 (self-contained units, `sport` shared)**.
- This sprint: an **adapter wraps the current flat plan into a single unit**; `groundScope`/`planFetch`
  speak `units[]` but always get one. **Extractor's unit/fixture structure unchanged** — the only
  extractor edit this sprint is the new `region` field (see Code changes); the selector↔fixture
  binding that would emit multiple units stays deferred (below).
- **Deferred (tracked prerequisite):** extractor selector↔fixture binding + gold migration → unlocks
  `units.length > 1` (multi-fixture queries). Multi-sport-per-query also out of scope.

---

## New build artifacts (Q10 — Option B: build-time precompute)

A new **`build-scope-index.ts`** (parallel to [`build-catalog.ts`](../src/resolver/build-catalog.ts))
writes a slim, **version-stamped `data/football/scope-index.json`** holding only the fields used:

| Structure | Source | Used by |
|---|---|---|
| Group index (303 whitelist): id → {name, sport, parent, tokens} | `groups.json` ∩ participant refs | competition + region grounding |
| Branch-subtree map: top-level scope branch (country *or* cross-country comp) → descendant comp ids | `groups.json` tree | region hard-scope |
| Team index: folded name → id (+ competitionIds, groupIds, ntVariant) | `participants.clubs` | team grounding |
| Player index: folded full-name → id, folded last-name → id(s) (+ clubId, countryTeamId, competitionIds) | `participants.players` | player grounding |
| Roster map: competitionId → [participantIds] | invert participants' competitionIds + countryTeamId | player hard-scope |

Alias lexicons stay **curated JSON** (new `data/football/scope-aliases.json`: competition aliases like
`EPL→Premier League`, region/country aliases, `(W)→women` markers), merged at load — same pattern as
[`aliases.json`](../data/football/aliases.json).

**Validated against real data (2026-06-14):** roster map is viable — **1295** players carry the WC26 id
(`2010133908`) directly in `competitionIds`; national-team rosters reachable via `countryTeamId`
(2934 players / 116 nations); inverted map ≈ 340 keys / 65k entries.

---

## Code changes (critical files)

- **New** `src/resolver/build-scope-index.ts` — precompute `scope-index.json` (mirror `build-catalog.ts`; pure local join, version hash, no API).
- **New** `src/resolver/scope-catalog.ts` — loader for `scope-index.json` + `scope-aliases.json`, memoized (mirror [`catalog.ts`](../src/resolver/catalog.ts)).
- **New** `src/resolver/lexical.ts` — **extract** the lexical toolkit currently *private* to [`ground-market.ts`](../src/resolver/ground-market.ts) (`idfCover`/`bm25`/`contentTokens`/`corpusStats`/`lexicalCover`) into a shared module, **corpus-parameterized**: `corpusStats` takes the name list to weight over, so the market grounder passes criterion names and the scope grounder passes competition names — same code, correct word-rarity for each (criterion IDF is meaningless for matching competition names). Also lift `fold()` (from `build-catalog.ts`) and re-export `normalize` ([`structural-scorer.ts`](../src/eval/structural-scorer.ts)). `ground-market.ts` switches to importing from here — **no behavior change**, guarded by the existing market gate.
- **New** `src/resolver/ground-scope.ts` — `groundScope()` + `EntityResolution`, the lexical-first cascade with region/competition hard-scope and the participant hard/soft scope. Uses the shared `lexical.ts` (corpus = competition/participant names, **not** the criterion catalog).
- **New** `src/resolver/plan-fetch.ts` — `planFetch()` (Model P matrix) over a settled `ResolvedScope`.
- **Edit** [`schema.ts`](../src/resolver/schema.ts) — add nullable `region` to `EventScope`. (Units restructure stays deferred — the adapter lives in `ground-scope.ts`.)
- **Edit** [`extractor-prompt.md`](../src/resolver/extractor-prompt.md) — populate the new `region` field, **including the country-as-place vs country-as-team routing rule** (`"Italy to win"` → `teams`; `"Italian Serie A"` → `region`). Keep it **sport-agnostic** (a general "split a leading place/adjective off a competition phrase" rule, no hard-coded league names) and done **show-the-diff-and-ask**. This is the upstream dependency the region hard-scope rests on.
- **Edit** [`gold-record.ts`](../src/eval/gold-record.ts) — add a `region` `Grounded` cell; expand [`gold.seed.jsonl`](../src/eval/gold.seed.jsonl) with entity rows + new behavior tags ([`behavior-tags.ts`](../src/eval/behavior-tags.ts)).
- **Edit** structural scorer / [`run.ts`](../src/eval/run.ts) — grade entity grounding (recall@k + confident-precision per entity type).
- **New** `scripts/probe-scope.ts` — validate-early probe (mirror `scripts/probe-misses.ts`).
- **Edit** `package.json` + `scripts/refresh-football-feeds.ts` — add `build:scope` into the refresh pipeline.

---

## Eval & validation (Q11)

- **Deterministic grounder gate** (1× ship gate): **recall@k** (gold id in candidates) + **confident-
  precision** (when `confident`/`variants`, gold id returned), per entity type. **LLM disambiguator
  excluded** (non-deterministic; spot-checked separately). The gate covers the **confident path only** —
  with the disambiguator deferred, an `ambiguous`/`shortlist` scope is never settled, so the
  ambiguous→`planFetch` round-trip is out of the automated gate (optional: a "pick-first" stub
  disambiguator to exercise the wiring end-to-end).
- **Region fed as GIVEN, not extracted, in the gate**: the grounder is graded on `region` supplied by
  the gold row (exactly as market grounding is fed a clean `market_concept`), so a flaky extractor LLM
  can't redden a grounder test. "Does the extractor reliably populate/route `region`?" is a **separate**
  measurement in `scripts/probe-scope.ts`, not the ship gate.
- **Gold expansion** from real WC26 data, covering: competition `confident` (WC26) + `ambiguous`
  (WC26-vs-WC22); region-scoped league (`Italian Serie A`); a **high-collision** name the region cut
  must rescue (`English Premier League` → 1 id out of the **8** `premier league` whitelist nodes);
  mononym player (`Juninho`); nt-variant default; multi-team fixture (Model-P fetch). Competition
  grounding has **0 gold today** → net-new.
- **Validate-early probe first**: run `scripts/probe-scope.ts` over a batch of real queries to confirm
  the whitelist+lexical assumptions, **measure how often each entity type is actually ambiguous**, and
  **check extractor region routing** (place vs team) *before* committing the full grounder (per
  "validate with real data early").

---

## Explicitly deferred / out of scope
- Multi-fixture (`units.length > 1`) — needs the extractor selector↔fixture binding + gold migration.
- `attrFilter.region` player-nationality outcome filter (a separate, later piece).
- The LLM **disambiguator implementation** (separate layer — this sprint builds the contract it consumes).
- Multi-sport per query.

---

## Suggested build sequence
1. `build-scope-index.ts` + `scope-catalog.ts` → `scope-index.json`; wire `build:scope` into `refresh:feeds`.
2. `scripts/probe-scope.ts` — validate-early on real queries (whitelist+lexical, ambiguity rates, region routing). **Gate the rest on this.**
3. `lexical.ts` — extract the shared corpus-parameterized toolkit from `ground-market.ts`; switch `ground-market.ts` to it; confirm the existing market gate is unchanged.
4. `ground-scope.ts` — `groundScope`, `EntityResolution`, lexical-first, region/competition + player hard/soft scope, alias/marker norm, flat-plan→single-unit adapter.
5. `schema.ts` region field + `extractor-prompt.md` region population/routing (sport-agnostic; show-diff-and-ask).
6. `plan-fetch.ts` — Model P.
7. `gold-record.ts` region cell + expand `gold.seed.jsonl` + behavior tags + scorer entity grading.
8. Run the 1× deterministic gate (region fed as given; confident path).

## Verification (end-to-end)
- `npm run build:scope` → `scope-index.json` written, version-stamped, whitelist ≈ 303 groups, roster map non-empty.
- `node scripts/probe-scope.ts` over real queries → prints per-entity recall@k + ambiguity rates + region-routing (place vs team) hit-rate (the early-validation read).
- Unit-level: `groundScope` (region fed as given) on the worked examples returns expected tiers/ids
  (`"World Cup"`→ambiguous {WC26,WC22}; `"Italian Serie A"` region=Italy→confident via subtree hard-scope;
  `"English Premier League"` region=England→confident (1 of 8 `premier league` nodes);
  `"Juninho"` in WC26→confident, bare→ambiguous; `"Brazil"`→`senior_men`).
- `npm run eval` (1×) → entity recall@k + confident-precision green on the expanded gold; market grounding unchanged.
