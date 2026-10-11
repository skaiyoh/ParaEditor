// Photo recipe authoring. Core admits every definition/draft; the renderer admits
// the entire executable rack before publication. Projects owns checkpoint I/O.
import { sameValue } from '../core/equal.ts';
import { mathRefKey, type MathRef, type MathFunctionSource } from '../core/math-definition.ts';
import { createMathBlock, type MathBlockSource } from '../core/math-graph.ts';
import { location, mathAttempt, refuse, unwrapMath, type MathDiagnostic, type MathResult } from '../core/math-expression.ts';
import { applyRemixOperation, applyRemixSource, borrowFunction, createRemixFunction, displayLabel, isBuiltIn,
  forkBlock, forkFunction, packageBlock, remixBlock, remixInstance, remixInsertionSlots, remixNodeGroups,
  writeRemixDraft, type RemixOperation, type RemixOperationInput, type RemixResult } from '../core/remix.ts';
import { admitRemixDocument, admitRemixLibrary, grainBinding, withDerivedGrainStyle,
  type FunctionDraft, type MathCheckpoint, type RemixDocument, type RemixInstance, type RemixTarget, type Site } from '../core/remix-schema.ts';
import { canUseInBrush } from '../core/remix-view.ts';
import type { SceneDocument } from '../core/types.ts';
import { compilePhotoRack, type MathPhotoRack } from '../render/math-program.ts';
import type { PhotoRackRenderer } from '../render/types.ts';
import { recipeState, remixDocument, restoreRecipe, type CommandResult, type RecipeState } from './authoring.ts';

export type { FunctionDraft, RemixOperation, RemixTarget, Site };
export type RemixGesture = symbol;
export type RemixCommandResult = CommandResult & { readonly copied: { readonly label: string } | null };
export type ApplySaveState = { readonly kind: 'Applied' | 'Saving' | 'Saved'; readonly checkpoint: number }
  | { readonly kind: 'Save failed'; readonly checkpoint: number; readonly reason: string };
export type RemixSnapshot = MathCheckpoint & {
  readonly target: RemixTarget;
  /** Admitted raw read model for the pure remix-view queries; null before import. */
  readonly document: RemixDocument | null;
  readonly instances: readonly RemixInstance[];
  readonly functions: readonly MathFunctionSource[];
  readonly blocks: readonly MathBlockSource[];
  readonly drafts: readonly FunctionDraft[];
  readonly status: ApplySaveState;
  readonly preview: 'current' | 'last-valid';
  readonly diagnostics: readonly MathDiagnostic[];
  readonly copied: { readonly label: string } | null;
  readonly editing: { readonly gesture: RemixGesture; readonly draft: string; readonly site: Site | null } | null;
};
export type MathRemixHost = {
  /** Canonical document identity, not a newly allocated read projection. */
  readonly read: () => SceneDocument | null;
  readonly generation: () => number;
  readonly renderer: () => PhotoRackRenderer | null;
  /** Close other tools before beginning a recipe action. */
  readonly interrupt: () => void;
  /** Includes a potential history action and the complete Projects closure. */
  readonly preflight: (doc: SceneDocument, before: RecipeState | null) => CommandResult;
  readonly install: (doc: SceneDocument) => void;
  readonly record: (before: RecipeState, after: RecipeState) => void;
  readonly changed: () => void;
  readonly saving: () => { readonly state: 'absent' | 'saving' | 'saved' | 'failed'; readonly acknowledged: MathCheckpoint | null };
  readonly retrySave: () => Promise<CommandResult>;
};
type Ticket = { readonly epoch: number; readonly generation: number; readonly document: SceneDocument | null;
  readonly renderer: PhotoRackRenderer | null };
