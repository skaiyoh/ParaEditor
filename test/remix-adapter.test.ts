import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { applyRemixOperation, type RemixOperationInput } from '../src/core/remix.ts';
import { migrateV5ToV6, withDerivedGrainStyle, type FunctionDraft, type RemixDocument, type Site } from '../src/core/remix-schema.ts';
import { insertionSlots } from '../src/core/remix-view.ts';
import { createMathLibrary } from '../src/core/math-definition.ts';
import { parseMathFunction, sourceSpan, typecheckMathFunction } from '../src/core/math-expression.ts';
import type { PaintBrush } from '../src/core/paint.ts';
import type { RemixSessionPort } from '../src/ui/remix-adapter.ts';
import type { PaintSessionPort } from '../src/ui/paint-adapter.ts';
import type { RemixState, RemixTarget } from '../src/ui/remix-model.ts';
import { minimalDocument } from './fixtures/documents.ts';

// Bundle the real adapters because displayColor lives in TSX, which Node's type stripper cannot load.
const built = await build({ stdin: { contents: "export { remixModel } from './src/ui/remix-adapter.ts'; export { paintModel } from './src/ui/paint-adapter.ts';", resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2024' });
const output = built.outputFiles[0]; assert.ok(output);
const { remixModel, paintModel }: Pick<typeof import('../src/ui/remix-adapter.ts'), 'remixModel'> & Pick<typeof import('../src/ui/paint-adapter.ts'), 'paintModel'> =
  await import(`data:text/javascript;base64,${Buffer.from(output.text).toString('base64')}`);

function harness() {
  const migrated = migrateV5ToV6(minimalDocument()); assert.ok(migrated.ok);
  let doc: RemixDocument = migrated.value;
  let target: RemixTarget = 'photo';
  let status: ReturnType<RemixSessionPort['snapshot']>['status'] = { kind: 'Applied', checkpoint: 0 };
  let preview: 'current' | 'last-valid' = 'current';
  let draftRevision = 0;
  const calls: RemixOperationInput[] = [];
  const writes: Parameters<RemixSessionPort['writeSource']>[0][] = [];
  const begun: Site[] = [], commits: symbol[] = [];
  const packages: Parameters<RemixSessionPort['packageBlock']>[0][] = [];
  const borrows: Parameters<RemixSessionPort['borrowFunction']>[0][] = [];
  const uses: string[] = [], created: Parameters<RemixSessionPort['newFunctionAt']>[0][] = [];
  let retries = 0;
  let editing: ReturnType<RemixSessionPort['snapshot']>['editing'] = null;
  let copied: { readonly label: string } | null = null;
  const unchanged = () => ({ kind: 'unchanged', copied: null } satisfies Awaited<ReturnType<RemixSessionPort['perform']>>);
  const port: RemixSessionPort = {
    snapshot: () => ({ ...doc.remix.checkpoint, draftRevision, ...doc.remix, target, status, preview, document: doc, diagnostics: [], copied, editing }),
    setTarget(next) { target = next; return { kind: 'applied' }; },
    perform(input) { calls.push(input); const result = applyRemixOperation(doc, input); if (result.kind === 'applied') doc = result.doc; return result; },
    packageBlock(input) { packages.push(input); return { ok: true, value: { id: 'packaged', revision: 1 } }; },
    borrowFunction(input) { borrows.push(input); return unchanged(); },
    useInBrush(instance) { uses.push(instance); return unchanged(); },
    beginSourceEdit(site) { begun.push(site); editing = { gesture: Symbol('edit'), draft: `draft-${site.node}`, site }; return { ok: true, value: editing }; },
    writeSource(input) {
      writes.push(input); draftRevision++;
      return input.source.includes('/') ? { ok: false, error: { kind: 'domain', message: 'Division needs a safe form here.', sourceId: input.draft, path: null, span: sourceSpan(input.source, input.source.indexOf('/')) } } : { ok: true, value: draftRevision };
    },
    newFunctionAt(slot) {
      created.push(slot);
      editing = { gesture: Symbol('new'), draft: 'new-draft', site: { kind: 'function', instance: slot.instance, node: 'new-node' } };
      return { ok: true, value: { gesture: editing.gesture, draft: editing.draft, node: 'new-node' } };
    },
    commitGesture(gesture) { commits.push(gesture); if (editing?.gesture === gesture) editing = null; return unchanged(); }, cancelGesture() {},
    retrySave() { retries++; return { kind: 'applied' }; },
  };
  const session = { remix: port, previewDocument: () => withDerivedGrainStyle(doc) };
  return { port, session, calls, writes, begun, commits, packages, borrows, uses, created,
    model() { const model = remixModel(session); assert.ok(model); return model; },
    document: () => doc, setDocument: (next: RemixDocument) => { doc = next; }, setCopied: (next: typeof copied) => { copied = next; },
    setStatus: (next: typeof status) => { status = next; }, setPreview: (next: typeof preview) => { preview = next; },
    setDraft(phase: FunctionDraft['phase'], node = 'remap') {
      doc = { ...doc, remix: { ...doc.remix, drafts: [{ id: `draft-${node}`, base: null, revision: draftRevision, source: 'broken source', phase,
        site: { kind: 'function', instance: 'photo-grain', node }, diagnostics: [{ kind: 'syntax', message: 'Expected a function.', sourceId: 'draft', path: null,
          span: { start: 0, end: 1, line: 2, column: 3 } }] }] } };
    }, retries: () => retries,
  };
}

test('real v6 rack, grouped functions, parameters, slots and compatible replacements', () => {
  const h = harness(), model = h.model();
  assert.deepEqual(model.targets, ['photo']); assert.equal(model.brush, null);
  assert.deepEqual(model.rack.blocks.map(block => block.name), ['Grain']);
  assert.equal(model.rack.inLabel, 'Photo in'); assert.equal(model.rack.outLabel, 'Result');
  const detail = model.detail('photo-grain'); assert.ok(detail);
  for (const label of ['Cells', 'Seeded noise', 'Identity', 'Grain color']) assert.ok(detail.nodes.some(node => node.name === label));
  for (const label of ['Seeded noise', 'Identity']) assert.equal(detail.nodes.find(node => node.name === label)?.channels, 3, `${label}: 3 channels`);
  assert.deepEqual(detail.nodes.find(node => node.name === 'Cells')?.params.map(param => param.id), ['grainSize']);
  assert.ok(detail.nodes.find(node => node.name === 'Grain color')?.params.some(param => param.id === 'amount'));
  assert.deepEqual(detail.slots, insertionSlots(h.document(), 'photo-grain').map(({ id, after, flow }) => ({ id, after, flow })));
  assert.ok(detail.slots.every(slot => slot.flow.includes('→')));
  assert.equal(detail.inFlow, 'Color in'); assert.equal(detail.outFlow, 'Color out');
  const at = { kind: 'node', id: 'remap' } satisfies Parameters<typeof model.actions.candidates>[1];
  const choices = model.actions.candidates('photo-grain', at);
  for (const name of ['Curve', 'Threshold']) assert.ok(choices.compatible.some(choice => choice.name === name && choice.detail === 'amount → amount'));
  assert.ok(choices.incompatible.length > 0);
  assert.deepEqual(choices.create, { kind: 'unavailable', reason: 'New functions are added at an insert point.' });
  const threshold = choices.compatible.find(choice => choice.name === 'Threshold'); assert.ok(threshold);
  model.actions.placeFunction('photo-grain', at, threshold.id);
  assert.deepEqual(h.calls[0], { expected: 0, target: 'photo', operation: { kind: 'replace', at: { kind: 'function', instance: 'photo-grain', node: 'remap' }, replacement: { id: 'grain-threshold', revision: 1 } } });
  assert.equal(h.model().rack.blocks[0]?.owned, true);
  assert.match(h.model().status.notice ?? '', /copied so you can change it\.$/);
  model.actions.setBlockEnabled('photo-grain', false);
  assert.equal(h.calls[1]?.expected, 1, 'an existing model reads the latest revision');
  assert.equal(h.model().status.notice, null);
  const other = harness(); assert.equal(other.model().status.notice, null, 'notice is per session');
  const contrast = other.model().rack.addable.find(choice => choice.name === 'Contrast'); assert.ok(contrast);
  other.model().actions.addBlock(contrast.id, 1);
  assert.deepEqual(other.model().rack.blocks.map(block => block.name), ['Grain', 'Contrast']);
});

test('full Grain exposes insert points and refuses incompatible or over-budget choices without changing its graph', () => {
  const h = harness(), model = h.model(), before = h.document();
  assert.ok(model.detail('photo-grain')?.slots.some(slot => slot.id === 'after-remap'));
  const at = { kind: 'slot', id: 'after-remap' } satisfies Parameters<typeof model.actions.candidates>[1];
  const choices = model.actions.candidates('photo-grain', at);
  assert.equal(choices.compatible.length, 0);
  assert.equal(choices.create.kind, 'available', 'new source is admitted separately from existing candidates');
  for (const name of ['Cells', 'Threshold']) {
    const choice = choices.incompatible.find(value => value.name === name); assert.ok(choice);
    assert.equal(choice.available.kind, 'unavailable');
    model.actions.placeFunction('photo-grain', at, choice.id);
    assert.ok(h.model().status.notice);
    assert.equal(h.document(), before);
    assert.equal(h.calls.length, 0);
  }
  assert.equal(model.actions.candidates('photo-grain', { kind: 'slot', id: 'after-color' }).create.kind, 'available');
});

test('every draft/save combination follows precedence, including persisted invalid text after Done', () => {
  const saveKinds = ['Applied', 'Saving', 'Saved', 'Save failed'] satisfies ReturnType<RemixSessionPort['snapshot']>['status']['kind'][];
  const phases = [undefined, 'checking', 'invalid', 'valid'] satisfies (FunctionDraft['phase'] | undefined)[];
  const rows: Record<string, readonly RemixState[]> = {
    none: ['applied', 'saving', 'saved', 'save-failed'], checking: ['checking', 'checking', 'checking', 'save-failed'],
    invalid: ['invalid', 'invalid', 'draft-saved', 'save-failed'], valid: ['applied', 'saving', 'saved', 'save-failed'],
  };
  for (const phase of phases) for (const [index, kind] of saveKinds.entries()) {
    const h = harness();
    if (phase !== undefined) h.setDraft(phase);
    h.setStatus(kind === 'Save failed' ? { kind, checkpoint: 0, reason: 'Offline' } : { kind, checkpoint: 0 });
    h.setPreview('last-valid');
    const model = h.model(); model.source('photo-grain', 'remap');
    assert.equal(model.status.state, rows[phase ?? 'none']?.[index], `${phase}/${kind}`);
    assert.equal(model.status.lastWorkingPreview, true);
  }
  const h = harness(); h.setDraft('invalid'); h.setStatus({ kind: 'Saved', checkpoint: 0 });
  h.model().actions.beginEdit('photo-grain', 'remap'); h.model().actions.endEdit('photo-grain', 'remap');
  assert.equal(h.model().status.state, 'draft-saved');
  h.model().source('photo-grain', 'cells'); assert.equal(h.model().status.state, 'saved', 'unrelated draft does not override the open function');
});

test('source, diagnostics, example admission and one source gesture across model rebuilds', () => {
  const h = harness(), model = h.model(), source = model.source('photo-grain', 'remap'); assert.ok(source);
  assert.equal(source.signature, '(n: coverage) -> coverage'); assert.equal(source.owned, false); assert.equal(source.editing, false);
  assert.equal(source.draft, null); assert.ok(source.builtins.includes('step'));
  const parsed = parseMathFunction(source.example); assert.ok(parsed.ok);
  const typed = typecheckMathFunction(parsed.value, 'example'); assert.ok(typed.ok);
  assert.equal(typed.value.output, 'coverage'); assert.deepEqual(typed.value.inputs.map(input => input.type), ['coverage']);
  const library = createMathLibrary([{ id: 'example', revision: 1, libraryRevision: 1, source: source.example, dependencies: [] }]); assert.ok(library.ok);
  model.actions.beginEdit('photo-grain', 'remap'); h.model().actions.beginEdit('photo-grain', 'remap');
  assert.equal(h.begun.length, 1); assert.equal(h.model().source('photo-grain', 'remap')?.editing, true);
  model.actions.setDraft('photo-grain', 'remap', 'first'); h.model().actions.setDraft('photo-grain', 'remap', 'second');
  assert.deepEqual(h.writes.map(write => write.expected), [0, 1]);
  assert.equal(h.writes[0]?.gesture, h.writes[1]?.gesture);
  // writeSource reports a MathResult (MRX0 item 6): a refusal becomes the notice, not an exception.
  h.model().actions.setDraft('photo-grain', 'remap', 'value(x) / 2.0');
  assert.equal(h.model().status.notice, 'Division needs a safe form here.');
  h.model().actions.saveAsBlock('photo-grain', 'Speckle'); assert.equal(h.model().status.notice, null);
  h.setDraft('invalid');
  const invalid = h.model().source('photo-grain', 'remap'); assert.ok(invalid);
  assert.equal(invalid.draft, 'broken source'); assert.deepEqual(invalid.diagnostics, [{ line: 2, column: 3, message: 'Expected a function.' }]);
  model.actions.endEdit('photo-grain', 'remap'); h.model().actions.endEdit('photo-grain', 'remap');
  assert.equal(h.commits.length, 1); assert.equal(h.model().source('photo-grain', 'remap')?.editing, false);
  assert.equal(model.actions.createFunction('photo-grain', { kind: 'node', id: 'remap' }), null);
  assert.equal(model.actions.createFunction('photo-grain', { kind: 'slot', id: 'after-remap' }), 'new-node');
  assert.deepEqual(h.created, [{ instance: 'photo-grain', slot: 'after-remap' }]);
  model.actions.setDraft('photo-grain', 'new-node', source.example); assert.equal(h.writes.at(-1)?.draft, 'new-draft');
});

test('Fry needs both Grain bindings, parameter gestures preserve the core address, and refusals surface', () => {
  const h = harness(), model = h.model(); assert.equal(model.fry.kind, 'available');
  const param = model.rack.blocks[0]?.params.find(value => value.id === 'amount'); assert.ok(param);
  assert.deepEqual(model.parameterValue({ kind: 'function', block: 'photo-grain', node: 'color' }, param, .42),
    { kind: 'remix-parameter', target: 'photo', instance: 'photo-grain', name: 'amount', value: .42 });
  model.actions.setBlockEnabled('photo-grain', false);
  assert.equal(h.model().fry.kind, 'unavailable'); assert.deepEqual(h.model().fry, h.model().grainControl('grain'));
  model.actions.renameBlock('photo-grain', 'No fork'); assert.ok(h.model().status.notice);
  model.actions.saveAsBlock('photo-grain', 'Saved block'); model.actions.useInBrush('photo-grain'); model.actions.retrySave();
  assert.deepEqual(h.packages, [{ instance: 'photo-grain', name: 'Saved block' }]); assert.deepEqual(h.uses, ['photo-grain']); assert.equal(h.retries(), 1);
  model.actions.moveFunction('photo-grain', 'remap', -1);
  assert.deepEqual(h.calls.at(-1)?.operation, { kind: 'reorder', at: { kind: 'function', instance: 'photo-grain', node: 'remap' }, index: 2 });
  model.actions.removeFunction('photo-grain', 'remap');
  assert.deepEqual(h.calls.at(-1)?.operation, { kind: 'remove', at: { kind: 'function', instance: 'photo-grain', node: 'remap' } });
});

function paintHarness() {
  const h = harness();
  let brush: PaintBrush = { operation: 'draw', color: { l: .2, c: .1, h: 40 }, diameter: 24, opacity: .8, pressure: 'off' };
  let tool: ReturnType<PaintSessionPort['snapshot']>['authoring']['tool'] = 'select';
  let fingerDraw = false;
  const starts: Parameters<PaintSessionPort['beginStroke']>[0][] = [], extensions: Parameters<PaintSessionPort['extendStroke']>[] = [];
  const ends: symbol[] = [], cancels: symbol[] = [], interruptions: string[] = [], attachments: (HTMLCanvasElement | null)[] = [];
  let resets = 0;
  const token = Symbol('stroke');
  const paint: PaintSessionPort = {
    snapshot: () => ({ authoring: { tool }, brush, fingerDraw }), setTool(next) { tool = next; return { kind: 'applied' }; },
    setBrush(next) { brush = next; return { kind: 'applied' }; }, attachBrushPreview: canvas => { attachments.push(canvas); },
    resetBrushPreview() { resets++; }, drawingAvailability: () => ({ kind: 'unavailable', reason: 'Drawing needs depth. Preparing depth…' }),
    beginStroke(input) { starts.push(input); return { ok: true, value: token }; },
    extendStroke(...input) { extensions.push(input); return { kind: 'applied' }; }, endStroke(token) { ends.push(token); return { kind: 'applied' }; },
    cancelStroke: token => { cancels.push(token); }, interrupt: reason => { interruptions.push(reason); },
    setFingerDraw: value => { fingerDraw = value; },
  };
  const session = { ...h.session, ...paint };
  return { h, session, starts, extensions, ends, cancels, interruptions, attachments, token, resets: () => resets };
}

test('scene and pad map the S12 port with distinct coordinate spaces and current brush settings', () => {
  const h = paintHarness();
  const model = paintModel(h.session); assert.ok(model);
  assert.equal(model.tool, null); assert.equal(model.brush.minDiameter, 1); assert.equal(model.brush.maxDiameter, 256);
  model.setTool('eraser'); assert.equal(paintModel(h.session)?.tool, 'eraser'); model.setTool(null); assert.equal(paintModel(h.session)?.tool, null);
  model.setBrush({ diameter: 60 }); model.setBrush({ opacity: .3 });
  assert.equal(paintModel(h.session)?.brush.diameter, 60); assert.equal(paintModel(h.session)?.brush.opacity, .3);
  model.setFingerDraw(true); assert.equal(paintModel(h.session)?.fingerDraw, true);
  const sample = { at: { x: 150, y: 250 }, pressure: .7 };
  assert.equal(model.begin('pen', sample), h.token); model.extend(h.token, [sample]); model.end(h.token); model.cancel(h.token); model.interrupt('second-touch');
  assert.deepEqual(h.starts[0], { surface: 'scene', pointer: 'pen', sample });
  assert.deepEqual(h.interruptions, ['second-touch']);
  const remix = remixModel(h.session); assert.ok(remix); assert.deepEqual(remix.targets, ['photo', 'brush']); assert.ok(remix.brush);
  assert.equal(remix.brush.view.backdrop, 'light'); assert.match(remix.brush.view.colorLabel, /^#[0-9a-f]{6}$/i);
  assert.deepEqual(remix.brush.view.drawing, { kind: 'unavailable', reason: 'Drawing needs depth. Preparing depth…' });
  assert.deepEqual(model.drawing, remix.brush.view.drawing);
  const padSample = { x: .25, y: .75, pressure: null, time: 123, pointer: 'finger' } satisfies Parameters<typeof remix.brush.pad.begin>[0];
  assert.equal(remix.brush.pad.begin(padSample), h.token); remix.brush.pad.extend(h.token, [padSample]);
  assert.deepEqual(h.starts[1], { surface: 'pad', pointer: 'finger', sample: { at: { x: .25, y: .75 }, pressure: null } });
  assert.deepEqual(h.extensions[1], [h.token, [{ at: { x: .25, y: .75 }, pressure: null }]]);
  remix.brush.pad.end(h.token); remix.brush.pad.cancel(h.token); remix.brush.pad.reset(); remix.brush.pad.setPressure(true);
  remix.setBrushParam(remix.brush.view.size, 90); remix.setBrushParam(remix.brush.view.opacity, .5);
  assert.equal(paintModel(h.session)?.brush.diameter, 90); assert.equal(paintModel(h.session)?.brush.opacity, .5); assert.equal(paintModel(h.session)?.brush.pressure, 'size');
  assert.equal(h.resets(), 1);
  assert.deepEqual(h.ends, [h.token, h.token]); assert.deepEqual(h.cancels, [h.token, h.token]);
  remix.setTarget('brush'); const rack = remixModel(h.session)?.rack; assert.ok(rack);
  assert.equal(rack.inLabel, 'Stroke in'); assert.equal(rack.outLabel, 'Ink'); assert.ok(rack.blocks.every(block => block.useInBrush === null));
});

test('missing or incomplete ports produce no model; remix needs v6, paint does not', () => {
  const h = harness();
  assert.equal(remixModel({ previewDocument: h.session.previewDocument }), null);
  // The session's snapshot owns the document (MRX4b-photo): none before import means no model.
  const empty = { ...h.port, snapshot: () => ({ ...h.port.snapshot(), document: null }) };
  const unloaded = { ...h.session, remix: empty }; assert.equal(remixModel(unloaded), null);
  // An incomplete port is now a compile-time error: session.remix is typed (MRX4b-photo).
  assert.equal(paintModel(h.session), null);
  // A freshly imported v5 photo can paint: the session upgrades it to v6 on the first stroke.
  const paint = paintHarness(); assert.notEqual(paintModel({ ...paint.session, previewDocument: () => minimalDocument() }), null);
});
