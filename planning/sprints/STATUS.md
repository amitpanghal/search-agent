# Sprint Status Log

Progress log for sprints under `planning/sprints/`. Each sprint gets timestamped entries,
newest on top. A sprint's plan lives in its own `sprint-N.md`.

---

## Sprint 5.1 — Facet soft-demote (period-led) for the shallow grounding band

Plan: [sprint-5.1.md](sprint-5.1.md)

### 2026-06-10 — Designed + offline-validated; doc recorded, no code

Root-caused the **shallow** reachable misses (gold at rank 9–32). Two facts make the grounder ignore a
paraphrase's period/side: the extractor passes casual words through verbatim (prompt rule
`extractor-prompt.md:187`) so the grounder re-infers via the brittle `periodOf` regex, AND `PERIOD_PENALTY`
lives on `adj` while the sub-threshold `shortlist` path orders its lexical-"strong" group by **BM25, not
`adj`** — so the penalty never reaches the top-3 (why the deployed `periodOf` expansion recovered **1/26**).
Fix (documented, not built): feed facets from the LLM (`opts.period ?? periodOf`), add the missing
`SIDE_PENALTY`, and **fix the shortlist ordering** so the penalty participates — keep `market_concept` rich,
demote-don't-drop (`adj` only → 0 golds dropped). Offline-validated: LLM facets ~90% accurate; rejected the
strip+hard-filter arm (recall@3 73→40); winning soft-demote arm shallow recall@3 **25→33–37%**, recall@10
**54→68%**, 0 drops. **Honest scope:** period+side are **32/132 (~24%)** of the shallow band by cause-tag — the
plurality (near-synonym 29) is Sprint-6 doc-views, combined 15 is Sprint-7 Stage-2; the **SIDE arm is
validate-first** (10/273 misses; the `Criterion.side` tag only marks per-side twins). No code.

---

## Sprint 7 — Outcome-family gate: same-level meaning-tightness so the executor's live-menu collapse is safe

Plan: [sprint-7.md](sprint-7.md)

### 2026-06-09 — Designed via grill (Q1–Q7); plan recorded

Root-caused "to win the world cup" → a **qualify** market: the embedding melts win/qualify, and **Stage 2
can't fix it** because `To qualify from Group Stage` is genuinely live in the WC (48 comp-events vs the winner
market's 9). So tightness must come **upstream**: a Stage-1 **outcome-family gate** in the grounder (decision
20's vector tail), partnering decision-23's deferred executor live-menu collapse (Stage 2). Settled design
(see [sprint-7.md](sprint-7.md), proposed **decision 28**): family = the **outcome-type** axis only, orthogonal
to period/subject/side/scope; **hard but conditional** cut (drop only when both query+candidate families are
committed AND differ; uncertain → leak); query family **derived in the grounder by the same shared lexical
tagger** that build-time-tags the catalog (extractor untouched, sport-agnostic); **precision-biased** lexical
rules (commit only when sure), LLM as deferred **auditor** only; **per-selector** (extractor already splits
combos), catalog combos/borderlines stay `uncertain` (no family-sets yet); filter **at pool construction** so
BM25 can't dodge it; activate **first only on the competition-outcome cluster** (win-title / reach-stage /
qualify / finish-position / top-scorer / award). Validate: no-LLM **WC-oracle collapse check first**, then the
catalog-sweep round-trip (0 self-drops) + ship gate. **Deferred** (separate workstream): the combined-market
reachability gap the "Mexico to Win and Both Teams To Score" probe exposed (extractor splits "X and Y", so
pre-packaged combo rows are unreachable) — needs its own probe before any fix. No code yet.

---

## Sprint 6 — Doc-views: generated paraphrase vectors for the grounding tail

Plan: [sprint-6.md](sprint-6.md)

### 2026-06-10 — Step 0 retired; Phase 1 step 2 (doc-view generation) pipeline built, paid run NOT executed

**Step 0 (voyage-3.5/-large upgrade probe) marked NOT REQUIRED** in `sprint-6.md` — proceeding straight to
doc-views regardless of embedding-space gains.

**Phase 1 status.** The clean-room **query half is done**: 355/401 stratified-blind queries authored across
all 17 families, 354 normalized through real Haiku + cached (`tier1-extractor-cache.json`), and the
**extractor-in-loop baseline (doc-views OFF) is measured** — `54/355 (15.2%)` [clean 22 + twin 1 + narrowed
31], recall ceiling 273/355 reachable / only 71 in top-8 → **202-miss doc-view headroom** (tier_1_automation.md).

