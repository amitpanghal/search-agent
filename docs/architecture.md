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
   _Updated (decision 20): among **same-vocabulary collisions** (one phrase, many near-identical
   criterion names), tie-breaking is no longer "the extraction LLM" — it's a **deterministic chain
   inside grounding** (subject pre-filter → cosine → facet-boost → tier). The LLM's only input is the
   `subject.kind` it already emits at extraction (decision 12); irreducible ambiguity is surfaced to
   the executor to clarify, never guessed (E5)._
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

20. **Same-vocabulary market collisions are resolved by a deterministic pipeline — subject pre-filter →
    cosine → facet-boost → tier — not by a reranker or an LLM tie-break.** _New this session (2026-06-03)._
    The collision: a market phrase ("shots on target") sits in **38** criterion names, so raw cosine alone
    ranks the wrong one (a per-player pre-baked row, or the match-total `1001159926` vs the side-split pair).
    Decision 5 left tie-breaking to "the extraction LLM"; this replaces that with a deterministic chain that
    stays inside grounding. Eight stages — **1–3 build-time** (catalog), **4–8 query-time**:
    1. **Rebuild the catalog by joining the raw criterion feed ⋈ the category feed**, carrying **full
       multi-category membership** + boTypes per criterion, and **version-stamp** it (E11). Load-bearing
       because the committed snapshot was **trimmed** (see data facts): its criterions list held **598** ids
       while category mappings referenced **1151**, so **553 criterions — including g001's target
       `2100015085` "Player Shots on Target" — were invisible to grounding pre-rebuild**. **Now built**
       (Stage A, catalog `0f2aac930df9`); the target grounds, subject `player`. *(prerequisite)*
    2. **Tag each criterion's subject** from category membership: **in any player-meaning category →
       `player`; else `team_or_match`** (player wins on overlap). Player-meaning = the 10 `Player*`
       categories **plus four prefix-less ones** verified to name player markets — `Goal Scorer` ("To
       Score"/first/last scorer), `Either Player`, `Man of the Match`, `Goalkeeper Saves` — **except**
       explicit team-side rows ("… - Home Team"/"- Away Team", the 2 mixed `Goalkeeper Saves` rows) which
       demote back to `team_or_match`. The strict `Player*` prefix alone mislabels 13 real player markets;
       the curated set + demotion gets all 15 edge cases right (player = **705** post-quarantine on the full
       feed). This is the catalog-native signal (the categories were built off these mappings), not a name-parse.
    3. **Quarantine per-player pre-baked criterions** at build time via participant-name match, so the
       ~32.5k-player explosion ("*Mbappé* shots on target" rows) never enters the vector index. Guarded
       against common-word player names (open item). *(The earlier `*`-prefix hypothesis was disproved —
       only 1/5647 raw names carried it — so participant-name match is the route.)*
    4. **Hard pre-filter candidates to the query's `subject.kind`** (decision 12) before any cosine. This —
       not category — is the load-bearing cut: a `player` query never sees team/match criterions, nor v.v.
    5. **Cosine the market text against criterion names *within the subject bucket*** (decision 5's vector
       tail, now scoped). Category does no further narrowing once subject has filtered; it stays only as the
       subject-tag source (2) and as corroboration in the core test (7).
    6. **Facet-boost the survivors.** **`line → boType` is a HARD gate** (a counted over/under line can only
       ground a criterion that offers an over/under boType; a yes/no can't ground an over/under-only one).
       **Period mismatch is a SOFT penalty** (a query saying "first half" down-ranks a full-match candidate).
       **Presentation/settlement-source facets are neither gated nor penalized** — `(Settled using Opta
       data)`, alternate-line labels — they don't change *which market* it is.
    7. **Tier the result rather than force one id.** Build each survivor's **stat-type core** = name minus
       the subject prefix minus a finite **non-semantic suffix strip-list** (settlement-source + alternate-
       line presentation **only** — *not* period or extra-time, which are semantic), corroborated by a
       shared stat-type category. Then: **one clear winner → `confident`**; **several sharing a core →
       `variants`** (same market, different settlement/line/side — incl. the home/away **side-split pair**
       `{1001159967,1001159633}` g001 wants); **otherwise → `ambiguous`** (the default when the core test is
       inconclusive). A bare "corners" with both a full-match and a 1st-half criterion surviving tiers
       **`ambiguous`** (distinct cores) → clarify the period, never a silent pick.
    8. **The executor owns policy** (decision 9): it silently uses/offers a `variants` set (filtering the
       live betoffer response by both ids), and **clarifies** on `ambiguous`. Grounding never guesses (E5).

    The grounder therefore returns **`{ ids[], tier, score?, candidates? }`** — a `tier` discriminator added
    beside today's `method` on `GroundResult`, an extension not a rewrite. (Rejected: **categories as a
    second narrowing filter** — redundant once subject pre-filters; they add nothing for the seeds.
    Rejected: a **cross-encoder rerank** — deferred; the deterministic chain resolves the seed collisions
    with no new model dependency, and precision is served by abstain/clarify (E5), not a sharper ranker;
    revisit only if a real collision survives all four deterministic stages. Rejected: a **suffix-penalty
    that prefers the "modern"/"canonical" criterion** — E8 gold-fitting: there is **no recency/version
    field**, and `shownInLive` shows the *suffixed* `1002035662` is the **more** featured row, so "prefer the
    bare name" is reverse-engineered from the answer key; return both as `variants` and let the executor
    filter live. Rejected: an **LLM disambiguation call on collisions** (old plan step 5) — superseded; the
    LLM already emits `subject.kind`, consumed deterministically, with no second model call in the hot path.)
    **Still uncalibrated / open** (none blocks the build; each fails safe — worked examples in Open
    questions): the **cosine threshold + near-tie epsilon**, the **non-semantic suffix strip-list**, and the
    **participant-name common-word guard**.

21. **A generic (unnamed) player market is a nameless `player` subject — not `event` — bound by a per-player-line test.** _New this session (2026-06-05)._ Resolves **KE-6** — a generic "player shots" / "player props" emitted `subject {kind: player}` with no name, which the schema rejected. Design locked this session; the schema + prompt edits are **pending**.
    - **`player.name` becomes optional.** A player-owned market carries `player` with a `name` when one is specified ("Mbappé shots") and `player` **with no name** when generic ("player shots"). The nameless form keeps the **player bucket** — the load-bearing precision cut (decision 20 step 4). Measured this session: "shots" grounds `confident` to `Player's shots` in-bucket, but as `event` (both buckets, `bucketFor`→null) it degrades to a `variants` set leaking `Kubo total shots` / `Shots Handicap`, and "passing" surfaces the *team* `Most Passes Completed` first — so routing the generic case to `event` (the obvious fix) is the *worse* one. Backward-compatible: every named-player gold (g001–g003) still validates; **grounding is unchanged** — `bucketFor`/`exactNameIds` key off `subject.kind`, never the name.
    - **The binding test is per-player-line, not surface wording.** *Does each player get their own line/price → `player` (name optional); is there one outcome for the whole match/tournament → `event` + `attrFilter`.* This root-causes the crash — Haiku was swinging on the literal word "player" ("anytime scorer" → `event`, "player shots" → `player`) — with one **sport-agnostic** rule (decision 16-safe, no example-stuffing). Consequence: per-match scorer markets ("goalscorer", "anytime scorer") **flip** from `event` to nameless `player` (+attr); intended (keeps the bucket), with a required re-probe to confirm they still ground (To Score / Goal Scorer in the player bucket).
    - **Scoped to fixture per-player stats; awards stay `event` — an amendment to decision 14.** "Single outcome → event" carves out tournament awards/outrights (Golden Boot, Player of the Tournament, top goalscorer, Golden Glove) **without naming them**; they remain `event` + `attrFilter`, low-collision and already grounding right. Decision 14 said an unnamed participant set *defined by a predicate* ("strikers") is `event` + attrFilter; decision 21 amends that for the player case — a generic *per-player line* (predicate or not) is a nameless `player`, and `attrFilter` rides on either subject for position/age. The two reconcile through the per-player-line test.
    - **Topic phrasings ground to the head stat; breadth is a separate, shared engine.** "passing-related player props" → the canonical head market (`Player's passes completed`), `confident` — not an eager fan-out of the {passes completed, pass %, most passes} family. **Family-expansion and the roadmapped no-result *suggestions* feature are the same primitive**: given a concept (or a missed query), return a ranked *related set* via category membership + the existing `shortlist`/`candidates` neighborhood (decision 20 steps 4–5), fired on a **miss** or an explicit "show all" — never as a topic default. Keeps the precision bias (E5); breadth comes free with the suggestions build.
    - **The executor reads an absent `name` as "all players".** A nameless `player` selector means the executor returns every player's outcome in that market (decision 9 — resolver picks the market, executor enumerates outcomes); a position/age `attrFilter` narrows them. "All players" is never materialised in the resolver.
    - **Blank-leak hardening (KE-6 secondary / KE-1 family).** An absent optional selector leaf `line`/`odds`/`attrFilter` that Haiku emits as an explicit `null` **or an empty `{}`** (both observed — `line: null` on a no-line selector, `attrFilter: {}` on a generic "player props") is dropped to omitted **at the parse boundary** (`dropBlankSelectorLeaves` in `extract.ts`): `.optional()` rejects `null` and the `.refine` guards reject `{}`, and none of the three is ever validly empty. Done there rather than via `.nullish()`/transform in the schema so the model-facing JSON Schema stays unchanged (we don't advertise `null`) and no `| null` leaks into downstream types. Scoped to those three — the legitimately `nullable` fields (`stage`, `time`, `competition`) are untouched.
    - (Rejected: **routing generic player → `event`** — the probe shows it loses the player bucket and leaks team/per-player markets; rejected: **eager family-expansion as the topic default** — over-returns, softens E5; rejected: a **bespoke topic→category expander** separate from the suggestions engine — same machinery, build once; rejected: a **prompt-only "omit, never null"** rule — rule #6 already tried it and it leaks on a small model, KE-1; rejected: an **award name-list** carve-out in the prompt — example-stuffing that goes stale. Deferred: the **team parallel** — decision 14's unnamed *team* set ("European nations") is the same question for `team.name`, not decided here; and a **behavior-tagged gold record** for the generic-player case to lock the new behavior.)

22. **A marketless query is a fixture lookup — a 4th plan status `fixture_lookup`, not a fabricated market.** **[SUPERSEDED by decision 24 (2026-06-06): the `fixture_lookup` status over-triggered — the small extractor dropped real markets into the no-selector branch — so the marketless case is now the lone `main` sentinel selector under `resolved`. The trigger rule, executor contract, and Option-A eval grading below all carry over; only the *encoding* changed.]** _New this session (2026-06-06)._ A football query that names **no bettable market** (only events/teams/competition/stage/time/players) had no honest encoding: the `selectors.min(1)` invariant (decision 18) forced the extractor to fabricate a `"match"` concept (→ grounding noise "Fantasy Match / Match Odds"), emit `selectors:[]` (→ schema crash), or bail to `unsupported`. All three were observed in a 30-query probe ("France opener" crash; "Brazil vs Argentina group-stage match" → Fantasy Match; "what's live now" → unsupported). Root cause: the prompt assumed ≥1 market always exists. Implemented this session; paid-Haiku verification pending (like prior sprints).
    - **Trigger = zero markets, by an event-noun-vs-outcome cut.** A **market** is a *bettable outcome* (match result, BTTS, a player prop, an outright, a card/corner total). A noun naming the **event itself** ("match", "fixture", "game", "tie") or a verb that only **lists/shows** it ("show me", "do we have", "what's on") is **not** a market. ≥1 outcome survives → `resolved`; none survives → `fixture_lookup`. One market makes the whole query `resolved` (with just that selector), however fixture-flavoured the rest reads. One crisp rule in `extractor-prompt.md` (Step 3 head) — *not* a per-query example pile (decision 16 / bounded prompt).
    - **Encoding = a 4th `status`, nesting intent under "resolved".** `QueryPlan` gains `{ status:"fixture_lookup", sport, event_scope }` off a shared `{sport, event_scope}` base — **no `selectors`**. The discriminator now reads as "kind of resolver outcome": **decide sport first** (Step-1 gate → `unsupported`/`ambiguous` abstain), and **only if that resolves** split into market-search (`resolved`, ≥1 selector) vs fixture-lookup (`fixture_lookup`, no selectors). This keeps `resolved ⇒ ≥1 selector` intact, so a *dropped-market* extraction bug still fails loudly instead of masquerading as a lookup — the decisive reason over the rejected "relax `selectors` to `min(0)`" (an empty array can't tell "fixture lookup" from "lost the market").
    - **Sport is the only hard minimum, and it's free.** Guaranteed twice: structurally (`sport` is a required enum on the shape) and by precedence (the sport gate runs before the market-vs-fixture split). Sportlessness → `ambiguous`; a named-unbuilt sport → `unsupported`; neither yields a sportless lookup, so no new check. The event-scope facets (teams/competition/stage/time/players) have **no** minimum — breadth is the executor's pagination/clarify problem (decision 9), not a reason to abstain.
    - **Grounding doesn't run; the "main market" is the executor's, deferred.** With no selectors, the grounder is never invoked — the fabricated-"match" noise disappears by construction. Contract for the not-yet-built executor (roadmap item 7): a `fixture_lookup` plan → resolve events from `event_scope`, show each under its **main betoffer**; the resolver emits no market. Preferred default = the live feed's main-line betoffer, fallback a per-`level` constant (fixture → Match Odds `1004712874`, competition → Winner `1001221607`). `level` + `event_scope` already carry everything the executor needs — no new resolver field, no catalog "primary" flag built now (rejected as premature).
    - **Eval grades the event_scope HARD on a `fixture_lookup` (Option A).** A gold record mirrors the shape (`expect.status:"fixture_lookup"`, no selector cells, like the `unsupported` g002); the status gate stays exact (a `fixture_lookup`↔`resolved` mismatch is a hard fail). On a market query the costly facet is the market id, so event_scope is soft (E5); on a `fixture_lookup` there **is** no market id — the **fixture-selecting facets (teams, `stage` incl. `conditional`, `time`) become costly/exact**, because a wrong event slate is the failure mode nothing downstream catches ("matches tomorrow night" with `time` dropped, "Spain knockout *once they qualify*" with `conditional` dropped both show the wrong matches). `level`/`competition`/`players` stay soft. New **critical** behavior tag `fixture-lookup`; ~5 off-corpus gold records over the contrast set.
    - (Rejected: **`selectors: min(0)`** — empty array conflates a lookup with a dropped-market bug; **a `"main"` sentinel `market_concept`** — a magic string the grounder *and* executor must special-case, collides with a real market, encodes control-flow as data; **a separate orthogonal `intent` field** — purer, but two correlated signals to keep in sync, and the intent axis is strictly nested under "resolved" so a 4th status models the real flow; **building a catalog "primary betoffer" flag now** — no evidence it beats a per-`level` constant. Deferred: **live/in-play as a first-class axis** — the same probe surfaced live queries ("live BTTS at 1-0" → wrongly `unsupported`) needing a non-cacheable live-state layer (decision 6) + a schema axis; out of scope here, flagged as a separate follow-up.)

23. **Team match-result grounding: `level`-aware aliases + executor menu-grounding — scope is offering data, not a catalog tag.** _New this session (2026-06-06)._ A 30-query probe surfaced a grounding blind spot: fixture **match-result derivatives** ("Brazil **to win** in their opener", "**draw** after 90", "**HT/FT**", "win to nil") mis-ground. Root cause: the fixture result market is named `Match Odds` / `Half Time/Full Time` (1X2), **lexically disjoint** from the user's phrasing, while ~80 tournament-**outright** `To win …` criterions own the "win" vocabulary — so cosine routes a fixture-winner bet onto the outright family (`Winner` 0.513 tops "to win"; `Match Odds` isn't even top-6). Compounded by grounding being **`level`-blind** (`GroundOpts` had only `subjectKind`, `line`). Design locked this session; code pending.
    - **Spine = carry `level` into grounding (not extractor canonical phrasing).** The fork was *placement* of the fixture-vs-tournament disambiguation — the LLM (rewrite the concept) vs grounding+catalog (carry the structured signal). Chose grounding: keeps the prompt **flat** (decision 16 — the rewrite is *context-conditional on `level`*, unlike the existing context-free canonical rules, so it's the wrong fit for the cheap extractor), keeps sport facts in the catalog, and `level` **generalizes** to the whole fixture-vs-tournament class (top scorer vs Golden Boot, most cards, winner) across every sport. `GroundOpts` gains `level`; the plan threads `event_scope.level` into `groundSelectors`.
    - **Reach = `level`-aware aliases → the per-sport canonical result betoffer.** A `level`-penalty could only *demote* the outrights — it can't *summon* `Match Odds` (lexically too far, <0.394). So extend the alias head with an optional `level` key and map the small result family (`to win` / `match result` / `1X2` / `draw` / `HT/FT`) to the betoffer **decision 22 already designates** (fixture → `Match Odds` 1004712874, `Half Time/Full Time` 1001159830). The alias runs *before* the vector stage, so `To Win The Trophy` can never out-rank it. The executor picks the team/draw **outcome** within the betoffer (decision 9 / the per-side divert's betoffer-outcome model). Bonus: fixes the `HT/FT`-abbreviation-below-floor miss for free.
    - **Scope is offering data, not a catalog tag (the load-bearing finding).** A `SCOPE_PENALTY` in grounding would need a per-criterion fixture-vs-tournament tag — and **none exists**: categories don't encode it (the outright `To Win The Trophy` carries `["Match","Most Popular"]`, same as `Match Odds`; many outrights carry no marker), boTypes don't (`outright` is a *format*, on fixture `Win to Nil`/`HT/FT` too; `onecrosstwo` is on both `Match Odds` and `To Win The Trophy`), and the raw criterion is just `id` + localized `names`. Scope is a property of the **betoffer** (criterion × event-vs-competition), which lives in the **live layer** (decision 6), not the static catalog. So there is **no scope tag and no `SCOPE_PENALTY`**; `level`'s only grounding-side job is gating the aliases.
    - **Executor enforces scope by *re-grounding within the offered menu* — not filter-then-clarify.** The resolver does a best-effort static pass and hands the executor its **ranked candidate set**; the executor fetches the resolved events' actual betoffers (the live "menu") and **re-resolves the concept against that menu**. Because the menu is *inherently* fixture-scoped, a tournament outright is **structurally unreachable** for a fixture query (it isn't on the menu) — scope correctness by construction, no static tag, per sport, for free. **Clarify shrinks to its honest role** — the market genuinely isn't offered, or the menu itself is ambiguous — **never** "we guessed a tournament market and bounced." (Supersedes the weaker first cut "filter the grounded id against the menu, else clarify": a non-aliased fixture concept that grounded to an outright would clarify on a *clearly*-fixture query — bad UX; re-grounding within the menu removes that path.)
    - **Multilingual is a forward-decision (M1), deferred.** The alias head + exact-name index are *string-keyed* (monolingual); only the voyage-3 tail is cross-lingual, and it's the layer that fails on the result family. Stance when multilingual lands: normalize at the **LLM boundary** — a universal extraction rule emits `market_concept` in canonical English, so the single-language alias/name/vector core "just works"; entities go multilingual via the participant feed (decision 8); the feed's localized criterion names (`Match Odds` = `Moneyline` en_US, `Vainqueur du match` fr) are a free exact-name layer if wanted. **Documented, not built** (see Open questions). (Rejected: per-locale alias tables — combinatorial across sports × languages; cross-lingual-vectors-only — the very layer that fails.)
    - (Rejected: **B — extractor canonical phrasing as the spine** (grows the prompt with a context-conditional rewrite on the cheap model, case-by-case); **a name-derived scope tag** (brittle per-sport word-list; bare `Winner` carries no marker). Deferred to the executor build (roadmap item 7): **menu-constrained re-grounding** + outcome-picking. Buildable now: `GroundOpts.level`, the `level`-keyed alias head, the result-family entries in `aliases.json`, and threading `level` plan→`groundSelectors`.)

24. **The marketless case is the lone `main` sentinel selector under `resolved`, not a `fixture_lookup` status — reverses decision 22 on probe evidence.** _New this session (2026-06-06)._ Decision 22's 4th status `fixture_lookup` (a marketless plan with **no** selectors) **over-triggered**: a 30-query probe + a stash-based A/B showed the small extractor (`claude-haiku-4-5`, temp 0) treating the no-selector branch as a cheap escape hatch and **dropping ~13 named, catalogued markets** wrapped in fixture-flavoured scope — "France **draw-no-bet** vs the highest-ranked side", "**winning margin** for Brazil's group games", "**second-half BTTS** across every group game", "first-half **corners** over 4.5", the four player **duels** (top scorer / assists / SoT / saves), "Mbappé **to score 2+**". A/B proof: stashing the WIP and re-running the same queries through the committed (pre-22) extractor **resolved every one** to the right market; restoring the WIP dropped them again. Root cause: a separate no-selector status is a **second output shape**, and "emit this whole section or not, and flip the status" is exactly the structural decision a small model fumbles.
    - **Fix = one output shape.** A built-sport plan is **always `resolved` with ≥1 selector**; a query that names no market still resolves — to a single sentinel `{ subject: event, market_concept: "main" }` ("this fixture's main betoffer"). This restores the **pre-22 always-resolve recall** (the A/B confirms it was there) **minus the fabricated `"match"` market** that made it wrong (KE-8) — `"main"` is an honest, reserved concept, not an invented one. The Step-3 reframe is *name the market for each request; if none, its concept is `main`* — a fill-the-slot content decision, not a drop-the-section structural one. Sport-agnostic (the prompt is sport-neutral by hard constraint — no per-sport examples).
    - **Reverses decision 22's explicit rejection of a `"main"` sentinel — on evidence not in hand then.** Decision 22 rejected it as "a magic string the grounder *and* executor special-case, collides with a real market, encodes control-flow as data." Rebuttal: the recall regression (measured here, not foreseen) outweighs the purity; the grounder cost is **one** reserved-word short-circuit (`key === "main"` → `method:"main"`, ids `[]`, never vector-searched, so no junk); no catalog criterion normalizes to bare `"main"` (collision is theoretical); "control-flow as data" is the accepted price of the single output shape that fixes the bug.
    - **`resolved ⇒ ≥1 selector` no longer catches a dropped market — the scorer does instead.** Decision 22's headline virtue (a dropped-market bug "fails loudly" rather than masquerading as a lookup) is preserved by **moving detection from the schema to the eval**: a marketless gold is `resolved` + one `{main:true}` selector, and the scorer requires the plan to be the lone `main` selector too — a fabricated market or extra selector on a marketless gold is a hard fail (Option A), and a *dropped* market on a real-market gold still fails normal selector pairing. Same protection, one layer down.
    - **Executor contract unchanged from decision 22.** A `main` selector → the executor shows each scoped event under its **main betoffer** (live main-line, fallback per-`level` constant: fixture → `Match Odds` 1004712874, competition → `Winner` 1001221607). Grounding returns `method:"main"` with no id — exactly the "deferred to the executor" contract decision 22 designated; only the *encoding* moved (status → selector). Decision 23's `level`-aware result aliases are unaffected (a named result market still grounds; only the *no-market* case routes to `main`).
    - **Verified.** Ship gate **8/8 PASS** (gf01–gf05 regraded against the `main` sentinel; all critical tags 100%, `fixture-lookup` 5/5); the 30-probe over-trigger collapsed **~13 → 1** (residual: "**European handicap** … Round of 16 tie" still → `main` — the worst-case unfamiliar-term + event-noun combo), **0 regressions** on the 10 already-resolved, and gf01–gf05 + the genuinely-marketless probes still correctly emit `main`. Bonus: several now ground *better* (2nd-half BTTS → `Both Teams To Score - 2nd Half` confident; scorecast decomposes into scorer + correct-score). (Rejected, still: relaxing `selectors` to `min(0)` — an empty array conflates lookup with a dropped-market bug, the same reason decision 18/22 gave; the protection now lives in the scorer instead.)

25. **Testing strategy = a two-tier, self-improving loop — by-construction catalog grounding (Tier 1) +
    human-labeled behavior gold (Tier 2) — under strict fix-routing.** _New this session (2026-06-06)._
    Extends the eval design (E1–E13) from a static gold set into a coverage-driven improvement loop:
    rigorously test the two built stages (extractor + market grounder) and self-improve **without** breaking
    E8 (neutral grader) or decision 16 (bounded prompt). Plan: `planning/sprints/sprint-4.md`.
    - **Two tiers, split by where an honest answer-key comes from.** **Tier 1 (catalog breadth, grounding,
      no LLM):** round-trip every groundable criterion — feed a concept *built from* a known criterion,
      assert it grounds back to that id (E13 containment + clean tier). Key = the catalog row, not the
      grounder → E8-clean, automatic, near-exhaustive over the 2486 kept criterions; the misses ARE the
      shortcomings list — *this is "maximum catalog coverage."* **Tier 2 (reasoning, extraction):** a *big*
      model proposes messy/casual queries; a **human** labels via neutral search (E8); behavior tags stay the
      gated spine (E7/E12), the 10 query *shapes* a tracked diversity axis (a behavior×shape matrix exposes
      blind spots). Generator ≠ grader; the model under test never grades itself.
    - **Tier-1 input is layered.** Verbatim criterion name = a cheap deterministic regression floor (every
      rebuild); a paraphrase batch = the real test of the voyage-3 vector tail (the layer that regresses).
      The paraphrase label stays by-construction (paraphrase *of* C → expect C), with a human drift-check on a
      sample. Floor-green + paraphrase-red = a hand-fit head (a built-in overfitting tell).
    - **Scope = the built market grounder only.** Entity/competition/attrFilter grounders aren't built
      (text-graded today) — testing them is a build task, out of scope. **Live/in-play** (decision 22
      deferred) is **pinned as a tracked abstain case**, not graded as a resolved facet; odds/time/stage are
      tested as extractor *capture* only (no executor/live layer resolves them).
    - **Improve = strict fix-routing + a held-out slice; the prompt is the last resort.** Each failure routes
      to a target: grounding miss → alias/data/knob; a genuinely new reading → a rare crisp universal rule;
      another instance → an eval regression guard + a rule *rewrite*, never an example (decision 16).
      **Alias discipline (a hard rule, sibling to the prompt rules):** add a market alias ONLY to bridge a
      **lexically-disjoint** gap the vector tail fundamentally can't (decision 23's result family, cosine
      <0.394) — **never** to patch a tuning miss (below-threshold → recalibrate off the **Tier-1
      distribution**; wrong bucket / missing row → fix data; near-twin → tier logic). **Alias-table growth is
      a tracked health metric** — a spike means weak vectors or hand-fitting (E8 "never hand-fit a seed"). A
      locked **held-out** Tier-2 slice (~15–20%) the fix step never sees proves generalization, not memory.
    - **Loop = semi-autonomous, human-gated fixes.** Automation generates (Tier-1 templates / Tier-2
      big-model), runs both tiers, attributes extraction-vs-grounding, and **proposes** a fix-target per
      failure in **plain English with a worked example each** (house style); a human approves/redirects the
      fix; retest + held-out run automatically. Cadence: Tier 1 every index rebuild + on demand; Tier 2 1× per
      change, 5× before release (E10). **First iteration = Tier 1 only** (cheapest, the catalog-coverage
      headline, zero LLM, zero attribution — every Tier-1 failure is by definition a grounding miss); gate to
      Tier 2 on the outcome.
    - (Rejected: a **fully autonomous patcher** — drifts to easy prompt/alias edits, overfits, can't be kept
      E8/decision-16-honest; **shapes as the primary corpus axis** — E7 already rejected it, the gate can't
      key off shapes and a critical behavior hides in a passing shape-bucket; **self-grading generation** —
      the grounder or model-under-test writing its own key, the E8 trap; **building entity grounding** to test
      it now — a build project, deferred; **over-adding aliases** to pass seeds — the grounding-side twin of
      prompt-stuffing.)

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

**E13. Multi-candidate grounding is graded by *containment + tier* (decision 20).** _New this session
(2026-06-03)._ When the grounder returns a tiered set, the market axis (E3/E5) passes iff **the gold id ∈
the returned ids AND the tier is clean**: `confident` and `variants` pass and stay **critical-gate-eligible**
(E12); **`ambiguous` is a soft/tracked outcome, never a hard pass** — it means "ask the user", which is
recorded, not scored correct. **Gold cells stay single ids** — g001's Vitinha SOT stays `{id: 2100015085}`
and a `variants` return passes because that id is *contained*; the side-split `{1001159967,1001159633}` is
the one gold cell that is natively a set (the `id: number|number[]` widening, Open questions). (Rejected:
**exact set-equality** of returned vs gold ids — punishes a correct `variants` return that legitimately
offers a sibling line gold didn't enumerate; rejected: **containment alone** — would bless an `ambiguous`
5-way tie that happens to contain the gold id, hiding a real "couldn't tell" behind a green cell.)

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
- **Multilingual concept normalization (M1).** _New (2026-06-06)._ The alias head + exact-name index are
  **string-keyed** (monolingual); only the voyage-3 tail is cross-lingual, and it's the layer that fails
  on the result family (decision 23). Stance when multilingual lands: a universal extraction rule emits
  `market_concept` in **canonical English** at the LLM boundary, keeping the alias/name/vector core
  single-language; entities go multilingual via the participant feed (decision 8); the feed's localized
  criterion names (`Moneyline`, `Vainqueur du match`) are a free exact-name layer. **Not built** until
  multilingual is on the roadmap. Rejected: per-locale alias tables (combinatorial); cross-lingual-vectors-
  only (the failing layer).
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
- **Player subject bound to a team-only market (extraction/grounding) — RESOLVED (2026-06-05).** "Bruno
  Fernandes corner markets" (seed g001) is a `player` subject + a team-only stat: no player corners-count
  criterion exists. **Decision: reject the player owner for the absent market and _offer_ the real
  alternatives** — not faithful-keep. Grounding a `player` subject to **Total Corners** (a team/match
  market) is semantically incoherent and is structurally blocked anyway by the subject pre-filter
  (decision 20, the load-bearing cut). Instead the grounder surfaces the player corner markets that _do_
  exist (`To score from a direct corner`, `To give an assist from a corner`) as a `shortlist`, and the
  executor says "a player corners-count market isn't offered — here's what is." Encoded as a gold
  `{offer:[...]}` cell graded by the scorer's OFFER rule (`structural-scorer.ts`: pass iff a `shortlist`
  contains the offered alternatives). Generalised rule: **a player subject for a stat with no player
  market is an offer-of-alternatives, never a cross-bucket bind.** (The "corners in Bruno's _match_"
  reading is a *different* extraction — a `team`/`event` subject — handled upstream, cf. Q26's `his team`.)
- **Cosine threshold + near-tie epsilon (grounding, decision 20).** _New (2026-06-03)._ Two distinct knobs
  the current code conflates into one (`THRESHOLD = 0.55`, no epsilon): the **floor** below which we abstain
  (`none`, E5), and the **epsilon** within which top-1 and top-2 count as a near-tie that triggers the
  `variants`/`ambiguous` test (stage 7). Both are untrustworthy until the catalog rebuild, which shifts the
  score distribution (recovers ~315 player rows). _Example (floor):_ `"anytime scorer"` vs catalog `"Player
  To Score Anytime"` may land ~0.52 — a too-high floor returns a false `none` on a market we have.
  _Example (epsilon):_ `"team total goals"` → `Total Goals by Home Team` 0.71 / `Away` 0.70 (Δ=0.01 < ε →
  near-tie → side-split `variants`) vs `"corners"` → `Total Corners` 0.74 / `Corner Race To 5` 0.58 (Δ=0.16
  ≫ ε → clear `confident`). Calibrate both off the **rebuilt seeds' top-k cosine table** (read from
  `candidates`), from the score *distribution* — never hand-fit a seed (E8). Fails safe: too high → abstain,
  never a wrong bet.
