// SELECT — build plan Phase 3 (deterministic, ZERO LLM). Once the market is picked (RESOLVE), pull the
// concrete outcome mechanically from that market's REAL betoffers (theory §5): the line, the subject's
// outcome, the relational role, a combo (correct score / HT-FT / double chance). Nothing is asserted blind
// — a missing subject, line or selection degrades to an honest fallback (nearest offered line, or "not
// offered"), never a confident wrong pick.
//
// The market is READ, not guessed. Every outcome carries a stable `type` enum (OT_OVER/OT_UNDER/OT_YES/
// OT_NO, OT_ONE/OT_CROSS/OT_TWO, OT_ONE_ONE…, OT_UNTYPED) — a far more reliable key than the localized
// `label`. We key off `type`, falling back to the un-localized `englishLabel` (never the reversible, now
// possibly-localized `label`) ONLY when the type is uninformative (OT_UNTYPED or
// missing). That fallback is LOAD-BEARING, not a rare safety net: ~half the live feed is OT_UNTYPED (the
// outright Yes/No outcomes, Asian-Handicap sides, correct score), so a gate that ignored it would silently
// drop them. Combos match the un-localized `englishLabel` / numeric `homeScore`/`awayScore` (never the
// reversible `label`). Participant matching is diacritic-FOLDED, like the filter ("Çalhanoglu" / "Mbappé").

import { fold } from "./lexical";
import type { BetOffer, KEvent, KOutcome } from "./offering-client";
import type { Selection } from "./live-menu-types";

// The query's outcome constraints, carried by the extractor as-is (value + direction) — never a market binding.
export type SelectSpec = {
  subjectId?: number; // PREFERRED: the grounded participant id (== outcome.participantId on named markets)
  subject?: string; // a participant NAME (display + fallback when no id), or the relational "home" / "away"
  // the query's outcome VALUE, carried RAW from the extractor: a numeric rung in the query's units (2.5, -2) OR a
  // combo token (correct score "2-1", HT/FT "1/1"). SELECT reads it per the picked market's betOfferType, not by
  // its JS type — a numeric line for most markets, a combo token for correct-score/HT-FT.
  lineValue?: number | string;
  dir?: "over" | "under" | "yes" | "no";
  oddsMin?: number; // price floor (decimal, 5.0): keep only outcomes priced >= min ("first scorer over 5.0")
  oddsMax?: number; // price ceiling (decimal): keep only outcomes priced <= max
  sort?: "low" | "high"; // rank a field outright by price (low = favourite first) — drives count + selected
  count?: number; // surface only the top N of a many-outcome field (omitted = the whole field)
  outcomeLabel?: string; // a feed outcome the resolver named ("Eliminated in Round of Last 16") -> exact englishLabel match
};

// The picked market as Kambi's own shape (the market's betoffers + their events). We keep the betOffer
// parent per outcome so SELECT can read sibling-outcome lines (the handicap-sign check). `events` rides
// along as the picked-market's fixtures (the contract; the funnel resolves home/away off `ctx`).
export type Slice = { events: KEvent[]; betOffers: BetOffer[] };
type Cand = { o: KOutcome; bo: BetOffer };

type Dir = "over" | "under" | "yes" | "no";
const DIR_OF_TYPE: Record<string, Dir> = { OT_OVER: "over", OT_OVER_EXACT: "over", OT_UNDER: "under", OT_YES: "yes", OT_NO: "no" };
// `type` is uninformative when absent or the catch-all OT_UNTYPED — then (and only then) read the englishLabel.
const noType = (t?: string) => !t || t === "OT_UNTYPED";
// The direction an outcome represents: from its `type`, else (untyped/absent) an EXACT lowercased englishLabel.
// The un-localized englishLabel — NOT the localized `label`, which would be e.g. Swedish "över"/"ja" once the
// fetch follows the query's language, silently breaking this match.
const dirOf = (o: KOutcome): Dir | undefined => {
  const byType = DIR_OF_TYPE[o.type ?? ""];
  if (byType) return byType;
  if (!noType(o.type)) return undefined; // type IS informative, just not a direction (OT_ONE, OT_TWO, …)
  return (["over", "under", "yes", "no"] as const).find((d) => d === (o.englishLabel ?? o.label ?? "").toLowerCase());
};

