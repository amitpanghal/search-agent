# Player-anchored competition grounding (gender/variant-safe)

## Context

When a query names a player **and** a competition, the competition is currently grounded
**globally and independently** of the player. For competitions whose display name splits by
gender into separate feed nodes, the global grounder picks the wrong node, and a downstream
filter then drops every one of the player's events.

Concrete failure — **"Swiatek to win Wimbledon"**:
1. `groundCompetition("Wimbledon")` → alias → `1000096467` = **men's** Wimbledon (confident).
2. `planRecall` fetches by **Swiatek's id** → her events all sit under `1000096477` = **Wimbledon Women**.
3. `scopeMenu` filter (`recall.ts:308`): `e.groupId (1000096477) !== compId (1000096467)` → **all events dropped → empty answer.**

This is **not tennis-specific**. Football has the same shape today: 594 women's players sit under
a `(W)` competition group, and 10 `(W)` competition groups exist (`Champions League (W)`,
`Eredivisie (W)`, …). (There are also 23 `(W)` *teams* like `Arsenal (W)`, but those never reach
this code path — `groundCompetition` matches competition groups, not teams.) Verified failure —
**"Wendie Renard to win the Champions League"**: bare "Champions League" exact-matches the men's
group (`1000093381`, 815-player roster) and grounds confident, but Renard's events sit under
`Champions League (W)` (`2000051466`, 287 players) → all dropped. Basketball has no women's nodes
yet, so it can't fire there. The mechanism is general; only the trigger (one name → two gendered
nodes) is new with tennis.

**Intended outcome:** when a leg names a player (or, failing that, a team), ground the competition
**within that anchor's own league list** (`competitionIds`), so the gendered/variant node is
chosen correctly — in one pass, with no extractor change and no `gender` field. This is the
agreed **Option B**: the player always drives competition resolution, even when the player name
is ambiguous (then the pool is the **union** of all candidate players' leagues).

## Approach

Invert the grounding cascade so the competition is resolved **last**, against an anchor-derived
allow-set:

| Leg names… | Competition grounded against… |
|---|---|
| a player (any tier) | union of `competitionIds` over **all** that leg's player candidates |
| no player, a team | union of `competitionIds` over the team candidates |
| neither | the global whitelist (today's behaviour, region-scoped) |

The fix lands entirely in the **grounding stage**. The `scopeMenu` competition filter
(`recall.ts:301`,`:308`) and `planRecall` (`plan-recall.ts`) are **unchanged** — they were always
correct; they were just being fed the wrong comp id.

## Files & changes

### `src/resolver/ground-scope.ts`

1. **`groundCompetition(text, regionBranch, cat)` → add 4th arg `allow: Set<number> | null = null`.**
   After the region-scoped `pool` is built (the block at lines ~149–156), when `allow` is set add a
   **hard** filter: `pool = pool.filter(g => allow.has(g.id))`. Unlike the region cut (which has a
   *soft* fallback to the full pool when it empties, lines 153–156), the anchor cut is hard: if it
   empties the pool, the existing `if (!scored.length) return none` (line 159) returns tier `none`.
   Because it runs **after** the soft region cut, the two AND together: a named region that disagrees
   with the player's comps empties the pool → `none` (the anchor effectively wins on conflict, since
   the region cut already fell back to the full pool first).
   That is the "don't hard-zero the player" path — a `none` competition means `compId` stays null in
   `scopeMenu`, so the player's own events are kept (and the none-tier cell routes to the LLM
   clarify/reexpress path in `resolve-entities`, e.g. "Messi in the Premier League"). **Known rough
   edge:** the re-ground is also anchor-constrained, so it returns `none` again and the cell lands on
   the canned clarify "I couldn't pin down 'Premier League'" — misleading, since the competition is
   clear and the real situation is that the player isn't in it. Decide whether "player not in this
   competition" should instead return an empty/"no offers" answer; not addressed here.

2. **`groundScope` cascade (lines 283–321) — reorder per leg:**
   - Ground `teams` first (unchanged), then `players` and `subjectPlayer` **by name + `teamIds` only**
     — pass `compId: null`. This is where Option B drops the comp→player homonym cut.
   - Compute the anchor:
     `allow = playerComps.size ? playerComps : (teamComps.size ? teamComps : null)`,
     where each is the union of candidate `competitionIds`. Team candidates carry `competitionIds`
     (`groundTeam` cand, line 191); player candidates carry them too (`groundPlayer` cand, line 229).
   - Ground `competition` **last**, passing `allow`.
   - `compId` is no longer needed inside `groundScope` (players don't consume it; downstream
     recomputes it from `leg.competition`), so the line-293 `compId` local is removed.
   - **Memo keys** must fold in the anchor so two legs with the same competition text but different
     anchors don't share a result: the `comp …` key gains an anchor signature
     (`allow ? [...allow].sort((a,b)=>a-b).join(",") : "*"`); the player key drops `compId`.

   New shared, exported helper (re-used by `resolve-entities`):
   ```ts
   export const compUnion = (rs: (EntityResolution | null)[]): Set<number> => {
     const s = new Set<number>();
     for (const r of rs) if (r) for (const c of r.candidates) for (const id of c.competitionIds ?? []) s.add(id);
     return s;
   };
   ```