- **Non-semantic suffix strip-list (grounding, decision 20 stage 7).** _New (2026-06-03)._ The maintained
  enumeration of **provably non-semantic** suffixes stripped before the stat-type-core test — settlement
  source `(Settled using Opta data)`, alternate-line presentation labels — explicitly **not** period
  (`- 1st Half`), extra-time (`- Including Extra Time`), or odd/even, which change *which market* it is. The
  list is finite and Kambi can ship an un-listed suffix. _Example (safe failure):_ a new `(VAR Reviewed)`
  variant of `Player Shots on Target` keeps a different core → tiers `ambiguous` instead of `variants` → the
  executor **over-clarifies** (worse UX, never a wrong bet). _Example (dangerous edit):_ wrongly adding
  `- 1st Half` to the list merges a half-market with the full match → silent wrong period. Editing rule is
  asymmetric — only add a provably non-semantic suffix; when unsure, omit and eat the clarify. Derive
  candidates empirically (group by core, inspect high-frequency residual tails); add a guard test that no
  entry is also a period/scope token.
- **Participant-name common-word guard (catalog build, decision 20 stage 3).** _New (2026-06-03)._ The
  quarantine matches criterion names against the ~32.5k-row participant list; a participant whose name is a
  stat word would wrongly drop a **generic** market. _Example:_ a real player surnamed "Corner" makes
  `Total Corners` match the participant list → quarantined → grounding for g001's `corners → 1001159897`
  breaks. Guard, biased to **keep**: (a) no quarantine on a single-token substring — require the name to
  consume a `Player`-subject criterion's leading proper-noun span; (b) a small stop-list of football
  vocabulary that can't be a sole quarantine key; (c) a length/token floor. Validate by diffing the
  quarantine set post-rebuild — every dropped name must be a real full player name. Fails safe: a stray
  per-player row left in the index is one extra candidate the subject filter + tiering already contain.

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
   _Updated (decision 20): **market** vector-tie clusters are no longer disambiguated by an LLM call — they
   are resolved by the deterministic subject-filter + facet-boost + tier, and irreducible ties become
   `ambiguous` → the executor clarifies. This LLM call is now reserved for **entity** homonyms (decision 8)
   if context disambiguation alone can't settle them — not for markets._
