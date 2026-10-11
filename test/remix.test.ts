import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMathLibrary, mathRefKey } from '../src/core/math-definition.ts';
import { createMathBlock, reopenMathBlock } from '../src/core/math-graph.ts';
import { applyRemixOperation, applyRemixSource, borrowFunction, createRemixFunction, forkBlock, forkFunction,
  packageBlock, setPaintLayer, transitionLegacyPolicy, writeRemixDraft, type RemixOperation } from '../src/core/remix.ts';
import { admitRemixDocument, migrateV5ToV6, type RemixDocument } from '../src/core/remix-schema.ts';
import { minimalDocument, OBJECT_IDS, assetId } from './fixtures/documents.ts';
function document(): RemixDocument { const result = migrateV5ToV6(minimalDocument()); assert.ok(result.ok); return result.value; }
function apply(doc: RemixDocument, operation: RemixOperation, target: 'photo' | 'brush' = 'photo'): RemixDocument {
  const result = applyRemixOperation(doc, { expected: doc.remix.checkpoint.appliedRevision, target, operation });
  assert.equal(result.kind, 'applied', result.kind === 'refused' ? result.reason : 'unchanged');
  assert.ok(result.kind === 'applied'); return result.doc;
}
const at = { kind: 'function', instance: 'photo-grain', node: 'remap' } as const;
function currentBlock(doc: RemixDocument, id = 'photo-grain') { const instance = doc.remix.instances.find(value => value.id === id); assert.ok(instance);
  const block = doc.remix.blocks.find(value => mathRefKey(value) === mathRefKey(instance.block)); assert.ok(block); return block; }

test('rack actions work on both targets, preserve target order and reject stale revisions', () => {
  let doc = document();
  for (const target of ['photo', 'brush'] as const) {
    const ref = target === 'photo' ? { id: 'authored-contrast', revision: 1 } : { id: 'grain-texture', revision: 1 };
    doc = apply(doc, { kind: 'add', block: ref, index: 0 }, target);
    const instance = doc.remix.instances.find(value => value.target === target && value.block.id === ref.id); assert.ok(instance);
    const site = { kind: 'block', instance: instance.id } as const;
    doc = apply(doc, { kind: 'parameter', instance: instance.id, name: target === 'photo' ? 'strength' : 'grainSize', value: 2 }, target);
    doc = apply(doc, { kind: 'bypass', at: site, bypassed: true }, target);
    assert.equal(doc.remix.instances.find(value => value.id === instance.id)?.enabled, false);
    doc = apply(doc, { kind: 'bypass', at: site, bypassed: false }, target);
    if (target === 'photo') doc = apply(doc, { kind: 'reorder', at: site, index: 1 }, target);
    doc = apply(doc, { kind: 'replace', at: site, replacement: ref }, target);
    doc = apply(doc, { kind: 'remove', at: site }, target);
    assert.equal(doc.remix.instances.some(value => value.id === instance.id), false);
  }
  const result = applyRemixOperation(doc, { expected: 0, target: 'photo', operation: { kind: 'parameter', instance: 'photo-grain', name: 'amount', value: .9 } });
  assert.equal(result.kind, 'refused'); assert.equal(result.doc, doc);
});

test('channel replacement is one owned copy and leaves original pinned uses unchanged', () => {
  let doc = document(); doc = apply(doc, { kind: 'add', block: { id: 'authored-grain', revision: 1 }, index: 1 });
  const old = currentBlock(doc), before = JSON.stringify(doc);
  const result = applyRemixOperation(doc, { expected: doc.remix.checkpoint.appliedRevision, target: 'photo', operation: { kind: 'replace', at, replacement: { id: 'grain-threshold', revision: 1 } } });
  assert.equal(result.kind, 'applied'); assert.ok(result.kind === 'applied');
  assert.deepEqual(result.copied, { label: 'Your copy of Grain' });
  assert.equal(JSON.stringify(doc), before);
  const updated = currentBlock(result.doc);
  assert.equal(updated.nodes.filter(node => /^remap[012]$/.test(node.id) && node.function.id === 'grain-threshold').length, 3);
  assert.deepEqual(result.doc.remix.blocks.find(block => mathRefKey(block) === mathRefKey(old)), old);
  assert.equal(result.doc.remix.instances.find(value => value.id !== 'photo-grain')?.block.id, 'authored-grain');
  const renamed = apply(result.doc, { kind: 'rename', instance: 'photo-grain', name: 'My texture' });
  assert.equal(currentBlock(renamed).name, 'My texture');
  const individual = applyRemixOperation(doc, { expected: doc.remix.checkpoint.appliedRevision, target: 'photo', operation: { kind: 'replace', at: { ...at, node: 'remap0' }, replacement: { id: 'grain-threshold', revision: 1 } } });
  assert.equal(individual.kind, 'refused'); assert.equal(individual.doc, doc);
});

