// The durable v6 recipe. Source is authoritative; admission rebuilds proofs.
// v5 stays frozen. Derived Camera controls are a read projection, never storage.
import { collectCompositionAssets } from './asset-refs.ts';
import { COMPOSITION_LIMITS } from './composition-ranges.ts';
import { compositionDocumentSchema, compositionDocumentShapeSchema, compositionObjectIdSchema, compositionSizeSchema, rgbaRefSchema } from './composition-schema.ts';
import { sameValue } from './equal.ts';
import { createMathLibrary, mathFunctionSourceSchema, mathRefKey, mathRefSchema, MATH_PRESET_FUNCTIONS, type MathFunctionLibrary, type MathFunctionSource, type MathRef } from './math-definition.ts';
import { byteLength, location, mathAttempt, MATH_LIMITS, refuse, unwrapMath, type MathResult, type TypedMathExpression } from './math-expression.ts';
import { admitMathRecipeBytes, CONTRAST_BLOCK_SOURCE, createMathBlock, GRAIN_BLOCK_SOURCE, mathBlockSourceSchema, resolveMathParameters, TEXTURE_BLOCK_SOURCE, type MathBlockSource } from './math-graph.ts';
import { PAINT_LIMITS, PAINT_TILE_SIZE, type PaintBrush } from './paint.ts';
import type { FrozenCompositionDocument, Style } from './types.ts';
import { z } from './zod.ts';

export const REMIX_DOCUMENT_VERSION = 6;
export const MATH_REMIX_GPU_BYTES = 128 * 1024 * 1024;
export const REMIX_LIMITS = Object.freeze({ ...MATH_LIMITS, patches: PAINT_LIMITS.patches, tilesPerPatch: PAINT_LIMITS.tiles,
  tiles: PAINT_LIMITS.patches * PAINT_LIMITS.tiles, layers: COMPOSITION_LIMITS.readableLayers });
const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const unit = z.number().min(0).max(1);
export const remixTargetSchema = z.enum(['photo', 'brush']);
export type RemixTarget = z.infer<typeof remixTargetSchema>;
export const remixSiteSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('block'), instance: identity }),
  z.strictObject({ kind: z.literal('function'), instance: identity, node: identity }),
]).readonly();
export type Site = z.infer<typeof remixSiteSchema>;
export const mathCheckpointSchema = z.strictObject({ appliedRevision: revision, draftRevision: revision, checkpointRevision: revision }).readonly()
  .refine(value => value.checkpointRevision >= value.appliedRevision && value.checkpointRevision >= value.draftRevision,
    'The checkpoint must include the newest applied and draft revisions.');