6. **Define the resolver output schema** — the grounded query plan is now the **status-discriminated
   `QueryPlan`** of decision 18: `resolved → { sport, event_scope{ teams, players[{name,role}],
   competition, level, stage{round,ordinal,conditional}, time }, selectors[{ subject, market_concept,
   line?, odds?, attrFilter? }] }`, else `ambiguous` / `unsupported`.
   _Updated: encoded as Zod this session (decision 18); `conditional` folded into `stage`._
7. **Build the executor + the live-event-layer contract** — `event_scope` → event ids (fixtures feed),
   with `stage` / `time` / `conditional` / lineup-`role` predicates computed there (decision 6); fetch
   betoffers (batched); apply selectors + `attrFilter` + line/odds filters; **re-ground each `market_concept`
   against the fetched betoffer menu** (decision 23 — the menu is inherently scoped, so a fixture query can't
   surface a tournament market; clarify only on a genuinely-absent or menu-ambiguous market); apply the
   **degrade-to-`plays`** fallback + caveat. _Updated: added conditional / role / attrFilter handling +
   degrade rule + decision-23 menu-grounding._
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
_Updated (2026-06-03): the committed `data/football/` criterions snapshot **was trimmed** relative to the
category feed — Sprint 3 Stage A rebuilt the catalog from the full feed (see the rebuilt-snapshot bullet
below); this drove the catalog rebuild in decision 20, now built (catalog version `0f2aac930df9`)._

