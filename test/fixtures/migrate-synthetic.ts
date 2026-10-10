// A stand-in for src/core/migrate.ts with two migrations, so SCENE_VERSION is 2:
// the first adds analysis.legacyPlate (an ImageRef or null; a version-0
// document gets null), and the second deletes it. A version-1 document whose
// legacyPlate names an asset is then a document whose migration drops a
// reference, and a version-0 document walks both. Each migration writes the
// version it yields, as every migration must.
// Node tests pass MIGRATIONS to core/schema.ts's parseDocumentWith; a dev build
// given `--migrations test/fixtures/migrate-synthetic.ts` loads this module
// wherever an import resolves to core/migrate.ts. It exports the same names as
// that module, and imports from it only a type, which the build erases, so the
// substituted build does not load the real module.
// Pure: no browser global, no Node API, no I/O.

import type { Migration } from '../../src/core/migrate.ts';

export type { Migration };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Version 0 to 1: adds `analysis.legacyPlate`, null. A document with no `analysis` object keeps what it has, for the strict parse to refuse. */
const addLegacyPlate: Migration = (json) => {
  if (!isRecord(json)) return json;
  const analysis = json['analysis'];
  if (!isRecord(analysis)) return { ...json, version: 1 };
  return { ...json, version: 1, analysis: { ...analysis, legacyPlate: null } };
};

/** Version 1 to 2: deletes `analysis.legacyPlate`, dropping the asset it named. */
const dropLegacyPlate: Migration = (json) => {
  if (!isRecord(json)) return json;
  const analysis = json['analysis'];
  if (!isRecord(analysis)) return { ...json, version: 2 };
  return { ...json, version: 2, analysis: Object.fromEntries(Object.entries(analysis).filter(([key]) => key !== 'legacyPlate')) };
};

export const MIGRATIONS = [addLegacyPlate, dropLegacyPlate] as const satisfies readonly Migration[];

export const SCENE_VERSION = MIGRATIONS.length;