export type MathCheckpoint = z.infer<typeof mathCheckpointSchema>;
export const mathDiagnosticSchema = z.strictObject({
  kind: z.enum(['syntax', 'type', 'domain', 'budget', 'cycle', 'missing', 'context', 'value', 'revision']),
  message: z.string(), sourceId: z.string(), path: z.string().nullable(),
  span: z.strictObject({ start: revision, end: revision, line: z.number().int().positive(), column: z.number().int().positive() })
    .refine(span => span.end >= span.start, 'The source span must end after it starts.').readonly(),
}).readonly();
export const functionDraftSchema = z.strictObject({ id: identity, base: mathRefSchema.nullable(), revision,
  source: z.string().refine(source => byteLength(source) <= MATH_LIMITS.draftBytes, 'A recoverable draft can contain at most 16 KiB.'),
  phase: z.enum(['checking', 'invalid', 'valid']), diagnostics: z.array(mathDiagnosticSchema).readonly(), site: remixSiteSchema.nullable(),
}).readonly();
export type FunctionDraft = z.infer<typeof functionDraftSchema>;
export const remixInstanceSchema = z.strictObject({ id: identity, target: remixTargetSchema, block: mathRefSchema,
  enabled: z.boolean(), parameters: z.record(z.string(), z.number().finite()).readonly(),
}).readonly();
export type RemixInstance = z.infer<typeof remixInstanceSchema>;
export const remixOwnershipSchema = z.strictObject({ kind: z.enum(['block', 'function']), ref: mathRefSchema,
  owner: identity, label: z.string().min(1).max(80),
}).readonly();
export type RemixOwnership = z.infer<typeof remixOwnershipSchema>;
export const remixStateSchema = z.strictObject({
  functions: z.array(mathFunctionSourceSchema.transform((source): MathFunctionSource => source)).max(MATH_LIMITS.functionRevisions).readonly(),
  blocks: z.array(mathBlockSourceSchema).readonly(), instances: z.array(remixInstanceSchema).max(2 * MATH_LIMITS.blocksPerRack).readonly(),
  ownership: z.array(remixOwnershipSchema).readonly(), grainInstance: identity.nullable(),
  bypasses: z.array(z.strictObject({ instance: identity, node: identity, functions: z.array(z.strictObject({ node: identity, ref: mathRefSchema }).readonly()).readonly() }).readonly()).readonly(),
  drafts: z.array(functionDraftSchema).readonly(), checkpoint: mathCheckpointSchema,
}).readonly();
export type RemixState = z.infer<typeof remixStateSchema>;
export const strokePatchSchema = z.strictObject({ id: identity, owner: compositionObjectIdSchema, order: revision,
  disparity: unit, brush: mathRefSchema, seed: z.number().int().min(0).max(0xffffffff), size: compositionSizeSchema,
  tiles: z.array(z.strictObject({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), rgba: rgbaRefSchema }).readonly())
    .max(PAINT_LIMITS.tiles).readonly(),
}).readonly();
export type StrokePatch = z.infer<typeof strokePatchSchema>;
export const paintLayerSchema = z.strictObject({ id: compositionObjectIdSchema, name: z.string().min(1).max(80),
  hidden: z.boolean(), opacity: unit, patches: z.array(strokePatchSchema).max(PAINT_LIMITS.patches).readonly(),
}).readonly();
export type PaintLayer = z.infer<typeof paintLayerSchema>;
const brushFields = { diameter: z.number().min(1).max(256), opacity: unit, pressure: z.enum(['off', 'size']) };
// MRX2 exports the inferred settings type, but keeps its boundary schema private.
export const remixPaintBrushSchema: z.ZodType<PaintBrush> = z.discriminatedUnion('operation', [
  z.strictObject({ ...brushFields, operation: z.literal('draw'), color: z.strictObject({ l: unit, c: z.number().min(0).max(.4), h: z.number().min(0).max(360) }).readonly() }),
  z.strictObject({ ...brushFields, operation: z.literal('erase') }),
]).readonly();
export const paintContentSchema = z.strictObject({ layers: z.array(paintLayerSchema).max(COMPOSITION_LIMITS.readableLayers).readonly(), brush: remixPaintBrushSchema }).readonly();
export const legacyPolicyTransitionSchema = z.strictObject({ from: z.literal('legacy-order'), to: z.literal('scene-depth'), checkpoint: revision }).readonly();
const v5 = compositionDocumentShapeSchema.unwrap().shape;
export const remixStyleSchema = v5.style.unwrap().omit({ grain: true, colorNoise: true, grainSize: true, grainHold: true }).readonly();
export const remixDocumentShapeSchema = z.strictObject({ ...v5, version: z.literal(REMIX_DOCUMENT_VERSION), style: remixStyleSchema,
  remix: remixStateSchema, paint: paintContentSchema, policyTransition: legacyPolicyTransitionSchema.nullable(),
}).readonly();
export type RemixDocument = z.infer<typeof remixDocumentShapeSchema>;
export type RemixReadDocument = Omit<RemixDocument, 'style'> & { readonly style: Style };
export type GrainControl = 'grain' | 'colorNoise' | 'grainSize' | 'grainHold';
export type GrainBinding = { readonly kind: 'bound'; readonly instance: string; readonly parameter: string }
  | { readonly kind: 'unavailable'; readonly reason: string };
export const GRAIN_PARAMETERS = { grain: 'amount', colorNoise: 'colorNoise', grainSize: 'grainSize', grainHold: 'grainHold' } as const;