| Dataset | Count | Cross-sport? | Record shape |
|---|---|---|---|
| BetOfferType | ~28 | **Universal** | `{id, label}` |
| Criterion | 600 | per-sport | `{id, sport, name, shownInLive, shownInPreMatch, categoryNames[], boTypeNames[]}` |
| Category (BetOfferCategory) | 395 (11,927 mappings) | per-sport | `{id, name, mappings:[{criterionId, boType, boTypeName}]}` |
| Clubs | 1,784 | per-sport | `{id, kind, sport, name, competitionIds[], groupIds[], ntVariant}` |
| Players | 32,587 | per-sport | `{id, kind, sport, name, clubId, competitionIds[], countryTeamId}` |
| Groups | hierarchical forest | per-sport | `{id, name, sport, groups[]}` |

- **The committed criterions snapshot was trimmed — rebuilt from the feed (Sprint 3 Stage A, 2026-06-03).**
  The old `football_criterions.json` held **598** criterions (its own `counts.criterions` claimed **600** —
  internally inconsistent) while `football_categories.json` mappings referenced far more, so g001's target
  `2100015085` "Player Shots on Target" (and many player markets) were **ungroundable**. ∴ decision 20 step 1
  rebuilt the criterions list from the **raw criterion feed** (names + flags, 5647 entries) ⋈ the **category
  feed** (membership + boTypes). **Post-rebuild (catalog version `0f2aac930df9`):** categories reference
  **8550 distinct** criterion ids → **2486 kept + 2437 quarantined + 3627 still absent** (referenced by
  categories but missing from the raw criterion feed — closing that gap needs a richer feed, not a join fix);
  g001's `2100015085` is now **present, subject `player`**. *(The category `name` is the subject-tag source;
  **49 player-meaning category ids in the full feed** carry the player markets. "shots on target" appears in
  **38** criterion names locally: the collision decision 20 solves.)*
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
- **subject pre-filter** — decision 20 stage 4: restricting market candidates to the query's `subject.kind`
  *before* cosine; the load-bearing cut for same-vocabulary collisions (a `player` query never sees team/match criterions).
