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
import { isMainLine, type BetOffer, type KEvent, type KOutcome } from "./offering-client";
import type { Selection } from "./live-menu-types";

// The query's outcome constraints, carried by the extractor as-is (value + direction) — never a market binding.
export type SelectSpec = {
  subjectId?: number; // PREFERRED: the grounded participant id (== outcome.participantId on named markets)
  subject?: string; // a participant NAME (display + fallback when no id), or the relational "home" / "away"
  // the query's outcome VALUE, carried RAW from the extractor: a numeric rung in the query's units (2.5, -2) OR a
  // combo token (correct score "2-1", HT/FT "1/1"). SELECT reads it per the picked market's betOfferType, not by
  // its JS type — a numeric line for most markets, a combo token for correct-score/HT-FT.
  lineValue?: number | string;
  dir?: "over" | "under" | "at_least" | "at_most" | "yes" | "no";
  oddsMin?: number; // price floor (decimal, 5.0): keep only outcomes priced >= min ("first scorer over 5.0")
  oddsMax?: number; // price ceiling (decimal): keep only outcomes priced <= max
  // FIXTURE-level line bounds/ranking ("games with a runs line above 8.5", "the biggest handicap"). These read
  // each fixture's HEADLINE line (its MAIN_LINE betoffer), never the whole ladder — see the schema's LineRange.
  lineMin?: number;
  lineMax?: number;
  lineSort?: "low" | "high"; // rank fixtures by |headline line|; pairs with `count` (default 1)
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
// Is an outcome inside the query's [min,max] price bound? A priceless outcome is KEPT (lenient, like the line
// gate). Shared by the outright-field block and the (1.5) odds gate.
const withinOdds = (o: KOutcome, min?: number, max?: number): boolean => {
  const d = oddsOf(o);
  return d == null || ((min == null || d >= min) && (max == null || d <= max));
};
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

// An OUTRIGHT-FIELD outcome: the outcome's own label IS a competitor — its participant name equals its
// englishLabel/label (one outcome per player/team: a top-scorer / MVP / winner list). This is the live feed's
// real shape for outright fields (participant == englishLabel == "Alexander Isak"), and it's the MIRROR IMAGE of
// isNamedOutcome — the distinguishing signal from a player-prop line (participant "Isak", label "Over 16.5"),
// which isNamedOutcome catches but this does not.
const isOutrightOutcome = (o: KOutcome): boolean => {
  const p = o.participant ?? "";
  return p !== "" && p !== "Yes" && p !== "No" && p === (o.englishLabel ?? o.label);
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
  let cands: Cand[] = slice.betOffers.flatMap((bo) => (bo.outcomes ?? []).map((o) => ({ o, bo })));

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
  const absent = (fb: NonNullable<Selection["fallback"]>): Selection => ({ ...withSubj, fallback: fb });
  // The combo + outcome-label branches below RETURN through here, above the (1.5) odds gate — so the price
  // bound is enforced here too, or "in straights above 1.7" would hand back a 1.38 correct-score. Checked on
  // the already-chosen outcome (never a pool prune): the gate must not outlive the subject narrowing, or the
  // OPPONENT's row survives the bound and becomes the answer.
  const pick = (o: KOutcome): Selection =>
    withinOdds(o, spec.oddsMin, spec.oddsMax)
      ? { ...withSubj, outcomeId: o.id, ...(lineOf(o) != null ? { line: lineOf(o)! } : {}) }
      : absent("odds-absent");

  // ---- (0) FIXTURE LINE — bound or rank fixtures by their HEADLINE line, before anything picks an outcome.
  // "games with a runs line above 8.5" is about the fixture's headline, not a rung of its ladder: every game
  // offers the whole 6.5-12.5 ladder, so an outcome-level bound would keep every game and filter nothing. The
  // headline is the feed's MAIN_LINE betoffer (one per market family per event).
  // MAGNITUDE, not signed value — "a handicap bigger than 10" means a 10-point head start either way, and the
  // feed stores it as -12.5. Totals are positive so |x| is a no-op there.
  // Lenient like the other gates: a fixture whose market carries no MAIN_LINE is KEPT (never dropped on missing
  // data); a bound that matches nothing degrades to an honest `line-absent` rather than silently widening.
  const headline = new Map<number, number>();
  for (const bo of slice.betOffers) {
    if (bo.eventId == null || headline.has(bo.eventId) || !isMainLine(bo.tags)) continue;
    const l = (bo.outcomes ?? []).map(lineOf).find((x): x is number => x != null);
    if (l != null) headline.set(bo.eventId, Math.abs(l));
  }
  const headlineOf = (bo: BetOffer): number | undefined => (bo.eventId != null ? headline.get(bo.eventId) : undefined);
  if (spec.lineMin != null || spec.lineMax != null) {
    const kept = cands.filter(({ bo }) => {
      const h = headlineOf(bo);
      return h == null || ((spec.lineMin == null || h >= spec.lineMin) && (spec.lineMax == null || h <= spec.lineMax));
    });
    if (!kept.length) return absent("line-absent");
    cands = kept;
  }
  if (spec.lineSort) {
    // Rank the FIXTURES (not the outcomes) and keep the top `count` — "which game has the biggest handicap"
    // wants one game, with all of its outcomes intact for display.
    const ranked = [...new Set(cands.map((c) => c.bo.eventId).filter((id): id is number => id != null && headline.has(id)))]
      .sort((a, b) => (spec.lineSort === "low" ? headline.get(a)! - headline.get(b)! : headline.get(b)! - headline.get(a)!));
    const top = new Set(ranked.slice(0, spec.count ?? 1));
    if (top.size) cands = cands.filter((c) => c.bo.eventId != null && top.has(c.bo.eventId));
  }

  // The picked market's TYPE decides how the query's line VALUE is read: correct-score (3) and HT/FT (8) carry a
  // COMBO TOKEN ("2-1", "1/1"); every other market carries a NUMERIC line ("-2", "2.5"). A picked market always has
  // a betOfferType, so this is a clean two-way split — never a guess off the value's JS type (a handicap "-2" that
  // the extractor typed as a string is still a numeric line here, routed to the line matcher, not the combo one).
  const botId = slice.betOffers.find((b) => b.betOfferType?.id != null)?.betOfferType?.id;
  const isComboMarket = botId === 3 || botId === 8;
  // token: extractor's line, or — when it stated none (an idiom like "straight sets" it can't resolve blind to
  // the menu) — the picker's named outcome. Both are in the SUBJECT's view; the flip below maps to the feed side.
  const comboToken = isComboMarket ? (spec.lineValue != null ? String(spec.lineValue) : spec.outcomeLabel) : undefined;
  // a numeric line for a non-combo market; an unparseable value (e.g. the extractor put the side-word "over" in a
  // number field) reads as NO line stated -> fall through to show every side, never drop the leg.
  const rawLine = !isComboMarket && spec.lineValue != null ? Number(String(spec.lineValue).trim()) : undefined;
  // Same call, one case further: a ladder constraint the picked market CANNOT EXPRESS also reads as NOT
  // STATED. "to win at least one set" arrives as line 1 + at_least, but the market is a Yes/No with no line
  // axis at all — the count is part of its NAME, not a rung to match. over/under/at_least/at_most only mean
  // something against a ladder, so the direction goes with the line; yes/no are real here and pass through.
  // Combo markets are lineless BY DESIGN (they carry homeScore/awayScore) -> excluded, their token is read above.
  const lineless = !isComboMarket && !cands.some(({ o }) => o.line != null);
  const numLine = Number.isNaN(rawLine) || lineless ? undefined : rawLine;
  if (lineless && ["over", "under", "at_least", "at_most"].includes(spec.dir ?? "")) spec = { ...spec, dir: undefined };

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
    // away subject: the feed scoreline is the REVERSED one; the literal is the OPPONENT's. Replace, don't add —
    // else "2-0" and "0-2" both sit in `wants` and the match is decided by feed order, not the subject.
    if (side === "away" && score) { wants.length = 0; wants.push(`${score[2]}-${score[1]}`); }
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
    const hit = cands.find(({ o }) =>
      norm(o.englishLabel ?? o.label ?? "") === want || (want === "draw" && o.type === "OT_CROSS"));
    if (hit) return pick(hit.o);
  }

  // Does any outcome carry a NAMED participant (player props, an outright with team outcomes)? A Yes/No
  // mirrored into `participant` does NOT count (so an owner-bound market reads as owner-bound, not named).
  const hasNamed = cands.some(({ o }) => isNamedOutcome(o));

  // ---- OUTRIGHT FIELD (a "who wins / MVP / top scorer" list of named competitors — no side, no line, no
  // combo, no directional axis) — ranked by odds (favourite first, or `high` for underdog-first) and never
  // sliced to `count`. When the query NAMES a competitor the field is not the answer — that one price is — so
  // we narrow to the subject's rows ("Haaland first scorer" returns Haaland, not 34 players). A field ask with
  // no named subject ("who wins") still renders WHOLE: the list IS the answer there. Named-but-unpriced falls
  // back to the whole field, so an absent player still shows the market. `selectedIds` carries the id(s) to
  // HIGHLIGHT: the named subject, else the favourite / top-`count` on a "who's the favourite / top N" ask
  // (odds_sort/count set), else nothing. A "no" is a genuine negation -> falls through to the gates below.
  const isField =
    cands.some(({ o }) => isOutrightOutcome(o)) && !isComboMarket && numLine == null && spec.dir !== "no" && !cands.some(({ o }) => dirOf(o) != null);
  if (isField) {
    const asked = spec.subjectId != null || (spec.subject != null && spec.subject !== "home" && spec.subject !== "away");
    // The price bound applies to WHAT WAS ASKED FOR: a named subject's own rows, else the field itself.
    // Filtering the whole field up front drops a priced-out subject and then hands back the REST of the
    // field as if it were the answer — "De Minaur to win, only if priced above 1.5" rendered Fery @4.3.
    const field = asked ? [...cands] : cands.filter(({ o }) => withinOdds(o, spec.oddsMin, spec.oddsMax));
    if (!field.length) return absent("odds-absent");
    const desc = spec.sort === "high";
    field.sort((a, b) => {
      const ka = oddsOf(a.o) ?? Infinity, kb = oddsOf(b.o) ?? Infinity;
      return desc ? kb - ka : ka - kb; // default favourite-first
    });
    const ids = field.map(({ o }) => o.id).filter((id): id is number => id != null);
    const subjOut = asked ? subjectOutcomes(field.map(({ o }) => o), spec) : [];
    // A subject that IS in the field but fails the bound is an honest miss, not a reason to show the field.
    if (subjOut.length && !subjOut.some((o) => withinOdds(o, spec.oddsMin, spec.oddsMax))) return absent("odds-absent");
    const subj = subjOut.map((o) => o.id).filter((id): id is number => id != null);
    const sel = subj.length ? subj : !asked && (spec.sort != null || spec.count != null) ? ids.slice(0, spec.count ?? 1) : [];
    return { ...withSubj, ...(sel.length ? { outcomeId: sel[0], selectedIds: sel } : {}), outcomeIds: subj.length ? subj : ids };
  }

  // ---- (1) SUBJECT -> the candidate pool ----
  let pool = cands;
  if (spec.subjectId != null) {
    const byId = cands.filter(({ o }) => o.participantId === spec.subjectId);
    if (byId.length) {
      pool = byId;
      // (An outright field with a named subject is already handled above by the OUTRIGHT FIELD block, which
      // renders the whole list and highlights the subject. Here byId is a subject-scoped DIRECTIONAL/line
      // market — the line/dir gates below pick the outcome.)
    } else if (hasNamed && !cands.some(({ o }) => dirOf(o) === "yes")) {
      return absent("subject-absent"); // market NAMES other participants, not the subject (and no owner-Yes)
    }
    // else (byId empty): either NO outcome names anyone — an owner-scoped market whose outcomes carry no
    // participant, e.g. "Total Aces - Taylor Fritz" with anonymous Over/Under — or an affirmative Yes exists.
    // Both are ABOUT the subject, so keep the whole pool; the line/dir/(3)/(4) branches pick the outcome.
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
    const bounded = pool.filter(({ o }) => withinOdds(o, spec.oddsMin, spec.oddsMax));
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
    // A BAND is inclusive of N ("2+ hits" = >= 2) and no feed outcome type says that: a ladder prices it as the
    // OVER at the largest line BELOW N ("over 1.5" IS "2+"), a band market labels an outcome at N itself. Only
    // here are the offered rungs visible, so the band is read as its SIDE and the line branch prefers the exact
    // N, then that side's inclusive rungs. over/under/yes/no pass through unchanged.
    const dir = spec.dir === "at_least" ? "over" : spec.dir === "at_most" ? "under" : spec.dir;
    if (numLine != null) {
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
      // Exact offered line first, else the nearest offered line. When the query stated a SIDE (over/under),
      // pick from that side so "over 9.5" doesn't flag the Under at 9.5; a handicap has no over/under axis
      // (dirOf undefined) so sidePool == pool, unchanged. A preference, never a drop — every side still rides
      // along in the returned pool for display.
      // MARGIN on a SIDE ladder: "win by N or more" (at_least, positive N) reaches a handicap whose rungs are
      // SIGNED from the subject's side — there is no over/under axis to read N against. The rung that pays
      // exactly at margin N is -(N-0.5) ("by 2+" = -1.5). Stated handicap lines (negative, or on an over/under
      // ladder) pass through untouched. ponytail: "win by MORE than N" (dir=over) not converted — add -(N+0.5)
      // when a real query produces it.
      const sideLadder = !pool.some(({ o }) => dirOf(o) != null);
      const asMargin = spec.dir === "at_least" && numLine > 0 && sideLadder;
      const want = asMargin ? -(numLine - 0.5) : numLine;
      const nearest = (set: Cand[]) =>
        set.filter((c) => effLine(c) != null).sort((a, b) => Math.abs(effLine(a)! - want) - Math.abs(effLine(b)! - want))[0];
      const sidePool = dir && pool.some(({ o }) => dirOf(o) === dir) ? pool.filter(({ o }) => dirOf(o) === dir) : pool;
      // A band takes the rungs on its inclusive side only ("2+" -> over 1.5, never over 2.5); a margin's
      // inclusive side is the LESS negative rung (-0.5 still pays whenever a 2+ win happens); null for a stated
      // side/handicap line, which leaves the exact-then-nearest pick byte-identical to before.
      const inBand =
        asMargin ? (l: number) => l > want :
        spec.dir === "at_least" ? (l: number) => l < numLine : spec.dir === "at_most" ? (l: number) => l > numLine : null;
      const chosen =
        sidePool.find((c) => effLine(c) === want) ??
        (inBand ? nearest(sidePool.filter((c) => effLine(c) != null && inBand(effLine(c)!))) : undefined) ??
        nearest(sidePool);
      return chosen ? withPool(chosen.o, effLine(chosen)!) : absent("line-absent");
    }
    // direction only. The asked side is a PREFERENCE over the live market, never a drop (same decision as the
    // line branch + the subjectId outright at (1)): take the matching outcome if the market offers that
    // direction. If the market has NO direction axis (a FIELD outright of named outcomes — who wins / top
    // scorer / an award), `dir` is inapplicable, so the live field wins: rank by price (odds_sort) and keep the
    // top `count` (favourite when sort="low"), leader selected. Only a real binary lacking the asked SIDE absents.
    const flt = dir ? pool.filter(({ o }) => dirOf(o) === dir) : pool;
    if (flt[0]) return withPool(flt[0].o);
    // "no <stat>" on an over/under ladder: zero-of-the-stat IS the 0.5 boundary — "not scoring" = Under 0.5,
    // an owner-bound "to score" (yes) = Over 0.5. Exact 0.5 rung first, else that side's nearest (honest
    // degrade, same as the line branch). Only reached when no literal Yes/No outcome matched above.
    if (dir === "no" || dir === "yes") {
      const side = dir === "no" ? "under" : "over";
      const rungs = pool.filter(({ o }) => dirOf(o) === side && lineOf(o) != null);
      const zero =
        rungs.find(({ o }) => lineOf(o) === 0.5) ??
        rungs.sort((a, b) => Math.abs(lineOf(a.o)! - 0.5) - Math.abs(lineOf(b.o)! - 0.5))[0];
      if (zero) return withPool(zero.o, lineOf(zero.o)!);
    }
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
  // MULTI-FIXTURE: the pool holds one answer PER FIXTURE, each its own -> flag one per event, not just the
  // first. Not only the relational case ("home teams to win"): a NAMED subject spans fixtures too ("City to
  // win", several upcoming games), and flagging only the first leaves every later card rendered with nothing
  // selected. Dedupe over the answers `chosen` came from, so the flagged id per event matches the pick rule.
  // A single-fixture pool keeps single-pick semantics, unchanged.
  const answers = yes ? pool.filter(({ o }) => dirOf(o) === "yes") : pool;
  const perEvent = new Map<number, number>();
  for (const { o, bo } of answers) if (bo.eventId != null && o.id != null && !perEvent.has(bo.eventId)) perEvent.set(bo.eventId, o.id);
  return withPool(chosen, undefined, ids, perEvent.size > 1 ? [...perEvent.values()] : undefined);
}