/** Adapter-owned hold is explicit in the recipe, although it is not a graph input parameter. */
export const REMIX_GRAIN_BLOCK: MathBlockSource = { ...GRAIN_BLOCK_SOURCE,
  parameters: [...GRAIN_BLOCK_SOURCE.parameters, { name: 'grainHold', type: 'scalar', default: 2, min: 1, max: 3, integer: true }],
};
export const REMIX_BUILTIN_BLOCKS: readonly MathBlockSource[] = [REMIX_GRAIN_BLOCK, CONTRAST_BLOCK_SOURCE, TEXTURE_BLOCK_SOURCE];

export function grainBinding(doc: Pick<RemixDocument, 'remix'>, control: GrainControl): GrainBinding {
  const instance = doc.remix.instances.find(value => value.id === doc.remix.grainInstance && value.target === 'photo');
  const unavailable = (reason: string): GrainBinding => ({ kind: 'unavailable', reason });
  if (!instance) return unavailable('The photo no longer has its designated Grain block.');
  if (!instance.enabled) return unavailable('Enable the Grain block to use this control.');
  const block = doc.remix.blocks.find(value => mathRefKey(value) === mathRefKey(instance.block));
  if (!block) return unavailable('The Grain block revision is missing.');
  const parameter = GRAIN_PARAMETERS[control];
  const original = REMIX_GRAIN_BLOCK.parameters.find(value => value.name === parameter);
  if (!original || !block.parameters.some(value => sameValue(value, original))) return unavailable('This recipe no longer exposes the original Grain parameter.');
  const reachable = new Set<string>();
  function visit(binding: MathBlockSource['output']): void {
    if (binding.kind !== 'node' || reachable.has(binding.node)) return;
    reachable.add(binding.node); block?.nodes.find(value => value.id === binding.node)?.args.forEach(visit);
  }
  visit(block.output);
  const required = control === 'grainSize' ? ['cells'] : control === 'grainHold' ? ['noise0', 'noise1', 'noise2'] : ['color'];
  for (const nodeId of required) {
    const node = block.nodes.find(value => value.id === nodeId), preset = REMIX_GRAIN_BLOCK.nodes.find(value => value.id === nodeId);
    if (!node || !preset || !reachable.has(nodeId) || !sameValue(node, preset)) return unavailable('The edited recipe no longer gives this Grain control its original meaning.');
    const source = doc.remix.functions.find(value => mathRefKey(value) === mathRefKey(node.function));
    if (!source || !MATH_PRESET_FUNCTIONS.some(value => sameValue(value, source))) return unavailable('The edited function no longer gives this Grain control its original meaning.');
  }
  return { kind: 'bound', instance: instance.id, parameter };
}

export function withDerivedGrainStyle(doc: FrozenCompositionDocument): FrozenCompositionDocument;
export function withDerivedGrainStyle(doc: RemixDocument | RemixReadDocument): RemixReadDocument;
export function withDerivedGrainStyle(doc: FrozenCompositionDocument | RemixDocument | RemixReadDocument): FrozenCompositionDocument | RemixReadDocument;
export function withDerivedGrainStyle(doc: FrozenCompositionDocument | RemixDocument | RemixReadDocument): FrozenCompositionDocument | RemixReadDocument {
  if (doc.version === 5) return doc;
  const instance = doc.remix.instances.find(value => value.id === doc.remix.grainInstance);
  const block = instance && doc.remix.blocks.find(value => mathRefKey(value) === mathRefKey(instance.block));
  const parameters = { ...Object.fromEntries(block?.parameters.map(value => [value.name, value.default]) ?? []), ...instance?.parameters };
  return { ...doc, style: { ...doc.style, grain: parameters?.['amount'] ?? 0, colorNoise: parameters?.['colorNoise'] ?? 0,
    grainSize: parameters?.['grainSize'] ?? 1, grainHold: parameters?.['grainHold'] ?? 1 } };
}

/** Remove only the four documented derived values. All other unexpected fields remain errors. */
export function serializeRemixDocument(doc: RemixDocument | RemixReadDocument): RemixDocument {
  const { grain: _grain, colorNoise: _noise, grainSize: _size, grainHold: _hold, ...style } = withDerivedGrainStyle(doc).style;
  return { ...doc, style };
}