- **facet-boost** — decision 20 stage 6: on the cosine survivors, `line → boType` is a **HARD gate** and a
  period mismatch a **SOFT penalty**; presentation/settlement-source facets are neither.
- **grounding tier** — decision 20 stage 7, returned on `GroundResult` beside `method`: `confident` (one
  winner) / `variants` (share a stat-type core — offer all, incl. the side-split pair) / `ambiguous`
  (default; the executor clarifies, E5).
- **stat-type core** — a criterion name minus its subject prefix minus the non-semantic suffix strip-list;
  two criterions sharing a core (corroborated by a shared stat-type category) are `variants` of one market.
- **non-semantic suffix strip-list** — maintained list of presentation/settlement-source suffixes (e.g.
  `(Settled using Opta data)`) stripped for the core test; **excludes** period/extra-time/odd-even (semantic).
- **participant quarantine** — decision 20 step 3: dropping per-player pre-baked criterions from the vector
  index by participant-name match, so the ~32.5k-player explosion never pollutes grounding.
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
- **Market collisions disambiguated by an LLM call on vector-tie clusters** (old plan step 5 applied to
  markets) → *superseded* by decision 20's deterministic chain (subject pre-filter → cosine → facet-boost →
  tier); the only LLM input is the extraction-time `subject.kind`. The step-5 LLM call survives only for
  *entity* homonyms.
