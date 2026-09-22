# Spec: <short feature name>

- **Intent:** ./intent.md
- **Date:** <yyyy-mm-dd>
- **Status:** draft | accepted

## Summary

<Two or three sentences: what will be built, at what altitude.>

## Acceptance criteria

<Numbered. Each criterion independently checkable — a reviewer (human or the
automated REVIEW.md Pass 3) must be able to answer met/unmet from the diff and
a running session. No "should generally" language.>

1. …
2. …

## Affected surfaces

<Routes/pages, components, API routes, database collections/tables, workflows,
external dashboards this touches.>

## Policy constraints

<Populated by the /spec skill's constraint pass: the applicable rules from the
project's policy skills, each cited by skill name (and section number where
the skill has one).>

## Data / API contracts

<New or changed shapes: request/response bodies, stored documents, event
payloads. Omit if none.>

## Test plan

<Which verification applies: unit tests for which modules, type check,
verification by hand where a person can observe it (which screens, endpoints
or messages), eval harnesses, end-to-end tests. Name the loop that must be
green before "done".>

## Out of scope

<Explicit exclusions, carried over from the intent's non-goals plus anything
discovered while speccing.>

## Decisions

<Dated amendments made after acceptance. When plan mode, implementation or
review finds a criterion wrong, fix the criterion above AND record why here —
the spec is what the automated review checks the diff against. Example:
- 2026-09-03 — Criterion 2 cited `short_name`, which does not exist; reworded to
  `participant.name` truncated with ellipsis (`shortCode` is a 3-letter code,
  not a display name). Decided by: engineer (factual).
A decision the engineer made on the facts but that changes what a player
sees or how far the feature reaches ends with the fixed marker, so the
hand-in step lists it under the product owner's box:
- 2026-09-15 — The message reads `120.00 kr`, two decimals, because the
  shared formatter renders two decimals. Decided by: engineer. Product owner
  to confirm.>