type Gesture = { readonly token: RemixGesture; readonly generation: number; readonly project: string;
  readonly before: RecipeState; readonly target: RemixTarget } & (
  | { readonly kind: 'parameter' }
  | { readonly kind: 'source'; readonly draft: string; readonly site: Extract<Site, { kind: 'function' }> | null }
);
type WriteSourceInput = { readonly draft: string; readonly expected: number; readonly source: string } & (
  | { readonly gesture: RemixGesture }
  | { readonly bind: Extract<Site, { kind: 'function' }> | null }
);
const checkpointZero: MathCheckpoint = { appliedRevision: 0, draftRevision: 0, checkpointRevision: 0 };
const command = (kind: 'applied' | 'unchanged' | 'cancelled', copied: RemixCommandResult['copied'] = null): RemixCommandResult => ({ kind, copied });
const refusal = (reason: string): RemixCommandResult => ({ kind: 'refused', reason, copied: null });
const diagnostic = (message: string, kind: MathDiagnostic['kind'] = 'context'): MathDiagnostic => ({ kind, ...location('photo-rack'), message });

/** Rebuild the executable photo closure, never reading draft text. */
export function photoRack(doc: RemixDocument): MathResult<MathPhotoRack> {
  return mathAttempt(() => {
    const library = unwrapMath(admitRemixLibrary(doc.remix.functions));
    return unwrapMath(compilePhotoRack(doc.remix.instances.filter(instance => instance.target === 'photo').map(instance => {
      const source = remixBlock(doc, instance.block), block = unwrapMath(createMathBlock(source, library));
      // The v6 adapter adds Grain hold to the pinned legacy graph. Zero Grain
      // retains the original bypass, including its absence of a color round trip.
      const legacy = source.id === 'authored-grain' && isBuiltIn(doc, source) && source.nodes.every(node => isBuiltIn(doc, node.function));
      const values = { ...Object.fromEntries(source.parameters.map(value => [value.name, value.default])), ...instance.parameters };
      return { block, parameters: instance.parameters,
        enabled: instance.enabled && !(legacy && values['amount'] === 0 && values['colorNoise'] === 0) };
    })));
  });
}

