// Per-sport config registry. Each entry drives build-scope-index, scope-catalog, and ground-scope.
// slug matches the lowercase data/ directory name and the scope-index.json "sport" field.
// label is what the extractor emits (uppercase free-text in plan.sport).

export type SportConfig = {
  slug: string;
  label: string;
  sportRootId: number;
  participantsFile: string;
};

export const SPORTS: Record<string, SportConfig> = {
  football: { slug: "football", label: "FOOTBALL", sportRootId: 1000093190, participantsFile: "football_participants.json" },
  basketball: { slug: "basketball", label: "BASKETBALL", sportRootId: 1000093204, participantsFile: "basketball_participants.json" },
};

export function getSport(slug: string): SportConfig | undefined {
  return SPORTS[slug.toLowerCase()];
}