- **A suffix-penalty / "modern vs legacy criterion" ranking to pick one id among name-twins** → *rejected*
  this session as **E8 gold-fitting**: no recency/version field exists on criterions, and `shownInLive`
  shows the suffixed `1002035662` is the *more* featured row (contradicting "legacy"). Replaced by returning
  the twins as `variants` and letting the executor filter against the live betoffer response (decision 20).
- **`*`-prefix as the per-player-criterion quarantine signal** → *disproved* (only 1/5647 raw football
  criterion names carried a leading `*`). Replaced by participant-name matching at build time (decision 20
  step 3).

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
3). Region is a static ~48-row table; only position + age need the roster feed. **Sprints 1–2 are built**
(runnable structural eval; hybrid market grounder — alias head + voyage-3 cosine tail — with the id-graded
market axis). The **collision-handling design is settled** (decision 20 + eval E13): same-vocabulary market
collisions resolve by a deterministic **subject pre-filter → cosine → facet-boost → tier** chain, graded by
containment + tier; **Sprint 3 Stage A is built** (`planning/sprints/sprint-3.md`) — the catalog was
rebuilt from the full criterion ⋈ category feed (version `0f2aac930df9`: 8550 referenced → 2486 kept +
2437 quarantined + 3627 absent from the criterion feed), subject-tagged and participant-quarantined, and
g001's `2100015085` now grounds as `player`; **Stages B (subject-filtered tiered grounding) and C (E13
scorer) are not yet started**."*
