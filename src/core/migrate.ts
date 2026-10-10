// The scene document's version: the migration table's length is the version,
// so a version bump without a migration, or a migration without a bump, cannot
// be written. Every change to the document's shape appends one migration.
// A dev build may substitute another module for this one (tools/build.mjs
// --migrations); a substitute exports the same three names.
// Pure: no browser global, no Node API, no I/O.

/**
 * A total function from a document at version v to the same document at
 * version v + 1, its `version` field included: the parse chain refuses a
 * result whose version is not v + 1. It may write to its argument, which the
 * chain copies first. A migration that keeps the shape, such as the first one,
 * which marks the shape frozen, is still `(json) => ({ ...json, version: v + 1 })`.
 */
export type Migration = (json: unknown) => unknown;

/** Version 0 to 1. Freeze these defaults here so later defaults never rewrite old scenes. */
const addSurface: Migration = (json) => {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return json;
  // Preserve unknown keys for the strict parse; migration only adds its field.
  return { ...json, version: 1, surface: { enabled: false, pattern: 'bars', relief: 0.5, refraction: 0.5, shine: 0.5, scale: 0.5 } };
};

/** Version 1 to 2. Preserve the old camera travel for every existing scene. */
const addParallax: Migration = (json) => {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return json;
  const motion = 'motion' in json ? json.motion : null;
  // Leave malformed motion untouched for the strict parse to report it.
  const patch = typeof motion === 'object' && motion !== null && !Array.isArray(motion) ? { motion: { ...motion, parallax: 1 } } : {};
  return { ...json, ...patch, version: 2 };
};

/** Version 2 to 3. Existing layers keep their names and remain visible. */
const addLayerVisibility: Migration = (json) => {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return json;
  const objects = 'objects' in json && Array.isArray(json.objects) ? json.objects.map((object: unknown, index: number) => {
    if (typeof object !== 'object' || object === null || Array.isArray(object)) return object;
    return { name: `Object ${index + 1}`, ...object, hidden: false };
  }) : undefined;
  return { ...json, ...(objects === undefined ? {} : { objects }), version: 3 };
};

/** Version 3 to 4. An existing orbit keeps its circular path and amplitude. */
const addDrift: Migration = (json) => {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return json;
  const motion = 'motion' in json ? json.motion : null;
  if (typeof motion !== 'object' || motion === null || Array.isArray(motion) || !('orbit' in motion) || 'drift' in motion) {
    return { ...json, version: 4 };
  }
  const { orbit, ...rest } = motion;
  return { ...json, version: 4, motion: { ...rest, drift: { direction: 'circle', amount: orbit } } };
};

export const MIGRATIONS = [addSurface, addParallax, addLayerVisibility, addDrift] as const satisfies readonly Migration[];

/** The table's length, typed as the tuple's literal length, so `SceneDocument['version']` is a literal type. */
export const SCENE_VERSION = MIGRATIONS.length;