/** Adapter contexts are fixed source pixels and semantic types, never viewport values. */
export function blockTargetReason(block: MathBlockSource, target: RemixTarget): string | null {
  const output = target === 'photo' ? 'srgb' : 'coverage';
  if (block.outputType !== output) return target === 'photo' ? 'Photo blocks must produce color.' : 'Brush blocks must produce amount.';
  const contexts: Readonly<Record<string, string>> = target === 'photo'
    ? { color: 'srgb', position: 'coord', seed: 'seed', hold: 'hold', clarity: 'coverage', time: 'time' }
    : { position: 'coord', seed: 'seed', hold: 'hold', time: 'time', pressure: 'pressure', coverage: 'coverage' };
  for (const input of block.inputs) if (contexts[input.name] !== input.type) return `The ${target} has no ${input.name} input of this kind.`;
  return null;
}

/** Tighten the supplied math proof to the settled document admission policy. */
export function admitRemixLibrary(input: unknown): MathResult<MathFunctionLibrary> {
  return mathAttempt(() => {
    const library = unwrapMath(createMathLibrary(input));
    for (const fn of library.definitions) {
      function visit(expression: TypedMathExpression): void {
        const at = { sourceId: mathRefKey(fn.ref), span: expression.span, path: null };
        const range = fn.ranges.expressions.find(value => value.span.start === expression.span.start && value.span.end === expression.span.end)?.range;
        if (!['seed', 'hold', 'time', 'cell', 'coord'].includes(expression.type) && range?.some(value => value.min < -65536 || value.max > 65536))
          refuse('domain', 'Every intermediate number must stay between -65536 and 65536.', at);
        switch (expression.kind) {
          case 'binary':
            if (expression.operator === '/') refuse('domain', 'Division is not available in this math language.', at);
            visit(expression.left); visit(expression.right); break;
          case 'call': {
            if (expression.name === 'mix') {
              const factor = expression.args[2];
              const bound = factor && fn.ranges.expressions.find(value => value.span.start === factor.span.start && value.span.end === factor.span.end)?.range;
              if (!bound || bound.some(value => value.min < 0 || value.max > 1)) refuse('domain', 'Mix needs an amount between zero and one.', at);
            }
            expression.args.forEach(visit); break;
          }
          case 'choose': visit(expression.condition); visit(expression.yes); visit(expression.no); break;
          case 'unary': visit(expression.operand); break;
          case 'component': visit(expression.vector); break;
          case 'number': case 'boolean': case 'variable': break;
          default: { const exhaustive: never = expression; return exhaustive; }
        }
      }
      fn.parsed.statements.forEach(statement => visit(statement.expression)); visit(fn.parsed.result);
    }
    return library;
  });
}

