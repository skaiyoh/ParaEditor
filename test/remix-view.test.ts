import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addableBlocks, allowedOperations, candidates, canUseInBrush, compatibility, displayLabel, functionSites, grainBinding,
  insertionSlots, isBuiltIn, parameters, withDerivedGrainStyle } from '../src/core/remix-view.ts';
import { applyRemixOperation, applyRemixSource } from '../src/core/remix.ts';
import { migrateV5ToV6, type RemixDocument } from '../src/core/remix-schema.ts';
import { minimalDocument } from './fixtures/documents.ts';
function doc(): RemixDocument { const result = migrateV5ToV6(minimalDocument()); assert.ok(result.ok); return result.value; }

test('labels, built-in flags and channel groups describe the exact applied revisions', () => {
  const source = doc(), sites = functionSites(source, 'photo-grain');
  assert.deepEqual(sites.map(value => [value.id, value.channels]), [['cells',1],['noise',3],['normalized',3],['remap',3],['signed',3],['color',1]]);
  for (const [id, label] of [['grain-cells','Cells'],['grain-noise','Seeded noise'],['grain-remap','Identity'],['grain-curve','Curve'],['grain-threshold','Threshold'],['grain-color','Grain color'],['photo-contrast','Contrast'],['texture-coverage','Texture coverage']]) {
    assert.ok(id); assert.equal(displayLabel(source, { id, revision: 1 }), label); assert.equal(isBuiltIn(source, { id, revision: 1 }), true);
  }
  const changed = applyRemixSource(source, { expected: 0, site: { kind: 'function', instance: 'photo-grain', node: 'remap' }, source: 'fn identity(x: coverage) -> coverage { return coverage(step(0.4,value(x))); }' });
  assert.ok(changed.kind === 'applied'); const instance = changed.doc.remix.instances[0]; assert.ok(instance);
  assert.equal(displayLabel(changed.doc, instance.block), 'Your copy of Grain'); assert.equal(isBuiltIn(changed.doc, instance.block), false);
  const remap = functionSites(changed.doc,'photo-grain').find(value => value.id === 'remap');
  assert.equal(remap?.label, 'Your copy of Identity'); assert.equal(remap?.builtIn, false);
});

test('candidate provenance, compatibility and insertion flow share the reducer rules', () => {
  const source = doc(), choices = candidates(source, { instance: 'photo-grain', at: { kind: 'node', node: 'remap' } });
  const identity = choices.find(value => value.ref.id === 'grain-remap'); assert.ok(identity);
  assert.equal(identity.origin, 'this-block'); assert.equal(identity.apply.kind, 'replace'); assert.equal(identity.available.kind, 'available');
  const contrast = choices.find(value => value.ref.id === 'photo-contrast'); assert.ok(contrast);
  assert.equal(contrast.origin, 'other-block'); assert.deepEqual(contrast.apply, { kind: 'borrow', from: { id: 'authored-contrast', revision: 1 }, node: 'contrast' });
  assert.equal(contrast.available.kind, 'unavailable');
  const result = compatibility(source, { instance: 'photo-grain', at: { kind: 'node', node: 'remap' }, candidate: { id: 'grain-noise', revision: 1 } });
  assert.ok(result.kind === 'unavailable'); assert.match(result.reason, /amount/); assert.doesNotMatch(result.reason, /coverage/);
  const slots = insertionSlots(source, 'photo-grain'); assert.equal(slots.find(value => value.id === 'after-remap')?.flow, 'amount → amount');
});

test('allowed actions, addable blocks and brush capability include local reasons', () => {
  const source = doc(); const actions = allowedOperations(source, { kind: 'block', instance: 'photo-grain' });
  assert.equal(actions.rename.kind, 'unavailable'); assert.equal(actions.moveUp.kind, 'unavailable'); assert.equal(actions.remove.kind, 'available');
  const node = allowedOperations(source, { kind: 'function', instance: 'photo-grain', node: 'cells' }); assert.equal(node.remove.kind, 'unavailable');
  const brush = addableBlocks(source, 'brush');
  assert.equal(brush.find(value => value.ref.id === 'grain-texture')?.available.kind, 'available');
  assert.equal(brush.find(value => value.ref.id === 'authored-grain')?.available.kind, 'unavailable');
  assert.equal(canUseInBrush(source, 'photo-grain').kind, 'available');
  const added = applyRemixOperation(source, { expected: 0, target: 'photo', operation: { kind: 'add', block: { id: 'authored-contrast', revision: 1 }, index: 1 } }); assert.ok(added.kind === 'applied');
  const contrast = added.doc.remix.instances.find(value => value.block.id === 'authored-contrast'); assert.ok(contrast);
  assert.equal(canUseInBrush(added.doc, contrast.id).kind, 'unavailable');
});

test('parameter gestures expose labels, ranges, step and integer flag with the owner', () => {
  const source = doc(), values = parameters(source, 'photo-grain');
  const size = values.find(value => value.name === 'grainSize'); assert.ok(size);
  assert.equal(size.label, 'Grain size'); assert.equal(size.min,1); assert.equal(size.max,4); assert.equal(size.step,1); assert.equal(size.integer,true);
  assert.deepEqual(size.gesture, { kind: 'remix-parameter', target: 'photo', instance: 'photo-grain', name: 'grainSize', value: source.remix.instances[0]?.parameters['grainSize'] });
  assert.equal(values.find(value => value.name === 'amount')?.integer, false);
  assert.equal(grainBinding(source, 'grain').kind, 'bound');
  assert.equal(withDerivedGrainStyle(source).style.grain, source.remix.instances[0]?.parameters['amount']);
  const removed = applyRemixOperation(source, { expected: 0, target: 'photo', operation: { kind: 'remove', at: { kind: 'block', instance: 'photo-grain' } } }); assert.ok(removed.kind === 'applied');
  assert.equal(grainBinding(removed.doc, 'grain').kind, 'unavailable');
});

test('an explicitly forked owned library block is renameable when added to a rack', async () => {
  const { forkBlock } = await import('../src/core/remix.ts');
  const copied = forkBlock(doc(), { expected:0,from:{id:'authored-contrast',revision:1},name:'My block' }); assert.ok(copied.ok);
  const added = applyRemixOperation(copied.value.doc, { expected:1,target:'photo',operation:{kind:'add',block:copied.value.ref,index:1} }); assert.ok(added.kind==='applied');
  const instance = added.doc.remix.instances.find(value=>value.block.id===copied.value.ref.id); assert.ok(instance);
  assert.equal(allowedOperations(added.doc,{kind:'block',instance:instance.id}).rename.kind,'available');
  const renamed=applyRemixOperation(added.doc,{expected:2,target:'photo',operation:{kind:'rename',instance:instance.id,name:'Renamed'}}); assert.ok(renamed.kind==='applied');
  const current=renamed.doc.remix.instances.find(value=>value.id===instance.id); assert.ok(current);
  assert.equal(displayLabel(renamed.doc,current.block),'Renamed');
});
