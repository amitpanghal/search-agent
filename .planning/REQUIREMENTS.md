# Requirements: Intent Resolver

**Defined:** 2026-06-01
**Core Value:** High-precision resolution of fuzzy NL betting queries to the *correct* catalog markets and entities — and you cannot ship precision you cannot measure, so a trustworthy structural eval harness comes before grounding.

## v1 Requirements

This milestone: stand up a runnable structural eval harness — wire the Haiku extractor and a scorer that grades the no-grounding axes on raw extractor output. Each requirement maps to a roadmap phase.

### Bootstrap

- [ ] **BOOT-01**: The repo is runnable — a `package.json` with TypeScript, Zod, and the Anthropic SDK installed; `npm install` succeeds and `resolver/schema.ts` type-checks.
- [ ] **BOOT-02**: The Anthropic API key is read from the environment (never committed); a missing key fails fast with a clear, actionable error before any query runs.

### Extraction

- [ ] **EXT-01**: A query string can be sent to Claude Haiku (temperature 0, structured output) using `resolver/extractor-prompt.md` + `resolver/schema.ts`, returning a `QueryPlan`.
- [ ] **EXT-02**: The returned `QueryPlan` is validated against the Zod schema; malformed model output surfaces as a typed failure rather than being silently accepted.
- [ ] **EXT-03**: Model responses are cached keyed by (query + prompt-hash + model) so re-running the same corpus against an unchanged prompt makes zero API calls.
- [ ] **EXT-04**: A `--fresh` flag bypasses the cache and runs each query 5× at temperature 0, for a release-grade reproducibility check (E10).

### Scoring

- [ ] **SCORE-01**: The scorer grades the enum/structural axes on raw extractor output — `status`, `sport`, and `subject.kind`.
- [ ] **SCORE-02**: The scorer grades `binding` and `market` by text against the gold `accept[]` lists, with selectors paired by market (order-independent).
- [ ] **SCORE-03**: The scorer grades line-vs-odds typing and values, `level`, player `role`, age-normalization, and `attrFilter` routing.
- [ ] **SCORE-04**: A wrong answer is weighed worse than a missing one (precision ≫ recall), and this weighting is visible in the per-record outcome.

### Reporting

- [ ] **RPT-01**: The report emits per-axis pass-rates across the corpus.
- [ ] **RPT-02**: The report emits per-behavior-tag pass-rates (all 17 tags in `eval/behavior-tags.ts`).
- [ ] **RPT-03**: The report emits a tiered-gate verdict — critical behaviors at 100%, soft behaviors against a ~90% aggregate (E12).
- [ ] **RPT-04**: On any failure, the raw text `QueryPlan` is retained in the report for triage (E4).

### Corpus

- [ ] **CORP-01**: The harness is validated end-to-end against the 3 seed records (`eval/gold.seed.jsonl`, known answers) before any bulk authoring.
- [ ] **CORP-02**: The gold corpus is expanded to ~2 records per behavior tag (~35 structural records: text plan + tags + `accept[]` + `expect.status`, no ids), including the abstain/sentinel cases (no-sport → FOOTBALL default, named-unbuilt-sport → `unsupported`).

### Harness

- [ ] **HARN-01**: `npm test` runs the full corpus and emits the baseline report.

## v2 Requirements

Deferred to the next milestone (grounding). Tracked but not in this roadmap.

### Grounding

- **GND-01**: Retrieval grounding — resolve text facets (binding, market, entity) to concrete catalog ids.
- **GND-02**: id-graded eval axes — the gold records' `Grounded { id, accept[] }` cells are graded once grounding exists.
- **GND-03**: Full gold corpus — expand to ~5 records per behavior tag (~50–70 total).
- **GND-04**: Prompt-tuning to a green ship gate — drive the baseline number to PASS (starts from this milestone's baseline).

## Out of Scope

Explicitly excluded from the project's current direction. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Executor + live event layer (fixtures, stage, time, lineup roles) | Separate component; explicitly out of scope in the design. Structural eval grades the *plan*, not its execution. |
| Static SQLite store / FTS5 / precomputed embeddings | A build-pipeline milestone; not needed to grade raw extractor output before grounding. |
| Position + age roster feed + Kambi-id↔provider-id matching | The single genuinely expensive external dependency; deferred to grounding era. |
| Region static table | Grounding-era concern. |
| Embedding model selection (local ONNX vs API) | Grounding-era; the matching layer doesn't exist yet. |
| Disambiguation LLM call (homonym / vector-tie clusters) | Grounding-era; depends on retrieval candidates. |
| Multi-sport partitions | Only FOOTBALL is built; the `ambiguous` status (needs ≥2 built sports) cannot occur yet. |
| Stuffing the prompt to fix failing eval queries | Bounded-prompt constraint (decision 16): new rule-instances go to the eval set, sport facts to the catalog — never to the prompt. The eval exists to protect this. |

## Traceability

Which phases cover which requirements. Populated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| BOOT-01 | TBD | Pending |
| BOOT-02 | TBD | Pending |
| EXT-01 | TBD | Pending |
| EXT-02 | TBD | Pending |
| EXT-03 | TBD | Pending |
| EXT-04 | TBD | Pending |
| SCORE-01 | TBD | Pending |
| SCORE-02 | TBD | Pending |
| SCORE-03 | TBD | Pending |
| SCORE-04 | TBD | Pending |
| RPT-01 | TBD | Pending |
| RPT-02 | TBD | Pending |
| RPT-03 | TBD | Pending |
| RPT-04 | TBD | Pending |
| CORP-01 | TBD | Pending |
| CORP-02 | TBD | Pending |
| HARN-01 | TBD | Pending |

**Coverage:**
- v1 requirements: 17 total
- Mapped to phases: 0 (pending roadmap)
- Unmapped: 17 ⚠️ (resolved at roadmap step)

---
*Requirements defined: 2026-06-01*
*Last updated: 2026-06-01 after initial definition*