test('incompatible insertion and replacement preserve exact work and use plain flow words', () => {
  const doc = document();
  for (const operation of [{ kind: 'replace', at, replacement: { id: 'grain-noise', revision: 1 } },
    { kind: 'insert', at: { instance: 'photo-grain', slot: 'after-remap' }, fn: { id: 'grain-noise', revision: 1 } }] satisfies RemixOperation[]) {
    const result = applyRemixOperation(doc, { expected: 0, target: 'photo', operation });
    assert.equal(result.kind, 'refused'); assert.equal(result.doc, doc); assert.ok(result.kind === 'refused');
    assert.match(result.reason, /amount/); assert.doesNotMatch(result.reason, /coverage|coord|srgb/);
  }
});

test('insert and reorder rewire executable unary chains; bypass restores the original pinned functions', () => {
  let doc = document(); doc = apply(doc, { kind: 'add', block: { id: 'grain-texture', revision: 1 }, index: 0 }, 'brush');
  const id = doc.remix.instances.find(value => value.target === 'brush')?.id; assert.ok(id);
  doc = apply(doc, { kind: 'insert', at: { instance: id, slot: 'after-remap' }, fn: { id: 'grain-threshold', revision: 1 } }, 'brush');
  let block = currentBlock(doc, id); const added = block.nodes.find(node => node.id.startsWith('insert_')); assert.ok(added);
  const remapIndex = block.nodes.findIndex(node => node.id === 'remap');
  doc = apply(doc, { kind: 'reorder', at: { kind: 'function', instance: id, node: added.id }, index: remapIndex }, 'brush');
  block = currentBlock(doc, id);
  assert.deepEqual(block.nodes.find(node => node.id === 'remap')?.args, [{ kind: 'node', node: added.id }]);
  assert.deepEqual(block.output, { kind: 'node', node: 'remap' });
  assert.deepEqual(block.nodes.find(node => node.id === added.id)?.args, [{ kind: 'node', node: 'normalized' }]);
  const site = { kind: 'function', instance: id, node: added.id } as const;
  doc = apply(doc, { kind: 'bypass', at: site, bypassed: true }, 'brush');
  assert.equal(currentBlock(doc, id).nodes.find(node => node.id === added.id)?.function.id, 'bypass-coverage');
  doc = apply(doc, { kind: 'bypass', at: site, bypassed: false }, 'brush');
  assert.equal(currentBlock(doc, id).nodes.find(node => node.id === added.id)?.function.id, 'grain-threshold');
  doc = apply(doc, { kind: 'remove', at: site }, 'brush');
  assert.deepEqual(currentBlock(doc, id).nodes.find(node => node.id === 'remap')?.args, [{ kind: 'node', node: 'normalized' }]);
  const library = createMathLibrary(doc.remix.functions); assert.ok(library.ok); assert.ok(createMathBlock(currentBlock(doc, id), library.value).ok);
});

test('create, fork, borrow and package retain complete transitive pinned closure and swap one instance', () => {
  let doc = document();
  const leaf = createRemixFunction(doc, { expected: 0, name: 'Leaf', source: 'fn leaf(x: coverage) -> coverage { return x; }' }); assert.ok(leaf.ok); doc = leaf.value.doc;
  const middle = createRemixFunction(doc, { expected: doc.remix.checkpoint.appliedRevision, name: 'Middle', source: 'fn middle(x: coverage) -> coverage { return leaf(x); }', dependencies: [{ name: 'leaf', ref: leaf.value.ref }] }); assert.ok(middle.ok); doc = middle.value.doc;
  const outer = createRemixFunction(doc, { expected: doc.remix.checkpoint.appliedRevision, name: 'Outer', source: 'fn outer(x: coverage) -> coverage { return middle(x); }', dependencies: [{ name: 'middle', ref: middle.value.ref }] }); assert.ok(outer.ok); doc = outer.value.doc;
  doc = apply(doc, { kind: 'replace', at, replacement: outer.value.ref });
  const packaged = packageBlock(doc, { expected: doc.remix.checkpoint.appliedRevision, instance: 'photo-grain', name: 'Packaged' }); assert.ok(packaged.ok);
  assert.equal(currentBlock(packaged.value.doc).id, packaged.value.ref.id);
  for (const ref of [leaf.value.ref, middle.value.ref, outer.value.ref]) assert.ok(packaged.value.package.functions.some(fn => mathRefKey(fn) === mathRefKey(ref)));
  assert.ok(reopenMathBlock(packaged.value.package).ok);
  doc = apply(packaged.value.doc, { kind: 'add', block: { id: 'grain-texture', revision: 1 }, index: 0 }, 'brush');
  const brush = doc.remix.instances.find(value => value.target === 'brush'); assert.ok(brush);
  const borrowed = borrowFunction(doc, { expected: doc.remix.checkpoint.appliedRevision, from: packaged.value.ref, node: 'remap', into: { kind: 'function', instance: brush.id, node: 'remap' } });
  assert.ok(borrowed.kind === 'applied'); assert.deepEqual(currentBlock(borrowed.doc, brush.id).nodes.find(node => node.id === 'remap')?.function, outer.value.ref);
  const copied = forkFunction(doc, { expected: doc.remix.checkpoint.appliedRevision, from: outer.value.ref, name: 'Explicit copy' }); assert.ok(copied.ok);
  assert.notEqual(copied.value.ref.id, outer.value.ref.id);
  const block = forkBlock(doc, { expected: doc.remix.checkpoint.appliedRevision, from: packaged.value.ref, name: 'Other block' }); assert.ok(block.ok);
});

