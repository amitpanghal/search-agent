# Intent Resolver — Architecture Handoff

> Greenfield design for a natural-language **intent resolver** over a Kambi sports-betting
> catalog. This document is self-contained: it assumes zero prior context and can be acted on
> directly. Treat the existing repository setup as **out of scope** — this is a clean-sheet design,
> though the data facts below were measured against the real catalog and are authoritative.

## Context

We are designing a system that turns a messy natural-language search query (e.g. *"Portugal vs
Brazil quarterfinal with Bruno Fernandes corner markets, Vitinha shots on target over 0.5, and
team total goals over 1.5"*) into a **grounded, structured query plan** against a sportsbook
catalog. The starting framing was "three datasets (Category, Betoffer, Criterion) with mappings —
what tech stack stores them for fast retrieval?" That framing was wrong in two ways: (1) the data
is tiny, so **storage is never the bottleneck**; (2) real queries touch far more than three
datasets. The actual problem is **fuzzy NL → correct catalog ids**, i.e. an intent-resolution /
entity-grounding problem, not a database problem.

## Goals

- **Short term:** Resolve a single raw query into a grounded query plan — `{sport, event_scope, selectors[]}` —
  where every facet is mapped to concrete catalog ids or typed predicates, scoped to the inferred sport,
  and **every market is bound to its owning subject**. Facets: market/criterion, team, player (with
  lineup **role**), competition, **event level** (fixture vs competition), **stage**, **time**,
  participant attributes (**position, region, age**), **line**, **odds**.
  _Updated: plan shape made concrete this session — subject taxonomy, `attrFilter`, `event_scope.players`
  roles, `level`, stage/time; added `sport`, `age`, and lineup `role` to the facet list._
- **Longer term:** Drive a real sportsbook search box: high precision (showing the *wrong* market or
  *wrong* player is costly with money on the line), graceful handling of compound multi-subject
  queries, and maintainable enrichment for facets the catalog can't answer alone.

## Key decisions made

_Updated: #6 and #7 revised against data re-measured this session; decisions 11–16 added to specify the
extractor schema designed this session._

1. **The hard problem is fuzzy NL matching, not storage.** Data is a few MB total (see facts below);
   any substrate is fast enough. Engineering effort goes to matching quality, not to a DB.
2. **Input = raw, multi-facet natural-language query.** One string blends market + period + line +
   team + player at once → a real extraction step is unavoidable.
3. **Architecture = two stages: LLM extracts → retrieval grounds.** Extraction (split text into typed
   facets) is an LLM strength and a retrieval weakness; grounding (map a clean facet to a fixed,
   tiny vocabulary) is a retrieval strength and an LLM overkill/non-determinism risk. Keep them split.
4. **Criterion is the join hub.** Criterion names already encode period/occurrence
   (`"3-Way Handicap - 1st Half"`) and already carry `categoryNames[]` + `boTypeNames[]`. Category and
   betoffertype are labels hanging off the criterion. So the "three-dataset relation" is a **star with
   criterion at the center**, not a symmetric graph — no graph DB needed.
5. **Market grounding = hybrid: curated aliases + semantic vectors.** Aliases cover the head
   (deterministic, auditable); vectors cover the long tail of novel phrasings; the extraction LLM
   breaks ties. Betting vocab is finite, so this is tractable.
6. **Event / stage / time / lineup is a SEPARATE live layer.** "quarterfinal", "opener", "group games",
   "first week", "late kick-offs" need real fixtures + kickoff times + round metadata — dynamic and
   non-cacheable. It must NOT live in the static index; it is computed at query time against a live
   fixtures feed. Concrete query-time vocabulary this layer must resolve:
   - **stage**: `GROUP_STAGE, ROUND_OF_16, QUARTERFINAL, SEMIFINAL, FINAL`, plus `KNOCKOUT` (superset).
     Two wrinkles — **subject-relative** ("Spain opener", "Netherlands group opener", "Argentina's semi"
     = *that team's* match at that stage) and **conditional** ("if it happens in the knockouts", "if they
     reach it", "the final whoever's in it") → never fabricate; resolve only if the bracket slot exists,
     and return tournament futures even when participants are TBD.
   - **time**: two sub-kinds — **date_window** ("first week", "this week", "opening weekend", "next 48
     hours") and **kickoff_time_of_day** ("late kick-offs"); each with an **anchor**: tournament-relative
     ("first week", "opening weekend") vs now-relative ("next 48 hours", "this week").
   - **lineup roles**: `starts` / `captain` (see #13) need the team sheet, which publishes ~1h before
     kickoff; **degrade to `plays`** + a caveat note when unavailable.
   _Updated: enumerated the concrete stage/time/lineup vocabulary the live layer must resolve
   (subject-relative + conditional stages, date-window vs kickoff-time, degrade-to-plays)._
7. **Facets the catalog lacks are solved by enrichment — but region and position have very different
   costs.** Re-measured this session (see facts): player **position**, player **age/DOB**, and team
   **region** are all absent from the catalog. They split into two tiers:
   - **Region (confederation) = a tiny hand-kept static table.** All three in-catalog derivation paths
     fail (NT `groupIds` stripped to the Football root; no continent level in the group tree;
     `competitionIds`∩WC-qualifiers resolves only 43/110 NTs). So region is **typed in once** — ~48 rows
     for WC 26, keyed by Kambi NT id → confederation. Player region = `countryTeamId → NT → table`.
     Cheap, static, never stale.
   - **Position + age = the single genuinely expensive dependency** — an external roster/positions feed
     (per-player, squad-dependent) joined to Kambi player ids. This is the real id-matching job.
   (Rejected: scope-cutting these; LLM world-knowledge expansion — stale rosters + hallucination,
   unacceptable with money on the line.)
   _Updated: split the old single "enrichment" decision — region is a trivial static table (catalog
   derivation disproved this session), and only position + age are the expensive external feed; added age._
8. **Entity (team/player) grounding = lexical/fuzzy + context disambiguation, NOT semantic vectors.**
   Proper nouns have no useful semantic neighborhood — "Mbappé" and "Haaland" embed *close* (both
   strikers) but must never be confused. Use trigram/phonetic + nickname aliases for candidates, then
   disambiguate with other facets in the same query (`countryTeamId`/`clubId`/`competitionIds`). The
   LLM resolves coreference ("his team"). The store therefore has **two indexes with opposite
   philosophies**: semantic (vectors) for markets, lexical (trigram) for names.
9. **Output = grounded query plan + a separate executor.** Resolver emits `{event_scope, selectors[]}`
   and stops; a distinct executor resolves `event_scope` via the live layer, fetches betoffers, and
   applies selectors + numeric filters. Keeps the static store out of live I/O; plans are cacheable
   and unit-testable. (Rejected: resolver executes inline; flat ids with the join pushed to callers.)
10. **Runtime = single long-lived service.** Substrate = **one SQLite file** (relation tables + FTS5
    for alias/lexical + precomputed embedding blobs) built offline and **loaded into in-memory maps at
    boot**. Vector search = **exact brute-force cosine** at query time — at a few thousand vectors this
    is sub-millisecond, so **no ANN index / vector DB / graph DB / server DB is required**. SQLite is a
    build artifact and inspection format, not a performance play.
11. **The extractor's output IS the plan skeleton, text-valued — never ids.** _New this session._
    A single LLM call emits `{sport, event_scope, selectors[]}` with free-text values (`market_concept`,
    entity names); retrieval grounding maps text→ids *in place* downstream. Subject↔market binding is
    decided **inside the LLM call** — binding is language understanding (an LLM strength, a retrieval
    weakness), so it must not be deferred to deterministic grounding.
12. **Selector subject is a four-way discriminated union: `{player | team | either_match_team | event}`.**
    _New this session._ This is the make-or-break (compound subject-binding). `either_match_team` is its
    **own kind**, not eagerly fanned out into two `team` selectors (keeps the "which side?" ambiguity
    honest for the executor / a clarify). Default binding rule: *nearest preceding named subject owns the
    market; a market with no owner is `event`-level; a generic "team" market with ≥2 match teams in scope
    is `either_match_team`.* **Coreference** ("his shots", "his team") is resolved at extraction and
    emitted as a **concrete** subject — never a `"his"` pointer; in WC context "his team" → the player's
    **national team** (`countryTeamId` anchor), not his club.
13. **A player that *scopes* the event is a separate axis from a player that *owns* a market.**
    _New this session._ `event_scope.players: [{ name, role: plays | starts | captain }]` filters *which
    fixtures* ("featuring Mbappé" = `plays`, "Bellingham starting" = `starts`, "Bruno Fernandes is
    captain" = `captain`) — distinct from `selector.subject = player`, and the same name can fill both
    roles in one query. The extractor **always records the stated role faithfully**; the **degrade to
    `plays` + caveat** (when the team sheet isn't published yet) happens at execution, not extraction.
14. **Participant attributes (position / region / age) are an outcome attribute-filter, not a subject
    kind.** _New this session._ `attrFilter { position?, region?, ageMin?, ageMax? }` sits beside `odds`
    on a selector and filters the **outcomes within a betoffer** ("Golden Boot for midfielders",
    "European nations under 6.0", "anyone under 23"). Reason: these markets are *one* betoffer with many
    participant outcomes — the predicate filters outcomes exactly like `odds` does; a `participant_set`
    *subject* would wrongly conflate "pick betoffers" with "filter outcomes". `attrFilter` applies
    wherever a market lists many participants — both **competition-level** (Golden Boot / outright) and
    **fixture-level** ("anytime scorer for strikers"). Pairs with **`event_scope.level: fixture |
    competition`** to mark tournament-wide futures vs match markets.
15. **Numeric typing is line vs odds, settled by one universal rule — plausibility is resolved against
    real markets, not the prompt.** _New this session._ The same word ("over"/"under") does two different
    jobs: on a **line** it picks the outcome side (`{ line, direction: over|under|yes|no }`); on **odds**
    it bounds the price (`{ min?, max? }`). One sport-agnostic rule decides which: *a number tied to a
    counted thing is a line; a bare number — or one with "priced/odds" — is a price.* Genuinely ambiguous
    numbers ("assists above 4.0" vs "aces over 4.5") are resolved **downstream against the actually-
    offered markets** ("is there a real over/under line at 4?"), never by memorising plausibility in the
    prompt. **Age** does not appear here — it routes to `attrFilter` (#14). A line phrase with **no
    number** ("passes completed over/under") names the market and returns all offered lines.
16. **The extractor prompt stays bounded.** _New this session — a hard constraint set by the user; see
    Constraints._ Only **universal, sport-agnostic reasoning** lives in the prompt (subject binding, the
    line/odds/age structural rule, coreference). Discipline for anything you're tempted to add: a
    genuinely **new way of reading** → prompt (rare); **another instance** of an existing rule → the
    **golden eval set**, not the prompt; a **sport fact / plausibility range** → the **catalog / real
    markets**, never the prompt. Combined with "infer sport first" (load only the active sport's slice),
    this keeps the prompt **flat as sports are added** — what grows is the catalog (data) and the eval
    set (tests).

17. **Sport inference = an output field of the single extraction call, verified against grounding.**
    _New this session — resolves the former "sport-inference mechanism" open question._
    - **Placement.** `sport` is a field the *single* text-valued extraction call emits (decision 11) from
      world knowledge — no pre-pass, no second model. "Infer sport first" means **grounding** scopes to
      that emitted label, not that a separate stage runs first.
    - **Prompt stays flat by construction.** The text-valued boundary bars sport *vocab* from the prompt
      (markets/entities → catalog; plausibility → real markets; coverage examples → eval set). Per-sport
      prompt **fragments** are a documented escape hatch — *not built* until an eval failure proves a
      universal rule can't be reformulated as an eval instance. Only *per-call* size must stay bounded;
      the total body of knowledge may grow.
    - **Cardinality.** `sport` is **scalar**; a multi-sport query routes to the ambiguity path (below),
      never silently reduced to a dominant sport. (Fan-out to N single-sport plans = deferred.)
    - **Value space.** Closed enum = the `sport` keys on the **group-tree's top-level nodes** (see data
      facts), minus non-sports, restricted to **built partitions** (today: only `FOOTBALL`). Emitted
      directly via structured output (no free string, no normalisation); the key doubles as the **root of
      that sport's competition subtree**.
    - **Abstention (D1).** Can't-resolve → **abstain + clarify**, never a guessed sport — with two
      refinements: a **sole-built-sport default** (a sport-*silent* query resolves to the only built sport,
      since the answer is then unique — but a query that *names* a different sport does not), and
      **explicit-enum sentinels** `ambiguous` (multi / torn) vs `unsupported` (recognised but not built),
      kept distinct because they drive different clarify UX. No numeric confidence.
    - **Robustness = trust-but-verify.** The LLM emits `sport` open-loop; grounding proceeds scoped to it;
      **grounding hit-rate is the verifier/tie-breaker — the catalog breaks ties, never prompt-encoded
      signal priorities.** Hit-rate is measured **only over the groundable facets actually present** (a
      query with no proper nouns rests on competition + market vocab). Low hit-rate → abstain now;
      **re-route** to a re-inferred sport once ≥2 partitions exist (paid only on failure).
    - **Boundary.** All of this lives in the **resolver** (emit in extraction, verify in grounding); the
      emitted plan carries a confirmed-or-sentinel `sport`; the **executor never re-infers**.

18. **The extractor's Zod schema — the concrete encoding of decisions 11–17.** _New this session._
    The single extraction call returns this `QueryPlan`. Two encoding rules run through it: a
    **discriminated union** wherever variants are *mutually exclusive* (plan `status`, `subject.kind`,
    `line` numeric-vs-binary), and a **flat object + `.refine` guards** wherever fields are *orthogonal
    and co-occur* (`odds`, `attrFilter`, `stage`, `time`). Values that are **data** stay **text**, grounded
    downstream (`market_concept`, entity names, `attrFilter.position/region`, `stage.round`, time
    windows/dayparts); values that are **universal classification** are **enums the LLM emits**
    (`subject.kind`, `line.direction`, `stage.ordinal`, `date_window.anchor`, `level`, player `role`).

    ```ts
    // BUILT_SPORTS is generated at startup from groups.json (decision 17) — today ['FOOTBALL'] as const.
    const Subject = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('player'),            name: z.string().min(1) }),
      z.object({ kind: z.literal('team'),              name: z.string().min(1) }),
      z.object({ kind: z.literal('either_match_team') }),   // bare — teams come from event_scope
      z.object({ kind: z.literal('event') }),               // bare — whole-match / no named owner
    ]);
    const Line = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('numeric'), value: z.number(), direction: z.enum(['over','under']) }),
      z.object({ kind: z.literal('binary'),                     direction: z.enum(['yes','no'])    }),
    ]);  // omitted entirely = "all offered lines"
    const Odds = z.object({ min: z.number().positive().optional(), max: z.number().positive().optional() })
      .refine(o => o.min !== undefined || o.max !== undefined, 'need ≥1 bound')
      .refine(o => o.min === undefined || o.max === undefined || o.min <= o.max, 'min ≤ max');
    const AttrFilter = z.object({
      position: z.string().min(1).optional(), region: z.string().min(1).optional(),
      ageMin: z.number().int().positive().optional(), ageMax: z.number().int().positive().optional(),
    })  // age bounds INCLUSIVE; extractor normalises ("under 23" → ageMax:22)
      .refine(a => a.position || a.region || a.ageMin != null || a.ageMax != null, 'need ≥1 predicate')
      .refine(a => a.ageMin == null || a.ageMax == null || a.ageMin <= a.ageMax, 'ageMin ≤ ageMax');
    const Selector = z.object({
      subject: Subject, market_concept: z.string().min(1),
      line: Line.optional(), odds: Odds.optional(), attrFilter: AttrFilter.optional(),
    });
    const Stage = z.object({
      round: z.string().min(1).nullable(), ordinal: z.enum(['first','last']).nullable(), conditional: z.boolean(),
    }).refine(s => s.round !== null || s.ordinal !== null, 'stage needs a round or an ordinal');
    const Time = z.object({
      date_window: z.object({ value: z.string().min(1), anchor: z.enum(['tournament','now']) }).nullable(),
      kickoff_time_of_day: z.string().min(1).nullable(),
    }).refine(t => t.date_window !== null || t.kickoff_time_of_day !== null, 'need a window or a kickoff band');
    const EventScope = z.object({
      teams: z.array(z.string().min(1)),
      players: z.array(z.object({ name: z.string().min(1), role: z.enum(['plays','starts','captain']) })),
      competition: z.string().min(1).nullable(), level: z.enum(['fixture','competition']),
      stage: Stage.nullable(), time: Time.nullable(),
    });
    const QueryPlan = z.discriminatedUnion('status', [
      z.object({ status: z.literal('resolved'), sport: z.enum(BUILT_SPORTS),
                 event_scope: EventScope, selectors: z.array(Selector).min(1) }),
      z.object({ status: z.literal('ambiguous'),   candidates:   z.array(z.enum(BUILT_SPORTS)).min(2) }),
      z.object({ status: z.literal('unsupported'), recognizedAs: z.string().nullable() }),
    ]);
    ```

    Consequences worth keeping in view: a sentinel `status` can never be used as a scoping `sport`, and
    **no `event_scope`/`selectors` exist unless `status==='resolved'`** — grounding can't run on an
    unconfirmed sport. `conditional` lives **inside `stage`** (folded from a top-level field);
    `either_match_team`/`event` are **bare** tags; an unnamed participant *set* ("strikers", "European
    nations") is **not** a subject — it's `event` + `attrFilter` (decision 14). `line.numeric` and `odds`
    co-occur (a side *and* a price); `round`/window/daypart stay **text** because resolving them needs the
    live layer's calendar/bracket. _Open: structured-output backends compile discriminated unions to
    `anyOf` — eval the model's branch adherence once >1 is live (sport stays single-branch until a 2nd
    partition is built)._

19. **Extraction model = Claude Haiku — and the bounded prompt + text-valued schema are now drafted
    against it.** _New this session (2026-06-01, prompt-drafting) — resolves the previously-uncaptured
    "which model runs extraction"._ The single extraction call (decision 11) runs on **Haiku**, the
    cheapest tier that supports structured output. This is affordable *because* the architecture offloads
    everything hard to deterministic layers (grounding, the live layer, the eval) — the LLM is left only
    the **universal, sport-agnostic reasoning** a small model can do reliably (subject binding, coref, the
    line/odds/age structural rule, sport inference). The prompt lives at `src/resolver/extractor-prompt.md`;
    the text-valued `QueryPlan` it emits into (decision 18 with every groundable leaf as a plain string —
    the twin of `src/eval/gold-record.ts` minus its `Grounded` wrappers) lives at `src/resolver/schema.ts`.
    - **Bounded-prompt (decision 16) is load-bearing, not just tidy.** A small model has less headroom, so
      "only universal reasoning" is what *keeps it accurate* — the model choice and the constraint
      reinforce each other; both push sport facts → catalog and coverage → eval set.
    - **Procedural shape.** The prompt is a 3-step procedure (decide sport/status → scope event → extract
      selectors), each discriminated-union's branches named inline, because Haiku follows an explicit step
      order far better than a wall of principles.
    - **Examples allowed — but only as fixed, OFF-corpus rule-illustrations.** Haiku is materially better
      at binding/coref with one canonical example per rule; read as compatible with decision 16 (which
      bars *reactive per-query patching*, not a flat illustration set that stays flat as sports are added).
      **Hard sub-rule: a prompt example must never reuse an eval query, entity, or market** — e.g. "shots
      on target over 0.5" is g001's Vitinha selector, so seeding it would leak the graded answer and blind
      that eval row. The drafted prompt illustrates every rule on **off-catalog** markets (tackles,
      interceptions, win-to-nil) for exactly this reason.
    (Rejected: a larger extraction model — unnecessary once the hard work is deterministic, and costlier
    per call on a high-volume search box. Revisit only if the structural eval shows Haiku can't hold a
    well-stated universal rule — which is also the trigger for a per-sport prompt fragment, decision 17.)

## Golden eval set — design & grading

_New this session (2026-06-01). The query corpus lives under "Representative queries" below; this section
is **how that corpus is encoded, graded, and gated**. It fleshes out plan step 1 and is the concrete eval
home that decision 16 promised for rule-*instances*. Headline scope choice: the set grades the resolver
**through grounding** (query → grounded plan with real catalog ids), **not** the extractor's text in
isolation — because "right market" is only meaningful post-grounding (an accept-set of surface strings is
just a shadow alias table, and "shots on goal" vs "shots on target" can't be told apart on text alone)._

**E1. Gold labels carry real catalog ids, not just text.** A query is graded on what it *grounds to*
(criterion / player / team / competition ids), so the harness runs the resolver through grounding.
Consequence (accepted with eyes open): the set is **authorable now** (ids hand-looked-up) but only
**runs** once grounding exists (plan step 3) → eval and grounding co-depend; eval no longer strictly
precedes grounding. A failure can't *by itself* say whether extraction or grounding broke — reclaimed in E4.

**E2. Hybrid id-coverage — id where the catalog can answer, text/enum otherwise.** By **id**: market
(criterion/boType), team/player, competition, region. By **text/label**: round/stage, time window,
lineup role, participant **position/age** — their ids come from the **live layer** or the
**not-yet-built roster feed**, so resolving them is the executor's job, out of golden scope. By **exact
match**: the structural/enum fields (subject.kind + binding, line-vs-odds typing + values, `level`,
`status`, `sport`). (Rejected: freeze a fixtures+roster snapshot to id-grade *everything* — turns this
into an executor/roster test + snapshot upkeep; rejected: drop the non-id facets — guts the corpus,
since nearly every query names a round or a time.)

**E3. Selectors are paired by market, order-independent, scored on three separate axes.** Align each
predicted selector to the gold selector with the same market id (never positionally); then report, as
distinct numbers: (a) **markets found** (precision/recall over markets), (b) **binding** (right owner),
(c) **line/odds** correctness. A subject↔market **swap** therefore reads as "found the markets, mis-bound
them" — the make-or-break (binding) stays legible. (Rejected: pair on subject+market jointly — a swap then
looks identical to missing both; rejected: positional compare — reordering tanks a correct answer.)

**E4. Failure reports retain the AI's raw text plan** so a fail localises to **extraction** (wrong words)
vs **grounding** (good words, mis-mapped to an id). Human triage at this corpus size; automate attribution
later if failures pile up. (The cheap reclaim of the "which part broke?" signal E1 otherwise loses.)

**E5. Verdict = strict pass on the *costly* facets + per-facet diagnostics.** A query **passes** only if
every costly facet is exact: market id, the owner it's bound to, line side+value, and sport. The per-axis
numbers from E3 are kept for tracking *how close* a fail was but don't earn a pass. A **wrong** answer is
weighed worse than a **missing** one (precision ≫ recall — money on the line). (Rejected: a single
partial-credit score — hides a wrong-bet under a healthy average; rejected: whole-plan exact match —
fails on a harmless wording gap, no gradient.)

**E6. Abstain/sentinel cases are in the set — three buckets reachable today.** (i) **no sport named →
resolve to FOOTBALL** (sole-built default), e.g. "Golden Boot markets, players priced 5.0–15.0"; (ii)
**names an unbuilt sport → `unsupported`** (recognizedAs text, graded loosely), e.g. "Djokovic vs Alcaraz
total games over 22.5"; (iii) **football mixed with an unbuilt sport → `unsupported` now** — don't
silently drop the other half or fake a plan — **flips to `ambiguous` once a 2nd sport is built**. The
`ambiguous` "torn between two **built** sports" case can't occur with one partition (its `candidates`
need ≥2 built sports) → documented, not run. Graded on the `status` enum (+ recognizedAs text). _Pins a
case the doc had left open (the built+unbuilt mix)._ **Gap:** the current corpus is all resolvable
football — these abstain cases must be **added**.

**E7. Coverage is organised by behavior tags, not surface shapes.** Each query is **multi-tagged** with
the behaviors it stresses (~15: `binding`, `coref-his`, `coref-his-team`, `line-vs-price`,
`line-no-number`, `attrFilter`, `player-role`, `level`, `stage`, `time`, `abstain`, `either-team`,
`yes/no-line`, `odds-only-bounds`, `self-correction`, `age-normalize`). Target **~5 queries per
behavior**; report **pass-rate per behavior**; fill thin spots with targeted queries; **~50–70 total**.
This is the concrete home decision 16 promised: rule-*instances* live here, the prompt stays bounded.
(Rejected: the doc's surface-shape groups — they don't map to what can break; rejected: an untagged
diverse pile — can't prove coverage or spot a blind spot.)

**E8. Authoring: human writes the text plan, fills ids from a *neutral* catalog search, second pass
re-checks ids.** The id helper is a **plain name-search** over the catalog files (substring/fuzzy),
**not the grounder under test** — else the key inherits the grounder's errors and the test goes blind to
them (no self-grading). Ties broken by query context; a second pass re-checks id cells. Only id cells need
lookup; text/enum/structure cells are typed in. (Rejected: hand-grep JSON — slow, typo-prone, no second
eyes; rejected: draft-with-the-AI-then-edit — circular, anchors the human on model output, can't start
pre-grounder.)

**E9. Gold record mirrors the `QueryPlan`; every groundable cell = `{ id, accept[] }`.** Plus top-level
`tags[]` and `expect.status`. Reads like a plan, diffs cleanly against AI output, scorer walks it
directly. **One JSONL file.** `accept[]` (surface-form variants) is **diagnostic-only for now** (triage +
the future text-fidelity layer); the **id** is the grading source of truth. (Rejected: a flat assertion
list — schema-churn-proof but less legible; rejected: one-file-per-query — unwieldy at 50–70, coverage
hard to scan.)

**E10. Reproducibility: temperature 0, run each query 5×, pass only if all 5 pass.** Consistency *is*
correctness — a market right 4/5 times is a **fail** (a 1-in-5 wrong bet is unshippable). Per-query
pass-rate is reported so flakiness is visible; even at temp 0 outputs aren't bit-identical, so repetition
surfaces residual nondeterminism. Cadence: **1 run per change, 5 before release** (~300 calls/full run —
cheap). (Rejected: single run — hides flakiness; rejected: majority vote — blesses "wrong 40% of the time".)

**E11. Stamp + validate ids on load.** The gold file carries the **schema version + catalog version** it
was authored against; at eval start every gold id is checked against the loaded catalog. A missing id →
**"stale gold — re-author"**, that cell **skipped, never an AI failure** — so a catalog rebuild can't make
a stale key masquerade as a regression. (Kambi ids are stable for entities that still exist; the rot risk
is add/remove, which this catches. Rejected: no versioning — rebuild noise drowns real regressions;
rejected: freeze a catalog snapshot as the *only* source — then you test against a stale catalog and miss
"AI breaks on new markets" — though a pinned snapshot may still be added for CI repeatability.)

**E12. Tiered ship gate.** **Critical** behaviors (market-id, binding, line direction+value, sport,
correct abstain) must be **100%**; **soft** behaviors (stage/time wording, optional-facet recall) sit on
an **aggregate bar (~90%)**. One critical miss **blocks release**; soft misses are tracked. Exact
percentages are calibratable against a baseline; the *principle* (critical = 100, soft = aggregate) is
fixed. (Rejected: a single overall threshold — a critical failure hides under the average; rejected: no
gate — not auditable, indefensible with money on the line.)

**Authoring rules (write down, not forks):**
- **Coreference → concrete subject.** Gold records the resolved subject, never a pointer: "his shots" →
  that player's id; "his team" → the **national-team** id (`countryTeamId` anchor in WC context), not the club.
- **Self-correction → final intent only.** For query 418 ("Haaland-less Norway out — sorry, with Modrić…"),
  gold = the **corrected** plan (Modrić / Croatia); the retracted entity never appears.
- **`accept[]` is diagnostic-only now** — author the obvious surface variants; the set's correctness isn't
  load-bearing on `accept[]` for pass/fail until the text-fidelity layer exists (see Open questions).

## Open questions / unresolved (deliberately deferred)

_Updated: roster-provider item narrowed to position + age; live-layer spec expanded; sport-inference +
conditional semantics + line/odds resolution stage + fixture-level `attrFilter` added._
_Updated this session: the sport-inference item is **resolved** → see decision 17 (removed from this list)._
_Updated (2026-06-01): folded two findings from authoring the eval seed records — groundable **id-sets** and the **player-bound team market**._

- **Embedding model: local vs API.** Tradeoff is host-a-model vs a network hop; both fine. Leaning
  local (e.g. bge-small / gte-small via ONNX) for a long-lived service. Must use the **same model at
  build time and query time**.
- **Position + age roster provider + id-matching.** Which external source for player **position and
  age/DOB**, and how to match Kambi player id ↔ provider player id. This is the single genuinely
  expensive dependency — decide deliberately. (Region is *not* part of this — it's the static table in #7.)
  _Updated: narrowed to position + age; region removed (now a static table)._
- **Sync cadence.** Nightly rebuild vs change-webhook for the static artifact.
- **SQLite as runtime store vs pure build format.** Current lean: load it into RAM at boot rather than
  query SQLite live.
- **Live-layer semantics spec.** Exact definitions must be written down or they will drift. Concrete
  checklist now: the stage enum incl. **subject-relative** openers ("Spain opener") and **conditional**
  slots ("if they reach it", "whoever's in it"); time **date_window vs kickoff_time_of_day** and the
  **tournament- vs now-relative** anchor; and the **lineup-role degrade** rule.
  _Updated: expanded into the concrete vocabulary surfaced this session (see #6)._
- **Where line-vs-odds ambiguity is resolved.** _New._ Static catalog (does this criterion support
  over/under at all?) vs the live betoffer fetch (is line *N* actually offered?). Pin the stage.
- **`attrFilter` id-resolution at fixture level.** _New._ Resolving "strikers" / "European" to a
  player/team **id set** is clear for competition futures; confirm the same filter applies to
  fixture-level player outcomes ("anytime scorer for strikers") and where that join happens.
- **Text-fidelity grading layer (eval).** _New._ `accept[]` surface-form variants are diagnostic-only
  today (E9); decide if/when text fidelity on the non-id facets (round, time window, role) earns its own
  pass/fail axis rather than just informing triage.
- **Automate extraction-vs-grounding failure attribution (eval).** _New._ Today a failure is triaged by
  hand against the retained raw text plan (E4); if failures pile up, build the rule that auto-localises a
  fail to wrong-words (extraction) vs good-words-mis-mapped (grounding).
- **Gold rule for an entity with no catalog id (eval).** _New._ E1 grades to real ids; pin what a gold
  cell records when a named player/team legitimately has **no** catalog id (skip vs text-only vs expect
  `unsupported`) so authoring isn't blocked on a missing entity.
- **Groundable cells can resolve to an id *set*, not a single id (eval + grounding).** _New._ Authoring
  seed record g001 showed "team total goals" (`either_match_team`) grounds to the **home+away split
  criteria** `{Total Goals by Home Team 1001159967, Total Goals by Away Team 1001159633}` — the catalog
  has no side-agnostic team-total. E9 specified a single-id `{id, accept[]}` gold cell; the seed schema
  widened it to `id: number | number[]` (same shape as the `attrFilter`→participant **id set** above).
  Confirm the representation (widen `id` vs add a separate `ids[]`) and that grounding emits the set the
  executor then fans out.
- **Player subject bound to a team-only market (extraction/grounding).** _New._ "Bruno Fernandes corner
  markets" (seed g001) binds a `player` subject to **Total Corners**, a team/match market — no
  player-corner criterion exists. The gold keeps the **stated** binding (faithful to the canonical
  `Bruno↔corners`), leaving "can it filter to the player?" to the executor. Pin whether faithful-keep is
  always the rule, or whether some markets should **reject** a player owner (caveat vs drop vs `unsupported`).

## Plan / next steps (ordered, concrete)

_Updated: step 1's Zod schema written this session (decision 18); steps 2–4, 6–7 refined for the region
table / position+age feed / live-layer vocab._

1. **Finalise the extractor schema + bounded prompt + eval set.** The **Zod schema is written**
   (decision 18 — the concrete encoding of decisions 11–17: status-discriminated `QueryPlan`, four-way
   subject union, line numeric-vs-binary union, guarded `odds`/`attrFilter`, `event_scope` with
   roles/level/stage/time). Remaining: author the **bounded** prompt (decision 16) and **expand the
   golden eval set** with this session's query corpus — subject-binding, numeric-typing, `attrFilter`,
   stage/time, lineup-role, and conditional cases are the make-or-break. _Updated: Zod schema completed
   this session (decision 18); only the prompt + eval set remain._ _Updated (2026-06-01): the golden
   eval-set **design** is now settled (decisions E1–E12 in "Golden eval set — design & grading"): grade
   through grounding to real ids, hybrid id/text coverage, per-market selector scoring with binding as
   its own axis, strict pass on costly facets, behavior-tag coverage, a tiered ship gate. Remaining work:
   author ~50–70 behavior-tagged gold records (including the abstain cases E6 flags as missing) and build
   the scorer. The eval **co-depends on step 3** — it's authorable now but only runs once grounding exists._
   _Updated (2026-06-01, prompt-drafting): the **bounded prompt is drafted** (`src/resolver/extractor-prompt.md`,
   decision 19) and the **text-valued extractor schema written** (`src/resolver/schema.ts`); extraction runs on
   **Haiku**. Refinement to the eval co-dependency: only the **id-graded** axes wait for grounding — the
   **structural/enum axes** (E2: `status`, `sport`, `subject.kind`, line-vs-odds typing+values, `level`,
   `role`, age-normalize, attrFilter routing, plus binding & market matched by *text* against `accept[]`)
   are gradeable on the **raw extractor output now**, so the prompt can be iterated against a structural
   eval **before** grounding exists. Remaining: bootstrap that structural eval (needs `package.json` + zod +
   the Anthropic SDK), expand the corpus toward ~5/tag, and build the full post-grounding scorer._
2. **Build the static-store build pipeline** — pull Kambi catalog per sport (criterions, categories,
   betoffertypes, participants, groups) → join enrichment → embed criterion/category names → build
   alias/nickname tables → write a **versioned SQLite artifact**. Add: the **~48-row region table**
   (NT id → confederation) and the **position + age roster join** to Kambi player ids.
   _Updated: added the region table + position/age roster join as build inputs._
3. **Implement grounding (in-memory, scoped to inferred sport):** market star via vectors+alias (exact
   cosine); entities via trigram+alias+context disambiguation; competitions via tree lookup; enrichment
   tables for position/region/age. Add: resolve `attrFilter` predicates → participant **id sets**, and
   settle the **line-vs-odds** ambiguity against actually-offered markets.
   _Updated: added attrFilter id-resolution + line/odds resolution + age._
4. **Decide + integrate the position + age roster provider** and the Kambi-id↔provider-id matching job.
   (Region needs no provider — it's the static table.) _Updated: narrowed to position + age._
5. **Implement disambiguation** — an LLM call that fires *only* on collisions (homonyms / vector tie
   clusters), with output ids **constrained to the retrieved candidate set**.
6. **Define the resolver output schema** — the grounded query plan is now the **status-discriminated
   `QueryPlan`** of decision 18: `resolved → { sport, event_scope{ teams, players[{name,role}],
   competition, level, stage{round,ordinal,conditional}, time }, selectors[{ subject, market_concept,
   line?, odds?, attrFilter? }] }`, else `ambiguous` / `unsupported`.
   _Updated: encoded as Zod this session (decision 18); `conditional` folded into `stage`._
7. **Build the executor + the live-event-layer contract** — `event_scope` → event ids (fixtures feed),
   with `stage` / `time` / `conditional` / lineup-`role` predicates computed there (decision 6); fetch
   betoffers (batched); apply selectors + `attrFilter` + line/odds filters; apply the **degrade-to-`plays`**
   fallback + caveat. _Updated: added conditional / role / attrFilter handling + degrade rule._
8. **Wire end-to-end and eval** against the golden set.

## Constraints & assumptions (do not re-litigate)

_Updated: added the bounded-prompt constraint and the region-is-static fact; added the Haiku
extraction-model constraint (decision 19)._

- **Greenfield.** Ignore any existing repo wiring; design clean.
- **Data is tiny** (a few MB across all sports) and fits in RAM. No scale/perf justification exists for a
  vector DB, graph DB, or server DB.
- **Money is on the line** → bias to **determinism and auditability**; never surface a hallucinated or
  semantically-fuzzed player/market.
- **Cross-sport shape:** betoffertype is **universal** (~28, ids 1–128 + specials, one table); criterion,
  category, and participants are **per-sport** → partition by sport and **infer sport first** so all
  grounding is scoped (precision + speed).
- **Live state + fixtures are non-cacheable** → must be a separate query-time layer.
- **Single long-lived service** is the runtime target.
- **The extractor prompt stays bounded** (decision 16): only universal, sport-agnostic reasoning in the
  prompt; sport facts → catalog, coverage → eval set; partition by sport at runtime so the prompt never
  holds more than one sport's slice. This is a hard constraint — do **not** "fix" failing queries by
  piling rules/examples into the prompt.
- **Extraction runs on Haiku** (decision 19): the cheapest structured-output tier is sufficient *because*
  the LLM only does universal reasoning — everything hard is deterministic. Do not push sport facts or
  plausibility into the prompt to compensate for the small model; that is what the catalog, the live
  layer, and the eval are for. Prompt examples must stay **off-corpus** (never an eval query/entity/market).
- **Region is a static hand-kept table**, not derived and not a feed (catalog derivation disproved this
  session); only position + age are an external dependency.

### Authoritative data facts (measured, football)

_Updated: re-measured region derivability this session — all in-catalog paths fail; age confirmed absent._

| Dataset | Count | Cross-sport? | Record shape |
|---|---|---|---|
| BetOfferType | ~28 | **Universal** | `{id, label}` |
| Criterion | 607 | per-sport | `{id, sport, name, shownInLive, shownInPreMatch, categoryNames[], boTypeNames[]}` |
| Category (BetOfferCategory) | 64 (1,399 mappings) | per-sport | `{id, name, mappings:[{criterionId, boType, boTypeName}]}` |
| Clubs | 1,784 | per-sport | `{id, kind, sport, name, competitionIds[], groupIds[], ntVariant}` |
| Players | 32,587 | per-sport | `{id, kind, sport, name, clubId, competitionIds[], countryTeamId}` |
| Groups | hierarchical forest | per-sport | `{id, name, sport, groups[]}` |

- **Sports are the top-level group nodes (measured this session).** The group forest is rooted at a
  universal node (`id 1, sport NOT-SPECIFIED`); its **direct children are the sports**, each
  `{id, name, sport, groups[]}` — e.g. `FOOTBALL → id 1000093190, "Football", 270 competition children`.
  ∴ the **sport enum = the `sport` field on those root children** (real: `FOOTBALL, ESPORTS,
  OLYMPIC_GAMES`; filter out non-sports `SPECIAL_BETS, NON_SPORT, NOT-SPECIFIED`), and each sport key is
  the **root of its competition subtree**. Only the **`FOOTBALL` partition is built** today. (Drives #17.)
- **No `position`/`role`, no `nationality`/`continent`** anywhere in player or club records → position
  (and age) need the external roster feed; region needs the static table (#7).
- `clubId` / `countryTeamId` / `competitionIds` **are** present → enough to disambiguate player homonyms
  by context and to resolve "his team".
- **Region is not catalog-derivable (measured this session).** National-team participants carry
  `groupIds: [Football root]` only (their region groupId was stripped); the group tree is **flat** —
  countries sit directly under "Football" with **no continent/confederation ancestor** (confederations
  appear only as *tournament* node names like "CONCACAF" / "World Cup Qualifying - Europe"); and
  `competitionIds`∩{6 WC-qualifier comps} resolves only **43/110** senior NTs (Spain, Argentina, Germany,
  Australia → none). ∴ region = the static table (#7).
- **No `age`/DOB** on any player record → age ("under 23/25") requires the roster feed, alongside position.
- **`countryTeamId` is the player→region hop**: `player.countryTeamId → NT → region table`. `clubId` vs
  `countryTeamId` is the dual anchor that "his team" coreference resolves through (NT in WC context).

### Grounding axes (derived from real queries)

_Updated: added axis 6 (participant attributes via enrichment + the static region table)._

1. **Market semantics** (criterion/category/betoffertype) — static, fixed vocab → alias + vectors.
2. **Teams & players** — high-cardinality, semi-static → trigram/alias + context disambiguation.
3. **Competitions / groups** — hierarchical → tree navigation.
4. **Event structure & time** (stage, kickoff window) — **dynamic** → live event layer, computed at query time.
5. **Numeric predicates** (lines, odds) — extracted params, post-fetch filters → **no store**.
6. **Participant attributes** (player position, player age, team region) — **enrichment**: position/age
   from an external roster feed, region from the ~48-row static table → resolved to participant **id sets**
   that drive `attrFilter`.

### Representative queries (golden eval set)

_Updated: expanded with this session's query corpus (subject-binding, numeric typing, `attrFilter`,
stage/time, lineup-role, and conditional cases)._
_Updated (2026-06-01): how this corpus is **encoded, graded, and gated** now lives in "Golden eval set —
design & grading" (E1–E12). Each query will be **multi-tagged** by the behaviors it stresses (E7), and
**abstain cases must be added** — every query below is resolvable football, so the no-sport, unbuilt-sport,
and football+unbuilt-mix buckets (E6) are not yet represented._

**Seed set (original):**

1. Portugal vs Brazil quarterfinal with Bruno Fernandes corner markets, Vitinha shots on target over 0.5, and team total goals over 1.5
2. Spain opener with Lamine Yamal markets, passes completed over/under, and any outside-the-box goal specials
3. USA group games with Pulisic shot markets, set piece specials, and corner totals above 9.5
4. All WC 26 matches in the first week with over 2.5 goals markets priced above 1.80
5. Netherlands group opener with Van Dijk aerial duels won markets, clean sheet odds, and Gakpo anytime scorer
6. Outright winner odds with European nations under 6.0
7. Most cards in tournament markets with defenders priced above 8.0
8. Any WC 26 match featuring Mbappé with his shots on target markets over 2.5 and team to score first odds
9. Every Yamal appearance in WC 26 with shot markets, dribbles completed over 3.5, and his team match result odds
10. Every Spain fixture with passing-related player props and possession over 60% markets
11. Late kick-offs at WC 26 with over 3.5 goals markets, anytime scorer for strikers, and clean sheet odds under 3.0

**Expanded set (this session) — grouped by the shape they stress:**

*Event + market + player filter:*
- Show me the Brazil vs Argentina group stage match with all Vinicius Jr shot markets and anytime goalscorer odds above 2.0
- Find me England's Round of 16 fixture with Bellingham player props and assist markets over 1.5
- Pull up France vs Germany if it happens in the knockouts with Mbappé shots on target markets and first goalscorer odds
- Give me the Spain opener with Lamine Yamal markets, passes completed over/under, and any outside-the-box goal specials
- Do we have the USA group games with Pulisic shot markets, set piece specials, and corner totals above 9.5

*Competition + timebound filters:*
- Show me all WC 26 matches in the first week with over 2.5 goals markets priced above 1.80
- Find every group stage game on opening weekend with both teams to score and player card markets
- Pull up all quarterfinal fixtures with Golden Boot updated odds and top assist markets
- Give me knockout round matches in the last 16 with extra time specials and penalty shootout markets
- List WC 26 fixtures this week with anytime goalscorer markets for players priced under 3.0

*Layered event + multiple market types:*
- Find me the Portugal vs Brazil quarterfinal with Bruno Fernandes corner markets, Vitinha shots on target over 0.5, and team total goals over 1.5
- Show the Netherlands group opener with Van Dijk aerial duels won markets, clean sheet odds, and Gakpo anytime scorer
- Pull up Argentina's semi if they reach it with Messi assist markets, Lautaro shots over 2.5, and match result + both teams to score
- Give me the final whoever's in it with first goalscorer odds, total cards over 4.5, and goal in stoppage time specials

*Tournament-wide markets with filters:*
- Show me Golden Boot markets with players priced between 5.0 and 15.0
- Find top assist tournament markets filtered to midfielders only
- Pull up outright winner odds with European nations under 6.0
- Give me Player of the Tournament markets for anyone under 23
- Do we have most cards in tournament markets with defenders priced above 8.0

*Mixed event + player + threshold filters:*
- Find any WC 26 match featuring Mbappé with his shots on target markets over 2.5 and team to score first odds
- Show all games with Bellingham starting and his passes completed over 40 plus anytime scorer markets
- Pull up matches with Modrić in the lineup and his assist markets above 4.0 (in-query self-correction: "Haaland-less Norway out — sorry, with Modrić…")
- Give me every Yamal appearance in WC 26 with shot markets, dribbles completed over 3.5, and his team match result odds
- List fixtures where Bruno Fernandes is captain with his free kick specials and shots on target over 1.5

*Casual layered discovery:*
- I want WC 26 knockout fixtures with goalscorer markets for forwards under 25 and first half goals over 0.5
- Can you show me group stage matches involving CONMEBOL teams with corner markets above 10.5 and red card specials
- Give me upcoming WC 26 games in the next 48 hours with player shot markets and BTTS odds over 1.90
- Pull together every Spain fixture with passing-related player props and possession over 60% markets
- Find me late kick-offs at WC 26 with over 3.5 goals markets, anytime scorer for strikers, and clean sheet odds under 3.0

## Glossary / key terms

_Updated: refined `Selector` + `Enrichment`; added terms for the extractor schema designed this session._

- **Resolver** — the system being designed: raw query → grounded query plan. Does NOT execute.
- **Extraction** — LLM stage: raw text → typed, subject-bound facets + inferred sport.
- **Grounding** — mapping a clean facet to concrete catalog ids (or filter sets).
- **Criterion** — the descriptive market definition; the **join hub** of the market star.
- **BetOfferType / Betoffer** — the market *type* (~28, universal, ids 1–128).
- **Category (BetOfferCategory)** — per-sport grouping of (criterion, boType) mappings.
- **Market star** — criterion at center, with category + betoffertype as attached labels.
- **Selector** — one `{subject, market_concept, line?, odds?, attrFilter?}` unit in the plan (decision 18);
  `subject ∈ {player | team | either_match_team | event}`; `line` = `numeric{value,over/under}` | `binary{yes/no}`.
- **Subject-binding** — attaching each market to its owning subject (Bruno↔corners, Vitinha↔SOT).
- **either_match_team** — selector subject for a generic "team" market when ≥2 match teams are in scope and
  no side is named; kept as its own kind, not fanned out into one selector per side.
- **attrFilter** — outcome attribute-filter `{position, region, age}` on a selector; filters participant
  outcomes *within* a betoffer (peer of `odds`), at fixture or competition level.
- **event_scope.players / role** — players that scope *which fixtures* (`plays | starts | captain`),
  distinct from a market subject; `starts`/`captain` **degrade to `plays`** + caveat when no team sheet.
- **level** — `fixture` vs `competition` (tournament-wide futures); a field on `event_scope`.
- **stage** — tournament round (`GROUP_STAGE … FINAL`, `KNOCKOUT`); may be **subject-relative**
  ("Spain opener") or **conditional** ("if they reach it", "whoever's in it").
- **time facets** — `date_window` vs `kickoff_time_of_day`, each tournament- or now-relative.
- **line vs odds** — line = threshold on a counted stat (`{line, direction}`); odds = price bound
  (`{min, max}`); decided by one universal rule, with plausibility resolved against real markets.
- **region table** — ~48-row static NT-id → confederation lookup (replaces failed catalog derivation).
- **bounded prompt** — the constraint that only universal, sport-agnostic reasoning lives in the extractor prompt.
- **sport enum / sentinels** — closed `sport` value space = the group-tree top-level `sport` keys, built
  partitions only; sentinels `ambiguous` / `unsupported` carry abstention (decision 17).
- **trust-but-verify** — sport-inference robustness: emit `sport` open-loop, confirm via grounding
  hit-rate over *present* facets; low hit-rate → abstain now / re-route once multi-sport (decision 17).
- **sole-built-sport default** — a sport-silent query resolves to the only built sport (unique answer);
  lapses once ≥2 partitions exist (decision 17).
- **Context disambiguation** — resolving a homonym entity using other facets in the same query.
- **Grounded query plan** — resolver output (decision 18): status-discriminated; `resolved` carries `{sport, event_scope{teams,players,competition,level,stage,time}, selectors[]}`.
- **Executor** — separate component that runs the plan: resolves events via the live layer, fetches betoffers, applies filters.
- **Live event layer** — query-time access to fixtures/round/kickoff/lineup metadata; owns stage, time, and lineup roles.
- **Enrichment** — data joined to Kambi ids for facets the catalog lacks: an external **position + age**
  roster feed, and the static **region table** (NT id → confederation).
- **Static store** — SQLite artifact (relations + FTS5 + embedding blobs), loaded into RAM at boot.
- **gold record** — one labelled eval row mirroring the `QueryPlan` shape (E9): top-level `tags[]` +
  `expect.status`, every groundable cell `{ id, accept[] }`; the scorer diffs AI output against it.
- **behavior tag** — a label for a tricky behavior a query stresses (`binding`, `coref-his`,
  `line-no-number`, `abstain`, …); coverage and pass-rate are tracked per tag, ~5 queries each (E7).
- **accept[] / accept-text** — surface-form variants on a gold cell; **diagnostic-only** today (triage +
  the future text-fidelity layer), the **id** is the grading source of truth (E9).
- **strict pass** — a query passes only if **every costly facet** is exact (market id, binding/owner, line
  side+value, sport); the per-axis closeness numbers track *how near* a fail was but don't earn a pass (E5).
- **ship gate** — the tiered release bar (E12): **critical** behaviors must be **100%**, **soft** behaviors
  sit on a **~90% aggregate**; one critical miss blocks release.
- **stale gold** — a gold id that no longer resolves against the loaded catalog; that cell is **skipped**
  and flagged "re-author", **never** counted as an AI failure (E11).

## Archived / superseded

_Items explicitly dropped or replaced this session — kept here in case they're worth revisiting._

- **`either_match_team` eager fan-out** (split a generic "team" market into one selector per match side at
  extraction) → *superseded* by a distinct subject kind (decision 12); fan-out baked in a "both sides"
  assumption the user may not mean.
- **`participant_set` as a subject kind** (treat "midfielders" / "European nations" as the selector's
  subject) → *superseded* by the `attrFilter` outcome-filter model (decision 14).
- **Region via group membership / group-tree walk / WC-qualifier `competitionIds`** → *disproved* against
  real data (NT groupIds stripped; flat tree; 43/110 qualifier coverage). Replaced by the static region
  table (#7).
- **Region as "expensive external enrichment"** (old single #7 framing) → *superseded*: region is a trivial
  static table; only position + age are the external feed.
- **Line-vs-odds via a growing set of prompt rules/examples** → *superseded* by one universal rule +
  downstream resolution against real markets, under the bounded-prompt constraint (decisions 15–16).

---

**Resume prompt:** *"Resuming the greenfield Kambi intent-resolver design — read
docs/architecture.md for full context. Architecture settled (LLM-extract → retrieval-ground →
grounded plan → separate executor; single long-lived service over an in-memory SQLite artifact). The
**extractor Zod schema is written** (decision 18 — status-discriminated `QueryPlan`; four-way subject
union; `line` numeric-vs-binary union; guarded `odds`/`attrFilter`; `event_scope` with `players` roles,
fixture-vs-competition `level`, and `stage`/`time`; sport sentinels; built-partition sport enum generated
from groups.json) — it encodes decisions 11–17. The **golden eval-set design is also settled** (decisions
E1–E12: grade through grounding to real catalog ids; hybrid id/text coverage; selectors paired by market
with binding scored as its own axis; strict pass on the costly facets; behavior-tag coverage ~5 each over
~50–70 queries; reproduce at temp 0 ×5; tiered ship gate, critical = 100%). The **bounded prompt is now
drafted** (`src/resolver/extractor-prompt.md`, decision 19) and the **text-valued extractor schema written**
(`src/resolver/schema.ts`); **extraction runs on Haiku**. **Next: bootstrap a structural eval** — the
no-grounding axes (status / sport / subject.kind / line-vs-odds typing+values / level / role / attrFilter,
plus binding & market matched by text against `accept[]`) are gradeable on raw extractor output *now*,
ahead of grounding — then **author the behavior-tagged gold records** (≈50–70, including the abstain cases
E6 flags as still missing) and **build the full scorer** (id-graded axes run once grounding exists, step
3). Region is a static ~48-row table; only position + age need the roster feed."*
