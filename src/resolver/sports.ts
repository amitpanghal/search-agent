// Per-sport config registry. Each entry drives build-scope-index, scope-catalog, and ground-scope.
// slug matches the lowercase data/ directory name and the scope-index.json "sport" field.
// label is what the extractor emits (uppercase free-text in plan.sport).

export type SportConfig = {
  slug: string;
  label: string;
  sportRootId: number;
  participantsFile: string;
  individual?: boolean;
  // Pass --national-teams to the normalizer (flag NT clubs / link countryTeamId). Basketball is off until
  // FIBA competitions appear in the offering (see project notes); flip to true when they do.
  nationalTeams?: boolean;
  // Individual sports only: maps a sport-root child (tour) NAME to the feed CODE that build-scope-index
  // reads for gender de-pollution. fetch-participants writes one <code>_participants.json per entry.
  tourFeeds?: Record<string, string>;
};

export const SPORTS: Record<string, SportConfig> = {
  football: { slug: "football", label: "FOOTBALL", sportRootId: 1000093190, participantsFile: "football_participants.json", nationalTeams: true },
  basketball: { slug: "basketball", label: "BASKETBALL", sportRootId: 1000093204, participantsFile: "basketball_participants.json" },
  baseball: { slug: "baseball", label: "BASEBALL", sportRootId: 1000093211, participantsFile: "baseball_participants.json" },
  tennis: {
    slug: "tennis", label: "TENNIS", sportRootId: 1000093193, participantsFile: "tennis_participants.json", individual: true, nationalTeams: true,
    tourFeeds: { "ATP": "ATP", "WTA": "WTA", "ITF Men": "ITFM", "ITF Women": "ITFW", "UTR Pro Tennis Series": "UTRM", "UTR Pro Tennis Series Women": "UTRW" },
  },
};

export function getSport(slug: string): SportConfig | undefined {
  return SPORTS[slug.toLowerCase()];
}
