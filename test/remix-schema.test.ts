import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectCompositionAssets } from '../src/core/asset-refs.ts';
import { admitRemixDocument, migrateV5ToV6, remixDocumentSchema, REMIX_LIMITS, withDerivedGrainStyle } from '../src/core/remix-schema.ts';
import { minimalDocument, assetId, OBJECT_IDS } from './fixtures/documents.ts';
function document() { const value = migrateV5ToV6(minimalDocument()); assert.ok(value.ok); return value.value; }

test('v6 raw shape roundtrips, excludes derived style, validates source closure and preserves v5 refinements', () => {
  const doc = document(); assert.deepEqual(remixDocumentSchema.parse(JSON.parse(JSON.stringify(doc))), doc);
  assert.equal(remixDocumentSchema.safeParse(withDerivedGrainStyle(doc)).success, false);
  for (const bad of [ { ...doc, remix: { ...doc.remix, functions: doc.remix.functions.filter(fn => fn.id !== 'grain-noise') } },
    { ...doc, style: { ...doc.style, paletteTargets: [{ cluster: 99, color: { l: .5,c:0,h:0 } }] } },
    { ...doc, remix: { ...doc.remix, instances: [...doc.remix.instances, ...doc.remix.instances] } },
    { ...doc, policyTransition: { from: 'legacy-order', to: 'scene-depth', checkpoint: 1 } },
    { ...doc, remix: { ...doc.remix, functions: [...doc.remix.functions, doc.remix.functions[0]] } } ]) assert.equal(admitRemixDocument(bad).ok, false);
});

test('patches retain owner/order/disparity and tile inventory; tile and global patch caps are enforced', () => {
  const doc = document(), id = OBJECT_IDS[0]; assert.ok(id);
  const patch = { id: 'patch-1', owner: id, order: 0, disparity: .3, brush: { id: 'grain-texture', revision: 1 }, seed: 3,
    size: { width: 256, height: 256 }, tiles: [{ x: 0, y: 0, rgba: { asset: assetId(14), encoding: 'rgba8-srgb-straight', size: { width: 256,height:256 } } }] } as const;
  const layer = { id, name:'Paint', hidden:false, opacity:1, patches: [patch, { ...patch, id:'patch-2', order:1, disparity:.8 }] };
  const raw = { ...doc, paint: { ...doc.paint,layers:[layer] } } as const;
  const parsed = remixDocumentSchema.parse(raw); const refs = collectCompositionAssets([{kind:'document',document:parsed}]); assert.ok(refs.ok);
  assert.equal(parsed.compositing, 'legacy-order'); assert.equal(parsed.policyTransition, null);
  assert.deepEqual(refs.value.get(assetId(14)), [{ asset:assetId(14),kind:'raster',format:'rgba8-srgb-straight',size:{width:256,height:256},byteLength:16+256*256*4 }]);
  assert.deepEqual(parsed.paint.layers[0]?.patches.map(value=>value.disparity), [.3,.8]);
  const patches = Array.from({length:64},(_,index)=>({...patch,id:`patch-${index}`,order:index}));
  assert.equal(remixDocumentSchema.safeParse({...raw,paint:{...raw.paint,layers:[{...layer,patches}]}}).success,true);
  assert.equal(remixDocumentSchema.safeParse({...raw,paint:{...raw.paint,layers:[{...layer,patches:[...patches,{...patch,id:'patch-65',order:65}]}]}}).success,false);
  for(const tiles of [[{...patch.tiles[0],x:1}], [patch.tiles[0],patch.tiles[0]], [{...patch.tiles[0],rgba:{...patch.tiles[0].rgba,size:{width:257,height:256}}}]]) {
    assert.equal(remixDocumentSchema.safeParse({...raw,paint:{...raw.paint,layers:[{...layer,patches:[{...patch,tiles}]}]}}).success,false);
  }
  for (const invalid of [{ ...patch, owner: OBJECT_IDS[1] }, { ...patch, disparity: -.01 }, { ...patch, disparity: 1.01 },
    { ...patch, disparity: Number.NaN }, { ...patch, id: '' }]) {
    assert.equal(remixDocumentSchema.safeParse({ ...raw, paint: { ...raw.paint, layers: [{ ...layer, patches: [invalid] }] } }).success, false);
  }
  for (const invalid of [[patch, { ...patch, order: 1 }], [patch, { ...patch, id: 'other' }]]) {
    assert.equal(remixDocumentSchema.safeParse({ ...raw, paint: { ...raw.paint, layers: [{ ...layer, patches: invalid }] } }).success, false);
  }
  assert.equal(REMIX_LIMITS.tiles,4096);
});