// The outcome line is stored as integer millis (2500 = 2.5, -500 = -0.5); to decimal for matching.
const lineOf = (o: KOutcome): number | null => (o.line != null ? o.line / 1000 : null);
// The outcome odds, stored as integer millis (1800 = 1.80); to decimal for the [min,max] bound check.
const oddsOf = (o: KOutcome): number | null => (o.odds != null ? o.odds / 1000 : null);
// Combo tokens compare loosely: case-insensitive, whitespace-stripped ("X2" == "x 2", "2 - 1" == "2-1").
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");

// An outcome is participant-KEYED when it carries a real participant name — not a Yes/No mirrored into
// `participant`, not the label echoed back. The shape (one outcome per player/team) is what lets a related-market
// suggestion be trimmed to the asked subject. Exported so execute classifies suggestions the same way the
// subject gate below does.
export const isNamedOutcome = (o: KOutcome): boolean => {
  const p = o.participant ?? "";
  return p !== "" && p !== (o.englishLabel ?? o.label) && p !== "Yes" && p !== "No";
};

// The outcomes that belong to the query's subject: by grounded id (preferred, diacritic-immune), else a folded
// participant-name match. A relational home/away (resolved to a team name upstream) or no subject -> all pass.
export const subjectOutcomes = (outcomes: KOutcome[], spec: { subjectId?: number; subject?: string }): KOutcome[] => {
  if (spec.subjectId != null) return outcomes.filter((o) => o.participantId === spec.subjectId);
  if (spec.subject && spec.subject !== "home" && spec.subject !== "away") {
    const s = fold(spec.subject);
    return outcomes.filter((o) => fold(o.participant ?? "").includes(s));
  }
  return outcomes;
};

