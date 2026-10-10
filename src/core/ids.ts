// Branded identifiers. A brand keeps two strings of different meaning from
// being mixed up; a value gets one only through a check that proves its shape.
// Pure: no browser global, no Node API, no I/O.

export type Brand<T, B extends string> = T & { readonly __brand: B };

/** UUID v4, minted at import. */
export type SceneId = Brand<string, 'SceneId'>;
/** UUID v4. */
export type ObjectId = Brand<string, 'ObjectId'>;
/** UUID v4. */
export type LightId = Brand<string, 'LightId'>;
/** 64 lowercase hex: the SHA-256 of the asset's bytes. */
export type AssetId = Brand<string, 'AssetId'>;
/** '<model name>@<64 lowercase hex>', as models.lock.json records it. */
export type ModelId = Brand<string, 'ModelId'>;
/** '<commit>-<yyyymmdd>': 12 or more lowercase hex digits, or 'nocommit', then the build's UTC date. */
export type BuildId = Brand<string, 'BuildId'>;
/** UUID v4, one per page load. */
export type TabId = Brand<string, 'TabId'>;

export type NonEmpty<T> = readonly [T, ...T[]];

const BUILD_ID = /^(?:[0-9a-f]{12,}|nocommit)-\d{8}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MODEL_ID = /^[a-z][a-z0-9-]*@[0-9a-f]{64}$/;

export function isBuildId(text: string): text is BuildId {
  return BUILD_ID.test(text);
}

/** True for a lowercase UUID v4, the form `crypto.randomUUID()` returns. */
export function isTabId(text: string): text is TabId {
  return UUID_V4.test(text);
}

/** True for a lowercase UUID v4. */
export function isSceneId(text: string): text is SceneId {
  return UUID_V4.test(text);
}

/** True for a lowercase UUID v4. */
export function isObjectId(text: string): text is ObjectId {
  return UUID_V4.test(text);
}

/** True for a lowercase UUID v4. */
export function isLightId(text: string): text is LightId {
  return UUID_V4.test(text);
}

/** True for 64 lowercase hex digits, the form of a SHA-256 digest. */
export function isAssetId(text: string): text is AssetId {
  return SHA256_HEX.test(text);
}

/** True for a model name (a lowercase letter, then lowercase letters, digits, and hyphens), '@', and 64 lowercase hex digits. */
export function isModelId(text: string): text is ModelId {
  return MODEL_ID.test(text);
}
