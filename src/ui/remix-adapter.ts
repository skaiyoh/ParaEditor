import { createMathLibrary, mathRefKey, type MathRef } from '../core/math-definition.ts';
import { MATH_BUILTINS, type MathDiagnostic, type MathResult } from '../core/math-expression.ts';
import { remixBlock, remixNodeGroups, type RemixOperation, type RemixOperationInput } from '../core/remix.ts';
import { grainBinding, type FunctionDraft, type MathCheckpoint, type RemixDocument, type Site } from '../core/remix-schema.ts';
import { addableBlocks, allowedOperations, candidates, canUseInBrush, displayLabel, flowWords, functionSites,
  insertionSlots, isBuiltIn, parameters, typeWord, type CandidatePlace, type RemixCandidate } from '../core/remix-view.ts';
import type { Capability, CommandResult } from '../session/authoring.ts';
import { colorInputFromOklch } from '../core/color.ts';
import type { Oklch } from '../core/raster.ts';
import type { SceneDocument } from '../core/types.ts';
import { paintBrushView, paintPortOf, setPaintBrush } from './paint-adapter.ts';
import type { RemixBlock, RemixChoice, RemixModel, RemixPadSample, RemixParam, RemixPlace, RemixState, RemixTarget } from './remix-model.ts';

/** setTarget and retrySave report a plain CommandResult; the rest add the copy-on-write label (S9 G10). */
type OperationResult = CommandResult & { readonly copied?: { readonly label: string } | null };
type EditSession = { readonly gesture: symbol; readonly draft: string };
type FunctionSite = Extract<Site, { kind: 'function' }>;
type SaveState = { readonly kind: 'Applied' | 'Saving' | 'Saved'; readonly checkpoint: number }
  | { readonly kind: 'Save failed'; readonly checkpoint: number; readonly reason: string };
/** The members of MRX4b-photo's `session.remix` (src/session/math-remix.ts) this adapter consumes. */
export type RemixSessionPort = {
  snapshot(): MathCheckpoint & Pick<RemixDocument['remix'], 'instances' | 'functions' | 'blocks' | 'drafts'> & {
    readonly target: RemixTarget; readonly status: SaveState; readonly preview: 'current' | 'last-valid';
    /** The admitted raw document for the pure remix-view queries; null before import. */
    readonly document: RemixDocument | null;
    /** Top-level compile refusals; draft diagnostics live on each FunctionDraft. */
    readonly diagnostics: readonly MathDiagnostic[];
    readonly copied: { readonly label: string } | null;
    /** The one open source edit session, owned by the session. */
    readonly editing: { readonly gesture: symbol; readonly draft: string; readonly site: Site | null } | null;
  };
  setTarget(target: RemixTarget): OperationResult;
  perform(input: RemixOperationInput): OperationResult | Promise<OperationResult>;
  /** MRX0 item 6: a MathResult, normalized by `fromMath`. */
  packageBlock(input: { readonly instance: string; readonly name: string }): MathResult<MathRef> | Promise<MathResult<MathRef>>;
  borrowFunction(input: { readonly from: MathRef; readonly node: string; readonly into: FunctionSite }): OperationResult | Promise<OperationResult>;
  useInBrush(instance: string): OperationResult | Promise<OperationResult>;
  /** Ends any open session first; a built-in is copied on its first valid applied change. */
  beginSourceEdit(site: FunctionSite): MathResult<EditSession>;
  /** MRX0 item 6: a MathResult of the new draft revision, normalized by `fromMath`. */
  writeSource(input: EditSession & { readonly expected: number; readonly source: string }): MathResult<number> | Promise<MathResult<number>>;
  /** Inserts a typed identity example and leaves its source gesture open; Done groups insertion and edits. */
  newFunctionAt(slot: { readonly instance: string; readonly slot: string }): MathResult<EditSession & { readonly node: string }>;
  commitGesture(gesture: symbol): OperationResult | Promise<OperationResult>;
  cancelGesture(gesture: symbol): void;
  retrySave(): OperationResult | Promise<OperationResult>;
};

/** Structural, so the adapter and its test never pull the session's module graph; DemoSession satisfies it. */
type Session = { readonly previewDocument: () => SceneDocument | null; readonly remix?: RemixSessionPort };
const inkHex = (color: Oklch): string => { const display = colorInputFromOklch(color); return display.kind === 'valid' ? display.color.hex : '#FFFFFF'; };
function remixPortOf(session: Session): RemixSessionPort | null {
  return session.remix ?? null;
}

