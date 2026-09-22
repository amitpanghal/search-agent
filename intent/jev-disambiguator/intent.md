# Intent: Jev settles the disambiguator's entity cells

- **Date:** 2026-09-22
- **Source:** human
- **Status:** accepted
- **Jira:** none

## Problem / observed signal

When the grounder cannot settle an entity (a team, player or competition at tier `ambiguous`, `shortlist`
or `none`), the pipeline makes one Qwen call on Bedrock (`settle_cells`, `src/resolver/resolve-entities.ts`,
`decide()`) to pick from a short candidate list. Measured on captured cells from the 2026-09-10 probe
traces: 0.8 to 1.0 s and about $0.00034 per call (1,650 to 1,835 input tokens, mostly the fixed prompt).

Replaying the same cells through TypeSafe's Jev decision model on 2026-09-21 (`POST api.typesafe.ai/v1/systemone`,
one `choice` question per cell, key `JEV_ACCESS_KEY` in `.env`): 3 of 3 picks matched Qwen's (Bukayo Saka 0.97,
Premier League (England) 1.00, Full Time 0.99) in 0.3 to 0.7 s at about $0.00003 per call. One cell showed the
risk: for "Tottenham Hotspur", whose candidate list held five esports clones and a trotting horse and no right
answer, Jev committed to the horse at 0.75 where Qwen fell through to a clarify. The three good picks were all
at 0.97 or above, so a confidence threshold separates them.

Evidence: local probe traces (`scripts/.trace-out/*.jsonl`, gitignored) and the replay outputs of 2026-09-21,
recorded in the session notes; no user report. Jev returns a probability per option and no text, so it cannot
perform the `reexpress` action Qwen has today.

## Desired outcome

Doubtful entity cells are settled by Jev. A pick below a confidence threshold, or a cell that arrives with no
candidates, is asked back to the user as a clarify, exactly the clarify the pipeline produces today when a
cell cannot be settled. The entity stage makes no Qwen call at all; Jev is its only model. The stage answers
in well under half a second and at a small fraction of today's cost.

## Non-goals

- The market resolver and the extractor stay on Qwen, with no prompt changes to either; the disambiguator's
  own Qwen prompt goes away with the Qwen call.
- No change to how candidate lists are built (grounding, widening, caps); the dedupe fix is its own intent.
- No Vercel AI Gateway or new npm dependency; the direct REST endpoint is enough.
- No change to the clarify wording or the `SettledEntities` shape downstream.

## Constraints known up front

- Jev is not on Bedrock and has no text output: it is a second transport with its own key and its own retry
  with backoff on 429 and 529. It cannot rewrite a phrase, so the `reexpress` rescue is given up; a cell Jev
  cannot settle becomes a clarify.
- The stage is shipped resolver code (the **Human-gated resolver code** rule): plan and approval before edits.
- Per-query cost accounting (`cost.ts`) must record Jev calls with their real token counts and price.
- Any live measurement is a paid run and needs an explicit OK (the **Ask before paid runs** rule); the
  captured cells replay for free against the committed catalogs.

## Success signal

- The deterministic entity gate in `npm run eval` stays at 100%.
- A replay of the captured cells commits on the three good picks and clarifies on the Tottenham case.
- Probe traces show the entity stage at p50 below 500 ms when it fires, and its cost block below $0.00005 per
  call (today about $0.00034).
- One live A/B probe on a query that trips the disambiguator agrees with the Qwen answer or clarifies.

## Decisions
- 2026-09-22 — Fallback changed from "today's Qwen call" to "a clarify": the product owner wants the stage
  completely Jev-driven when the switch is on, with no Bedrock call in it. `reexpress` is given up in that mode.
  Asked by the product owner in the /spec chat; accepted again below.
- 2026-09-22 — No `.env` switch and no Qwen path left in the stage: the product owner wants Qwen dropped from
  the disambiguator completely, not kept behind a flag. Asked by the product owner in the /spec chat;
  accepted again below.
