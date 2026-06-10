# Sprint 5 — Offer-observation registry: catalog hygiene (noise quarantine + gap-finding) + grounding signal

> Full design context: `docs/architecture.md` (**decision 26** is this sprint; supporting: decision 20
> grounding chain/tiers, decision 23 level-scoped aliases, decision 25 alias discipline; eval **E8**
> neutral grader, **E11** stale-index guard, **E13** containment). Builds on Sprint 4
> ([sprint-4.md](sprint-4.md)). Progress in [STATUS.md](STATUS.md). Embedding model unchanged: Voyage
> `voyage-3`. API reference: [docs/OFFERING_API.md](../../docs/OFFERING_API.md).

## End goal (plain English)

`football_criterions.json` is **every criterion ever created for football** — old, legacy, and current. A
large fraction is **dead noise that will never be offered again** (e.g. `Total shots on target by Mark Noble`,
a retired player). The catalog feed carries **no lifecycle signal** to find it (only `id, names,
shownInLive, shownInPreMatch`; `shownInPreMatch` is true for 1923/2311 unseen markets — useless), so the
**offering API is the only way** to tell live from legacy.

Build an **accumulating "ever-offered" registry** from real offerings and use it for, in priority order:
1. **Catalog hygiene (primary):** identify dead/legacy criterions (never offered after broad, sustained
   observation) → **reviewed, reversible quarantine** (never hard-delete). Also surface **gaps** — markets
   offered live that are *missing* from our catalog (2 already found in the WC pull).
2. **Grounding signal (secondary, deferred):** a per-criterion `level` tag + `frequency`, folded into
   grounding as a **reward-only** tie-breaker. The WC pilot showed this lever is real but **mainstream-only**
   and needs prop-rich in-season data, so it trails the hygiene work.

**The iron rule (whole sprint):** trust **presence**, never **absence-from-a-snapshot**. "Seen offered" =
live, immediately. "Never seen" = legacy *only* after coverage spans the seasonal cycle.

## What the measure-first pilot established (2026-06-07, see STATUS)

- API access works (public CDN, no auth). `event/group` → events tagged `MATCH`/`COMPETITION` (= level);
  `betoffer/event` in batches under the **2000-betoffer cap** → betoffers carrying `criterion.id`.
- Full WC-2026 pull: 40,280 betoffers / 139 events. **Signal is clean** (level split 108/69/0; BTTS freq 1.0)
  **but a single snapshot sees ~7%** of the catalog — and the *unseen* set is dominated by **real** markets
  (`Next Card`, penalty-shootout, 1st-half booking points), not legacy. **Proves snapshot-pruning is unsafe.**
- Probing live/imminent matches: in-play **trims** the menu (21 criterions); the richest *prematch*
  internationals (108 criterions) still **lack the deep per-player count tail** (tackles/per-player offsides
  are **top-league-only Opta props**). → the grounding nudge is mainstream-only; deep-prop failures need a
  top-league in-season source. Hence hygiene-first.

## Scope

- **Non-destructive.** Noise → reversible **quarantine** (like the existing participant quarantine), human-
  reviewed; never hard-delete. Grounding signal → **reward-only**, never drops a candidate.
- **Registry is longitudinal**, not a snapshot — it accumulates across competition types and over time.
- **Quarantine only after the coverage bar** (below) is met — never from a point-in-time pull.
- **Grounding nudge deferred** until a prop-rich in-season source exists; validated against mainstream
  near-tie/noise cases, not the prop/alias-heavy Tier-1 set.
- Market grounder only; live/in-play stays a pinned abstain (decisions 9, 22).

## Key design decisions

