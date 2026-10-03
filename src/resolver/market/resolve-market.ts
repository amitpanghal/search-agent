// RESOLVE(market) — build plan Phase 2. The LLM picks one market per BET from the FILTERED live menu and labels
// each exact | close | none (theory §4). It sees LABELS ONLY (no odds, no outcomes) and picks by `ref`; we map
// the ref back to the menu item's label (the market identity). The model may always abstain (`none`).
// ONE CALL PER QUERY (ADR one-market-call): every bet arrives with its OWN filtered menu; the menus are unioned by
// label (outcome lists merged) and sent once, and a bet whose menu is a strict subset of the union carries a
// `[may pick: 0-5, 9]` tag naming its refs — the subject filter's precision survives the merge. Answered refs map
// back into each bet's own menu, so a ref outside the bet's set (or an outcome on another bet's twin of the same
// label) can never become a market: it collapses to `none`, as any unknown ref does. `resolveMarket` (singular) is
// a thin wrapper kept for the offline gates. The contract — confident-wrong ≈ 1 in 180 case-evaluations. Model is
// BEDROCK_MODEL (or DeepSeek under LLM_PROVIDER=deepseek) via bedrock-call.ts.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { bedrockToolCall } from "../llm/bedrock-call";
import type { Menu, MarketPick, MatchLabel } from "../shared/live-menu-types";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL_NAME = "pick";

let cachedPrompt: string | undefined;
const systemPrompt = (): string => (cachedPrompt ??= readFileSync(join(HERE, "resolve-market-prompt.md"), "utf8"));

// One pick per BET: `leg` echoes which bet it answers (so a missing/reordered pick is detectable, never silently
// mis-bound), `ref` indexes the shared menu (null = none).
const INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    picks: {
      type: "array",
      description: "exactly one pick per bet",
      items: {
        type: "object",
        properties: {
          leg: { type: "integer", description: "the bet's leg index this pick answers" },
          ref: { type: ["integer", "null"], description: "the chosen menu item's ref, or null for none" },
          match: { type: "string", enum: ["exact", "close", "none"] },
          outcome: {
            type: ["string", "null"],
            description:
              "verbatim outcome label from the picked item's [outcomes: …], when the bet names one; else null",
          },
          related: {
            type: "array",
            items: { type: "integer" },
            maxItems: 3,
            description:
              "the (up to 3) menu refs for other markets on the same fixture, most related first; [] only if the fixture has no other market",
          },
        },
        required: ["leg", "ref", "match"],
      },
    },
  },
  required: ["picks"],
};

// The raw model output for one bet (a ref + label), before we map it back to the market identity.
export type RawPick = { ref: number | null; match: string; outcome?: string | null; related?: number[] };
// A bet: the phrase to settle and the filtered menu it may pick from.
export type Bet = { phrase: string; menu: Menu };
// Batched decider — one call for every bet of the query, each with its own menu; refs index each bet's OWN menu.
// Injectable so the gates can replay captured decisions.
export type DecideManyFn = (bets: Bet[], query?: string) => Promise<RawPick[]>;
// Singular decider — kept for the offline gates' per-phrase replay.
export type DecideFn = (phrase: string, menu: Menu) => Promise<RawPick>;

// Map one raw pick -> MarketPick. `none` (or a ref the menu doesn't carry, or a missing leg) collapses to an
// abstain with no market identity, so a hallucinated/absent pick can never become a confident wrong answer.
// `outcomeLabel` is only accepted when it appears verbatim in the item's outcomes list (anti-hallucination) AND is not
// a bare 1X2 side code: "1"/"2" enter a menu item only to mark the result market (recall.ts meaningfulOutcomeLabels) and
// name no team, so the side stays with select's subject gate — accepting "1" for "Arsenal to win" picked the HOME row
// (Sunderland) on the 2026-09-10 snipe run. "Draw" is a real outcome and stays accepted.
const SIDE_CODES = new Set(["1", "2"]);
const toPick = (raw: RawPick | undefined, menu: Menu): MarketPick => {
  const match = (raw?.match ?? "none") as MatchLabel;
  // related: the model's suggested refs (deduped, self dropped, capped 3). No same-event filter here — execute
  // attaches a related market only if a betoffer with that label exists on the leg's OWN event, so the real
  // event guard is downstream; filtering here on the menu's example eventId only dropped valid same-event markets.
  // Kept on a `none` too: the asked market is missing but its live siblings still help (HockeyAllsvenskan 2026/27
  // offers only Top 2 / Top 4, so "AIK to win the league" shows those instead of a dead end). Suggestions only.
  const related = [
    ...new Set(
      (raw?.related ?? []).filter((r): r is number => typeof r === "number" && r !== raw?.ref && menu[r] != null),
    ),
  ]
    .slice(0, 3)
    .map((r) => menu[r]!.label);
  const rel = related.length ? { related } : {};
  if (!raw || match === "none" || raw.ref == null || !menu[raw.ref]) return { match: "none", ...rel };
  const item = menu[raw.ref]!;
  const outcomeLabel =
    raw.outcome && item.outcomes?.includes(raw.outcome) && !SIDE_CODES.has(raw.outcome) ? raw.outcome : undefined;
  return {
    label: item.label,
    match,
    ...(outcomeLabel ? { outcomeLabel } : {}),
    ...rel,
  };
};