export function select(slice: Slice, spec: SelectSpec, ctx: { home?: string; away?: string } = {}): Selection {
  // resolve a relational subject to the fixture's team name; a plain name passes through
  const subjName = spec.subject === "home" ? ctx.home : spec.subject === "away" ? ctx.away : spec.subject;
  const relational = spec.subject === "home" || spec.subject === "away";
  const withSubj = subjName ? { subject: subjName } : {};
  const cands: Cand[] = slice.betOffers.flatMap((bo) => (bo.outcomes ?? []).map((o) => ({ o, bo })));

  // The outcome's OWN fixture, via its betoffer's eventId — execute's step: any event fact (here home/away) is
  // read from THIS outcome's event, never a single shared `ctx`. A leg's pool can span fixtures, so a relational
  // subject must bind per-outcome.
  const eventOfBo = (bo: BetOffer): KEvent | undefined =>
    bo.eventId != null ? slice.events.find((e) => e.id === bo.eventId) : undefined;
  // Is cand `c` the home/away side IN ITS OWN fixture? Static 1X2/handicap: OT_ONE/"1" = home, OT_TWO/"2" = away
  // (no event lookup needed). Named 1X2: the outcome's participant == that event's home/away team (folded).
  const relationalSide = (c: Cand, side: "home" | "away"): boolean => {
    const [t, l] = side === "home" ? ["OT_ONE", "1"] : ["OT_TWO", "2"];
    if (c.o.type === t || (noType(c.o.type) && (c.o.englishLabel ?? c.o.label) === l)) return true;
    const team = side === "home" ? eventOfBo(c.bo)?.homeName : eventOfBo(c.bo)?.awayName;
    return !!team && isNamedOutcome(c.o) && fold(c.o.participant ?? "").includes(fold(team));
  };
  const pick = (o: KOutcome): Selection => ({ ...withSubj, outcomeId: o.id, ...(lineOf(o) != null ? { line: lineOf(o)! } : {}) });
  const absent = (fb: NonNullable<Selection["fallback"]>): Selection => ({ ...withSubj, fallback: fb });

  // The picked market's TYPE decides how the query's line VALUE is read: correct-score (3) and HT/FT (8) carry a
  // COMBO TOKEN ("2-1", "1/1"); every other market carries a NUMERIC line ("-2", "2.5"). A picked market always has
  // a betOfferType, so this is a clean two-way split — never a guess off the value's JS type (a handicap "-2" that
  // the extractor typed as a string is still a numeric line here, routed to the line matcher, not the combo one).
  const botId = slice.betOffers.find((b) => b.betOfferType?.id != null)?.betOfferType?.id;
  const isComboMarket = botId === 3 || botId === 8;
  const comboToken = isComboMarket && spec.lineValue != null ? String(spec.lineValue) : undefined;
  // a numeric line for a non-combo market; may be NaN when the raw value can't parse -> the line branch degrades.
  const numLine = !isComboMarket && spec.lineValue != null ? Number(String(spec.lineValue).trim()) : undefined;

  // The subject's SIDE in this fixture (for translating positional combo tokens, below). Prefer the event
  // participant whose id == the grounded subjectId and read its `home` flag — id-keyed, immune to name/diacritic
  // drift; fall back to a folded name match against the fixture's home/away names. undefined when undeterminable.
  const subjectSide = (): "home" | "away" | undefined => {
    if (spec.subjectId != null)
      for (const e of slice.events)
        for (const p of e.participants ?? [])
          if (p.participantId === spec.subjectId && typeof p.home === "boolean") return p.home ? "home" : "away";
    if (subjName) {
      if (fold(subjName) === fold(ctx.home ?? "")) return "home";
      if (fold(subjName) === fold(ctx.away ?? "")) return "away";
    }
    return undefined;
  };

  // ---- COMBO (correct score / HT-FT) — event-level, resolved straight off the token. homeScore/awayScore and
  // englishLabel are un-localized (immune to AWAY_HOME reversal), but the EXTRACTOR emits the token from the
  // SUBJECT's view while the feed labels it from the HOME/AWAY view (1 = home win, X = draw, 2 = away win). So
  // translate by the subject's side before matching, trying the literal token too:
  //   - HT/FT result tokens (win/draw/loss, "/"-joined) -> 1/X/2 per side  (an away team's "win/win" -> "2/2")
  //   - correct score "a-b" stated for a NAMED team is in that team's order -> reverse it for an away subject
  // (Double Chance does NOT reach here — the extractor emits it as a binary, not a selection.)
  if (comboToken != null) {
    const side = subjectSide();
    const want = norm(comboToken);
    const wants = [want];
    const R: Record<string, Record<"home" | "away", string>> =
      { win: { home: "1", away: "2" }, draw: { home: "x", away: "x" }, loss: { home: "2", away: "1" } };
    const parts = want.split("/");
    if (side && parts.every((p) => p in R)) wants.push(parts.map((p) => R[p]![side]).join("/"));
    const score = want.match(/^(\d+)-(\d+)$/);
    if (side === "away" && score) wants.push(`${score[2]}-${score[1]}`);
    const hit = cands.find(
      ({ o }) =>
        (o.homeScore != null && o.awayScore != null && wants.includes(`${o.homeScore}-${o.awayScore}`)) ||
        wants.includes(norm(o.englishLabel ?? o.label ?? "")),
    );
    return hit ? pick(hit.o) : absent("subject-absent");
  }

  // ---- OUTCOME LABEL — resolver named the exact feed outcome ("Eliminated in Round of Last 16") because
  // the market NAME alone carries no direction. Match against all cands' englishLabel (folded) BEFORE the
  // subject gate: "Tournament progress" markets put stage ids (not team ids) on outcomes, so the subject
  // gate would abort with subject-absent before we ever reach this check. A miss falls through to the
  // normal dir/line/subject logic below — honest degrade, never a blind wrong pick.
  if (spec.outcomeLabel != null) {
    const want = norm(spec.outcomeLabel);
    const hit = cands.find(({ o }) => norm(o.englishLabel ?? o.label ?? "") === want);
    if (hit) return pick(hit.o);
  }

  // Does any outcome carry a NAMED participant (player props, an outright with team outcomes)? A Yes/No
  // mirrored into `participant` does NOT count (so an owner-bound market reads as owner-bound, not named).
  const hasNamed = cands.some(({ o }) => isNamedOutcome(o));

  // ---- (1) SUBJECT -> the candidate pool ----
  let pool = cands;
  if (spec.subjectId != null) {
    const byId = cands.filter(({ o }) => o.participantId === spec.subjectId);
    if (byId.length) {
      pool = byId;
      // OUTRIGHT pick: one named outcome (label is the participant, not a direction word) with no line and only
      // the DEFAULT affirmative left to satisfy -> that outcome IS the bet, returned directly (sidesteps the
      // direction gate it can't pass). A superlative/outright ("most goals", "golden ball", "first goalscorer")
      // arrives as binary "yes", but the named outcome has no yes/no direction, so the (2) gate would wrongly
      // drop it — so accept dir null OR "yes" here; a real "no" still falls through (a genuine negation).
      if (byId.length === 1 && numLine == null && dirOf(byId[0]!.o) == null && (spec.dir == null || spec.dir === "yes")) return pick(byId[0]!.o);
    } else if (!cands.some(({ o }) => dirOf(o) === "yes")) {
      return absent("subject-absent"); // market lists OTHER participants, not the subject (and no owner-Yes)
    }
    // else (byId empty, an affirmative exists): owner-bound Yes/No market ABOUT the subject -> keep all; (3) picks Yes.
  } else if (relational) {
    // RELATIONAL subject (home/away) — bind PER FIXTURE against each outcome's OWN event, never a single
    // ctx.home: a multi-fixture "home teams to win" holds a different home team per game, so one shared name
    // would collapse the pool to that one fixture. relationalSide reads outcome -> betoffer -> event -> side,
    // unifying static-label (OT_ONE/OT_TWO) and named (participant == fixture's home/away) markets.
    pool = cands.filter((c) => relationalSide(c, spec.subject as "home" | "away"));
    if (!pool.length) return absent("subject-absent");
  } else if (spec.subject) {
    if (hasNamed) {
      // a participant NAME -> folded participant match.
      const s = fold(subjName ?? "");
      pool = cands.filter(({ o }) => fold(o.participant ?? "").includes(s));
      if (!pool.length) return absent("subject-absent");
    }
    // else: owner-bound market -> keep all outcomes; the affirmative is picked at (3).
  }

  // ---- (1.5) ODDS BOUND — narrow the pool to outcomes priced within [min,max]. A price FILTER, not a pick:
  // a priceless outcome is KEPT (lenient, like the line/time gates); an empty result is an honest degrade.
  if (spec.oddsMin != null || spec.oddsMax != null) {
    const within = (o: KOutcome) => {
      const d = oddsOf(o);
      return d == null || ((spec.oddsMin == null || d >= spec.oddsMin) && (spec.oddsMax == null || d <= spec.oddsMax));
    };
    const bounded = pool.filter(({ o }) => within(o));
    if (!bounded.length) return absent("odds-absent");
    pool = bounded;
  }

  // The participant's WHOLE pool (every line + side they hold in this market) is RETURNED; one outcome is the
  // query's match, flagged downstream. The extractor's line/dir only choose WHICH is selected — never a filter
  // that drops the rest (the live market is the source of truth; the query is a preference over it).
  const ids = pool.map(({ o }) => o.id).filter((id): id is number => id != null);
  const withPool = (o: KOutcome, line?: number, idList: number[] = ids, selIds?: number[]): Selection => ({
    ...withSubj,
    outcomeId: o.id,
    ...(line != null ? { line } : lineOf(o) != null ? { line: lineOf(o)! } : {}),
    outcomeIds: idList,
    ...(selIds?.length ? { selectedIds: selIds } : {}),
  });

  // ---- (2) DIRECTION + (3) LINE -> the SELECTED outcome (the rest of `pool` rides along for display) ----
  if (spec.dir || numLine != null) {
    if (numLine != null) {
      // A line-type market got a value that can't parse to a number (an extractor contradiction) -> honest degrade.
      if (Number.isNaN(numLine)) return absent("line-absent");
      // Handicap sign: a SAME-line betoffer (type-11 3-way) stores the line from the HOME perspective, so
      // negate it for the away side. Opposite-sign betoffers (type 1/7) store each team's own line -> as-is.
      const sameLine = (bo: BetOffer) => {
        const ls = (bo.outcomes ?? []).filter((o) => o.line != null && (o.type === "OT_ONE" || o.type === "OT_TWO")).map((o) => o.line!);
        return ls.length >= 2 && ls.every((l) => l === ls[0]);
      };
      const effLine = (c: Cand): number | null => {
        const l = lineOf(c.o);
        return l != null && sameLine(c.bo) && (c.o.type === "OT_TWO" || (c.o.englishLabel ?? c.o.label) === "2") ? -l : l;
      };
      // Exact offered line first, else the nearest offered line. Every side rides along in the pool — the
      // query no longer states over/under, so the rung alone picks which outcome is flagged the match.
      const nearest = (set: Cand[]) =>
        set.filter((c) => effLine(c) != null).sort((a, b) => Math.abs(effLine(a)! - numLine) - Math.abs(effLine(b)! - numLine))[0];
      const chosen = pool.find((c) => effLine(c) === numLine) ?? nearest(pool);
      return chosen ? withPool(chosen.o, effLine(chosen)!) : absent("line-absent");
    }
    // direction only. The asked side is a PREFERENCE over the live market, never a drop (same decision as the
    // line branch + the subjectId outright at (1)): take the matching outcome if the market offers that
    // direction. If the market has NO direction axis (a FIELD outright of named outcomes — who wins / top
    // scorer / an award), `dir` is inapplicable, so the live field wins: rank by price (odds_sort) and keep the
    // top `count` (favourite when sort="low"), leader selected. Only a real binary lacking the asked SIDE absents.
    const flt = spec.dir ? pool.filter(({ o }) => dirOf(o) === spec.dir) : pool;
    if (flt[0]) return withPool(flt[0].o);
    const directional = pool.some(({ o }) => dirOf(o) != null);
    if (!directional && spec.dir !== "no" && pool[0]) {
      const key = (c: Cand) => oddsOf(c.o) ?? (spec.sort === "high" ? -Infinity : Infinity);
      const ordered = spec.sort ? [...pool].sort((a, b) => (spec.sort === "low" ? key(a) - key(b) : key(b) - key(a))) : pool;
      const top = spec.count != null ? ordered.slice(0, spec.count) : ordered;
      return withPool(top[0]!.o, undefined, top.map(({ o }) => o.id).filter((id): id is number => id != null));
    }
    return absent("subject-absent");
  }

  // ---- (4) no direction / no line -> the owner-bound affirmative (Yes), else the single survivor ----
  const yes = !hasNamed ? pool.find(({ o }) => dirOf(o) === "yes") : undefined;
  const chosen = (yes ?? pool[0])?.o;
  if (!chosen) return absent("subject-absent");
  // RELATIONAL multi-fixture ("home teams to win"): the pool holds ONE side-outcome per fixture, each its OWN
  // answer -> flag them ALL selected, not just the first. A named/owner subject keeps single-pick semantics.
  return withPool(chosen, undefined, ids, relational ? ids : undefined);
}
