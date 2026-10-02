# Known limitations

The canonical list of things the resolver deliberately does **not** handle yet, by sport. Each entry says what fails, why, and whether it's a fixable gap or a permanent data limit. When a plan defers something product-facing, record it here so it isn't mistaken for a bug later.

## Tennis

- **Doubles: pair-named queries work; one-partner queries still miss.** (Fixed 2026-08-22, verified live
  against Cincinnati doubles.) Pairs ground by surname-set match against the pair entries in the players
  table — any order/separator ("Granollers/Zeballos", "Marcel Granollers and Horacio Zeballos"), and split
  partner mentions rejoin via the leg-level pair join. Padel and table-tennis inherit this (same catalog
  shape). Still missing: a query naming only ONE partner ("Granollers doubles tonight") — doubles events
  attach only to pair participant ids and the catalog doesn't link a player to their pairs. *Fixable —
  needs a player→pairs expansion at recall.* Typos inside a surname don't match either (no fuzzy layer);
  the entity gate clarifies with suggestions instead. *Deliberately not built until real traffic shows it.*

- **Mixed doubles: honest miss until the feed lists it.** Kambi carries no mixed offering most of the year
  (no group, no events — checked 2026-08-22). The extractor now keeps the "doubles"/"mixed doubles"
  qualifier in the market phrase (prompt edit 2026-08-22, **eval gate not yet run**), so these resolve to
  "not offered" instead of substituting a singles market. When the US Open mixed event appears, the daily
  catalog refresh picks up its group and pairs ground via the doubles path — untested until then.

- **Davis Cup / national-team tennis: honest out-of-season, thin data.** Probed 2026-08-22: no Davis Cup /
  BJK Cup / United Cup groups in the feed → "Spain to win the Davis Cup" clarifies honestly (sport
  inference correctly stays tennis, not football). The catalog holds 37 senior-men and only 2 senior-women
  NT rows, and 0 of ~56k players carry a countryTeamId link (the tennis half of the normalizer NT gap).
  Men's Davis Cup should ground once the group returns via the daily refresh; BJK Cup (women) will likely
  miss. *Fixable later; not chased — rare next to "Alcaraz to win".*

- **No country/region scoping.** Tennis has no geography tree: ATP, WTA, and the Grand Slams sit flat under the sport root, with no country layer above them (a player's nationality is not a scopable region). So "tennis matches in Spain" or "Spanish tennis" can't narrow by region. *Permanent data limit, not a bug — the data simply has no such layer.*

## Basketball

- **National teams are missing.** The normalizer's noise pass drops clubs whose only competition is "International Friendly Matches". Basketball national teams (Spain, USA, Serbia, Senegal…) are in the feeds (~160 clubs) but have no deeper competition node in the basketball tree, so they get dropped and won't ground. *Fixable — skip the friendly-only drop for clubs the NT detector tags, or add FIBA tournament nodes to the tree.*

- **No US super-region.** NBA, WNBA, and NCAAB are flat siblings under the sport root with no "US" region tying them together, so a cross-league US region query can't scope. *Permanent-ish data limit; rare, acceptable for v1.*

## Cross-sport

- **One sport per query.** `plan.sport` is a single sport, so mixed-sport parlays ("LeBron 25+ pts AND Man City win") are not handled — cross-sport legs are deferred.

- **Unknown sport (`other`) is rescued only on precise names.** When the extractor can't tell the sport, the sport
  that places every named team (read with its squad) is used, and a tie between sports is settled by the feed
  (biggest match in the asked window; the other sides are named in a note). If any name is only a weak match in
  some sport, the query stops with the unsupported-sport message, as before: "England women" is behind its U19
  twin in football, and bare "Växjö" matches two football teams, so "Växjö to beat Lund" (the men's sides) is not
  rescued. *Deliberate: a weak match is usually the name's real sport, so acting on it would switch silently to
  the wrong one (see recover-sport.ts).*