**Built this turn (step 2 — the Opus view-generation half):** `scripts/gen-doc-views.ts` +
`planning/prompts/genDocViewsPrompt.md` (npm `gen:doc-views`). **Cluster-contrastive** (#6): clusters one per
(subject, primary category), distinct `statCore`s are the members, side/settlement twins collapse + share;
Opus (`claude-opus-4-8`, forced tool use mirroring extract.ts — no temperature/thinking, Opus-4.8-safe) writes
6-8 terse `market_concept`-register views/member that distinguish it from its cluster siblings; **mechanical
collision filter** embeds every view (`embed()`, voyage-3) and drops any with `cosine(view, sibling-name) ≥
cosine(view, own-name)` for any distinct-`statCore` sibling (twins excluded → keep sharing). **Anchoring rule
(#5/#6) honored** — output is text only (`criterion-doc-views.json: {id → views[]}`); statCore/penalty stay
name-derived. **LLM-free reruns**: raw Opus output cached per batch (`doc-views-gen-cache.json`), resumable
mid-run; idempotent (skips done clusters). `--dry-run` builds clusters + sample prompt with **0 API calls**.
Exported `statCore` from `ground-market.ts` (zero-behavior, enables the script). **Typecheck clean.**

**Dry-run shape:** 138 clusters, 2361 distinct members, 2486 criterions (incl. twins), 195 Opus batches;
sizes median 5, max 236, 39 singletons. **Finding:** a few catch-all categories ("Special Offers", 236
unrelated members) dominate the count but are low-value for contrast (no real siblings → filter passes them
through); the tight mainstream categories (median 5) are where the lever matters. **Eval-scoped run = 131 of
195 batches** (defers only 64 never-probed tail clusters), so it's the minimum spend that still lets step 5's
go/kill be fully measured.

**Paid run NOT executed — user chose "don't spend yet."** Pipeline is ready; next action is the generation
run (recommended scope: eval-scoped, with a 1-cluster smoke-test first), then steps 3-5 (index `vecs[]`,
`nameRaw`/`bestRaw` match, measure ON/OFF). No `criterion-doc-views.json` written yet.

### 2026-06-08 — Plan drafted (not started)

Designed the dataset-level fix for the weak voyage-3 vector tail (architecture **decision 27**), grilled
end-to-end with the user. Lever = **doc-views**: extra embedded vectors per criterion (name + Opus-generated
user-language paraphrases) scored by **max-pool** — "bulk-generated soft aliases at the embedding layer,"
the scalable successor to decision-25 hand-aliases. **Reframed the eval** off the pessimistic direct-
paraphrase batch (39%, skips the extractor) onto the **extractor-in-loop** distribution (query → real Haiku
→ `market_concept` → ground; 75% on the same markets), keeping **E8** by-construction labels. **Clean-room**
generation to dodge contamination: **Opus** authors views · **GPT-5.5/Sonnet** authors queries · real
**Haiku** normalizes · mutual blindness; report lexical-overlap of wins. **Precision by construction (E5):**
two scores per criterion — `nameRaw`→`confident` (unchanged), `bestRaw = max(name+views)`→`shortlist` only —
so **phase 1 cannot change any confident outcome** (`ground-snapshot` 0-diff assertion). Generation =
**cluster-contrastive + a mechanical collision filter** (drop a view closer to a sibling than to its own
market). Eval = **stratified-blind ~300–500 queries**; go/kill = net sub-threshold `none`/`below`→`narrowed`
> 0 with **zero `narrowed`→`below`**. **Alias table frozen** (new tail gaps → doc-views; opaque abbreviations
stay aliases). **Step 0** = a cheap `voyage-3.5`/`-large` upgrade probe that may shrink the build. **Phase 2**
(promote views to `confident`) is **gated** on a measured separation bar — the exact test the Sprint-4
reranker failed. Adapter/fine-tune/own-model = deferred escalation on the same dataset; reranker +
single-vector doc-enrichment stay rejected. Implementation pending approval; runs on a fresh branch.

---

## Sprint 5 — Offer-observation registry: catalog hygiene (noise quarantine + gap-finding) + grounding signal

Plan: [sprint-5.md](sprint-5.md)

### 2026-06-08 — Phase B full sweep: definitive current-football ceiling = 194/2486

Added `--all` mode to `probe-offers.ts` (auto-enumerates football leaf comps via the group tree, excludes
esports) and swept **all 124 in-season football competitions** (501 fixture + 118 competition prematch events,
**0 group failures**). **Definitive current ceiling: 194/2486 (7.8%) ever-offered; 2292 never-seen.** Going
5 → 124 comps added only **+16** markets (178 → 194) — confirms **hard saturation**: current football converges
at ~194, so the 2292 unseen are NOT reachable by more current comps. They are **top-league-only deep props**
(off-season until ~Aug) + **genuine legacy** + **seasonal/out-of-window** markets. Only **2 catalog gaps**
(offered-but-missing) across all 124 comps → our catalog is ~a superset of currently-offered markets. Typecheck
clean. Next per plan: schedule the recurring fetch (b) in ~2 weeks as **WC knockouts + transfer window** post
new markets; **quarantine review ~Aug** when top leagues resume (needed to separate legacy from top-league prop).

### 2026-06-08 — Phase B first broadening: coverage saturates at ~178 (mainstream converges)

Merged 3 varied competitions into the registry: **Brazil Série B (+0 new), Copa Sudamericana knockouts (+1),
Transfers group (+1)**. Ever-offered moved only **176 → 178 / 2486**; never-seen 2308. **Finding: mainstream
competitions converge fast** — a full 2nd-tier league + a continental knockout cup + the transfers group
together added ~2 criterions. The ~2308 unseen are dominated by **top-league-only deep player props**
(off-season now) + **genuine legacy** + seasonal/out-of-window markets. This **supports the "lots of legacy"
hypothesis** (5 varied comps offer only ~180 of 2486) but we **cannot yet separate legacy from top-league-prop**
until top leagues are in season (~Aug). Notable: the live Transfers group offered just **1** criterion (one
"to sign for" type across 18 events); our catalog's elaborate transfer specials ("Appointed as Assistant
Coach", "most signings on deadline day") did NOT appear → likely legacy. **Phase B is now wait-and-accumulate**
— further coverage needs top-tier leagues in season + calendar time (forward-only; the API has no historical
backfill). Quarantine stays gated. Registry now spans 5 groups (WC, Friendlies, Série B, Sudamericana, Transfers).

### 2026-06-08 — Phase A done: accumulating offer registry built + seeded

Evolved `scripts/probe-offers.ts` from snapshot-overwrite → **accumulating, idempotent-per-group merge** into
`data/football/offer-registry.json` (per criterion: `firstSeen/lastSeen/byComp/levels`; per group: event
counts). Only **NOT_STARTED (prematch)** events counted (in-play trims the menu). Verified: **typecheck clean**;
**idempotent** (re-running a group leaves totals unchanged). Seeded with **WC-2026 (72 fix + 67 comp prematch)
+ International Friendlies (9 fix)**.

Findings: **176/2486 ever-offered**; **2310 never-seen** (legacy candidates — NOT actioned; gated on the
seasonal-cycle coverage bar). The internationals added **0 new** criterions (their 92 ⊆ WC's 176) → mainstream
markets dominate, so shrinking the 2310 needs **different competition types** (top leagues w/ props, knockouts,
transfer windows), not more mainstream fixtures. **Gap report found 2 catalog-missing markets** offered live:
`Brazil Serie A player to score most goals…`, `Number of different goalscorers for the Team…`. Next (Phase B):
broaden pulls across competition types over time; Phase C (reviewed quarantine) stays gated on the coverage bar.

### 2026-06-08 — Reframed to catalog hygiene (accumulating offer registry); grounding nudge → secondary

After the pilot showed the grounding nudge is **mainstream-only** (deep player props are top-league-only Opta;
June data thin), reframed Sprint 5 around the higher-value, better-fit use of offer data: **catalog hygiene**.
`football_criterions.json` is every criterion ever created (old/legacy/current); the feed has **no lifecycle
field** (only `shownInLive`/`shownInPreMatch` — true for 1923/2311 unseen, useless), so the **offering API is
the only noise signal**. Decision: build an **accumulating ever-offered registry** (`criterionId →
firstSeen/lastSeen/nEvents/competitions/levels/freqs`), unioned across competitions over time. **Iron rule:
trust presence, never absence-from-a-snapshot** — the WC unseen set is dominated by REAL out-of-season markets
(`Next Card`, penalty shootout, 1st-half booking points), so snapshot-pruning is unsafe. Quarantine never-seen
legacy **only after a seasonal-cycle coverage bar** (tiers + transfer window + knockouts), **reviewed +
reversible** (like the participant quarantine), never hard-delete. The same registry yields a **gap report**
(offered-but-missing markets — 2 already found). The `level`+`frequency` grounding nudge → **Phase D,
deferred** until a prop-rich in-season source. `sprint-5.md` rewritten around this; `probe-offers.ts` to
evolve from snapshot-overwrite to accumulating merge.

### 2026-06-07 — Phase 0 pull executed; WC-only sample NO-GO (coverage), signal validated in miniature

Built `scripts/probe-offers.ts` (events-first → batched `/betoffer/event` under the 2000-betoffer cap) and
confirmed API access (public CDN `eu.offering-api.kambicdn.com`, **no auth**). Pulled the full WC-2026 group:
**40,280 betoffers / 139 events (72 fixture + 67 competition)** → `data/football/offer-stats.json`.

**Signal is clean** (concept validated in miniature): level split **108 fixture-only / 69 competition-only /
0 both** (perfectly disjoint), `Both Teams To Score` → fixture freq **1.0**, real frequency gradient (main
markets 1.0; corners/cards/offsides ~0.667). **But coverage is far too thin to run the gate:** only
**177/2486 (7.1%)** criterions offered, and **only 1 of the 9 failure targets is observable** — 8/9 unoffered
(penalty, per-player offside, per-player tackles, header, score-first, extra-time, win-to-nil; `qualify` is
moot at the finals). Root cause = **pre-tournament timing**: all 139 events `NOT_STARTED`; main/team markets
post on every match, the **deep per-player prop tail isn't posted yet**. Also surfaced **2 offered markets
absent from our catalog** (a real completeness gap the live feed reveals — supports the planned regular fetch).

**Verdict: NO-GO on this sample — concept sound, data not ready.** Did NOT wire the trial nudge into the
grounder (1/9 observable → the gate's ≥3-flip bar is unreachable; the data cannot move the metric).

**Live/imminent-prematch follow-up (same day).** Probed beyond the WC: an in-play match (`STARTED`) trims to
**21 criterions** (live betting suspends most markets — richness is *prematch*, not live), and the richest
*imminent* prematch internationals (Colombia–Jordan, +1.2h, **108 criterions / 35 player-prop types**) still
**lack the deep per-player count tail** — tackles **0**, per-player offsides **0** (only *team* offsides).
Those (`Player's tackles completed`, `Player's offside infringements`) are **top-league-only Opta props**, not
posted on friendlies or pre-tournament tournaments. Offered mainstream markets that WOULD get a clean signal:
win-to-nil per-side, score-first, header. **Refined conclusion:** the offer-frequency lever is real but
**mainstream-only**, and the Tier-1 9-failure set is **prop/alias-heavy → the wrong validation set for it**.
Resume the offer build against a **top-league in-season source** (full Opta props + real frequency), validated
against **mainstream near-tie / noise** cases (e.g. the penalty-combo and win-to-nil-combo shortlist cleanups).
Meanwhile the offer-independent failures (#1 `main` sentinel, #4 `win`→`qualify`, #6 `Extra Time` alias shadow,
+ the deep-prop accept-set/twin issues) are unblocked alias/tier work.

### 2026-06-07 — Plan drafted (not started)

Designed a non-destructive catalog enrichment (architecture **decision 26**): learn two signals from real
offerings — a per-criterion **`level`** tag (fixture/competition) and an **offer `frequency`** — and fold them
into grounding as a **reward-only** tie-breaker on `adj` (never `gate`/`THRESHOLD`/alias-head, so it can't mint
a false confident and the verbatim floor is safe by construction). Motivated by the true-distribution probe
(75%): **~3–4 of the 9 failures are "gold present but buried"** by combo/novelty noise or a wrong-level sibling
(#9 offsides → level; #3 penalty → frequency), which these signals address; the rest are alias/sentinel/synonym
gaps (separate work). Key decisions: **reward-only** (positive observations only; absence never penalizes → no
deletion trap); signals **baked into `football_criterions.json`** with the version hash kept over **`(id, name)`
only** (a frequency refresh never false-triggers a paid Voyage re-embed; an add/remove still does — correct);
**fetch → committed snapshot → `build-catalog` pure-join** wiring (reproducible, offline-testable), aligning
with the future unified fetch (criterion + level + frequency refreshed together). Verified blockers that force
the API as the only reliable level source: the **category feed cannot carry level** (6 competition-only vs 6309
fixture-only; the #9 pair sits in `pre_match_*` on both sides), and the **vector path ignores `level`** today
(only aliases read it) while criterions carry **no `level` field**. **Gated on a measure-first pilot:** pull the
WC-2026 group + 1–2 live leagues, re-score the existing 9 probe failures + paraphrase reds with a trial nudge;
**GO only if ≥3 flip with 0 verbatim-floor regressions.** First sub-step is a hard dependency — confirm API
access (no HTTP client in the repo yet). Implementation pending.

---

## Sprint 4 — Self-improving test loop: Tier-1 catalog grounding sweep (+ Tier-2 behavior corpus)

Plan: [sprint-4.md](sprint-4.md)

### 2026-06-08 — Extraction-failure probe round: #1 fixed (who-wins→`main`), #2 reverted (shut-out ambiguity)

Probed the **2 extraction failures** from the extractor→ground probe via `scripts/probe-both.ts` (logged as
**Q67** in `EvaledQueries.md`), root-caused both, then ran one disciplined fix-round.

**#1 — interrogative match-result → marketless `main` — FIXED.** "who wins / comes out on top / prevails
X vs Y" collapsed to `main`, while the noun "winner" already became `"match winner"` (→ Match Odds via the
decision-23 fixture alias). Root cause: Step 3's cut was framed as *event-noun vs outcome-**noun***, biasing
the model to require a market noun — a question has none. **Sport-agnostic rewrite** (no football terms):
*event-reference vs outcome, where an outcome may be a noun **or a question***; a who-wins question names the
result outcome → `"match winner"`, with a whole-competition scope guard. **No grounder/alias change.**
Verified regression-clean (outright / `main` / fixture_lookup / first-goalscorer untouched). Tier-1
extractor→ground probe **27 → 28/36 (77.8%)**.

**#2 — "shut out" → wrong "win to nil" — REVERTED (not fixed).** Two sport-agnostic prompt rewrites
(broaden anti-paraphrase to "different market name"; then "don't add an unstated outcome / compound market")
**both failed** to move Haiku off `"shut out"`→`"to win to nil"`. On reflection "shut out" is a **defensible
ambiguity** — in American sports a "shutout" implies a *win* (= win-to-nil); only in soccer does the
clean-sheet (concede-zero, draw-allowed) reading dominate — and the by-construction label (player clean-sheet
for a *team* query) is shaky. Per *stop-tweaking*, reverted both the prompt edits **and** the disjoint alias.
The residual 8th probe fail is this ambiguity, not a crisp bug.

**Net shipped diff (this round):** the **#1** sport-agnostic Step-3 rewrite in `extractor-prompt.md` — nothing else.

### 2026-06-06 — Scoring: `narrowed` pass + probe results logged with market_concept

**Scoring change (both tests):** added a `narrowed` PASS class — when the correct market is present in a
non-confident `ambiguous`/`shortlist` set, it counts as a pass (the executor clarifies, but grounding didn't
*lose* it). Applied to `catalog-sweep.ts` (classify) and `extractor-ground-probe.ts`. New numbers:
- Verbatim floor: **2485/2486 (100.0%)** [clean 2460 + twin 25 + narrowed 0] — unchanged (no ambiguous/shortlist there).
- Paraphrase batch: 8/36 → **14/36 (38.9%)** (+6 narrowed).
- Extractor→ground probe: 23/36 → **27/36 (75.0%)** [clean 23 + narrowed 4].

**Logging:** `tier_1_automation.md` now carries an **Extractor → Ground Probe** section (between `PROBE`
sentinels the no-LLM sweep preserves), logging the **`market_concept` for every query**, failing queries
(9) listed first with their extractor concept + grounding response.

**No-LLM hygiene:** added `data/football/tier1-extractor-cache.json` (query → extractor plan), so the probe
re-scores / re-logs / re-grounds **without re-hitting Haiku** — only uncached queries call `extract()`.
Populated from the captured run; the probe ran fully LLM-free for this update.

### 2026-06-06 — 3 disjoint-synonym aliases + reranker-on-extractor-concepts test

**Aliases (decision 25, routed):** added 3 lexically-disjoint betting-synonym bridges to `aliases.json` —
`win or draw`→Double Chance, `set up a goal`→To Assist, `booked`→To Get a Card (the genuinely-disjoint gaps
spike (b) surfaced). **Verified:** ship gate **PASS 8/8**, verbatim floor still **100.0%** (0 regressions),
alias table **171→174**. They also lifted the direct-paraphrase batch 13.9%→**22.2%** and the extractor probe
55.6%→**63.9%** (the 3 cases now ground via alias).

**Reranker on the extractor's market_concepts (the untested combo):** wired the reranker into `vectorGround`
as opt-in (`GROUND_RERANK=1`, default OFF) and re-ran the probe. **Result: 17/36 (47.2%) ON vs 23/36 (63.9%)
OFF — net −6.** It broke 8 previously-confident cosine groundings (`outright winner`→Winner, `winning
margin`, `half time full time`, `odd/even`, `first goalscorer`, `stoppage goal`, `red card`, `completed
passes`) while fixing only 2 tie-breaks (`opens the scoring`→Team to score first, `BTTS 1st half`). So the
reranker is a **net negative at BOTH stages** (aggressive paraphrases AND clean extractor concepts) —
confirming the shelving decision: it demotes/displaces correct vector groundings more than it rescues. (The
provisional 0.5 threshold accounts for some demotions, but the calibration showed no threshold cleanly
separates gold from distractors, so it doesn't change the verdict.) **Reranker code fully reverted** —
embed.ts back to identical-with-main, no rerank wiring in the grounder; the finding lives here in STATUS.
The validated path forward is the extractor's normalization (free) + disciplined lexicon aliases.

### 2026-06-06 — Spike (b): true-distribution probe (extractor → ground)

Built `scripts/extractor-ground-probe.ts` + `data/football/tier1-extractor-queries.json`: 36 realistic USER
queries (same target markets as the paraphrase batch) run through the REAL extractor (Haiku), then the
emitted `market_concept` grounded (mirrors run.ts wiring). Graded with an auto accept-set (target + its
settlement/register twins) — the "accept-set, not single-id" fix. This measures the production distribution
(extractor normalization in the loop), unlike the no-LLM sweep.

**Result: 20/36 = 55.6% strict — 4× the direct-paraphrase batch (5/36 = 13.9%) on the SAME markets.** The
extractor normalizes casual queries into standard betting vocab, which then hits the alias/exact-name head:
"how many corners in the Brazil game" → market_concept `total corners` → exact name (vs the direct paraphrase
"number of corner kicks in the match" → vector rank 651, miss). 11/20 wins land via name/alias, 9 via vector.

**The paraphrase batch was pessimistic/unrepresentative** — it fed the grounder a hand-authored paraphrase of
a catalog NAME, skipping the extractor's normalization. With fair grading (gold present in an ambiguous/
shortlist set = "narrowed", plus near-twins/defensible alt-readings) the effective rate is ~28/36 (~78%).

**Residual failures are NOT broad vector weakness — they cluster:** (a) lexically-disjoint betting synonyms
the LEXICON should bridge — "to win or draw"→Double Chance, "to set up a goal"→To Assist, "to be booked"→To
Get a Card (alias candidates, decision 25); (b) tier near-ties where the gold IS in the set — "offsides"
→[Total Offsides|Most Offsides], "tournament top scorer"→[Top Goal Scorer|Goal Scorer]; (c) a few genuine
grounder misses — "to win the World Cup"→"To qualify for the World Cup" (level-alias gap), "penalty to be
given"→combo junk; (d) debatable labels — extractor read "shut out"→`to win to nil` (defensible), not clean
sheet. **Reframed priority: with the extractor in the loop, the lexicon (aliases) + a few tier/level fixes
matter more than the reranker/model-upgrade levers.** Confirms the accept-set need before any tuning.

### 2026-06-06 — Reranker spike (Voyage rerank-2.5) — measured, NOT shipped

Spiked lever #1 (cross-encoder reranker) to lift the weak voyage-3 paraphrase tail. Added a `rerank()`
seam to `embed.ts` (Voyage `rerank-2.5`, same key/REST, zero new deps), then **calibrated on the paraphrase
batch before wiring anything in** — reranked each paraphrase's cosine top-30 pool and measured where the
gold lands.

**Result — the reranker does NOT help (slightly hurts):** exact gold = #1 after rerank in only **3/36**
(cosine baseline was 5/36 clean), and **no threshold separates gold from distractors** (at 0.50: 3 golds
pass, 27 non-golds would be falsely crowned). **Root cause is not the matcher** — the reranker shares
cosine's failure mode: it rewards the catalog's huge tail of wordy combo/novelty markets that literally
contain the query words, over the terse canonical market whose short name the paraphrase doesn't lexically
overlap. Worked examples: `"to be booked"` → "To be the only player booked for his team" / "To score & get
booked" (not "To Get a Card"); `"number of corner kicks in the match"` → "Match outcome & total corners
(9.5)" (plain "Total Corners" not even top-4); `"who wins the match"` → "Team scoring first to win the
match" (not "Match Odds").

**Decision:** do **not** wire the reranker into `vectorGround` (would add false confidents for no gain).
Kept the `rerank()` seam (validated, reusable). **Real levers identified by the spike:** (a) a
**canonicality / specificity prior** to suppress the combo/novelty tail (the grounder's existing
`specificityPenalty` is the seed; the reranker bypassed it), and (b) **lever #2 — paraphrase doc-views**:
give terse canonical markets a user-language vector ("Total Corners" ← "number of corner kicks in a match"),
which directly fixes the terse-name + recall-bound miss this spike exposed. Also surfaced: several v1 gold
labels are debatable (a paraphrase often has several valid catalog siblings) — the paraphrase batch needs an
**accept-set** (like the scorer's `accept[]`), not a single-id target, before further tuning.

### 2026-06-06 — Tier 1 built + run + one fix-round (branch `sprint-4-tier1-catalog-sweep`)

**Built:** `scripts/catalog-sweep.ts` — the no-LLM catalog round-trip sweep. Reuses `ground-snapshot.ts`'s
dotenv loader + `groundMarket`, and the scorer's now-exported `idsContainGold` (E13). Two passes reported
apart: a **verbatim floor** over all 2486 kept criterions (name-derived concept) and a **head paraphrase
batch** (`data/football/tier1-paraphrases.json`, 36 Opus-authored mild paraphrases — the vector tail).
Classifies each `clean | twin | none | below | ambiguous | wrong-id | wrong-bucket`; writes the full
per-test log to `planning/queries/tier_1_automation.md` (EvaledQueries format); asserts **0 quarantine
leaks**.

**Result — verbatim floor: 2485/2486 pass (100.0%)** [clean 2460 + twin 25], 0 leaks. The 1 residual is a
benign `"Passes By The Player"`→`"Player's passes completed"` (`passes`≈`passes completed`) lexical variation.

**Paraphrase batch: 5/36 pass (13.9%)** — the floor-green / paraphrase-red overfitting tell, as designed.
Score probes show most golds at raw cosine **0.32–0.47** (genuine voyage-3 weakness, not a calibration miss;
only `"the exact final scoreline"`→Correct Score at 0.540 is borderline). Caveat: several v1 paraphrases
drifted toward verbose definitions (the drift the spot-check targets) — a milder batch would score higher.

**Fix-round (this turn):**
- **Grounder (real bug, decision 25):** reordered `resolveMarket` so an **exact catalog name beats a loose
  subset alias** — a long market that is itself a catalog entry (`"Match to go into Extra Time"`) was being
  shadowed by a shorter subset alias (`"extra time"`→`"Extra Time"`). Exact alias-key still fires first;
  the subset fallback moved to after exact-name. Fixed **41 verbatim failures**, **0 alias growth**.
- **Sweep measurement:** added a `twin` pass class (same market under a settlement/`Player's`/`By The
  Player` register-folded sibling id) — the sprint's "real variant set = a pass".

**Verified:** `npm run typecheck` clean; `npm run eval` **ship gate PASS (8/8)**, 0 regressions; `ground-
snapshot diff` **0 regressions, +1 win** (top goalscorer ambiguous→confident), 2 benign other-changes.
Alias table unchanged at **171**.

**Decision:** disjoint-vocabulary aliases from the paraphrase batch (`"shut out"`→clean sheet, `"spot
kick"`→penalty) **deferred** — real synonyms but 1 seed each; gated on a fuller paraphrase batch that
confirms recurrence (alias growth is a tracked smell). **No threshold recalibration** (36 seeds ≠ a
distribution; golds sit at raw 0.32–0.47, genuine vector weakness not a tuning miss). Alias table stays
**171**. Next: a fuller, drift-spot-checked head paraphrase batch (few hundred) → then any
distribution-based calibration. Tier 2 remains gated/unbuilt.

### 2026-06-06 — Plan drafted (not started)

Designed a two-tier, self-improving test strategy (architecture **decision 25**, extending eval E1–E13).
**Tier 1** (this iteration): a no-LLM **catalog round-trip sweep** — feed a concept built from each of the
2486 groundable criterions, assert it grounds back to that id (E13 containment), report coverage +
plain-English shortcomings, one disciplined fix-round, retest. Delivers "maximum catalog coverage"; the
answer-key is the catalog row, so the grounder never grades itself (E8-clean). **Tier 2** (next, gated):
big-model-proposed / human-labeled behavior×shape gold toward ≥5/tag, a locked held-out slice, a semi-auto
human-gated loop. **Alias discipline locked as a hard rule** (decision 25): alias only to bridge a
lexically-disjoint gap vectors can't, never to patch a tuning miss; track alias-table growth. Scope = market
grounder only; live/in-play pinned as a tracked abstain case; odds/time tested as capture. Runs on a **fresh
branch**. Implementation pending.

---

## Sprint 3 — Collision handling: catalog rebuild + subject-filtered, tiered grounding

Plan: [sprint-3.md](sprint-3.md)

### 2026-06-03 — Stage B complete; Stage C code-complete (E13 scorer + tier threading); paid verification pending

**Stage B landed** (the older entry below saying "B not started" is now stale). `ground-market.ts` runs the
full decision-20 chain: hard **subject pre-filter** (`bySubject[kind]`), **`line→boType` gate** + **period
SOFT penalty**, and a **`tier`** on `GroundResult` (`confident | variants | ambiguous`; below threshold →
`none`, E5). Added a **named-team per-side divert** (a query naming one team that lands on a match-level
market diverts to that team's side-split). Seed-probed green.

**Two collision refinements beyond the plan.** (1) **Grounder-side exact-name canonicalization** — the
exact-name step now tries the bare text, then a **settlement-suffix-stripped** index ("… (Settled using
Opta data)"), then the catalog's **"Player X"/"Player's X"** registers; bare-first. (2) **Extractor
canonical phrasing** (`extractor-prompt.md`) — a bare count noun emits `"total <noun>"` ("Over 2.5 goals" →
"total goals"), and a player yes/no achievement emits the infinitive ("anytime goalscorer" → "to score",
"clean sheet" → "to keep a clean sheet"). Both push the market into the catalog's own register so the
deterministic exact-name path fires instead of a fuzzy collision — fixes "shots on target" → `2100015085`
(was grounding to the narrower "Headed Shots on Target"). Probes logged in
[EvaledQueries.md](../queries/EvaledQueries.md).

**Stage C steps 9 + 8 (this change).** *Step 9 (threading):* `groundSelectors` now returns the full
`(GroundResult | null)[]` (ids **+ tier**) instead of bare id-arrays; `scoreRun` takes `grounded[]` (a
**type-only** import of `GroundResult` — runtime stays acyclic, since `ground-market` imports `normalize`
the other way); banner → `Mode: GROUNDED (market axis by id; tiered, subject-filtered)`. *Step 8 (E13
grading):* the market axis moved from id **set-equality** → **containment + tier** — `idsContainGold`
replaces `idSetEqual`; a pair needs the gold id(s) **⊆** the returned ids AND `tier ∈ {confident,
variants}`; a containing-but-`ambiguous` selector becomes a recorded **failure** ("ask the user", never a
green cell — the doc's rejected "containment alone" case). `npm run typecheck` clean; a 6-case offline unit
check (no API) passes — incl. the key upgrade *variants-containing-single-gold now PASSES* (set-equality
failed it) and *ambiguous-containing-gold FAILS*.

**Remaining for Stage C.** Only the **paid-Haiku verification suite** is left (awaiting go-ahead before
spending): `--id g001` under E13, full `npm run eval` ship gate (g002 untouched, g003 BTTS → `1001642858`),
and `--release` 5×. Three knobs (threshold+ε, suffix strip-list, quarantine guard) stay uncalibrated by
design.

### 2026-06-03 — Stage A: full category feed decorated + catalog re-joined (FULL union)

Pulled the **full** offering-api category feed and added `src/resolver/build-categories.ts` (npm
`build:categories`, pure local transform — no API). It collapses the **28 UI `categoryGroups`** (retail /
digital-signage / player_props / *_us / list_view…) into the flat shape `build-catalog.ts` joins against:
dedupe categories by id (a category id is one logical category regardless of UI group — `categoryGroupName`
ignored, per the feed owner), union each id's mappings (deduped by `criterionId|boType`), and resolve numeric
`boType → boTypeName` via the inverted `football_betoffertypes.json`. Committed the raw response as
`football_categories.raw.json` (mirrors the criterions raw snapshot) so the build is reproducible/cron-ready.
Result: **395 categories, 11927 mappings, 8550 distinct criterions**.

**Two decisions worth recording.** (1) Category NAME = the feed's `name` (lang=en_GB display label), **not
`englishName`** — `englishName` is sometimes an internal slug or a different label ("Total Goals"→"totals",
"Full Time"→"Match"), and subject tagging keys off the display name, so a wrong name silently mis-buckets a
whole category. (2) boType ids **5 (9 mappings) and 15 (7 mappings)** aren't in `football_betoffertypes.json`
(scattered across Other Bets / Penalty Shootout / Team Progress) — `boTypeName` is **omitted** (numeric
`boType` kept) rather than guessed; `build-catalog.ts` already guards `if (m.boTypeName)`, so the criterion
still joins its category, just with no boType-gate signal.

**Re-ran `build:catalog` against the full feed (version `0f2aac930df9`).** Referenced **8550** →
**kept 2486 + quarantined 2437 + 3627 dropped** (referenced by categories but absent from the criterion
feed). Partition is exact (2486+2437+3627=8550) and the **groundable 4923 / missing 3627** split matches the
pre-build coverage estimate to the unit. Subject **player 705 / team_or_match 1781**; g001's `2100015085`
present, tagged player, boTypes `[head, overunder, playeroccurrenceline]`. Quarantine eyeball: 514 generic
scorer markets kept ("To Score", "Next Goalscorer", g001); every quarantined "generic-looking" row is a real
per-player combo ("Total Shots on Target by Alexander Isak & Marcus Berg"). Typecheck clean.

**The 3627 gap is the criterion feed, not the join.** `football_criterions.raw.json` simply doesn't contain
those ids — the categories reference markets the criterion snapshot lacks. Closing it fully needs a richer
criterion feed; the build reports the gap loudly (the `⚠ … no en_GB name` line) rather than hiding it.

**Index rebuilt to match** (paid Voyage `npm run build:index`, user go-ahead 2026-06-03):
`criterion-vectors.voyage-3.json` — **2486 vectors, dim 1024, catalogVersion `0f2aac930df9`**. Verified
1:1 against the kept set (no missing/extra ids), every entry carries `subject` + `boTypeNames` for the
query-time gates, and g001 `2100015085` is present (player, 1024-dim). Stage A is now end-to-end complete
(categories → catalog → index). Stages B (subject-filtered/tiered grounding) and C (E13 scorer) not started.

### 2026-06-03 — Stage A (catalog rebuild) code-complete; index re-embed pending

Built the rebuild prerequisite. New `src/resolver/build-catalog.ts` (npm `build:catalog`, pure local
join — no API) joins the **full** raw criterion feed ⋈ category feed, subject-tags each criterion,
quarantines per-player pre-baked rows, and stamps a content **version**. Verified output:
**referenced 1151 → kept 1093 + quarantined 58**; subject **player 372 / team_or_match 721**; g001's
`2100015085` "Player Shots on Target" is back, tagged **player**, and `byName` resolves it; typecheck
clean; the loader reads the new artifact. `catalog.ts` now exposes `subject`/`bySubject`/`version`;
`build-market-index.ts` carries `subject`+`boTypeNames` per entry and stamps `catalogVersion` (code only).

**Subject-tag refined (deviates from the literal plan; user-confirmed).** The written `Player*`-prefix
rule mislabels **13 real player markets** (Goal Scorer "To Score"/first/last, Either Player ×5, Man of
the Match ×2). Rule is now **curated player-category set** (10 `Player*` + {Goal Scorer, Either Player,
Man of the Match, Goalkeeper Saves}) **minus explicit team-side rows** ("- Home/Away Team", the 2 mixed
GK-saves rows) → all 15 edge cases correct. Decision 20 updated. Quarantine needed **diacritic folding**
(NFD) — en_GB names ASCII-flatten player names ("Muller") while the participant feed keeps diacritics
("Müller"); without folding only 8 matched, with it **58** (all real full names; common-word guard holds).

**Remaining for Stage A:** `npm run build:index` — a **paid Voyage** re-embed of the 1093 post-quarantine
names into a version-stamped index. The current index is **stale** (600 ids, no version stamp, missing
`2100015085`), so vector grounding can't hit the target until it's rebuilt. **Awaiting go-ahead** before
spending. Stages B (subject-filtered/tiered grounding) and C (E13 scorer) not started.

### 2026-06-03 — Plan drafted (not started)

Designed the same-vocabulary collision fix (architecture **decision 20** + eval **E13**): deterministic
**subject pre-filter → cosine → facet-boost → tier**, replacing Sprint 2's single-id raw cosine. Staged
A (catalog rebuild — full criterion⋈category join, subject tag, participant quarantine, version stamp) →
B (`ground-market.ts`: hard subject filter, `line→boType` gate + period penalty, `tier` on `GroundResult`)
→ C (`structural-scorer.ts` E13: containment + tier-aware grading). Verified prerequisite: the committed
criterions snapshot is **trimmed** — 598 listed vs **1151** category-referenced ids; **553 missing incl.
g001's `2100015085`** (315 of them `Player*`), so the target is ungroundable until the rebuild. Three knobs
left uncalibrated (threshold+ε, non-semantic suffix strip-list, quarantine common-word guard), each
fails-safe. Rejected: categories as a 2nd filter (redundant post-subject), cross-encoder (deferred),
suffix-penalty / LLM market-disambiguation (E8 gold-fitting / superseded). Implementation pending approval.

---

## Sprint 2 — Market grounding (criterion star) + id-graded market axis

Plan: [sprint-2.md](sprint-2.md)

### 2026-06-01 — Plan drafted (not started)

Drafted the Sprint 2 plan: ground `selector.market_concept` text → criterion id(s) via curated
alias (head) + voyage-3 cosine over criterion-name vectors (tail), then swap the scorer's market
axis from text (`accept[]`) to catalog id (doc E3). Staged A (catalog + alias + scorer id-swap) →
B (voyage-3 vectors + `build:index`) → C (subject-aware side-split for `team total goals`). SQLite
deferred (decision 10). Scope: market axis only — entities/competition/attrFilter stay text.
Implementation pending approval.

---

## Sprint 1 — Bootstrap a runnable structural eval

Plan: [sprint-1.md](sprint-1.md)

### 2026-06-01 13:05 CEST — Prompt refinements from ad-hoc probing (2 fixes)

Probed the extractor with 5 messy WC-26-style queries (Mbappé / Bellingham / Modrić /
Yamal / Bruno Fernandes) via `--query`. Two real issues found and fixed in
`resolver/extractor-prompt.md`; eval still 3/3, ship gate PASS (no regression).

1. **Empty-odds crash.** "…odds/price" with no number made Haiku emit `odds: {}`, which
   fails schema validation (`need >=1 bound`). Added an odds-section rule mirroring the
   existing line-no-number rule: a number-less price mention → omit `odds`, never emit `{}`.
   Confirmed: "team to score first odds" now omits odds instead of crashing.
2. **Self-correction miss.** "Haaland-less Norway out — sorry, with Modrić in the lineup"
   kept the retracted `Norway`. Rule 5 already covered the pattern; reinforced it with a
   matching worked example. Confirmed: `teams` now `[]`, only Modrić retained.

Note: these 5 probes are good candidates for gold records — they exercise the still-uncovered
tags `coref-his`, `coref-his-team`, `self-correction`, `player-role`, `line-no-number`.

---

### 2026-06-01 12:35 CEST — Sprint 1 COMPLETE — eval passes 3/3, ship gate PASS

**Status:** Done. The loop runs end-to-end against Haiku; `npm run eval` and
`npm run eval -- --release` both green. Typecheck clean.

**Live run results**
- `npm run eval` (1×): g001 / g002 / g003 all PASS. Ship gate PASS, exit 0.
- `npm run eval -- --release` (5×): 5/5 on all three — reproducible at temp 0 (E10).
- Critical tags binding / abstain / either-team / sport-default = 100%; soft stage /
  odds-only-bounds = 100%.

**Two fixes made during verification**
1. `eval/run.ts` `loadDotEnv` — was skipping a `.env` key when the shell already exported
   it as an **empty** string (`key in process.env` is true even for `""`). Changed the guard
   to skip only when the existing value is non-empty (`process.env[key]`).
2. `resolver/extract.ts` — Haiku serializes the `plan` tool field as a **JSON string**
   (not a nested object) because the wrapped field's schema is an `anyOf` (the status
   discriminated union — the doc's open question). Added a boundary decode: if `plan` comes
   back as a string, `JSON.parse` it before `QueryPlan` validation.

**First prompt-quality signal (resolved with user)**
- g003 ("Both teams to score markets priced over 1.90") initially failed: Haiku emitted
  `line {binary, yes}` + `odds {min:1.90}`, faithfully following the prompt's "named yes/no
  market defaults to yes" rule — but gold expects **odds-only** (price filter, no side).
- User ruled gold canonical. Added a **price-only exception** to the binary-line rule in
  `resolver/extractor-prompt.md`: a yes/no market named with only a price bound and no side
  word → omit `line`, emit only `odds`. g003 now passes 5/5.

**Removed** unused `zod-to-json-schema` dep (switched to zod v4 native `z.toJSONSchema`).

**Remaining (fast-follow, out of Sprint 1 scope)**
- [ ] Corpus expansion to ~5/tag, incl. the 11 currently-uncovered tags (coref-his,
      line-vs-price, attrFilter, player-role, level, time, self-correction, age-normalize, …).
- [ ] Grounding + the id-based scorer; catalog build pipeline; executor/live layer.

---

### 2026-06-01 12:10 CEST — Implementation code-complete (live run pending API key)

**Status:** All code written and statically verified. The live Haiku eval on the 3 seeds is
the one remaining step, blocked only on `ANTHROPIC_API_KEY` not being set in this environment.

**Completed**
- Project setup — `package.json`, `tsconfig.json` (strict + `noUncheckedIndexedAccess`),
  `.gitignore`, `.env.example`.
- Extractor runner — `resolver/extract.ts` (Haiku, `temperature: 0`, forced tool use via
  `emit_query_plan`, ~11 KB system prompt with `cache_control: ephemeral`).
- Structural scorer — `eval/structural-scorer.ts` (`normalize`/`looseMatch`, status gate,
  sport, market pairing vs `accept[]`, binding, line/odds, soft `event_scope`).
- Harness CLI — `eval/run.ts` (manual `.env` load, `--query`/`--id`/`--release`, per-tag
  pass-rate, ship gate, non-zero exit on critical miss).
- Switched to **zod v4 native** `z.toJSONSchema()`; uninstalled unused `zod-to-json-schema`.
- Verification done so far:
  - `npm run typecheck` — clean (no type errors).
  - `resolver/extract.ts` imports cleanly → `z.toJSONSchema` builds the input schema at load.
  - All 3 gold seeds validate against `GoldRecord`; scorer status-gate confirmed pass/fail
    offline (g002 unsupported-vs-unsupported → pass; unsupported-vs-resolved → fail).
  - Missing-key path exits cleanly with a clear message (exit 2).

**Remaining**
- [ ] Set `ANTHROPIC_API_KEY` (export or copy `.env.example` → `.env`), then run
      `npm run eval` on g001 / g002 / g003 and confirm per-record verdicts + ship gate.
- [ ] `npm run eval -- --release` (5×) to confirm temp-0 reproducibility.
- [ ] (fast-follow, out of scope) corpus expansion to ~5/tag + the id-based grounding scorer.

---

### 2026-06-01 11:33 CEST — Sprint kicked off

**Status:** Scaffolding only — implementation not started.

**Completed**
- `planning/sprints/` folder created.
- Plan captured in `sprint-1.md` (approved).

**Remaining**
- [ ] Project setup — `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`.
- [ ] Extractor runner — `resolver/extract.ts` (Haiku + forced tool use + prompt caching).
- [ ] Structural scorer — `eval/structural-scorer.ts` (+ `normalize`/`looseMatch` helper).
- [ ] Harness CLI — `eval/run.ts` (load gold, run N×, per-tag pass-rate, ship gate).
- [ ] Install deps + verify `npm run eval` on the 3 seeds (g001 / g002 / g003).