test('invalid drafts survive beside applied source; revisions advance independently', () => {
  const doc = document();
  const draft = writeRemixDraft(doc, { expected: 0, draft: { id: 'draft-1', base: { id: 'grain-remap', revision: 1 }, revision: 0, source: 'fn broken(', phase: 'invalid', diagnostics: [], site: at } });
  assert.ok(draft.ok); assert.deepEqual(draft.value.remix.checkpoint, { appliedRevision: 0, draftRevision: 1, checkpointRevision: 1 });
  assert.deepEqual(draft.value.remix.functions, doc.remix.functions);
  const applied = applyRemixSource(draft.value, { expected: 0, site: at, source: 'fn custom(x: coverage) -> coverage { return coverage(step(0.7,value(x))); }' });
  assert.ok(applied.kind === 'applied', applied.kind === 'refused' ? applied.reason : '');
  assert.deepEqual(applied.doc.remix.checkpoint, { appliedRevision: 1, draftRevision: 1, checkpointRevision: 2 });
  assert.equal(applied.doc.remix.drafts[0]?.source, 'fn broken(');
  assert.ok(applied.copied);
  const bad = applyRemixSource(doc, { expected: 0, site: at, source: 'fn bad(x: coverage) -> coverage {\n return unknown(x);\n}' });
  assert.equal(bad.kind, 'refused'); assert.equal(bad.doc, doc); assert.ok(bad.kind === 'refused');
  assert.equal(bad.diagnostic.span.line, 2); assert.ok(bad.diagnostic.span.column > 1); assert.ok(bad.diagnostic.span.end > bad.diagnostic.span.start);
});

test('rack, graph, source, revision, draft and aggregate budgets refuse before replacing valid work', () => {
  let doc = document(); for (let index = 1; index < 8; index++) doc = apply(doc, { kind: 'add', block: { id: 'authored-contrast', revision: 1 }, index });
  const overflow = applyRemixOperation(doc, { expected: doc.remix.checkpoint.appliedRevision, target: 'photo', operation: { kind: 'add', block: { id: 'authored-contrast', revision: 1 }, index: 8 } });
  assert.equal(overflow.kind, 'refused'); assert.equal(overflow.doc, doc);
  const nodes = applyRemixOperation(document(), { expected: 0, target: 'photo', operation: { kind: 'insert', at: { instance: 'photo-grain', slot: 'after-remap' }, fn: { id: 'grain-threshold', revision: 1 } } });
  assert.equal(nodes.kind, 'refused'); // 14 + three channel nodes exceeds 16
  for (const source of [' '.repeat(4097), `fn big(x: coverage) -> coverage { return ${'coverage(value('.repeat(65)}x${'))'.repeat(65)}; }`,
    'fn big() -> scalar { return 100000.0; }', 'fn div(x: scalar[0,1]) -> scalar { return x / 2.0; }',
    'fn mixBad(x: scalar[0,1]) -> scalar { return mix(0.0,x,2.0); }']) {
    const result = createRemixFunction(document(), { expected: 0, name: 'Rejected', source }); assert.equal(result.ok, false, source.slice(0,90));
  }
  const base = document();
  const revisions = Array.from({ length: 65 }, (_, index) => ({ id: `fn-${index}`, revision: 1, libraryRevision: 1, source: 'fn identity(x: coverage) -> coverage { return x; }', dependencies: [] }));
  assert.equal(admitRemixDocument({ ...base, remix: { ...base.remix, functions: revisions } }).ok, false);
  assert.equal(writeRemixDraft(base, { expected: 0, draft: { id: 'big', base: null, revision: 0, source: ' '.repeat(16385), phase: 'invalid', diagnostics: [], site: null } }).ok, false);
  const drafts = Array.from({ length: 34 }, (_, index) => ({ id: `draft-${index}`, base: null, revision: 0, source: ' '.repeat(16000), phase: 'invalid', diagnostics: [], site: null }));
  assert.equal(admitRemixDocument({ ...base, remix: { ...base.remix, drafts } }).ok, false);
});