/** UI-side memory only: the last refusal to show, and which function the panel last showed. The session owns edit sessions. */
type LocalState = { notice: string | null; operation: number; openSite: FunctionSite | null };
const states = new WeakMap<Session, LocalState>();
const AVAILABLE: Capability = { kind: 'available' };
const example = 'fn remap(x: coverage) -> coverage {\n  return coverage(step(0.5, value(x)));\n}';
const functionSite = (instance: string, node: string): FunctionSite => ({ kind: 'function', instance, node });
const place = (at: RemixPlace): CandidatePlace => at.kind === 'node' ? { kind: 'node', node: at.id } : { kind: 'slot', slot: at.id };
const paramView = (param: ReturnType<typeof parameters>[number]): RemixParam => ({ id: param.name, label: param.label,
  value: param.value, min: param.min, max: param.max, step: param.step, display: param.integer ? String(param.value) : param.value.toFixed(2) });
/** Packaging and source writes report MathResult (MRX0 item 6); the notice path reads operation results. */
function fromMath<T>(result: MathResult<T> | Promise<MathResult<T>>): OperationResult | Promise<OperationResult> {
  const normalize = (value: MathResult<T>): OperationResult => value.ok ? { kind: 'applied', copied: null }
    : { kind: 'refused', reason: value.error.message, copied: null };
  return result instanceof Promise ? result.then(normalize) : normalize(result);
}
const padSample = (sample: RemixPadSample) => ({ at: { x: sample.x, y: sample.y }, pressure: sample.pressure });

function statusState(draft: FunctionDraft | undefined, status: SaveState): RemixState {
  if (status.kind === 'Save failed') return 'save-failed';
  if (draft?.phase === 'checking') return 'checking';
  if (draft?.phase === 'invalid') return status.kind === 'Saved' ? 'draft-saved' : 'invalid';
  switch (status.kind) {
    case 'Applied': return 'applied';
    case 'Saving': return 'saving';
    case 'Saved': return 'saved';
  }
}