export const remixDocumentSchema = remixDocumentShapeSchema.superRefine((doc, ctx) => {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  const { remix, paint, policyTransition, ...base } = withDerivedGrainStyle(doc);
  const composition = compositionDocumentSchema.safeParse({ ...base, version: 5 });
  if (!composition.success) for (const error of composition.error.issues) ctx.addIssue({ code: 'custom', path: error.path, message: error.message });
  const seen = new Set<string>();
  for (const [kind, values] of [['function', remix.functions], ['block', remix.blocks]] as const) {
    for (const value of values) { const key = `${kind}:${mathRefKey(value)}`; if (seen.has(key)) issue(['remix', `${kind}s`], 'Pinned revisions must be unique.'); seen.add(key); }
  }
  const admitted = admitRemixLibrary(remix.functions);
  if (!admitted.ok) issue(['remix', 'functions'], admitted.error.message);
  if (admitted.ok) {
    const blocks = new Map(remix.blocks.map(block => [mathRefKey(block), createMathBlock(block, admitted.value)]));
    for (const [key, result] of blocks) if (!result.ok) issue(['remix', 'blocks'], `${key}: ${result.error.message}`);
    const instanceIds = new Set<string>();
    for (const instance of remix.instances) {
      if (instanceIds.has(instance.id)) issue(['remix', 'instances'], 'Rack instance ids must be unique.'); instanceIds.add(instance.id);
      const block = blocks.get(mathRefKey(instance.block));
      if (!block) issue(['remix', 'instances'], 'Every instance needs its pinned block revision.');
      else if (block.ok) {
        const reason = blockTargetReason(block.value.source, instance.target);
        if (reason) issue(['remix', 'instances'], reason);
        const parameters = resolveMathParameters(block.value, instance.parameters);
        if (!parameters.ok) issue(['remix', 'instances'], parameters.error.message);
      }
    }
    for (const target of ['photo', 'brush'] as const) {
      const instances = remix.instances.filter(value => value.target === target);
      if (instances.length > MATH_LIMITS.blocksPerRack) issue(['remix', 'instances'], 'A rack can hold at most eight blocks.');
      const steps = instances.reduce((sum, instance) => { const block = blocks.get(mathRefKey(instance.block)); return sum + (instance.enabled && block?.ok ? block.value.evaluationSteps : 0); }, 0);
      if (steps > MATH_LIMITS.evaluationSteps) issue(['remix', 'instances'], 'This rack exceeds 65536 expression evaluations.');
    }
  }
  if (remix.grainInstance !== null && !remix.instances.some(value => value.id === remix.grainInstance && value.target === 'photo')) issue(['remix', 'grainInstance'], 'The designated Grain instance must exist in the photo rack.');
  const owned = new Set<string>();
  for (const ownership of remix.ownership) {
    const key = `${ownership.kind}:${mathRefKey(ownership.ref)}`;
    if (owned.has(key) || !seen.has(key)) issue(['remix', 'ownership'], 'Ownership must name one existing pinned definition.'); owned.add(key);
  }
  const bypasses = new Set<string>();
  for (const bypass of remix.bypasses) {
    const key = `${bypass.instance}:${bypass.node}`;
    const instance = remix.instances.find(value => value.id === bypass.instance);
    const block = instance && remix.blocks.find(value => mathRefKey(value) === mathRefKey(instance.block));
    if (bypasses.has(key) || !block || bypass.functions.length === 0) issue(['remix', 'bypasses'], 'A bypass must name one existing site.');
    bypasses.add(key);
    const nodeIds = new Set<string>();
    for (const restore of bypass.functions) {
      const node = block?.nodes.find(value => value.id === restore.node);
      const current = node && admitted.ok ? admitted.value.get(node.function) : undefined;
      const original = admitted.ok ? admitted.value.get(restore.ref) : undefined;
      if (!node || !current || !original || !sameValue(current.signature, original.signature) || nodeIds.has(restore.node))
        issue(['remix', 'bypasses'], 'A bypass must retain compatible pinned functions for every channel.');
      nodeIds.add(restore.node);
    }
    const groupIds = bypass.functions.map(value => value.node);
    if (!(groupIds.length === 1 && groupIds[0] === bypass.node) && !(groupIds.length === 3 && [0,1,2].every(channel => groupIds.includes(`${bypass.node}${channel}`))))
      issue(['remix', 'bypasses'], 'A bypass must retain exactly the addressed channel group.');
  }
  const drafts = new Set<string>();
  for (const draft of remix.drafts) {
    if (drafts.has(draft.id)) issue(['remix', 'drafts'], 'Draft ids must be unique.'); drafts.add(draft.id);
    if (draft.revision > remix.checkpoint.draftRevision) issue(['remix', 'drafts'], 'The draft revision must be included in its checkpoint.');
    if (draft.base && !seen.has(`function:${mathRefKey(draft.base)}`)) issue(['remix', 'drafts'], 'The applied base of a draft must be retained.');
  }
  const bytes = admitMathRecipeBytes(JSON.stringify(remix), []);
  if (!bytes.ok) issue(['remix'], bytes.error.message);
  if (doc.objects.length + paint.layers.length > COMPOSITION_LIMITS.readableLayers) issue(['paint', 'layers'], 'A document can contain at most 32 top-level layers.');
  const layers = new Set<string>(doc.objects.map(layer => layer.id)), patches = new Set<string>();
  let patchCount = 0, tileCount = 0;
  for (const layer of paint.layers) {
    if (layers.has(layer.id)) issue(['paint', 'layers'], 'Top-level layer ids must be unique.'); layers.add(layer.id);
    const orders = new Set<number>();
    for (const patch of layer.patches) {
      patchCount++; tileCount += patch.tiles.length;
      if (patches.has(patch.id)) issue(['paint', 'layers'], 'Patch ids must be unique.'); patches.add(patch.id);
      if (orders.has(patch.order)) issue(['paint', 'layers'], 'Patch order must be unique within its layer.'); orders.add(patch.order);
      if (patch.owner !== layer.id) issue(['paint', 'layers'], 'A patch must name its owning paint layer.');
      if (!seen.has(`block:${mathRefKey(patch.brush)}`)) issue(['paint', 'layers'], 'The captured brush revision must be retained.');
      const coordinates = new Set<string>();
      for (const tile of patch.tiles) {
        const key = `${tile.x},${tile.y}`;
        if (coordinates.has(key)) issue(['paint', 'layers'], 'Patch tile coordinates must be unique.'); coordinates.add(key);
        if (tile.rgba.size.width !== Math.min(PAINT_TILE_SIZE, patch.size.width - tile.x * PAINT_TILE_SIZE) ||
          tile.rgba.size.height !== Math.min(PAINT_TILE_SIZE, patch.size.height - tile.y * PAINT_TILE_SIZE) ||
          tile.x * PAINT_TILE_SIZE + tile.rgba.size.width > patch.size.width || tile.y * PAINT_TILE_SIZE + tile.rgba.size.height > patch.size.height)
          issue(['paint', 'layers'], 'A paint tile must exactly fill its clipped 256-pixel cell within the patch extent.');
      }
    }
  }
  if (patchCount > PAINT_LIMITS.patches) issue(['paint', 'layers'], 'A project can contain at most 64 stroke patches.');
  if (tileCount > REMIX_LIMITS.tiles) issue(['paint', 'layers'], 'A project can contain at most 4096 paint tiles.');
  if (policyTransition && (doc.compositing !== 'scene-depth' || policyTransition.checkpoint > remix.checkpoint.checkpointRevision)) issue(['policyTransition'], 'The legacy policy transition must belong to this scene-depth checkpoint.');
  const assets = collectCompositionAssets([{ kind: 'document', document: doc }]);
  if (!assets.ok) issue(assets.error.path, assets.error.detail);
  else {
    let bytes = 0;
    for (const refs of assets.value.values()) bytes += refs.find(ref => ref.kind === 'raster')?.byteLength ?? 0;
    if (bytes > COMPOSITION_LIMITS.activeAssetBytes) issue(['paint'], 'The active immutable raster assets exceed 64 MiB.');
  }
});