test('recoverable source has UTF-16 and checkpoint metadata but never enters executable definitions', () => {
  const doc = document(), source = '/* 🎨 */\nfn broken(';
  const draft = {id:'draft',base:{id:'grain-remap',revision:1},revision:1,source,phase:'invalid',site:{kind:'function',instance:'photo-grain',node:'remap'},
    diagnostics:[{kind:'syntax',message:'Incomplete function.',sourceId:'draft',path:null,span:{start:source.length,end:source.length,line:2,column:11}}]};
  const parsed = remixDocumentSchema.parse({...doc,remix:{...doc.remix,drafts:[draft],checkpoint:{appliedRevision:0,draftRevision:1,checkpointRevision:1}}});
  assert.deepEqual(parsed.remix.functions,doc.remix.functions); assert.equal(parsed.remix.drafts[0]?.source,source);
  assert.equal(remixDocumentSchema.safeParse({...parsed,remix:{...parsed.remix,checkpoint:{appliedRevision:0,draftRevision:0,checkpointRevision:0}}}).success,false);
});

test('derived Grain defaults match execution and dead Grain nodes are not bound controls', async () => {
  const { grainBinding } = await import('../src/core/remix-schema.ts');
  const doc = document(), instance = doc.remix.instances[0]; assert.ok(instance);
  const omitted = remixDocumentSchema.parse({ ...doc, remix: { ...doc.remix, instances: [{ ...instance, parameters: {} }] } });
  assert.equal(withDerivedGrainStyle(omitted).style.grain, .5);
  assert.equal(withDerivedGrainStyle(omitted).style.colorNoise, .3);
  const dead = remixDocumentSchema.parse({ ...doc, remix: { ...doc.remix, blocks: doc.remix.blocks.map(block => block.id === instance.block.id ? { ...block, output: { kind:'input',name:'color' } } : block) } });
  for (const control of ['grain','colorNoise','grainSize','grainHold'] as const) assert.equal(grainBinding(dead,control).kind,'unavailable');
  assert.equal(remixDocumentSchema.safeParse({ ...doc, remix: { ...doc.remix, bypasses: [{ instance:'missing',node:'missing',functions:[{node:'missing',ref:{id:'missing',revision:1}}] }] } }).success,false);
});

test('paint tiles use MRX2 exact clipped dimensions and active asset admission counts unique digests', () => {
  const doc = document(), id=OBJECT_IDS[0]; assert.ok(id);
  const patch = { id:'patch',owner:id,order:0,disparity:.5,brush:{id:'grain-texture',revision:1},seed:0,size:{width:256,height:256},
    tiles:[{x:0,y:0,rgba:{asset:assetId(14),encoding:'rgba8-srgb-straight',size:{width:1,height:1}}}] };
  const paint={...doc.paint,layers:[{id,name:'Paint',hidden:false,opacity:1,patches:[patch]}]};
  assert.equal(remixDocumentSchema.safeParse({...doc,paint}).success,false);
  const clipped={...patch,size:{width:1,height:1}};
  assert.equal(remixDocumentSchema.safeParse({...doc,paint:{...paint,layers:[{...paint.layers[0],patches:[clipped]}]}}).success,true);
});

test('active immutable paint assets and expanded expression costs are refused before admission', () => {
  const doc=document(), id=OBJECT_IDS[0]; assert.ok(id);
  function patches(count:number) { return Array.from({length:count},(_,patchIndex)=>({id:`patch-${patchIndex}`,owner:id,order:patchIndex,disparity:.5,
    brush:{id:'grain-texture',revision:1},seed:0,size:{width:2048,height:2048},tiles:Array.from({length:64},(_,index)=>({x:index%8,y:Math.floor(index/8),
      rgba:{asset:assetId(1000+patchIndex*64+index),encoding:'rgba8-srgb-straight',size:{width:256,height:256}}}))})); }
  const base={...doc,paint:{...doc.paint,layers:[{id,name:'Paint',hidden:false,opacity:1,patches:patches(3)}]}};
  assert.equal(admitRemixDocument(base).ok,true);
  const over=admitRemixDocument({...base,paint:{...base.paint,layers:[{...base.paint.layers[0],patches:patches(4)}]}});
  assert.ok(!over.ok); assert.match(over.error.message,/64 MiB/);
  const functions=Array.from({length:17},(_,index)=>({id:`cost-${index}`,revision:1,libraryRevision:1,
    source:index===0?'fn first(x: coverage) -> coverage { return x; }':'fn twice(x: coverage) -> coverage { return coverage(value(previous(x)) * value(previous(x))); }',
    dependencies:index===0?[]:[{name:'previous',ref:{id:`cost-${index-1}`,revision:1}}]}));
  const cost=admitRemixDocument({...doc,remix:{...doc.remix,functions:[...doc.remix.functions,...functions]}});
  assert.ok(!cost.ok); assert.match(cost.error.message,/65536/);
});
