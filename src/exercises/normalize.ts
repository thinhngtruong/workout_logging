/** "  Bench   PRESS " -> "bench press". Used for uniqueness and lookups; the display name keeps its casing. */
export const normalizeExerciseName = (name: string): string => name.trim().replace(/\s+/g, ' ').toLowerCase();