export function migrateV5ToV6(doc: FrozenCompositionDocument): MathResult<RemixDocument> {
  return mathAttempt(() => {
    const checked = compositionDocumentSchema.safeParse(doc);
    if (!checked.success) refuse('value', 'The version 5 document is invalid.', location('document'));
    const { grain, colorNoise, grainSize, grainHold, ...style } = checked.data.style;
    const value: RemixDocument = { ...checked.data, version: 6, style,
      remix: { functions: MATH_PRESET_FUNCTIONS.map(fn => ({ ...fn, dependencies: [...fn.dependencies] })), blocks: [...REMIX_BUILTIN_BLOCKS], instances: [
        { id: 'photo-grain', target: 'photo', block: { id: REMIX_GRAIN_BLOCK.id, revision: REMIX_GRAIN_BLOCK.revision }, enabled: true,
          parameters: { amount: grain, colorNoise, grainSize, grainHold } }], ownership: [], grainInstance: 'photo-grain', bypasses: [], drafts: [],
        checkpoint: { appliedRevision: 0, draftRevision: 0, checkpointRevision: 0 } },
      paint: { layers: [], brush: { operation: 'draw', diameter: 24, opacity: 1, pressure: 'off', color: { l: .2, c: 0, h: 0 } } }, policyTransition: null };
    return unwrapMath(admitRemixDocument(value));
  });
}

export function admitRemixDocument(input: unknown): MathResult<RemixDocument> {
  return mathAttempt(() => {
    const parsed = remixDocumentSchema.safeParse(input);
    if (!parsed.success) {
      const error = parsed.error.issues[0];
      refuse(error?.code === 'too_big' ? 'budget' : 'value', error?.message ?? 'The remix document is invalid.', location('document', '', 0, 0, '/' + (error?.path ?? []).join('/')));
    }
    return parsed.data;
  });
}
