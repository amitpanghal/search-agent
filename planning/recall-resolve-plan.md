# Recall-then-Resolve — target architecture for market grounding

> **Status:** design proposal. Clean-slate — this **overrides** the current
> extract → ground → disambiguate split. Code it replaces is listed in
> [What this deletes](#what-this-deletes); we are **not** keeping back-compat.

---

## 1. Why redesign (the evidence)

Today the pipeline makes **early, catalog-blind, destructive commitments** in three
places. Each one throws away information the next stage needs, *before* the stage that
actually knows the catalog gets to decide:

| Commit point | What gets destroyed | Who decides today | Who *should* |
|---|---|---|---|
| **Market words** ("to score" dropped) | the alternative market reading | extractor (catalog-blind) | catalog-aware resolver |
| **Subject** (player vs event) | the other family, structurally | extractor (catalog-blind) | catalog-aware resolver |
| **Line** ("over 2.5" ignored, not carried) | numeric-vs-binary signal + the outcome filter | grounder (line-blind) | resolver + executor |

The reason this matters is **not** any single bug — it's that confident-wrong errors
are spread evenly across *three* axes, so no single patch covers them. Classifying every
mis-grounding flagged in [`EvaledQueries.md`](./queries/EvaledQueries.md):

| Axis | ~count | Example |
|---|---|---|
| **Near-synonym / false friend** (wrong market, same level) | ~5 | "method of victory" → Method of First Goal ([:350](./queries/EvaledQueries.md)); "race to X goals" → Total Goals ([:386](./queries/EvaledQueries.md)) |
| **Answer-type / facet drop** (line or dimension lost) | ~3 | over/under line on a yes/no "head" market ([:248](./queries/EvaledQueries.md)); interval dimension dropped → plain anytime scorer ([:398](./queries/EvaledQueries.md)) |
| **Level** (tournament-aggregate vs match) | ~3 | "corners over 10.5" → *Number of corners in the Tournament* not match Total Corners ([:265](./queries/EvaledQueries.md)) |

All three share **one shape**: a stage committed to one reading with partial information
and no second look. So we fix the shape once, not the axes one at a time.

---

## 2. The principle

> **Resolve where the knowledge lives. Preserve everything until then.**
> Mapping a messy phrase → (criterion, outcome) is one-to-many and *depends on the
> catalog*. Make that decision in **one** stage that sees the full intent **and** the
> catalog — never split it across a blind extractor, a line-blind grounder, and a
> sometimes-skipped disambiguator.

---

## 3. The three roles

### Role 1 — Preserve (replaces today's extractor normalization)

The extractor **segments and keeps**; it never canonicalizes a market into a
catalog-shaped guess.

- **Market phrase:** keep the user's words for each market. Do **not** drop verbs or
  rewrite "over 2.5 goals" → "total goals". (Strip only true scope words: teams, comp,
  time, stage.)
- **Subject:** `bound` when an owner names it, `soft` otherwise.
  - *bound* — a named team/player owns it → the kind is **certain**, hard-filter stays.
  - *soft* — no owner **and** the phrase reads at more than one level → carry the
    plausible kinds, don't pick one.
- **Line:** structured (`numeric | binary | selection`) **and** never erases a reading —
  it travels forward intact for the resolver and the executor.

**Example — "to score over 2.5 goals"** (no owner, two-faced):
```
{ phrase: "to score over 2.5 goals",
  subject: { kind: "soft", kinds: ["player", "event"] },   // both readings alive — don't pick
  line:    { kind: "numeric", value: 2.5, direction: "over" } }
```

**Example — "Haaland shots over 2.5"** (owner named → nothing changes):
```
{ phrase: "shots", subject: { kind: "player", name: "Haaland" },   // bound = one concrete kind
  line: { kind: "numeric", value: 2.5, direction: "over" } }
```

### Role 2 — Recall (replaces today's tiering grounder)

The grounder becomes a **recall engine**: per phrase it returns a **candidate set** (id + name),
and it does **not** mint a "confident, skip the resolver" verdict.

- Each candidate is just `{ id, name }` (+ its recall score). **No per-candidate
  `answerType`/`level`/`family` labels.** We built and probed `answerType`: given the candidate names +
  the full query, the resolver already picks the right line-capable market without it — the label was
  redundant on real traps and on the abstain case it *forced a wrong pick* (see §4). The line is honored
  downstream (executor), not via a candidate label.
- **Subject `soft` → recall per-family, balanced** (top-k from each plausible bucket), so
  neither family floods the other. Subject `bound` → one bucket, exactly as today.
- **Tiers stop being control flow.** The old confident/variants/ambiguous/shortlist
  distinction becomes at most a *prior* passed to the resolver, never a gate that skips it.
- **Markets are never gated; entities are.** Every non-exact **market** leg goes to the
  resolver — confident ones carried as the anchored default, *not* skipped (a market
  "confident" is just a high vector score: Q29 corners 0.492 and Q43 method-of-victory
  0.527 were both confident **and wrong**). For **entities** (groups / participants) only
  the doubtful tiers (shortlist / ambiguous / none) ride along; an entity "confident" is
  exact/alias-only ("Brazil" → Brazil), already resolved, so it is left out of the call.
- **Catalog-confirmed shortcut kept:** an exact alias or exact catalog-name hit is *not* a
  guess — it bypasses the resolver (the only LLM-free path; see Cost).

**Example — "to score over 2.5 goals":** recall returns the player scorer candidates by name only —
`[ {id, "To Score"}, {id, "To score at least {0} goals"}, {id, "First Goal Scorer"}, … ]`. The resolver
reads them against the full query and picks `To score at least {0} goals` (verified live).

### Role 3 — Resolve (today's disambiguator, promoted to owner)

**One batched LLM call per query** decides every doubtful cell at once. It sees the raw
query + each **market leg** (full phrase + line + candidates by name) + only the **doubtful
entities** (see Recall). One round-trip, not one per leg — a 3-leg query (Q26) costs one
wait, not three stacked in series, and the model reads legs together ("his team match
result" resolves against the other Yamal legs in the same query). Per leg it:

- **picks** the criterion whose name best fits the full query — the line and level are in the query
  text the model reads, so it judges line-fit from intent, not from a per-candidate label (probed, §4);
- **re-expresses or clarifies** when no candidate fits — rather than forcing a wrong market;
- **clarifies** when two real readings survive (kills the near-synonym/ambiguity axis);
- **anchors** on the recall top pick as the default and overrides only on clear evidence
  (guards against re-judging a correct answer — the over-clarify risk).

**Two-pass re-expression (kept from today).** Pass 1 resolves from the candidates above.
If a leg fits **none** of them — the truth sits below the recall cap of 10 (e.g. Q29's
match Total Corners never enters the top candidates) — the model **re-expresses** that leg,
recall fetches a fresh batch, and pass 2 picks or clarifies. This is the safety net for
buried-truth misses, and is distinct from the cascade re-ground in §8 (which re-scopes
*dependent* cells, not a single leg's own recall).

The chosen criterion **plus the line** then flow to the executor, which binds the outcome
(the line is finally carried downstream — see [`plan-fetch.ts`](../src/resolver/plan-fetch.ts)).

**Example — "Mbappe to score over 2.5 goals":** the resolver reads the candidates (`To Score`,
`To score at least {0} goals`, `First Goal Scorer`, …) against the full query and picks
`To score at least {0} goals` — from names + query, no answerType label (verified live). If nothing
fits, it clarifies instead of shipping a wrong market.

**Example — one batched call, "corners over 10.5 and red-card specials for Brazil":**
```
query:    "corners over 10.5 and red-card specials for Brazil's knockout games"
entities: []                          # "Brazil" = exact → resolved, not sent
markets:
  - phrase: "corners", line: {numeric, over, 10.5}
    anchor: "Number of corners in the Tournament"     # recall top pick (confident)
    candidates: [ Tournament corners (competition, numeric),
                  First Corner       (fixture,     selection),
                  Total Corners      (fixture,     numeric), ... ]
  - phrase: "red card specials", line: none
    candidates: [ To Get a Red Card (binary),
                  Red Cards Handicap (numeric),
                  Most Red Cards     (selection) ]
→ leg1: anchor is competition-level, line is a match numeric → no fit
        → RE-EXPRESS → pass 2 surfaces "Total Corners" (fixture, numeric) → PICK
→ leg2: vague "specials", two real readings → CLARIFY
```
One round-trip resolves both legs: a confident-but-wrong leg gets its second look (Brazil
never enters the call), and the vague leg clarifies.

---

## 4. How each axis is now covered (one mechanism, three wins)

The single mechanism is **the gate + the resolver reading the full query against the candidate names** —
*not* per-candidate labels. We probed an `answerType` label and dropped it (below).

- **Near-synonym** — resolver sees the phrase next to the candidate names and picks/asks.
- **Facet drop** — the **line is carried to the executor** (§8) as the outcome filter, so a market that
  can't price the line yields nothing there — the real fix. The resolver picks a line-capable market from
  names + the query; it does not need a label to do so.
- **Level** — the grounder already hard-filters candidates by `level` at recall (when level is set), and
  the names usually say "in the Tournament/Competition"; the resolver tells match from tournament from that.

**Probe note — `answerType` rejected (2026-06-17).** Built per-candidate `answerType` (numeric/binary/
selection from `boTypeNames`) and a resolver "reject a line it can't price" rule, then A/B tested it live.
On real traps (shots / shots-on-target / goals "over N", with binary name-twins present) the resolver picked
the **same correct numeric market with or without** the label — names + full query suffice. On the abstain
case ("over 1.5 own goals", no numeric market) the label was **worse**: it forced a wrong confident pick
(*First Goal Scorer*) where the unlabeled resolver **clarified** correctly. So `answerType`/`level` labels
were removed; the line lives on the selector → executor, and the resolver decides from the query.

---

## 5. What this deletes (clean slate — no back-compat)

| Current code | Fate |
|---|---|
| `extractor-prompt.md` market_concept canonicalization (drop-words, "over 2.5 goals → total goals") | **remove** — preserve the phrase instead |
| `schema.ts` single fixed `subject.kind` | **change** — add `bound`/`soft` subject |
| `ground-market.ts` tier-as-gate + confident bypass | **remove** — recall returns candidates (id+name), no gate |
| `disambiguate.ts` `SENT_TIERS` gate (sends only ambiguous/shortlist/none) | **scope to entities** — markets always go to the resolver; the doubtful-tier gate survives only for groups/participants |
| `disambiguate.ts` two-pass machinery | **keep the re-expression pass, drop the tier re-gate** — pass 1 resolves from top candidates, a non-fitting leg re-expresses, pass 2 picks/clarifies |
| `ground-market.ts` per-side divert, combos | **re-home** as recall-tagging / resolver inputs (keep behavior, move owner) |
| `plan-fetch.ts` (no line filter) | **change** — carry the line as an outcome filter |
| exact alias / exact-name resolution, vector + BM25 + lexical recall | **keep** — this is the recall engine |

Anything the redesign makes unreachable (dead tier-gate branches, the `pickFirst`-era
stubs, replay fixtures keyed on the old gate) gets **deleted in the same change**, not
left behind.

---

## 6. Cost

- **One batched Haiku call per query**, not one per leg — a multi-leg query (Q26 has 3)
  costs one round-trip, not three in series. Latency, not spend, was the worry; batching
  answers it. Markets in one query are independent, so they cost only more candidate lines
  in the same prompt, never extra round-trips.
- Catalog-confirmed exact market hits ("btts" → Both Teams To Score) and exact/alias
  entities ("Brazil") are not guesses, so they stay out of the call entirely.
- Accuracy-first by request; Haiku is cheap and the exact-match skips keep the one call
  lean — only doubtful cells are in it.

---

## 7. To validate before building

- **Soft-subject size** — data so far says the genuinely two-faced (no-owner + bare-stat)
  case is small; confirm on a wider set so the widen path stays rare.
- **Level data quality** — `levelOk` lets *unset*-level candidates through, so untagged
  aggregate markets slip the fixture filter. Tagging more markets is a **separate** lever
  from the resolver work.
- **Regression** — measure the always-on resolver against the gold set; it must not break
  phrases the recall engine already nails (anchor-on-default mitigates, but prove it).

---

## 8. Open / out of scope (for now)

- Multi-**scope** queries (more than one `event_scope` in a query). Multiple **selector**
  legs over one scope are *in* scope — that is exactly what the batched call handles.
- Cascade re-ground (a re-expressed phrase re-scoping dependent cells) — distinct from the
  per-leg two-pass re-expression in Role 3, which *is* in scope.
- LLM-assisted combo recall (below the cover floor).

---

## 9. Build order (to-do)

Ordered by dependency — **Preserve → Recall → Resolve → Executor → cleanup → prove**.

- [x] **Schema (Preserve):** add `bound`/`soft` subject; structured `line`
  (`numeric|binary|selection`); keep the raw market phrase. ([`schema.ts`](../src/resolver/schema.ts))
- [x] **Extractor (Preserve):** stop canonicalizing — drop the drop-words and
  "over 2.5 goals → total goals" rewrite; strip only scope words (team/comp/time/stage).
  ([`extractor-prompt.md`](../src/resolver/extractor-prompt.md))
- [x] **Recall — return candidates `{ id, name }`** (id+name only); balanced per-family for `soft`
  subjects. *(Built per-candidate `answerType`/`level`/`family` labels, probed them, and reverted —
  redundant and occasionally harmful; see §4.)* ([`ground-market.ts`](../src/resolver/ground-market.ts))
- [x] **Recall — remove tier-as-gate / confident bypass for markets**; keep the exact
  alias/name shortcut + vector/BM25/lexical recall (cap 10).
- [x] **Resolve — one batched call per query:** all non-exact market legs (confident
  anchored) + only doubtful entities; candidates `{id, name}` + the line as context; output
  pick / clarify / re-express per leg. ([`disambiguate.ts`](../src/resolver/disambiguate.ts))
- [x] **Resolve — two-pass re-expression:** a leg fitting none of its candidates
  re-expresses → recall fetches a fresh batch → pass 2 picks/clarifies. *(pre-existing, kept.)*
- [x] **Entities — scope the `SENT_TIERS` gate to entities only** (groups/participants);
  exact/alias entities stay out of the call. *(folded into the gate change.)*
- [x] **Executor — carry the line** into the outcome filter — the real facet-drop fix. `FetchPlan.
  postFilters.lines` pairs each settled criterion with its line; line-less markets omit it. *(Carried, not
  applied — no live fetch in-repo.)* ([`plan-fetch.ts`](../src/resolver/plan-fetch.ts))
- [x] **Cleanup:** no dead code — the redesign was in-place (no orphaned tier-gate branches; `pickFirst`
  was already gone; stale fixtures removed in Prove). Refreshed the now-misleading comments (SENT_TIERS =
  entities-only; marketIds seed = anchor/default; plan-fetch no longer "disambiguator deferred").
- [x] **Prove:** full eval green — SHIP GATE PASS (11/11, soft 100%), ENTITY GATE PASS, replay 4/4
  (exit 0). g001 re-keyed to WC26 + new `none`/abstain gold mode (schema + scorer); `soft` never fired
  (stays rare). Found the gold/fixtures were keyed to the old full-football catalog — the only failures
  were stale test data, not the redesign. 2 dead-catalog fixtures removed; fresh WC26 reexpress + combo
  replay fixtures tracked as a follow-up. *(Level-tag coverage tracked separately — §7.)*
