# Skill: Refactor criterions for embedding

Turn a raw Kambi criterion feed into a flat, normalised, English-only set of
records ready for the criterion-layer index. Sport-agnostic — football is the
first sport applied; the same rules apply to tennis, basketball, etc.

## When to use

- Ingesting a sport's criterions into the search index (criterion layer of
  the embedded catalog — see [`preprocess_classify_tightening.md`](../preprocess_classify_tightening.md)
  §"Layers + embedded text composition").
- Re-running after a refresh of the criterions feed.
- Generalising to a new sport — same rules, different input file.

## Input

One file per sport. Top-level JSON array of criterion objects. Schema is
uniform across all entries (verified for football by probing 5,551 records):

```json
{
  "id": 2100041234,
  "names": [
    { "name": "1+ assists each", "locale": "en_GB" },
    { "name": "Más de 1 asistencia cada uno", "locale": "es_ES" }
  ],
  "shownInLive": false,
  "shownInPreMatch": true
}
```

| Field | Purpose |
|---|---|
| `id` | Stable Kambi criterion ID. **Primary key — 29 distinct IDs share an English name in the football feed; the name alone is not unique.** |
| `names[]` | 1–39 locale variants (avg 16.5 in football). All 5,551 football entries carry `en_GB`. Other locales drop in this pipeline. |
| `shownInLive` | UX surface flag — does Kambi show this criterion on live-event pages. |
| `shownInPreMatch` | UX surface flag — does Kambi show this criterion on prematch pages. Every football entry has at least one true (0 "shown neither"). |

**Probe before loading.** Don't slurp the full file blind:

```bash
jq 'length' INPUT.json                            # count
jq '[.[] | keys] | add | unique' INPUT.json       # confirm 4-key shape
jq '[.[] | .names[].locale] | group_by(.) | map({locale: .[0], count: length}) | sort_by(-.count) | .[0:5]' INPUT.json
```

If the union-of-keys returns anything beyond `{id, names, shownInLive, shownInPreMatch}`, surface it before committing to a full ingest — the rules below assume the four-key shape.

## Refactor rules

Apply in order:

1. **Verify schema uniformity.** Every record has exactly the four keys
   listed above. New fields in a new sport's feed: stop and decide whether
   to keep them, not silently drop.

2. **Collapse `names[]` → single `name` string.** Resolution chain (mirrors
   participants):
   `en_GB → en_US → en_TK → en_GU → any en_* → first available`.
   In football every record has `en_GB`, so the fallback never fires. Keep
   the chain anyway — other sports' feeds may have partial English
   coverage.

3. **Strip template placeholders from `name`.** Two passes:

   a. Strip ` ({N})` (placeholder wrapped in its own parens, with the
      leading space). Catches the dominant pattern — 194 football entries,
      almost all `"<player> to score next goal ({0})"` style:

      ```
      "Adam Lallana (England) to score next goal ({0})"
      → "Adam Lallana (England) to score next goal"
      ```

   b. Strip any remaining bare `{N}` token, then collapse double-spaces
      and trim. Catches the tail (~127 in football) where the placeholder
      is embedded structurally:

      ```
      "Asian Handicap ({0} - {1})" → "Asian Handicap ( - )"
      "Card awarded - {0}0:00-{1}9:59" → "Card awarded - 0:00-9:59"
      ```

      Pass (b) leaves mild artifacts ("( - )", residual numerics). Accept
      it — these are template-style markets whose surface form will never
      match a user query verbatim anyway; retrieval works off the
      substantive tokens ("Asian Handicap", "Card awarded").

   The placeholders are runtime slot tokens — they pollute the embedding
   and carry no semantic content.

