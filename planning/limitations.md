# Known limitations

The canonical list of things the resolver deliberately does **not** handle yet, by sport. Each entry says what fails, why, and whether it's a fixable gap or a permanent data limit. When a plan defers something product-facing, record it here so it isn't mistaken for a bug later.

## Tennis

- **Doubles is not supported.** Only singles (one player per side) grounds. Doubles pairs (e.g. "Granollers/Zeballos") are a different shape — two people acting as one side — and live in separate feeds/tree nodes (the `CD` feed, `ATP Doubles`/`WTA Doubles`). A query like "Granollers and Zeballos to win the doubles" won't ground. *Fixable later; deferred because singles covers nearly all queries.*

- **Davis Cup / national-team tennis is not guaranteed.** When countries play instead of individuals (Davis Cup, Billie Jean King Cup), the side is a country team — the 16 `TEAM` entries in the feed (Sweden, Australia, France…). These are kept only if they survive the normalizer's noise filter, which is club-shaped and may drop them (basketball national teams hit the same filter). So "Sweden to win the Davis Cup" may or may not work. *Fixable later; not chased in v1 — rare next to "Alcaraz to win".*

- **No country/region scoping.** Tennis has no geography tree: ATP, WTA, and the Grand Slams sit flat under the sport root, with no country layer above them (a player's nationality is not a scopable region). So "tennis matches in Spain" or "Spanish tennis" can't narrow by region. *Permanent data limit, not a bug — the data simply has no such layer.*

## Basketball

- **National teams are missing.** The normalizer's noise pass drops clubs whose only competition is "International Friendly Matches". Basketball national teams (Spain, USA, Serbia, Senegal…) are in the feeds (~160 clubs) but have no deeper competition node in the basketball tree, so they get dropped and won't ground. *Fixable — skip the friendly-only drop for clubs the NT detector tags, or add FIBA tournament nodes to the tree.*

- **No US super-region.** NBA, WNBA, and NCAAB are flat siblings under the sport root with no "US" region tying them together, so a cross-league US region query can't scope. *Permanent-ish data limit; rare, acceptable for v1.*

## Cross-sport

- **One sport per query.** `plan.sport` is a single sport, so mixed-sport parlays ("LeBron 25+ pts AND Man City win") are not handled — cross-sport legs are deferred.