export function remixModel(session: Session): RemixModel | null {
  const candidatePort = remixPortOf(session);
  if (candidatePort === null) return null;
  const port = candidatePort, snapshot = port.snapshot(), document = snapshot.document, target = snapshot.target;
  if (document === null) return null;
  const doc: RemixDocument = document;
  const paint = paintPortOf(session);
  let local = states.get(session);
  if (local === undefined) { local = { notice: null, operation: 0, openSite: null }; states.set(session, local); }
  const state = local;
  function currentDocument(): RemixDocument | null { return port.snapshot().document; }
  /** The open source edit session when it is the given function's. */
  function editingAt(block: string, node: string): EditSession | null {
    const editing = port.snapshot().editing;
    return editing !== null && editing.site?.kind === 'function' && editing.site.instance === block && editing.site.node === node ? editing : null;
  }
  function run(action: () => OperationResult | Promise<OperationResult>): void {
    const sequence = ++state.operation;
    state.notice = null;
    const receive = (result: OperationResult) => {
      if (sequence !== state.operation) return;
      state.notice = result.kind === 'refused' ? result.reason : result.copied == null ? null : `${result.copied.label} copied so you can change it.`;
    };
    try {
      const result = action();
      if (result instanceof Promise) void result.then(receive, error => {
        if (sequence === state.operation) state.notice = error instanceof Error ? error.message : 'The change could not be completed.';
      });
      else receive(result);
    } catch (error) { state.notice = error instanceof Error ? error.message : 'The change could not be completed.'; }
  }
  function perform(operation: RemixOperation): void {
    const current = currentDocument();
    if (current === null) return;
    run(() => port.perform({ expected: current.remix.checkpoint.appliedRevision, target, operation }));
  }
  function blockView(id: string): RemixBlock | null {
    const instance = doc.remix.instances.find(value => value.id === id && value.target === target);
    if (instance === undefined) return null;
    const operations = allowedOperations(doc, { kind: 'block', instance: id });
    return { id, name: displayLabel(doc, instance.block), owned: !isBuiltIn(doc, instance.block), enabled: instance.enabled,
      params: parameters(doc, id).map(paramView), moveUp: operations.moveUp, moveDown: operations.moveDown, remove: operations.remove,
      useInBrush: target === 'photo' && paint !== null ? canUseInBrush(doc, id) : null };
  }
  const library = createMathLibrary(doc.remix.functions);
  function candidateChoice(candidate: RemixCandidate): RemixChoice {
    const fn = library.ok ? library.value.get(candidate.ref) : undefined;
    return { id: mathRefKey(candidate.ref), name: candidate.label,
      detail: fn === undefined ? '' : flowWords(fn.signature.inputs, fn.signature.output), origin: candidate.origin, available: candidate.available };
  }
  const choices = (document: RemixDocument, block: string, at: RemixPlace) => candidates(document, { instance: block, at: place(at) });
  const grainControl: RemixModel['grainControl'] = control => {
    const binding = grainBinding(doc, control);
    return binding.kind === 'bound' ? AVAILABLE : { kind: 'unavailable', reason: binding.reason };
  };
  const grain = grainControl('grain'), colorNoise = grainControl('colorNoise');
  const brush = paint === null ? null : paintBrushView(paint);
  const drawing = paint?.drawingAvailability();
  return {
    status: { get state() {
      const current = port.snapshot(), site = state.openSite;
      const draft = current.drafts.find(value => site !== null && value.site?.kind === 'function' && value.site.instance === site.instance && value.site.node === site.node);
      return statusState(draft, current.status);
    }, lastWorkingPreview: snapshot.preview === 'last-valid', get notice() {
      const current = port.snapshot();
      return state.notice ?? (current.copied === null ? null : `${current.copied.label} copied so you can change it.`) ?? current.diagnostics[0]?.message ?? null;
    } },
    targets: paint === null ? ['photo'] : ['photo', 'brush'], target,
    setTarget: next => run(() => port.setTarget(next)),
    rack: { target, inLabel: target === 'photo' ? 'Photo in' : 'Stroke in', outLabel: target === 'photo' ? 'Result' : 'Ink',
      blocks: doc.remix.instances.filter(value => value.target === target).flatMap(value => { const block = blockView(value.id); return block === null ? [] : [block]; }),
      addable: addableBlocks(doc, target).map(choice => {
        const block = remixBlock(doc, choice.ref);
        return { id: mathRefKey(choice.ref), name: choice.label, detail: flowWords(block.inputs.map(input => input.type), block.outputType), origin: null, available: choice.available };
      }) },
    detail(id) {
      const block = blockView(id), instance = doc.remix.instances.find(value => value.id === id);
      if (block === null || instance === undefined) return null;
      const source = remixBlock(doc, instance.block), groups = remixNodeGroups(source);
      const word = (type: typeof source.outputType | undefined): string => { const text = type === undefined ? '' : typeWord(type); return text.charAt(0).toUpperCase() + text.slice(1); };
      return { block, inFlow: `${word(source.inputs[0]?.type)} in`, outFlow: `${word(source.outputType)} out`,
        nodes: functionSites(doc, id).map(site => {
          const bound = new Set(groups.find(group => group.id === site.id)?.nodes.flatMap(node => node.args.flatMap(arg => arg.kind === 'parameter' ? [arg.name] : [])));
          return { id: site.id, name: site.label, flow: site.flow, owned: !site.builtIn, channels: site.channels, branchOf: null,
            params: block.params.filter(param => bound.has(param.id)), replace: site.operations.replace, moveUp: site.operations.moveUp,
            moveDown: site.operations.moveDown, remove: site.operations.remove };
        }), slots: insertionSlots(doc, id).map(({ id, after, flow }) => ({ id, after, flow })), saveAsBlock: AVAILABLE };
    },
    source(block, node) {
      const instance = doc.remix.instances.find(value => value.id === block);
      if (instance === undefined) return null;
      const group = remixNodeGroups(remixBlock(doc, instance.block)).find(value => value.id === node), ref = group?.nodes[0]?.function;
      const fn = ref === undefined ? undefined : doc.remix.functions.find(value => mathRefKey(value) === mathRefKey(ref));
      if (fn === undefined) return null;
      state.openSite = functionSite(block, node);
      const draft = snapshot.drafts.find(value => value.site?.kind === 'function' && value.site.instance === block && value.site.node === node);
      return { block, node, name: displayLabel(doc, fn), signature: /\bfn\s+\w+\s*([^{}]*)\{/.exec(fn.source)?.[1]?.trim() ?? '',
        owned: !isBuiltIn(doc, fn), text: fn.source, draft: draft !== undefined && draft.source !== fn.source ? draft.source : null,
        diagnostics: draft?.diagnostics.map(value => ({ line: value.span.line, column: value.span.column, message: value.message })) ?? [],
        editing: editingAt(block, node) !== null, example, builtins: MATH_BUILTINS.map(value => value.name) };
    },
    actions: {
      setBlockEnabled: (instance, enabled) => perform({ kind: 'bypass', at: { kind: 'block', instance }, bypassed: !enabled }),
      moveBlock: (instance, index) => perform({ kind: 'reorder', at: { kind: 'block', instance }, index }),
      removeBlock: instance => perform({ kind: 'remove', at: { kind: 'block', instance } }),
      renameBlock: (instance, name) => perform({ kind: 'rename', instance, name }),
      addBlock(choice, index) {
        const current = currentDocument();
        const block = current === null ? undefined : addableBlocks(current, target).find(value => mathRefKey(value.ref) === choice);
        if (block !== undefined) perform({ kind: 'add', block: block.ref, index });
      },
      useInBrush: instance => run(() => port.useInBrush(instance)),
      candidates(block, at) {
        const instance = doc.remix.instances.find(value => value.id === block);
        const running = at.kind !== 'node' || instance === undefined ? undefined
          : remixNodeGroups(remixBlock(doc, instance.block)).find(group => group.id === at.id)?.nodes[0]?.function;
        const entries = choices(doc, block, at).filter(candidate => running === undefined || mathRefKey(candidate.ref) !== mathRefKey(running)).map(candidateChoice);
        return { compatible: entries.filter(value => value.available.kind === 'available'), incompatible: entries.filter(value => value.available.kind === 'unavailable'),
          create: at.kind === 'slot' ? AVAILABLE : { kind: 'unavailable', reason: 'New functions are added at an insert point.' } };
      },
      placeFunction(block, at, id) {
        const current = currentDocument();
        const candidate = current === null ? undefined : choices(current, block, at).find(value => mathRefKey(value.ref) === id);
        if (candidate === undefined) return;
        if (candidate.available.kind === 'unavailable') { ++state.operation; state.notice = candidate.available.reason; return; }
        const apply = candidate.apply;
        if (at.kind === 'slot') perform({ kind: 'insert', at: { instance: block, slot: at.id }, fn: candidate.ref });
        else if (apply.kind === 'replace') perform({ kind: 'replace', at: functionSite(block, at.id), replacement: apply.replacement });
        else run(() => port.borrowFunction({ from: apply.from, node: apply.node, into: functionSite(block, at.id) }));
      },
      createFunction(block, at) {
        if (at.kind !== 'slot') return null;
        const created = port.newFunctionAt({ instance: block, slot: at.id });
        if (!created.ok) { ++state.operation; state.notice = created.error.message; return null; }
        state.openSite = functionSite(block, created.value.node);
        return created.value.node;
      },
      moveFunction(block, node, delta) {
        const current = currentDocument();
        if (current === null) return;
        const index = functionSites(current, block).findIndex(site => site.id === node);
        if (index >= 0) perform({ kind: 'reorder', at: functionSite(block, node), index: index + delta });
      },
      removeFunction: (block, node) => perform({ kind: 'remove', at: functionSite(block, node) }),
      saveAsBlock: (instance, name) => run(() => fromMath(port.packageBlock({ instance, name }))),
      beginEdit(block, node) {
        state.openSite = functionSite(block, node);
        // A second begin for the open session is a no-op; beginSourceEdit would end it first.
        if (editingAt(block, node) !== null) return;
        const begun = port.beginSourceEdit(functionSite(block, node));
        if (!begun.ok) { ++state.operation; state.notice = begun.error.message; }
      },
      setDraft(block, node, source) {
        const edit = editingAt(block, node);
        if (edit !== null) run(() => fromMath(port.writeSource({ gesture: edit.gesture, draft: edit.draft, expected: port.snapshot().draftRevision, source })));
      },
      endEdit(block, node) {
        const edit = editingAt(block, node);
        if (edit !== null) run(() => port.commitGesture(edit.gesture));
      },
      retrySave: () => run(() => port.retrySave()),
    },
    parameterValue(owner, param, value) {
      const current = currentDocument(), parameter = current === null ? undefined : parameters(current, owner.block).find(entry => entry.name === param.id);
      const gesture = parameter?.gesture ?? { kind: 'remix-parameter', target, instance: owner.block, name: param.id, value };
      return { ...gesture, value };
    },
    setBrushParam(param, value) { if (paint !== null) setPaintBrush(paint, param.id === 'size' ? { diameter: value } : { opacity: value }); },
    brush: paint === null || brush === null || drawing === undefined ? null : {
      view: { color: inkHex(brush.color), colorLabel: inkHex(brush.color),
        size: { id: 'size', label: 'Size', value: brush.diameter, min: brush.minDiameter, max: brush.maxDiameter, step: 1, display: String(brush.diameter) },
        opacity: { id: 'opacity', label: 'Opacity', value: brush.opacity, min: 0, max: 1, step: .01, display: brush.opacity.toFixed(2) },
        pressure: brush.pressure === 'size', drawing, backdrop: brush.color.l < .45 ? 'light' : 'dark' },
      pad: {
        attach(canvas) { paint.attachBrushPreview(canvas); return () => paint.attachBrushPreview(null); },
        begin(sample) { const result = paint.beginStroke({ surface: 'pad', pointer: sample.pointer, sample: padSample(sample) }); return result.ok ? result.value : null; },
        extend: (token, samples) => { paint.extendStroke(token, samples.map(padSample)); },
        end: token => { void paint.endStroke(token); }, cancel: token => paint.cancelStroke(token), reset: () => paint.resetBrushPreview(),
        setPressure: enabled => setPaintBrush(paint, { pressure: enabled ? 'size' : 'off' }), openColor: () => {},
      },
    },
    grainBlock: doc.remix.grainInstance, grainControl, fry: grain.kind === 'unavailable' ? grain : colorNoise,
  };
}