export function createMathRemixSession(host: MathRemixHost) {
  let target: RemixTarget = 'photo', epoch = 0, gesture: Gesture | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let diagnostics: readonly MathDiagnostic[] = [], copied: RemixCommandResult['copied'] = null;
  let active: { readonly renderer: PhotoRackRenderer; readonly key: string } | null = null;
  const documents = new WeakMap<SceneDocument, RemixDocument>();
  function read(): RemixDocument | null {
    const doc = host.read();
    if (doc === null) return null;
    let value = documents.get(doc);
    if (!value) { value = unwrapMath(remixDocument(doc)); documents.set(doc, value); }
    return value;
  }
  const requireDocument = (): RemixDocument => {
    const doc = read();
    if (!doc) refuse('context', 'Open a photo first.', location('photo-rack'));
    return doc;
  };
  function clearTimer(): void { if (timer !== null) clearTimeout(timer); timer = null; }
  function ticket(): Ticket {
    return { epoch: ++epoch, generation: host.generation(), document: host.read(), renderer: host.renderer() };
  }
  function current(value: Ticket): boolean {
    return value.epoch === epoch && value.generation === host.generation() && value.document === host.read() && value.renderer === host.renderer();
  }
  function recipeKey(doc: SceneDocument): string {
    if (doc.version === 5) return `${host.generation()}:${doc.id}:legacy`;
    return JSON.stringify([host.generation(), doc.id, doc.remix.functions, doc.remix.blocks, doc.remix.instances]);
  }
  /** Also used after setScene for preview/import and immutable checkpoint captures. */
  function synchronize(doc: SceneDocument, renderer = host.renderer()): MathResult<void> {
    // Legacy edits and their background repairs do not require a mounted canvas.
    // A v6 recipe still needs GPU admission before it can become authoritative.
    if (renderer === null) return doc.version === 5 ? { ok: true, value: undefined }
      : { ok: false, error: diagnostic('The photo renderer is unavailable.') };
    const key = recipeKey(doc);
    if (active?.renderer === renderer && active.key === key) return { ok: true, value: undefined };
    try {
      if (doc.version === 5) renderer.activatePhotoRack(null);
      else {
        const rack = photoRack(unwrapMath(remixDocument(doc)));
        if (!rack.ok) return rack;
        const prepared = renderer.preparePhotoRack(rack.value);
        if (!prepared.ok) return prepared;
        renderer.activatePhotoRack(prepared.value);
      }
      active = { renderer, key };
      return { ok: true, value: undefined };
    } catch (error) { return { ok: false, error: diagnostic(error instanceof Error ? error.message : 'The photo rack could not be compiled.') }; }
  }
  function show(error: MathDiagnostic): RemixCommandResult {
    diagnostics = [error]; host.changed(); return refusal(error.message);
  }
  function install(doc: RemixDocument, before: RecipeState | null, label: RemixCommandResult['copied'] = null): RemixCommandResult {
    const view = withDerivedGrainStyle({ ...doc, updatedAt: new Date().toISOString() });
    const admitted = host.preflight(view, before);
    if (admitted.kind === 'refused') return show(diagnostic(admitted.reason, 'budget'));
    const previous = host.read();
    const compiled = synchronize(view);
    if (!compiled.ok) return show(compiled.error);
    try {
      host.install(view);
      if (before !== null && !sameValue(before, recipeState(doc))) host.record(before, recipeState(doc));
      diagnostics = []; copied = label; host.changed();
      return command('applied', label);
    } catch (error) {
      if (previous !== null) synchronize(previous);
      return show(diagnostic(error instanceof Error ? error.message : 'The recipe could not be applied.'));
    }
  }
  function apply(result: RemixResult, before: RecipeState | null): RemixCommandResult {
    if (result.kind === 'refused') return show(result.diagnostic);
    if (result.kind === 'unchanged') return command('unchanged');
    return install(result.doc, before, result.copied);
  }
  function runningFunction(doc: RemixDocument, site: Extract<Site, { kind: 'function' }>): MathFunctionSource {
    const instance = remixInstance(doc, site.instance), block = remixBlock(doc, instance.block);
    const node = remixNodeGroups(block).find(value => value.id === site.node)?.nodes[0];
    if (!node) refuse('missing', 'This function no longer exists.', location(site.node));
    const source = doc.remix.functions.find(value => mathRefKey(value) === mathRefKey(node.function));
    if (!source) refuse('missing', 'The applied function revision is missing.', location(site.node));
    return source;
  }
  function draftPreview(doc: RemixDocument, draft: FunctionDraft): boolean {
    if (draft.phase !== 'valid') return true;
    // Undo/cancel retain valid text without making it the current candidate.
    // Reopening its editor makes any difference from the running source visible.
    if (gesture?.kind !== 'source' || gesture.draft !== draft.id) return false;
    if (draft.base === null) return true;
    const site = draft.site;
    if (site?.kind !== 'function') return false;
    const result = mathAttempt(() => runningFunction(doc, site).source !== draft.source);
    return !result.ok || result.value;
  }
  function snapshot(): RemixSnapshot {
    const doc = read(), checkpoint = doc?.remix.checkpoint ?? checkpointZero, saving = host.saving();
    let status: ApplySaveState;
    if (saving.state === 'failed') status = { kind: 'Save failed', checkpoint: checkpoint.checkpointRevision, reason: 'Your changes could not be saved. Retry saving.' };
    else if (saving.state === 'absent' || doc === null) status = { kind: 'Applied', checkpoint: checkpoint.checkpointRevision };
    else if (saving.state === 'saved' && sameValue(checkpoint, saving.acknowledged)) status = { kind: 'Saved', checkpoint: checkpoint.checkpointRevision };
    else status = { kind: 'Saving', checkpoint: checkpoint.checkpointRevision };
    return { ...checkpoint, target, document: doc, instances: doc?.remix.instances ?? [], functions: doc?.remix.functions ?? [],
      blocks: doc?.remix.blocks ?? [], drafts: doc?.remix.drafts ?? [], status,
      preview: diagnostics.length > 0 || doc?.remix.drafts.some(draft => draftPreview(doc, draft)) ? 'last-valid' : 'current',
      diagnostics, copied, editing: gesture?.kind === 'source' ? { gesture: gesture.token, draft: gesture.draft, site: gesture.site } : null };
  }
  function updateDraft(doc: RemixDocument, draft: FunctionDraft): MathResult<RemixDocument> {
    return writeRemixDraft(doc, { expected: doc.remix.checkpoint.draftRevision, draft });
  }
  function settleNow(): RemixCommandResult {
    clearTimer();
    const editing = gesture, doc = read();
    if (editing?.kind !== 'source' || doc === null || editing.generation !== host.generation() || editing.project !== doc.id) return command('cancelled');
    const draft = doc.remix.drafts.find(value => value.id === editing.draft);
    if (!draft) return command('cancelled');
    const result = mathAttempt(() => {
      let candidate = doc, applied = false, label: RemixCommandResult['copied'] = null, base: MathRef | null = draft.base;
      if (editing.site !== null) {
        const running = runningFunction(doc, editing.site);
        if (draft.source !== running.source) {
          const changed = applyRemixSource(doc, { expected: doc.remix.checkpoint.appliedRevision, site: editing.site, source: draft.source });
          if (changed.kind === 'refused') return changed;
          if (changed.kind === 'applied') { candidate = changed.doc; applied = true; label = changed.copied; }
        }
        const next = runningFunction(candidate, editing.site); base = { id: next.id, revision: next.revision };
      } else {
        const draftBase = draft.base;
        const previous = draftBase && doc.remix.functions.find(value => mathRefKey(value) === mathRefKey(draftBase));
        if (!previous || previous.source !== draft.source) {
          const created = unwrapMath(createRemixFunction(doc, { expected: doc.remix.checkpoint.appliedRevision,
            name: previous ? displayLabel(doc, previous) : 'Your function', source: draft.source }));
          candidate = created.doc; base = created.ref; applied = true;
        }
      }
      if (!applied && draft.phase === 'valid' && sameValue(base, draft.base) && draft.diagnostics.length === 0) return { kind: 'unchanged' } as const;
      candidate = unwrapMath(updateDraft(candidate, { ...draft, phase: 'valid', base, diagnostics: [] }));
      return { kind: 'candidate', doc: candidate, copied: label } as const;
    });
    let error: MathDiagnostic | null = result.ok ? null : result.error;
    if (result.ok) {
      if (result.value.kind === 'unchanged') return command('unchanged');
      if (result.value.kind === 'refused') error = result.value.diagnostic;
      else {
        const applied = install(result.value.doc, null, result.value.copied);
        if (applied.kind !== 'refused') return applied;
        error = diagnostics[0] ?? diagnostic(applied.reason);
      }
    }
    if (!error) return command('unchanged');
    const invalid = updateDraft(doc, { ...draft, phase: 'invalid', diagnostics: [error] });
    if (!invalid.ok) return show(invalid.error);
    const saved = install(invalid.value, null);
    diagnostics = [error]; host.changed();
    return saved.kind === 'refused' ? saved : refusal(error.message);
  }
  function commitGestureNow(token: RemixGesture): RemixCommandResult {
    const editing = gesture;
    if (!editing || editing.token !== token) return command('cancelled');
    if (editing.kind === 'source') settleNow();
    const doc = read();
    clearTimer(); ++epoch;
    if (!doc || editing.generation !== host.generation() || editing.project !== doc.id) { gesture = null; return command('cancelled'); }
    const after = recipeState(doc), changed = !sameValue(editing.before, after);
    if (changed) {
      const preflight = host.preflight(withDerivedGrainStyle(doc), editing.before);
      if (preflight.kind === 'refused') return show(diagnostic(preflight.reason, 'budget'));
      host.record(editing.before, after);
    }
    gesture = null; host.changed(); return command(changed ? 'applied' : 'unchanged', copied);
  }
  /** Close the edit boundary before any unrelated action enters history. */
  function finishEditing(): void { if (gesture !== null) commitGestureNow(gesture.token); else { clearTimer(); ++epoch; } }
  function beginGesture(nextTarget: RemixTarget): RemixGesture {
    finishEditing(); host.interrupt();
    const token = Symbol('remix gesture'), doc = read();
    if (doc !== null) gesture = { kind: 'parameter', token, target: nextTarget, generation: host.generation(), project: doc.id, before: recipeState(doc) };
    host.changed(); return token;
  }
  function updateGestureNow(token: RemixGesture, operation: RemixOperation): RemixCommandResult {
    const editing = gesture, doc = read(); ++epoch;
    if (!editing || editing.kind !== 'parameter' || editing.token !== token || doc === null || editing.generation !== host.generation() || editing.project !== doc.id) return command('cancelled');
    return apply(applyRemixOperation(doc, { expected: doc.remix.checkpoint.appliedRevision, target: editing.target, operation }), null);
  }
  function cancelGesture(token: RemixGesture): void {
    const editing = gesture;
    if (!editing || editing.token !== token) return;
    gesture = null; clearTimer(); ++epoch;
    const currentDoc = host.read();
    if (currentDoc && editing.generation === host.generation() && editing.project === currentDoc.id) {
      const restored = restoreRecipe(currentDoc, editing.before, new Date().toISOString());
      if (restored.ok) {
        const raw = unwrapMath(remixDocument(restored.value));
        if (!sameValue(recipeState(raw), recipeState(requireDocument()))) install(raw, null);
      } else show(restored.error);
    }
    host.changed();
  }
  function beginSourceEdit(site: Extract<Site, { kind: 'function' }>): MathResult<{ readonly gesture: RemixGesture; readonly draft: string }> {
    finishEditing(); host.interrupt(); ++epoch;
    return mathAttempt(() => {
      let doc = requireDocument();
      const source = runningFunction(doc, site), instance = remixInstance(doc, site.instance), before = recipeState(doc);
      let draft = doc.remix.drafts.find(value => sameValue(value.site, site));
      if (!draft) {
        let number = 1; while (doc.remix.drafts.some(value => value.id === `draft-${number}`)) number++;
        draft = { id: `draft-${number}`, base: { id: source.id, revision: source.revision }, revision: doc.remix.checkpoint.draftRevision,
          source: source.source, phase: 'valid', diagnostics: [], site };
        doc = unwrapMath(updateDraft(doc, draft));
        const installed = install(doc, null); if (installed.kind === 'refused') refuse('context', installed.reason, location(draft.id));
      }
      const token = Symbol('source edit');
      gesture = { kind: 'source', token, draft: draft.id, site, target: instance.target, before, project: doc.id, generation: host.generation() };
      host.changed(); return { gesture: token, draft: draft.id };
    });
  }
  function writeSource(input: WriteSourceInput): MathResult<number> {
    return mathAttempt(() => {
      const doc = requireDocument(), draft = doc.remix.drafts.find(value => value.id === input.draft);
      if (!draft) refuse('missing', 'This draft no longer exists.', location(input.draft));
      if ('gesture' in input && (gesture?.kind !== 'source' || gesture.token !== input.gesture || gesture.draft !== draft.id))
        refuse('revision', 'This source edit session is no longer open.', location(input.draft));
      if (input.expected !== doc.remix.checkpoint.draftRevision) refuse('revision', 'This draft changed. Use its current draft revision.', location(input.draft));
      if ('bind' in input && gesture === null) gesture = { kind: 'source', token: Symbol('source edit'), draft: draft.id, site: input.bind,
        target, before: recipeState(doc), project: doc.id, generation: host.generation() };
      clearTimer(); const authoring = ++epoch;
      const candidate = unwrapMath(writeRemixDraft(doc, { expected: input.expected, draft: { ...draft, source: input.source, phase: 'checking', diagnostics: [] } }));
      const installed = install(candidate, null);
      if (installed.kind === 'refused') refuse('budget', installed.reason, location(input.draft));
      timer = setTimeout(() => { timer = null; if (authoring === epoch) settleNow(); }, 400);
      return candidate.remix.checkpoint.draftRevision;
    });
  }
  async function perform(input: RemixOperationInput): Promise<RemixCommandResult> {
    finishEditing(); host.interrupt(); const issued = ticket();
    await Promise.resolve();
    if (!current(issued)) return command('cancelled');
    const result = mathAttempt(() => { const doc = requireDocument(); return apply(applyRemixOperation(doc, input), recipeState(doc)); });
    return result.ok ? result.value : show(result.error);
  }
  async function definition<T>(work: (doc: RemixDocument) => MathResult<{ readonly doc: RemixDocument; readonly value: T }>): Promise<MathResult<T>> {
    finishEditing(); host.interrupt(); const issued = ticket(); await Promise.resolve();
    if (!current(issued)) return { ok: false, error: diagnostic('This definition operation was cancelled by a newer action.', 'revision') };
    return mathAttempt(() => {
      const doc = requireDocument(), result = unwrapMath(work(doc));
      const installed = install(result.doc, recipeState(doc));
      if (installed.kind === 'refused') refuse('context', installed.reason, location('definition'));
      return result.value;
    });
  }
  function createFunction(input: { readonly name: string; readonly source: string }): MathResult<string> {
    finishEditing(); host.interrupt(); ++epoch;
    return mathAttempt(() => {
      const doc = requireDocument(), created = unwrapMath(createRemixFunction(doc, { ...input, expected: doc.remix.checkpoint.appliedRevision }));
      let number = 1; while (doc.remix.drafts.some(value => value.id === `draft-${number}`)) number++;
      const draft: FunctionDraft = { id: `draft-${number}`, base: created.ref, revision: doc.remix.checkpoint.draftRevision,
        source: input.source, phase: 'valid', diagnostics: [], site: null };
      const candidate = unwrapMath(updateDraft(created.doc, draft)), installed = install(candidate, recipeState(doc));
      if (installed.kind === 'refused') refuse('context', installed.reason, location(draft.id));
      return draft.id;
    });
  }
  function newFunctionAt(at: { readonly instance: string; readonly slot: string }): MathResult<{ readonly gesture: RemixGesture; readonly draft: string; readonly node: string }> {
    finishEditing(); host.interrupt(); ++epoch;
    return mathAttempt(() => {
      const doc = requireDocument(), before = recipeState(doc), slot = remixInsertionSlots(doc, at.instance).find(value => value.id === at.slot);
      if (!slot) refuse('missing', 'This insertion position no longer exists.', location(at.slot));
      const required = slot.required, bounded = required === 'srgb' || required === 'linear' ? '[0,1]' : required === 'scalar' ? '[-65536,65536]' : '';
      const source = `fn custom(x: ${required}${bounded}) -> ${required} { return x; }`;
      const created = unwrapMath(createRemixFunction(doc, { expected: doc.remix.checkpoint.appliedRevision, name: 'Your function', source }));
      const instance = remixInstance(doc, at.instance), inserted = applyRemixOperation(created.doc, {
        expected: created.doc.remix.checkpoint.appliedRevision, target: instance.target, operation: { kind: 'insert', at, fn: created.ref } });
      if (inserted.kind === 'refused') refuse(inserted.diagnostic.kind, inserted.reason, inserted.diagnostic);
      if (inserted.kind !== 'applied') refuse('value', 'The function could not be inserted.', location(at.slot));
      const block = remixBlock(inserted.doc, remixInstance(inserted.doc, at.instance).block);
      const group = remixNodeGroups(block).find(value => value.nodes.some(node => mathRefKey(node.function) === mathRefKey(created.ref)));
      if (!group) refuse('missing', 'The inserted function is missing.', location(at.slot));
      let number = 1; while (doc.remix.drafts.some(value => value.id === `draft-${number}`)) number++;
      const site: Extract<Site, { kind: 'function' }> = { kind: 'function', instance: at.instance, node: group.id };
      const draft: FunctionDraft = { id: `draft-${number}`, base: created.ref, revision: doc.remix.checkpoint.draftRevision,
        source, phase: 'valid', diagnostics: [], site };
      const candidate = unwrapMath(updateDraft(inserted.doc, draft)), installed = install(candidate, null, inserted.copied);
      if (installed.kind === 'refused') refuse('context', installed.reason, location(at.slot));
      const token = Symbol('new source edit');
      gesture = { kind: 'source', token, draft: draft.id, site, target: instance.target, before, project: doc.id, generation: host.generation() };
      host.changed(); return { gesture: token, draft: draft.id, node: group.id };
    });
  }
  async function borrow(input: { readonly from: MathRef; readonly node: string; readonly into: Extract<Site, { kind: 'function' }> }): Promise<RemixCommandResult> {
    finishEditing(); host.interrupt(); const issued = ticket(); await Promise.resolve();
    if (!current(issued)) return command('cancelled');
    const result = mathAttempt(() => { const doc = requireDocument(); return apply(borrowFunction(doc, { ...input, expected: doc.remix.checkpoint.appliedRevision }), recipeState(doc)); });
    return result.ok ? result.value : show(result.error);
  }
  async function useInBrush(instanceId: string): Promise<RemixCommandResult> {
    finishEditing(); host.interrupt(); const issued = ticket(); await Promise.resolve();
    if (!current(issued)) return command('cancelled');
    const result = mathAttempt(() => {
      const doc = requireDocument(), available = canUseInBrush(doc, instanceId);
      if (available.kind === 'unavailable') refuse('context', available.reason, location(instanceId));
      const instance = remixInstance(doc, instanceId), source = remixBlock(doc, instance.block);
      const library = unwrapMath(admitRemixLibrary(doc.remix.functions));
      const definition = unwrapMath(createMathBlock(source, library));
      const context = new Set(['position', 'seed', 'hold', 'pressure', 'time', 'coverage']);
      function closure(id: string, visited = new Set<string>()): Set<string> | null {
        if (visited.has(id)) return visited;
        const node = source.nodes.find(value => value.id === id);
        if (!node) return null;
        visited.add(id);
        for (const binding of node.args) {
          if (binding.kind === 'input' && !context.has(binding.name)) return null;
          if (binding.kind === 'node' && closure(binding.node, visited) === null) return null;
        }
        return visited;
      }
      // Parallel channels are one editable site. The first channel is the
      // canonical texture; take the last brush-compatible amount stage.
      const choices = remixNodeGroups(source).flatMap(group => {
        const node = group.nodes[0], typed = definition.nodes.find(value => value.source.id === node?.id);
        const retained = node && typed?.definition.signature.output === 'coverage' ? closure(node.id) : null;
        return node && retained ? [{ node, retained }] : [];
      });
      const chosen = choices.at(-1);
      if (!chosen) refuse('context', 'This block has no amount output that can run with brush inputs.', location(instanceId));
      const nodes = source.nodes.filter(node => chosen.retained.has(node.id));
      const inputs = new Set(nodes.flatMap(node => node.args.flatMap(binding => binding.kind === 'input' ? [binding.name] : [])));
      const parameters = new Set(nodes.flatMap(node => node.args.flatMap(binding => binding.kind === 'parameter' ? [binding.name] : [])));
      const name = `${displayLabel(doc, instance.block)} texture`.slice(0, 80);
      // Allocate an owned block identity through the core fork reducer, then
      // admit its extracted graph before the new identity can be published.
      const forked = unwrapMath(forkBlock(doc, { expected: doc.remix.checkpoint.appliedRevision,
        from: { id: 'grain-texture', revision: 1 }, name }));
      const texture: MathBlockSource = { ...source, ...forked.ref, name, nodes,
        inputs: source.inputs.filter(input => inputs.has(input.name)), parameters: source.parameters.filter(parameter => parameters.has(parameter.name)),
        output: { kind: 'node', node: chosen.node.id }, outputType: 'coverage' };
      unwrapMath(createMathBlock(texture, library));
      let candidate = unwrapMath(admitRemixDocument({ ...forked.doc, remix: { ...forked.doc.remix,
        blocks: forked.doc.remix.blocks.map(block => mathRefKey(block) === mathRefKey(forked.ref) ? texture : block) } }));
      const brush = candidate.remix.instances.find(value => value.target === 'brush');
      const placed = applyRemixOperation(candidate, { expected: candidate.remix.checkpoint.appliedRevision, target: 'brush', operation: brush
        ? { kind: 'replace', at: { kind: 'block', instance: brush.id }, replacement: forked.ref }
        : { kind: 'add', block: forked.ref, index: 0 } });
      if (placed.kind === 'refused') return show(placed.diagnostic);
      if (placed.kind !== 'applied') return command('unchanged');
      candidate = placed.doc;
      const inserted = candidate.remix.instances.find(value => value.target === 'brush' && mathRefKey(value.block) === mathRefKey(forked.ref));
      if (!inserted) refuse('missing', 'The borrowed brush texture is missing.', location(instanceId));
      for (const parameter of texture.parameters) {
        const changed = applyRemixOperation(candidate, { expected: candidate.remix.checkpoint.appliedRevision, target: 'brush',
          operation: { kind: 'parameter', instance: inserted.id, name: parameter.name, value: instance.parameters[parameter.name] ?? parameter.default } });
        if (changed.kind === 'refused') return show(changed.diagnostic);
        if (changed.kind === 'applied') candidate = changed.doc;
      }
      return install(candidate, recipeState(doc), { label: name });
    });
    return result.ok ? result.value : show(result.error);
  }
  return {
    snapshot, perform, createFunction, beginSourceEdit, writeSource, newFunctionAt, useInBrush,
    setTarget(next: RemixTarget): CommandResult {
      if (next === target) return { kind: 'unchanged' };
      finishEditing(); target = next; host.changed(); return { kind: 'applied' };
    },
    forkFunction(input: { readonly from: MathRef; readonly name: string }): Promise<MathResult<MathRef>> {
      return definition(doc => { const result = forkFunction(doc, { ...input, expected: doc.remix.checkpoint.appliedRevision });
        return result.ok ? { ok: true, value: { doc: result.value.doc, value: result.value.ref } } : result; });
    },
    forkBlock(input: { readonly from: MathRef; readonly name: string }): Promise<MathResult<MathRef>> {
      return definition(doc => { const result = forkBlock(doc, { ...input, expected: doc.remix.checkpoint.appliedRevision });
        return result.ok ? { ok: true, value: { doc: result.value.doc, value: result.value.ref } } : result; });
    },
    packageBlock(input: { readonly instance: string; readonly name: string }): Promise<MathResult<MathRef>> {
      return definition(doc => { const result = packageBlock(doc, { ...input, expected: doc.remix.checkpoint.appliedRevision });
        return result.ok ? { ok: true, value: { doc: result.value.doc, value: result.value.ref } } : result; });
    },
    borrowFunction: borrow,
    beginGesture,
    updateGesture: async (token: RemixGesture, operation: RemixOperation): Promise<RemixCommandResult> => updateGestureNow(token, operation),
    commitGesture: async (token: RemixGesture): Promise<RemixCommandResult> => commitGestureNow(token),
    cancelGesture,
    async retrySave(): Promise<CommandResult> { finishEditing(); return host.retrySave(); },
    /** Synchronous adapters for the existing GestureRange contract. */
    updateGestureNow, commitGestureNow, finishEditing, synchronize,
    /** Import/reset invalidate pending work without manufacturing a history action. */
    reset(): void { clearTimer(); ++epoch; gesture = null; target = 'photo'; diagnostics = []; copied = null; active = null; },
    invalidate(): void { clearTimer(); ++epoch; copied = null; },
    grainBinding(control: Parameters<typeof grainBinding>[1]) {
      const doc = read(); return doc ? grainBinding(doc, control) : { kind: 'unavailable' as const, reason: 'Open a photo first.' };
    },
  };
}
export type MathRemixSession = ReturnType<typeof createMathRemixSession>;