test('the separate legacy policy transition retains its readiness and checkpoint contract', () => {
  let doc = document();
  const blocked = transitionLegacyPolicy(doc, { expected: 0, depthReady: false, repairReady: true, rendererReady: true }); assert.equal(blocked.ok, false);
  const transitioned = transitionLegacyPolicy(doc, { expected: 0, depthReady: true, repairReady: true, rendererReady: true }); assert.ok(transitioned.ok); doc = transitioned.value;
  assert.equal(doc.remix.checkpoint.appliedRevision, 1); assert.equal(doc.policyTransition?.checkpoint, 1);
});

test('legacy paint admits captured planes and exact tile refs; overflow retains earlier work without policy changes', () => {
  const doc = document();
  const id = OBJECT_IDS[0]; assert.ok(id);
  const patch = { id: 'stroke-1', owner: id, order: 1, disparity: .2, brush: { id: 'grain-texture', revision: 1 }, seed: 4, size: { width: 256, height: 256 }, tiles: [{ x: 0, y: 0, rgba: { asset: assetId(14), encoding: 'rgba8-srgb-straight', size: { width: 256, height: 256 } } }] } as const;
  const layer = { id, name: 'Paint', hidden: false, opacity: 1, patches: [patch, { ...patch, id: 'stroke-2', order: 2, disparity: .8 }] };
  const painted = setPaintLayer(doc, { expected: 0, layer }); assert.ok(painted.ok);
  assert.equal(painted.value.compositing, 'legacy-order'); assert.equal(painted.value.policyTransition, null);
  assert.equal(painted.value.remix.checkpoint.appliedRevision, 1);
  assert.deepEqual(painted.value.paint.layers[0]?.patches.map(value => [value.order, value.disparity]), [[1,.2],[2,.8]]);
  const patches = Array.from({ length: 65 }, (_, index) => ({ ...patch, id: `stroke-${index}`, order: index }));
  assert.equal(setPaintLayer(painted.value, { expected: 1, layer: { ...layer, patches } }).ok, false);
  assert.equal(setPaintLayer(painted.value, { expected: 1, layer: { ...layer, patches: [{ ...patch, tiles: Array.from({ length: 65 }, (_, index) => ({ ...patch.tiles[0], x: index })) }] } }).ok, false);
  assert.equal(painted.value.paint.layers[0]?.patches.length, 2);
});

test('editing a bypassed group replaces its restore state instead of losing the edit later', () => {
  let doc = apply(document(), { kind: 'bypass', at, bypassed: true });
  doc = apply(doc, { kind: 'replace', at, replacement: { id: 'grain-curve', revision: 1 } });
  assert.equal(doc.remix.bypasses.length, 0);
  const result = applyRemixOperation(doc, { expected: doc.remix.checkpoint.appliedRevision, target: 'photo', operation: { kind: 'bypass', at, bypassed: false } });
  assert.equal(result.kind, 'unchanged'); assert.equal(currentBlock(doc).nodes.find(node => node.id === 'remap0')?.function.id, 'grain-curve');
});

test('bounded color function insertion and bypass preserve the admitted input domain', () => {
  const created = createRemixFunction(document(), { expected: 0, name: 'Color identity', source: 'fn colorIdentity(x: srgb[0,1]) -> srgb { return x; }' }); assert.ok(created.ok);
  let doc = apply(created.value.doc, { kind: 'insert', at: { instance: 'photo-grain', slot: 'after-color' }, fn: created.value.ref });
  const node = currentBlock(doc).nodes.find(value => value.id.startsWith('insert_')); assert.ok(node);
  doc = apply(doc, { kind: 'bypass', at: { kind: 'function', instance: 'photo-grain', node: node.id }, bypassed: true });
  assert.ok(admitRemixDocument(doc).ok);
});