### `src/resolver/resolve-entities.ts` (LLM re-ground closures, `buildEntityCells`, lines 109–119)

The closures must mirror the new cascade:
- **Player & subject** closures (lines 116, 118): drop `compId` → `groundPlayer(p, { compId: null, teamIds }, scat)`.
- **Competition** closure (line 114): compute `allow` from the leg's already-grounded players/teams via
  the exported `compUnion([...leg.players, leg.subjectPlayer])` (else teams), and pass it →
  `groundCompetition(p, regionBranch, scat, allow)`.
- Remove the now-unused `compId` local (line 111).

## Behaviour after the change (worked)

| Query | anchor = | comp grounds to | outcome |
|---|---|---|---|
| Alcaraz + "Wimbledon" | his comps | men's Wimbledon | ✓ unchanged |
| Swiatek + "Wimbledon" | her comps | **Wimbledon Women** | ✓ fixed |
| Wendie Renard + "Champions League" | her comps | **Champions League (W)** | ✓ fixed (real, testable today) |
| Bruno Fernandes (ambiguous) + "Premier League" | union of both Brunos' comps | Premier League | both homonyms fetched; live menu picks |
| Messi + "Premier League" (not his) | his comps (no PL) | `none` | no comp filter → none-tier clarify; events not hard-zeroed |
| "top scorer in Premier League" (no player/team) | null | Premier League (global) | ✓ unchanged |

## What this costs (accepted with Option B)

The **comp→player homonym cut is removed** (the team→player cut is kept). Two effects, not one:

1. *What gets fetched changes.* An *ambiguous-player + named-comp* leg now fetches all homonyms and
   leans on the live menu to sort them out (the wrong homonym has no offers under that competition,
   so the answer should still hold).
2. *Grounding tier changes — the bigger one.* A player that used to ground **confident** because the
   competition narrowed two homonyms to one in-scope (`groundPlayer` `hasScope`, line 248) now grounds
   **ambiguous** (compId is null). Ambiguous cells are sent to the entity LLM, so these legs gain an
   extra LLM cell and a possible **clarification** where before they resolved silently. Watch the
   clarify rate in the harness, not just the fetch set.

The `allow` union is computed from the player's **pre-disambiguation** candidates and is **not**
refined after the LLM settles the player: a competition that is ambiguous only because of the union
stays ambiguous and burns an LLM cell.

Per-leg note: because `groundScope` already runs the cascade per selector, this is automatically
per-leg — each leg's competition resolves against *its own* player. A cross-sport multi-subject
query (e.g. footballer + tennis player in one query) is **not** addressed here; that is blocked
earlier by single-sport-per-plan (`loadScopeCatalog(plan.sport)`), a separate limitation.

## Verification

1. `npm run typecheck`.
2. **Targeted grounder unit test — runnable TODAY (sync, no API, football only).** This is the proof
   the fix works; tennis can't run yet. Load the football catalog and assert:
   - `groundCompetition("Champions League", null, cat, allow)` returns the **men's** group
     (`1000093381`) for an `allow` derived from a men's-CL player, and **`Champions League (W)`**
     (`2000051466`) for an `allow` derived from a CL(W) player (e.g. Wendie Renard / Kadeisha
     Buchanan).
   - an empty-match anchor (a player with no overlapping comp) returns tier **`none`**.
3. **Harness-loop batch** (offline rig — no API, replays cached LLM steps + live menu): run the
   existing batch and confirm no regression. Note the batch likely has **no** women's-player +
   competition leg, so this proves "no regression on existing queries," NOT that the new path works —
   step 2 is what proves the fix. Triage any newly-red query, watching the **clarify rate** (the
   tier-downgrade cost above).
4. **Deferred until the tennis index is built** (`planning/add-tennis-sport-plan.md`): repeat step 2
   with `groundCompetition("Wimbledon", …)` for Alcaraz- vs Swiatek-derived `allow`, then the
   end-to-end proof **"Will Alcaraz and Swiatek reach the Wimbledon final?"** — two legs, same word
   "Wimbledon", two different nodes.

No extractor/prompt change, no new alias, no schema change.