| # | Decision | Choice |
| - | -------- | ------ |
| 1 | Noise source | **Offering API only** — feed has no lifecycle field, no cheap name heuristic (0 `*`-prefix; player-share 21% vs 29%), unseen set looks real |
| 2 | Trust model | **Presence, not absence** — seen ⇒ live now; never-seen ⇒ legacy *only* after the coverage bar |
| 3 | Registry shape | accumulating `criterionId → { firstSeen, lastSeen, nEvents, competitions:Set, levels:Set, fixtureFreq, compFreq }`; each probe **unions** in, never overwrites |
| 4 | Coverage bar | quarantine-eligible only once the registry spans the **seasonal cycle**: multiple competition tiers + a transfer window + a tournament **with knockouts** (so shootout/extra-time/transfer markets each got a fair chance) |
| 5 | Hygiene action | **reversible quarantine + human review**, never hard-delete; also emit a **gap report** (offered-but-missing markets) |
| 6 | Grounding signal | per-criterion `level` (high-confidence, API `MATCH`/`COMPETITION`; categories proven unable to carry it) + `frequency`; **reward-only on `adj`** — never `gate`/`THRESHOLD`/alias-head; add `level` to `groundMarket`'s memo key |
| 7 | Storage | derived fields (`level`, `offerFreq`, `lastSeen`, `hygieneStatus`) **baked into `football_criterions.json`**; raw registry kept **separate + accumulating**; version hash stays over **`(id, name)` only** (a registry refresh never triggers a paid re-embed) |
| 8 | Wiring | **fetch step → committed snapshot → `build-catalog` pure-join** (reproducible, offline-testable); aligns with the future unified fetch (criterion list + registry refreshed together) |

## Approach (staged)

### Phase A — the accumulating registry (build it; no grounding change)
1. Evolve `scripts/probe-offers.ts` from snapshot-overwrite to **merge-into-registry**: union each pull's
   observations into `data/football/offer-registry.json`, updating `lastSeen`, `nEvents`,
   `competitions`/`levels` per criterion. Idempotent re-runs.
2. **Seed it now** with the WC-2026 pull + the prematch internationals already fetched.
3. Emit two reports each run: **gap report** (offered ids absent from the catalog) and a **coverage report**
   (how much of the seasonal cycle the registry has spanned — which competition tiers / knockout / windows).

### Phase B — accumulate over the cycle (operational; the regular fetch)
4. Run the fetch broadly + repeatedly across live football (the planned regular pipeline) until the coverage
   bar (#4) is met. No quarantine yet — just grow the registry.

### Phase C — hygiene actions (only after the coverage bar)
5. Produce a **legacy-candidate list** (never-seen after the bar) → **human review** → reversible quarantine
   in `build-catalog` (new `quarantined` reason, mirroring the participant quarantine; assert 0 leak, E13).
6. Apply the **gap report** (decide whether to add offered-but-missing markets to the catalog).

### Phase D — grounding nudge (secondary; deferred until prop-rich in-season data)
7. Bake `level` + `frequency` onto each row; fold a **reward-only** nudge into `vectorGround`'s `adj`; add
   `level` to the memo key. Validate against a **mainstream near-tie/noise** set, not the Tier-1 prop set.

## Critical files
- **Evolve:** `scripts/probe-offers.ts` (snapshot → accumulating registry + gap/coverage reports).
- **Add:** `data/football/offer-registry.json` (accumulating, committed).
- **Change (Phase C+):** `src/resolver/build-catalog.ts` (join registry; bake derived fields; reviewed
  quarantine; hash stays `(id,name)`), `src/resolver/catalog.ts` (load fields), and — Phase D only —
  `src/resolver/ground-market.ts` (reward-only nudge on `adj`; `level` in memo key).
- **Reuse:** `scripts/catalog-sweep.ts`, `scripts/extractor-ground-probe.ts`, `structural-scorer.ts`.

## Verification
1. Registry merge is **idempotent** (re-running a pull doesn't double-count; `nEvents`/`lastSeen` correct).
2. **No quarantine before the coverage bar** — Phase C is gated; the legacy list is human-reviewed.
3. Quarantine asserts **0 leak** into grounding results (E13), and is **reversible** (a quarantined id can be
   restored if later seen offered).
4. Phase D only: `catalog-sweep` verbatim floor stays **100%**; `npm run eval` ship gate **PASS**;
   precision guard (reward on `adj` can't mint a wrong confident); **0 alias growth**.
5. `npm run typecheck` clean throughout.

## Out of scope (explicit)
- **Snapshot-based pruning** — proven unsafe (the WC unseen set is dominated by real, out-of-season markets).
- **Hard deletion** of any criterion — quarantine only, reversible.
- The grounding nudge's full build + calibration (Phase D) — gated on a prop-rich in-season source.
- The offer-independent failures (#1 `main` sentinel, #4 `win`→`qualify`, #6 `Extra Time` alias shadow, +
  accept-set/twin issues) — separate alias/extractor work, unblocked now.
- Entity/competition/attrFilter grounding; the executor + live layer; the fully automated fetch cron.
