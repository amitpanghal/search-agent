// Optional per-query TRACE capture for scripts/probe.ts. A probe wraps the pipeline in traceStore.run([], …);
// each stage + API boundary then pushes one ordered event. Mirrors cost.ts's usageStore: when no store is
// active (prod, eval, SSE) emit() is a no-op, so this cannot change the shipped path's behaviour.
import { AsyncLocalStorage } from "node:async_hooks";

type TracePayload =
  | { kind: "stage"; stage: string; out: unknown }
  | { kind: "llm-req"; tool: string; model?: string; system: string; user: string; schema: unknown }
  | { kind: "llm-resp"; tool: string; output: unknown; inputTokens: number; outputTokens: number; stopReason?: string } // "max_tokens" = the answer was cut off
  | { kind: "kambi-req"; url: string }
  | { kind: "kambi-resp"; url: string; ok: boolean; status: number };

export type TraceEvent = TracePayload & { t: number };
export const traceStore = new AsyncLocalStorage<TraceEvent[]>();
export const emit = (e: TracePayload): void => { traceStore.getStore()?.push({ ...e, t: Date.now() }); };
