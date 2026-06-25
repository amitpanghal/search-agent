// harness-loop — shared shapes for the offline, subagent-driven test rig.
//
// The rig runs the REAL pipeline (runPipeline) against the captured snapshot with every LLM step served from a
// content-addressed cache (llm-cache.ts) and the network fetch replaced by the snapshot (pipeline-doubles.ts).
// Grading reads ONLY the final ResponseEnvelope (grader.ts) — the single source of truth the user fixed.

// One leg's acceptable criterion id(s): ANY-of, so a side-split market (Total Goals by Turkey / by USA) passes
// on either side. A market-pointing query lists one inner array per target leg; a PURE filter query lists [].
export type GradeSpec = {
  targets: number[][];
  oddsMin?: number; // post-resolve price floor (decimal 6.0 == 5/1): every SELECTED outcome must price >= this
  oddsMax?: number; // post-resolve price ceiling (decimal)
  timebound?: boolean; // query carries a time scope; graded SOFT for now (slate non-empty) — time-window is pre-resolve
};

// One generated query + its by-construction answer key (the target ids) and filter assertions.
export type BatchQuery = {
  id: string;
  category: string;
  q: string;
  grade: GradeSpec;
};

// The grade of one query against its envelope. `pending` = an LLM cache miss aborted the run (NOT a real fail —
// the orchestrator fulfils the miss via a subagent and re-runs); `reasons` is empty on a pass.
export type GradeResult = {
  id: string;
  category: string;
  pass: boolean;
  pending: boolean;
  reasons: string[];
  gotIds: number[]; // criterion ids present in the envelope (triage aid)
};
