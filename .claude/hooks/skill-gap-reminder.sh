#!/usr/bin/env bash
# Stop hook: a quiet nudge to capture reusable conventions as skills.
#
# Fires at turn-end. Guarded by `stop_hook_active` so it blocks at most once
# per stop sequence (one reflection per turn) — never an infinite loop.
#
# The nudge deliberately asks for SILENCE when nothing fired: the earlier
# wording made every turn end with a paragraph of "no skill gap this turn"
# reasoning, which drowned the real answer and confused non-engineers. The
# rule (.claude/rules/skill-self-improvement/RULE.md) owns the triggers, the
# two-line proposal shape, and the product-owner exemption; this hook only
# makes sure the check happens.
#
# NUDGE is JSON-escaped once below (backslash then double-quote) before being
# emitted, so an accidental quote/backslash in the text can't produce invalid
# JSON. Keep NUDGE single-line — raw newlines/control chars are still not escaped.

input="$(cat)"

# Already re-woken by this hook? Let the turn end.
if printf '%s' "$input" | grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  exit 0
fi

NUDGE="Silent check before ending the turn, per .claude/rules/skill-self-improvement/RULE.md: (1) if this session ran /intent or the person is acting as product owner, add NOTHING and end. (2) Otherwise, did this turn reveal a reusable, codebase-specific gap in a skill (a review comment, a repeated correction, a gotcha that cost real time)? If NO: add NOTHING — no reflection, no 'no skill gap' line — just end. If YES: append exactly two lines — 'Skill gap noticed: <skill> does not cover <situation>.' and 'Want a patch? (yes / no)' — and end."

# JSON-escape NUDGE once (backslash first, then double-quote) so a stray quote
# or backslash in the text can't produce invalid JSON.
esc=${NUDGE//\\/\\\\}   # escape backslash first
esc=${esc//\"/\\\"}     # then double-quote

printf '{"decision":"block","reason":"%s"}\n' "$esc"
exit 0