// Pick + label a market for EACH bet against its own menu, in a single model call. A bet with an empty menu is
// `none` without asking (a choice between `none` and nothing).
export async function resolveMarkets(
  bets: Bet[],
  decideFn: DecideManyFn = callModel,
  query?: string,
): Promise<MarketPick[]> {
  const asked = bets.filter((b) => b.menu.length);
  const raws = asked.length ? await decideFn(asked, query) : [];
  let i = 0;
  return bets.map((b) => (b.menu.length ? toPick(raws[i++], b.menu) : { match: "none" }));
}

// Singular convenience (one phrase, one menu). Kept so the offline gates' singular replay deciders work unchanged.
export async function resolveMarket(phrase: string, menu: Menu, decideFn?: DecideFn): Promise<MarketPick> {
  const many: DecideManyFn = decideFn ? async (bs) => [await decideFn(bs[0]!.phrase, bs[0]!.menu)] : callModel;
  return (await resolveMarkets([{ phrase, menu }], many))[0]!;
}

// The union of the bets' menus — one item per label, outcome lists merged — and each bet's refs into it. Labels
// carry no team or fixture (englishLabel + variant), so two groups' menus overlap heavily: a team subject keeps
// most of its fixture's menu, two outright subjects share the same Finishing Position labels.
export const unionMenus = (bets: Bet[]): { menu: Menu; refs: number[][] } => {
  const menu: Menu = [];
  const at = new Map<string, number>();
  const refs = bets.map((b) =>
    b.menu.map((m) => {
      let r = at.get(m.label);
      if (r == null) {
        r = menu.length;
        at.set(m.label, r);
        menu.push({ label: m.label, ...(m.outcomes?.length ? { outcomes: [...m.outcomes] } : {}) });
      } else if (m.outcomes?.length) {
        const u = menu[r]!;
        u.outcomes = [...new Set([...(u.outcomes ?? []), ...m.outcomes])];
      }
      return r;
    }),
  );
  return { menu, refs };
};

// A bet's allowed refs as compact ranges ("0-5, 9, 12-14"), or "" when it may use the whole union — then no tag is
// written and the message reads exactly as a single-group call. Refs are distinct (a menu has one item per label).
export const rangeTag = (refs: number[], total: number): string => {
  if (refs.length >= total) return "";
  const s = [...refs].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j]! + 1) j++;
    parts.push(j > i ? `${s[i]}-${s[j]}` : `${s[i]}`);
    i = j + 1;
  }
  return parts.join(", ");
};

// Union refs -> each bet's OWN menu index. A ref outside the bet's set becomes -1, which toPick treats as unknown
// (the pick abstains, a related ref is dropped) — the deterministic half of the `[may pick]` rule.
export const ownRefs = (raws: RawPick[], refs: number[][]): RawPick[] =>
  raws.map((p, i) => {
    const own = (r: number) => refs[i]!.indexOf(r);
    return { ...p, ref: p.ref == null ? null : own(p.ref), ...(p.related ? { related: p.related.map(own) } : {}) };
  });

const callModel: DecideManyFn = async (bets, query) => {
  const { menu, refs } = unionMenus(bets);
  const list = menu
    .map((m, i) => `${i}: ${m.label}${m.outcomes?.length ? `  [outcomes: ${m.outcomes.join(" | ")}]` : ""}`)
    .join("\n");
  const lines = bets
    .map((b, i) => {
      const tag = rangeTag(refs[i]!, menu.length);
      return `${i}: ${b.phrase}${tag ? `  [may pick: ${tag}]` : ""}`;
    })
    .join("\n");
  const user =
    `LIVE menu (ref: label) — the only markets actually offered:\n${list}\n\nBETS (leg: phrase):\n${lines}\n\n` +
    `${query ? `Original request (context):\n"${query}"\n\n` : ""}For EACH bet, pick one market by ref (or none) and label it exact/close/none.`;
  const out = await bedrockToolCall(
    systemPrompt(),
    user,
    TOOL_NAME,
    INPUT_SCHEMA,
    Math.min(2048, 256 + 256 * bets.length),
  );
  return ownRefs(
    picksByLeg((Array.isArray(out.picks) ? out.picks : []) as Array<{ leg?: number } & RawPick>, bets.length),
    refs,
  );
};

// Map raw picks back to bet order BY `leg` (robust to reordering). A pick with NO `leg` falls back to its
// POSITION, but only when the model returned exactly one pick per bet — then position is unambiguous. Qwen
// answers in free text, so a runaway `related` array can hit maxTokens mid-list and cut off a trailing `leg`;
// without this a correct exact pick collapsed to none ("goals" -> Total Goals ref 31, shown as "no market").
export const picksByLeg = (picks: Array<{ leg?: number } & RawPick>, bets: number): RawPick[] => {
  const byLeg = new Map<number, RawPick>();
  picks.forEach((p, i) => {
    const leg = typeof p.leg === "number" ? p.leg : picks.length === bets ? i : undefined;
    if (leg != null) byLeg.set(leg, { ref: p.ref, match: p.match, outcome: p.outcome, related: p.related });
  });
  return Array.from({ length: bets }, (_, i) => byLeg.get(i) ?? { ref: null, match: "none" });
};