4. **Pass `shownInLive` / `shownInPreMatch` through unchanged** as
   record-level booleans. **Do not encode them into `name` or into any
   `embedText` field downstream.** See
   [Flag handling](#flag-handling-metadata-not-embed-text) below.

5. **No deduplication by name.** Two records with the same English name
   but different IDs are kept distinct — they are different markets that
   happen to share a label (29 such pairs in football). Downstream callers
   join on `id`.

## Output schema

```json
{
  "source": { "sport": "football", "sportLabel": "FOOTBALL" },
  "counts": {
    "criterions": 5551,
    "shownInLive": 2166,
    "shownInPreMatch": 4084,
    "shownInBoth": 699
  },
  "criterions": [
    {
      "id": 2100041234,
      "sport": "football",
      "name": "1+ assists each",
      "shownInLive": false,
      "shownInPreMatch": true
    }
  ]
}
```

Field notes:

- `id` — primary key. **Use as the cache key when computing / storing
  embeddings** (not the name — see rule 5). Globally unique across sports,
  so the criterion index is a single shared store.
- `name` — canonical English label after placeholder strip.
- `sport` — slug ("football"); duplicated onto each record for downstream
  cross-sport joins.
- `shownInLive` / `shownInPreMatch` — filter metadata only. Persist them
  as columns / sidecar fields on the index row, not inside the vector text.

**No `embedText` field at this stage.** The criterion-layer embed text
composition is

```
"<englishName> | sport=<sport> | type=<boType label> | category=<category label> | aliases=<derived plural/singular forms>"
```

locked in [`preprocess_classify_tightening.md`](../preprocess_classify_tightening.md)
§"Layers + embedded text composition". The `type` and `category` labels come
from BetOfferType / Category entities, and `aliases` from `aliases.json` —
none of which are in the criterions feed. Composition is the index builder's
job, not this refactor's. This step produces the `englishName` column it
will consume.

## Flag handling: metadata, not embed text

`shownInLive` and `shownInPreMatch` stay as record-level booleans, not in
the embed text. The reasoning, recorded once so future sports don't
re-litigate it:

- The flags describe Kambi's **UI shelf** ("does this criterion appear on
  the live page?"), not market identity. Embedding them shifts every
  vector by a UX attribute irrelevant to what the criterion *is*.
- Liveness is a **hard filter signal**, not a soft preference. When a
  query says "live", retrieval should *guarantee* a drop of prematch-only
  criteria, not a dense-similarity nudge. Metadata booleans give the
  strict behaviour; embedded text gives the weaker one.
- **699 football criterions are shown in both surfaces.** Any text
  encoding must either pick one form (lossy from the other side) or
  duplicate the row (catalog bloat). One boolean pair per row handles
  both directions for free.
- Liveness is already a first-class concept upstream: `ResolvedQuery.liveStateFilter`
  → `search_offering(liveOnly | excludePrematch | excludeLive)` →
  [`src/tools/liveFilter.ts`](../../src/tools/liveFilter.ts). Adding a
  parallel signal in the criterion vector creates dual-channel handling
  and two ways to be wrong.
- The catalog flag is **not** the same as runtime live availability.
  Whether *this specific event* offers *this criterion* live depends on
  the event's state at request time, not on `shownInLive`. The flag is a
  catalog-shelf attribute; embedding it would let retrieval over-promise.

## How to run

Rules 2–5 fit in a single jq pipeline — no Python script needed yet. Keep
it inline until per-sport variance demands one.

```bash
SPORT=football
SPORT_LABEL=FOOTBALL
IN=/path/to/FOOTBALL_CRITERIONS.json
OUT=data/football/football_criterions.json

jq --arg sport "$SPORT" --arg sportLabel "$SPORT_LABEL" '
  def pickEn(names):
    ((names | map(select(.locale == "en_GB"))[0].name) //
     (names | map(select(.locale == "en_US"))[0].name) //
     (names | map(select(.locale | startswith("en_")))[0].name) //
     names[0].name);
  def stripPlaceholders($s):
    ($s
      | gsub(" *\\(\\{[0-9]+\\}\\)"; "")
      | gsub("\\{[0-9]+\\}"; "")
      | gsub("  +"; " ")
      | sub("^ +"; "")
      | sub(" +$"; ""));
  {
    source: { sport: $sport, sportLabel: $sportLabel },
    counts: {
      criterions: length,
      shownInLive: ([.[] | select(.shownInLive)] | length),
      shownInPreMatch: ([.[] | select(.shownInPreMatch)] | length),
      shownInBoth: ([.[] | select(.shownInLive and .shownInPreMatch)] | length)
    },
    criterions: [ .[] | {
      id: .id,
      sport: $sport,
      name: stripPlaceholders(pickEn(.names)),
      shownInLive: .shownInLive,
      shownInPreMatch: .shownInPreMatch
    } ]
  }
' "$IN" > "$OUT"
```

For a new sport, override `SPORT` / `SPORT_LABEL` / `IN` / `OUT`:

```bash
SPORT=tennis SPORT_LABEL=TENNIS \
IN=/path/to/TENNIS_CRITERIONS.json \
OUT=data/tennis/tennis_criterions.json
# … same jq pipeline
```

If a sport's feed introduces fields beyond the four-key schema, the jq
pipeline will silently ignore them — rerun the schema verification step
(`jq '[.[] | keys] | add | unique'`) before assuming the rules apply
unchanged.

## Verification

```bash
F=data/football/football_criterions.json

# Counts (football reference: criterions=5551, shownInBoth=699)
jq '.counts' "$F"

# Every record has a non-empty name
jq '[.criterions[] | select(.name == null or .name == "")] | length' "$F"
# expect: 0

# Pass (a) removed all parenthesised placeholders
jq '[.criterions[] | select(.name | test("\\(\\{[0-9]+\\}\\)"))] | length' "$F"
# expect: 0

# Pass (b) removed all bare placeholders
jq '[.criterions[] | select(.name | test("\\{[0-9]+\\}"))] | length' "$F"
# expect: 0

# Unique IDs (no accidental dedupe)
jq '[.criterions[].id] as $ids | ($ids|length) - ($ids|unique|length)' "$F"
# expect: 0

# Distinct IDs sharing an English name — real, kept (football: 30 post-strip)
jq '[.criterions[].name] | (length - (unique | length))' "$F"

# Flag distribution preserved; "neither" should not exist
jq '{
  total: (.criterions | length),
  live: ([.criterions[] | select(.shownInLive)] | length),
  prematch: ([.criterions[] | select(.shownInPreMatch)] | length),
  both: ([.criterions[] | select(.shownInLive and .shownInPreMatch)] | length),
  neither: ([.criterions[] | select((.shownInLive|not) and (.shownInPreMatch|not))] | length)
}' "$F"
# expect: neither == 0
```

## Known data quirks

- **Leading `*` on translations is a "translation pending" marker** in
  Kambi locales (heavy in `lt_LT`, `no_NO`, `et_EE`, `fr_FR`, etc.). It
  rarely appears in `en_GB` (1 occurrence in 5,551 football entries).
  Since we drop all non-English locales, this doesn't affect the output.
  If a future sport's `en_GB` coverage is partial and the fallback chain
  picks a non-English locale, strip a leading `*` defensively at that
  point.
- **154 football criterions have only an `en_GB` name** — no other
  locales. Still kept (rule 2 always succeeds).
- **~30 distinct IDs share an English name** in football post-strip (29
  in the raw feed; placeholder-strip collapses one extra near-duplicate).
  They are real separate markets — typically player-specific variants
  under different boTypes. Do not collapse on name.
- **Template placeholders** (`{0}`, `{1}`) appear in ~194 names. Pass (a)
  handles ~67 cleanly (trailing `({N})`). Pass (b) handles the ~127 tail
  with mild residual artifacts ("( - )", residual numerics). Acceptable —
  these template-style markets are not how users phrase queries.
- **`shownInLive: false, shownInPreMatch: false` does not exist** in
  football (0 entries). If a future sport's feed contains such records,
  they are likely retired criterions; flag before inclusion.

## Scaling

One file per sport, one jq invocation. Football: 8.1 MB raw input →
~1.0 MB normalised output (no locale variants, no surrounding fields).

Cross-sport ingestion is not handled here: refactor once per sport, merge
downstream if needed. The criterion ID space is globally unique across
sports, so the criterion index is a single shared store keyed on `id`.
