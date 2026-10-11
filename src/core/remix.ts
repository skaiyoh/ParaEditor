// Pure recipe actions. Admission finishes before any candidate replaces work.
import { sameValue } from './equal.ts';
import { mathFunctionClosure, mathRefKey, MATH_PRESET_FUNCTIONS, type MathFunctionSource, type MathRef } from './math-definition.ts';
import { location, mathAttempt, MATH_LIBRARY_REVISION, refuse, unwrapMath, type MathDiagnostic, type MathResult, type MathType } from './math-expression.ts';
import { createMathBlock, resolveMathParameters, type MathBinding, type MathBlockSource } from './math-graph.ts';
import { admitRemixDocument, admitRemixLibrary, blockTargetReason, migrateV5ToV6, REMIX_BUILTIN_BLOCKS, serializeRemixDocument,
  type FunctionDraft, type MathCheckpoint, type PaintLayer, type RemixDocument, type RemixInstance, type RemixOwnership, type RemixReadDocument, type RemixTarget, type Site } from './remix-schema.ts';
import { COMPOSITION_LIMITS } from './composition-ranges.ts';
import type { CompositionDocument } from './types.ts';

export type RemixOperation =
  | { readonly kind: 'add'; readonly block: MathRef; readonly index: number }
  | { readonly kind: 'replace'; readonly at: Site; readonly replacement: MathRef }
  | { readonly kind: 'insert'; readonly at: { readonly instance: string; readonly slot: string }; readonly fn: MathRef }
  | { readonly kind: 'reorder'; readonly at: Site; readonly index: number }
  | { readonly kind: 'bypass'; readonly at: Site; readonly bypassed: boolean }
  | { readonly kind: 'remove'; readonly at: Site }
  | { readonly kind: 'parameter'; readonly instance: string; readonly name: string; readonly value: number }
  | { readonly kind: 'rename'; readonly instance: string; readonly name: string };
export type RemixOperationInput = { readonly expected: number; readonly target: RemixTarget; readonly operation: RemixOperation };
export type RemixResult =
  | { readonly kind: 'applied'; readonly doc: RemixDocument; readonly copied: { readonly label: string } | null }
  | { readonly kind: 'unchanged'; readonly doc: RemixDocument | RemixReadDocument | CompositionDocument; readonly copied: null }
  | { readonly kind: 'refused'; readonly doc: RemixDocument | RemixReadDocument | CompositionDocument; readonly copied: null; readonly reason: string; readonly diagnostic: MathDiagnostic };
export type RemixParameterGesture = { readonly kind: 'remix-parameter'; readonly target: RemixTarget; readonly instance: string; readonly name: string; readonly value: number };
export type RemixNodeGroup = { readonly id: string; readonly nodes: readonly MathBlockSource['nodes'][number][]; readonly channels: number };
export type RemixInsertionSlot = { readonly id: string; readonly after: string; readonly required: MathType; readonly bindings: readonly MathBinding[] };

const BUILTIN_LABELS: Readonly<Record<string, string>> = { 'grain-cells': 'Cells', 'grain-noise': 'Seeded noise', 'grain-remap': 'Identity',
  'grain-curve': 'Curve', 'grain-threshold': 'Threshold', 'grain-color': 'Grain color', 'photo-contrast': 'Contrast',
  'texture-coverage': 'Texture coverage', 'coverage-noise': 'Signed noise' };
export function isBuiltIn(doc: Pick<RemixDocument, 'remix'>, ref: MathRef): boolean {
  const fn = doc.remix.functions.find(value => mathRefKey(value) === mathRefKey(ref));
  const block = doc.remix.blocks.find(value => mathRefKey(value) === mathRefKey(ref));
  return (fn !== undefined && MATH_PRESET_FUNCTIONS.some(value => sameValue(value, fn))) ||
    (block !== undefined && REMIX_BUILTIN_BLOCKS.some(value => sameValue(value, block)));
}
export function displayLabel(doc: Pick<RemixDocument, 'remix'>, ref: MathRef): string {
  const ownership = doc.remix.ownership.find(value => mathRefKey(value.ref) === mathRefKey(ref));
  if (ownership) return ownership.label;
  const block = doc.remix.blocks.find(value => mathRefKey(value) === mathRefKey(ref));
  if (block) return block.name;
  if (isBuiltIn(doc, ref)) return BUILTIN_LABELS[ref.id] ?? ref.id;
  const library = admitRemixLibrary(doc.remix.functions);
  return library.ok ? library.value.get(ref)?.parsed.name ?? ref.id : ref.id;
}
export function remixBlock(doc: Pick<RemixDocument, 'remix'>, ref: MathRef): MathBlockSource {
  const block = doc.remix.blocks.find(value => mathRefKey(value) === mathRefKey(ref));
  if (!block) refuse('missing', 'The pinned block revision is missing.', location(mathRefKey(ref)));
  return block;
}
export function remixInstance(doc: Pick<RemixDocument, 'remix'>, id: string): RemixInstance {
  const instance = doc.remix.instances.find(value => value.id === id);
  if (!instance) refuse('missing', 'This rack instance no longer exists.', location(id));
  return instance;
}

/** Every complete three-channel family is one site; channel IDs never leak as editable sites. */
export function remixNodeGroups(block: MathBlockSource): readonly RemixNodeGroup[] {
  const seen = new Set<string>(), groups: RemixNodeGroup[] = [];
  for (const node of block.nodes) {
    if (seen.has(node.id)) continue;
    const prefix = /^(.*)[012]$/.exec(node.id)?.[1];
    const family = prefix ? [0, 1, 2].map(channel => block.nodes.find(value => value.id === `${prefix}${channel}`)) : [];
    const complete = family.filter(value => value !== undefined);
    if (complete.length === 3 && complete.every(value => mathRefKey(value.function) === mathRefKey(node.function))) {
      groups.push({ id: prefix ?? node.id, nodes: complete, channels: 3 }); complete.forEach(value => seen.add(value.id));
    } else { groups.push({ id: node.id, nodes: [node], channels: 1 }); seen.add(node.id); }
  }
  return groups;
}
function findGroup(block: MathBlockSource, id: string): RemixNodeGroup {
  const group = remixNodeGroups(block).find(value => value.id === id);
  if (!group) refuse('missing', 'Choose the whole channel group; individual channels are not editable here.', location(`block:${mathRefKey(block)}`));
  return group;
}
export function remixInsertionSlots(doc: Pick<RemixDocument, 'remix'>, instanceId: string): readonly RemixInsertionSlot[] {
  const instance = remixInstance(doc, instanceId), block = remixBlock(doc, instance.block), library = unwrapMath(admitRemixLibrary(doc.remix.functions));
  return remixNodeGroups(block).flatMap(group => {
    const node = group.nodes[0], fn = node && library.get(node.function);
    if (!fn) return [];
    return [{ id: `after-${group.id}`, after: group.id, required: fn.signature.output,
      bindings: group.nodes.map(value => ({ kind: 'node', node: value.id } satisfies MathBinding)) }];
  });
}
const refOf = (source: MathRef): MathRef => ({ id: source.id, revision: source.revision });
function nextId(prefix: string, taken: readonly string[]): string {
  let number = 1;
  while (taken.includes(`${prefix}-${number}`)) number++;
  return `${prefix}-${number}`;
}
function nextRevision(doc: RemixDocument, kind: 'block' | 'function', ref: MathRef): MathRef {
  const values = kind === 'block' ? doc.remix.blocks : doc.remix.functions;
  return { id: ref.id, revision: Math.max(...values.filter(value => value.id === ref.id).map(value => value.revision)) + 1 };
}
function checkedIndex(index: number, length: number): void {
  if (!Number.isInteger(index) || index < 0 || index > length) refuse('value', 'Choose an existing position in this rack or chain.', location('position'));
}
function checkExpected(doc: RemixDocument, expected: number): void {
  if (expected !== doc.remix.checkpoint.appliedRevision) refuse('revision', 'This recipe changed. Use its current applied revision.', location('checkpoint'));
}
function advance(checkpoint: MathCheckpoint, applied: boolean, draft = false): MathCheckpoint {
  return { appliedRevision: checkpoint.appliedRevision + Number(applied), draftRevision: checkpoint.draftRevision + Number(draft), checkpointRevision: checkpoint.checkpointRevision + 1 };
}
function admitted(doc: RemixDocument, applied = true, draft = false): RemixDocument {
  return unwrapMath(admitRemixDocument({ ...doc, remix: { ...doc.remix, checkpoint: advance(doc.remix.checkpoint, applied, draft) } }));
}
function withInstance(doc: RemixDocument, instance: RemixInstance): RemixDocument {
  return { ...doc, remix: { ...doc.remix, instances: doc.remix.instances.map(value => value.id === instance.id ? instance : value) } };
}
function defaults(block: MathBlockSource): Readonly<Record<string, number>> { return Object.fromEntries(block.parameters.map(value => [value.name, value.default])); }
function ownedBlock(doc: RemixDocument, instance: RemixInstance): { readonly ref: MathRef; readonly label: string; readonly copied: boolean } {
  const owner = doc.remix.ownership.find(value => value.kind === 'block' && mathRefKey(value.ref) === mathRefKey(instance.block));
  const shared = doc.remix.instances.some(value => value.id !== instance.id && mathRefKey(value.block) === mathRefKey(instance.block));
  if (!isBuiltIn(doc, instance.block) && owner?.owner === instance.id && !shared) return { ref: nextRevision(doc, 'block', instance.block), label: owner.label, copied: false };
  return { ref: { id: nextId('your-block', doc.remix.blocks.map(value => value.id)), revision: 1 }, label: `Your copy of ${displayLabel(doc, instance.block)}`.slice(0, 80), copied: true };
}
function saveBlock(doc: RemixDocument, instance: RemixInstance, block: MathBlockSource, label: string): RemixDocument {
  const library = unwrapMath(admitRemixLibrary(doc.remix.functions)); unwrapMath(createMathBlock(block, library));
  const owner: RemixOwnership = { kind: 'block', ref: refOf(block), owner: instance.id, label };
  return withInstance({ ...doc, remix: { ...doc.remix, blocks: [...doc.remix.blocks, block], ownership: [...doc.remix.ownership, owner] } }, { ...instance, block: refOf(block) });
}
function replacementSource(doc: RemixDocument, block: MathBlockSource, group: RemixNodeGroup, ref: MathRef): MathBlockSource {
  const library = unwrapMath(admitRemixLibrary(doc.remix.functions)), replacement = library.get(ref), first = group.nodes[0], current = first && library.get(first.function);
  if (!replacement || !current) refuse('missing', 'The pinned function revision is missing.', location(mathRefKey(ref)));
  if (!sameValue(current.signature, replacement.signature)) refuse('type', `This position needs ${flowWords(current.signature.inputs, current.signature.output)}; this function supplies ${flowWords(replacement.signature.inputs, replacement.signature.output)}.`, location(mathRefKey(ref)));
  return { ...block, nodes: block.nodes.map(node => group.nodes.some(value => value.id === node.id) ? { ...node, function: ref } : node) };
}
export const TYPE_WORDS: Readonly<Record<MathType, string>> = { coord: 'position', cell: 'position', noise: 'noise', coverage: 'amount', srgb: 'color', linear: 'color', oklab: 'color', scalar: 'number', bool: 'yes or no', vec2: 'pair', vec3: 'triple', pressure: 'pressure', seed: 'seed', time: 'time', hold: 'frame' };
export function typeWord(type: MathType): string { return TYPE_WORDS[type]; }
export function flowWords(inputs: readonly MathType[], output: MathType): string { return `${[...new Set(inputs.map(typeWord))].join(', ')} → ${typeWord(output)}`; }
function plainDiagnostic(error: MathDiagnostic): MathDiagnostic {
  let message = error.message;
  for (const [type, word] of Object.entries(TYPE_WORDS)) message = message.replace(new RegExp(`\\b${type}\\b`, 'g'), word);
  return { ...error, message };
}
function mapBindings(block: MathBlockSource, transform: (binding: MathBinding) => MathBinding): MathBlockSource {
  return { ...block, nodes: block.nodes.map(node => ({ ...node, args: node.args.map(transform) })), output: transform(block.output) };
}
function removeGroup(doc: RemixDocument, block: MathBlockSource, group: RemixNodeGroup): MathBlockSource {
  const library = unwrapMath(admitRemixLibrary(doc.remix.functions)), bindings = new Map<string, MathBinding>();
  for (const node of group.nodes) {
    const fn = library.get(node.function), input = node.args[0];
    if (!fn || !input || fn.signature.inputs.length !== 1 || fn.signature.inputs[0] !== fn.signature.output) refuse('type', 'Only a function that keeps the same input and output flow can be removed or bypassed.', location(node.id));
    bindings.set(node.id, input);
  }
  return mapBindings({ ...block, nodes: block.nodes.filter(node => !bindings.has(node.id)) }, binding => binding.kind === 'node' ? bindings.get(binding.node) ?? binding : binding);
}
function reorderGroup(doc: RemixDocument, block: MathBlockSource, group: RemixNodeGroup, index: number): MathBlockSource {
  const groups = [...remixNodeGroups(block)], from = groups.findIndex(value => value.id === group.id);
  checkedIndex(index, groups.length - 1);
  if (index === from) return block;
  const library = unwrapMath(admitRemixLibrary(doc.remix.functions)), low = Math.min(index, from), high = Math.max(index, from), chain = groups.slice(low, high + 1);
  const first = chain[0], last = chain.at(-1);
  if (!first || !last) refuse('value', 'Choose a position in this chain.', location(group.id));
  for (const part of chain) for (const [channel, node] of part.nodes.entries()) {
    const fn = library.get(node.function);
    if (part.channels !== group.channels || !fn || fn.signature.inputs.length !== 1 || fn.signature.inputs[0] !== fn.signature.output) refuse('type', 'These functions cannot be reordered because their position, noise, amount or color flow differs.', location(node.id));
    const previous = chain[chain.indexOf(part) - 1]?.nodes[channel];
    if (previous && (node.args[0]?.kind !== 'node' || node.args[0].node !== previous.id)) refuse('type', 'Only directly connected chain functions can be reordered.', location(node.id));
  }
  const ordered = [...chain]; ordered.splice(from - low, 1); ordered.splice(index - low, 0, group);
  const rewired = new Map<string, readonly MathBinding[]>(), outside = new Map<string, string>();
  for (let channel = 0; channel < group.channels; channel++) {
    const entry = first.nodes[channel]?.args[0], oldLast = last.nodes[channel], newLast = ordered.at(-1)?.nodes[channel];
    if (!entry || !oldLast || !newLast) refuse('value', 'The channel group is incomplete.', location(group.id));
    for (const [position, part] of ordered.entries()) {
      const node = part.nodes[channel], previous = ordered[position - 1]?.nodes[channel];
      if (node) rewired.set(node.id, [previous ? { kind: 'node', node: previous.id } : entry]);
    }
    outside.set(oldLast.id, newLast.id);
  }
  const transform = (binding: MathBinding): MathBinding => binding.kind === 'node' && outside.has(binding.node) ? { kind: 'node', node: outside.get(binding.node) ?? binding.node } : binding;
  const groupIds = new Set(chain.flatMap(value => value.nodes.map(node => node.id)));
  const nodes = groups.flatMap((value, at) => at === low ? ordered.flatMap(part => part.nodes) : at > low && at <= high ? [] : value.nodes)
    .map(node => ({ ...node, args: rewired.get(node.id) ?? (groupIds.has(node.id) ? node.args : node.args.map(transform)) }));
  return { ...block, nodes, output: transform(block.output) };
}

export function applyRemixOperation(document: RemixDocument | RemixReadDocument | CompositionDocument, input: RemixOperationInput): RemixResult {
  const result = mathAttempt(() => {
    let doc = document.version === 5 ? unwrapMath(migrateV5ToV6(document)) : serializeRemixDocument(document);
    checkExpected(doc, input.expected);
    const operation = input.operation;
    let copied: { readonly label: string } | null = null;
    if (operation.kind === 'add') {
      const block = remixBlock(doc, operation.block), reason = blockTargetReason(block, input.target);
      if (reason) refuse('context', reason, location(mathRefKey(block)));
      const rack = doc.remix.instances.filter(value => value.target === input.target); checkedIndex(operation.index, rack.length);
      const instance: RemixInstance = { id: nextId('instance', doc.remix.instances.map(value => value.id)), target: input.target, block: refOf(block), enabled: true, parameters: defaults(block) };
      rack.splice(operation.index, 0, instance);
      doc = { ...doc, remix: { ...doc.remix, instances: [...doc.remix.instances.filter(value => value.target !== input.target), ...rack] } };
    } else {
      const id = 'instance' in operation ? operation.instance : operation.at.instance;
      const instance = remixInstance(doc, id);
      if (instance.target !== input.target) refuse('context', 'This instance belongs to the other rack.', location(id));
      const block = remixBlock(doc, instance.block);
      if (operation.kind === 'parameter') {
        const library = unwrapMath(admitRemixLibrary(doc.remix.functions));
        const parameters = { ...instance.parameters, [operation.name]: operation.value };
        unwrapMath(resolveMathParameters(unwrapMath(createMathBlock(block, library)), parameters));
        doc = withInstance(doc, { ...instance, parameters });
      } else if (operation.kind === 'rename') {
        const owner = doc.remix.ownership.find(value => value.kind === 'block' && mathRefKey(value.ref) === mathRefKey(block));
        if (!owner || isBuiltIn(doc, block)) refuse('value', 'Only your owned blocks can be renamed.', location(id));
        const name = operation.name.trim(); if (!name || name.length > 80) refuse('value', 'Enter a block name of 1 to 80 characters.', location(id));
        const owned = ownedBlock(doc, instance); doc = saveBlock(doc, instance, { ...block, ...owned.ref, name }, name);
        copied = owned.copied ? { label: owned.label } : null;
      } else if (operation.kind !== 'insert' && operation.at.kind === 'block') {
        const rack = doc.remix.instances.filter(value => value.target === input.target), index = rack.findIndex(value => value.id === id);
        switch (operation.kind) {
          case 'replace': {
            const replacement = remixBlock(doc, operation.replacement), reason = blockTargetReason(replacement, input.target);
            if (reason) refuse('type', reason, location(mathRefKey(replacement)));
            rack[index] = { ...instance, block: refOf(replacement), parameters: defaults(replacement) }; break;
          }
          case 'reorder': checkedIndex(operation.index, rack.length - 1); rack.splice(index, 1); rack.splice(operation.index, 0, instance); break;
          case 'bypass': rack[index] = { ...instance, enabled: !operation.bypassed }; break;
          case 'remove': rack.splice(index, 1); break;
          default: { const exhaustive: never = operation; return exhaustive; }
        }
        doc = { ...doc, remix: { ...doc.remix, instances: [...doc.remix.instances.filter(value => value.target !== input.target), ...rack],
          grainInstance: operation.kind === 'remove' && doc.remix.grainInstance === id ? null : doc.remix.grainInstance,
          bypasses: operation.kind === 'remove' || operation.kind === 'replace' ? doc.remix.bypasses.filter(value => value.instance !== id) : doc.remix.bypasses } };
      } else {
        const owned = ownedBlock(doc, instance); let changed = block;
        if (operation.kind === 'insert') {
          const slot = remixInsertionSlots(doc, id).find(value => value.id === operation.at.slot), library = unwrapMath(admitRemixLibrary(doc.remix.functions));
          const fn = library.get(operation.fn);
          if (!slot) refuse('missing', 'This insertion position no longer exists.', location(operation.at.slot));
          if (!fn) refuse('missing', 'The pinned function revision is missing.', location(mathRefKey(operation.fn)));
          if (fn.signature.inputs.length !== 1 || fn.signature.inputs[0] !== slot.required || fn.signature.output !== slot.required)
            refuse('type', `This insertion needs ${flowWords([slot.required], slot.required)}.`, location(mathRefKey(operation.fn)));
          const prefix = nextId('insert', block.nodes.map(value => value.id.replace(/[012]$/, '').replaceAll('_', '-'))).replaceAll('-', '_');
          const added = slot.bindings.map((binding, channel) => ({ id: `${prefix}${slot.bindings.length === 1 ? '' : channel}`, function: operation.fn, args: [binding] }));
          const replacements = new Map(slot.bindings.flatMap((binding, index) => binding.kind === 'node' && added[index] ? [[binding.node, added[index].id] as const] : []));
          const mapped = mapBindings(block, binding => binding.kind === 'node' && replacements.has(binding.node) ? { kind: 'node', node: replacements.get(binding.node) ?? binding.node } : binding);
          const after = findGroup(block, slot.after), end = Math.max(...after.nodes.map(node => block.nodes.indexOf(node))) + 1;
          changed = { ...mapped, nodes: [...mapped.nodes.slice(0, end), ...added, ...mapped.nodes.slice(end)] };
        } else {
          const group = findGroup(block, operation.at.kind === 'function' ? operation.at.node : '');
          switch (operation.kind) {
            case 'replace':
              changed = replacementSource(doc, block, group, operation.replacement);
              doc = { ...doc, remix: { ...doc.remix, bypasses: doc.remix.bypasses.filter(value => value.instance !== id || value.node !== group.id) } }; break;
            case 'remove':
              changed = removeGroup(doc, block, group);
              doc = { ...doc, remix: { ...doc.remix, bypasses: doc.remix.bypasses.filter(value => value.instance !== id || value.node !== group.id) } }; break;
            case 'reorder': changed = reorderGroup(doc, block, group, operation.index); break;
            case 'bypass': {
              const saved = doc.remix.bypasses.find(value => value.instance === id && value.node === group.id);
              if (operation.bypassed === (saved !== undefined)) break;
              if (!operation.bypassed && saved) {
                changed = { ...block, nodes: block.nodes.map(node => ({ ...node, function: saved.functions.find(value => value.node === node.id)?.ref ?? node.function })) };
                doc = { ...doc, remix: { ...doc.remix, bypasses: doc.remix.bypasses.filter(value => value !== saved) } };
              } else {
                removeGroup(doc, block, group); // verifies a bypass has the same flow
                const library = unwrapMath(admitRemixLibrary(doc.remix.functions)), first = group.nodes[0], fn = first && library.get(first.function);
                if (!fn) refuse('missing', 'The function revision is missing.', location(group.id));
                const domain = fn.parsed.inputs[0]?.range;
                const bounds = domain && domain.length > 0 ? `[${Math.min(...domain.map(value => value.min))},${Math.max(...domain.map(value => value.max))}]` : '';
                const bypassText = `fn bypass(x: ${fn.signature.output}${bounds}) -> ${fn.signature.output} { return x; }`;
                const existing = doc.remix.functions.find(value => value.source === bypassText && value.dependencies.length === 0);
                const bypassId = existing?.id ?? (doc.remix.functions.some(value => value.id === `bypass-${fn.signature.output}`)
                  ? nextId(`bypass-${fn.signature.output}`, doc.remix.functions.map(value => value.id)) : `bypass-${fn.signature.output}`);
                const source: MathFunctionSource = { id: bypassId, revision: 1, libraryRevision: MATH_LIBRARY_REVISION, dependencies: [], source: bypassText };
                if (existing && !sameValue(existing, source)) refuse('revision', 'The bypass function identity is already in use.', location(bypassId));
                doc = { ...doc, remix: { ...doc.remix, functions: existing ? doc.remix.functions : [...doc.remix.functions, source],
                  bypasses: [...doc.remix.bypasses, { instance: id, node: group.id, functions: group.nodes.map(node => ({ node: node.id, ref: node.function })) }] } };
                changed = replacementSource(doc, block, group, refOf(source));
              }
              break;
            }
            default: { const exhaustive: never = operation; return exhaustive; }
          }
        }
        if (!sameValue(changed, block)) { doc = saveBlock(doc, instance, { ...changed, ...owned.ref, name: owned.label }, owned.label); copied = owned.copied ? { label: owned.label } : null; }
      }
    }
    const original = document.version === 5 ? null : serializeRemixDocument(document);
    return original && sameValue(original, doc) ? { kind: 'unchanged', doc: document, copied: null } as const : { kind: 'applied', doc: admitted(doc), copied } as const;
  });
  if (result.ok) return result.value;
  const diagnostic = plainDiagnostic(result.error);
  return { kind: 'refused', doc: document, copied: null, reason: diagnostic.message, diagnostic };
}

/** Drafts checkpoint independently and never enter an executable library. */
export function writeRemixDraft(doc: RemixDocument, input: { readonly expected: number; readonly draft: FunctionDraft }): MathResult<RemixDocument> {
  return mathAttempt(() => {
    if (input.expected !== doc.remix.checkpoint.draftRevision) refuse('revision', 'This draft changed. Use its current draft revision.', location(input.draft.id));
    const draft = { ...input.draft, revision: input.expected + 1 };
    return admitted({ ...doc, remix: { ...doc.remix, drafts: [...doc.remix.drafts.filter(value => value.id !== draft.id), draft] } }, false, true);
  });
}
export function createRemixFunction(doc: RemixDocument, input: { readonly expected: number; readonly name: string; readonly source: string; readonly dependencies?: MathFunctionSource['dependencies'] }): MathResult<{ readonly doc: RemixDocument; readonly ref: MathRef }> {
  return mathAttempt(() => {
    checkExpected(doc, input.expected);
    const source: MathFunctionSource = { id: nextId('your-function', doc.remix.functions.map(value => value.id)), revision: 1,
      libraryRevision: MATH_LIBRARY_REVISION, source: input.source, dependencies: input.dependencies ?? [] };
    const ref = refOf(source);
    unwrapMath(admitRemixLibrary([...doc.remix.functions, source]));
    return { ref, doc: admitted({ ...doc, remix: { ...doc.remix, functions: [...doc.remix.functions, source], ownership: [...doc.remix.ownership,
      { kind: 'function', ref, owner: 'project', label: input.name }] } }) };
  });
}
export function forkFunction(doc: RemixDocument, input: { readonly expected: number; readonly from: MathRef; readonly name: string }): MathResult<{ readonly doc: RemixDocument; readonly ref: MathRef }> {
  return mathAttempt(() => {
    const library = unwrapMath(admitRemixLibrary(doc.remix.functions)), fn = library.get(input.from);
    if (!fn) refuse('missing', 'The function revision to copy is missing.', location(mathRefKey(input.from)));
    return unwrapMath(createRemixFunction(doc, { expected: input.expected, name: input.name, source: fn.source.source, dependencies: fn.source.dependencies }));
  });
}
export function forkBlock(doc: RemixDocument, input: { readonly expected: number; readonly from: MathRef; readonly name: string }): MathResult<{ readonly doc: RemixDocument; readonly ref: MathRef }> {
  return mathAttempt(() => {
    checkExpected(doc, input.expected); const source = remixBlock(doc, input.from);
    const block = { ...source, id: nextId('your-block', doc.remix.blocks.map(value => value.id)), revision: 1, name: input.name }, ref = refOf(block);
    const library = unwrapMath(admitRemixLibrary(doc.remix.functions)); unwrapMath(mathFunctionClosure(library, block.nodes.map(node => node.function)));
    return { ref, doc: admitted({ ...doc, remix: { ...doc.remix, blocks: [...doc.remix.blocks, block], ownership: [...doc.remix.ownership,
      { kind: 'block', ref, owner: 'project', label: input.name }] } }) };
  });
}
export function packageBlock(doc: RemixDocument, input: { readonly expected: number; readonly instance: string; readonly name: string }): MathResult<{
  readonly doc: RemixDocument; readonly ref: MathRef; readonly package: { readonly block: MathBlockSource; readonly functions: readonly MathFunctionSource[] };
}> {
  return mathAttempt(() => {
    checkExpected(doc, input.expected); const instance = remixInstance(doc, input.instance), original = remixBlock(doc, instance.block);
    const library = unwrapMath(admitRemixLibrary(doc.remix.functions)), functions = unwrapMath(mathFunctionClosure(library, original.nodes.map(node => node.function))).map(fn => fn.source);
    const block: MathBlockSource = { ...original, id: nextId('your-block', doc.remix.blocks.map(value => value.id)), revision: 1, name: input.name };
    return { doc: admitted(saveBlock(doc, instance, block, input.name)), ref: refOf(block), package: { block, functions } };
  });
}
export function borrowFunction(doc: RemixDocument, input: { readonly expected: number; readonly from: MathRef; readonly node: string; readonly into: Extract<Site, { kind: 'function' }> }): RemixResult {
  const found = mathAttempt(() => {
    const block = remixBlock(doc, input.from), group = findGroup(block, input.node), first = group.nodes[0];
    if (!first) refuse('missing', 'The function to borrow is missing.', location(input.node));
    const instance = remixInstance(doc, input.into.instance);
    return { target: instance.target, replacement: first.function };
  });
  if (!found.ok) return { kind: 'refused', doc, copied: null, reason: found.error.message, diagnostic: found.error };
  return applyRemixOperation(doc, { expected: input.expected, target: found.value.target, operation: { kind: 'replace', at: input.into, replacement: found.value.replacement } });
}

/** Pure source admission; the session must also pass its generation-bound GPU compile before committing. */
export function applyRemixSource(doc: RemixDocument, input: { readonly expected: number; readonly site: Extract<Site, { kind: 'function' }>; readonly source: string }): RemixResult {
  const result = mathAttempt(() => {
    checkExpected(doc, input.expected);
    const instance = remixInstance(doc, input.site.instance), block = remixBlock(doc, instance.block), group = findGroup(block, input.site.node), first = group.nodes[0];
    if (!first) refuse('missing', 'This function no longer exists.', location(input.site.node));
    const library = unwrapMath(admitRemixLibrary(doc.remix.functions)), base = library.get(first.function);
    if (!base) refuse('missing', 'The function revision is missing.', location(mathRefKey(first.function)));
    const owned = ownedBlock(doc, instance), owner = doc.remix.ownership.find(value => value.kind === 'function' && mathRefKey(value.ref) === mathRefKey(first.function));
    const externalUse = doc.remix.blocks.some(value => mathRefKey(value) !== mathRefKey(block) && value.nodes.some(node => mathRefKey(node.function) === mathRefKey(first.function)));
    const copyFunction = isBuiltIn(doc, first.function) || owner?.owner !== block.id || externalUse || owned.copied;
    const ref = copyFunction ? { id: nextId('your-function', doc.remix.functions.map(value => value.id)), revision: 1 } : nextRevision(doc, 'function', first.function);
    const label = copyFunction ? `Your copy of ${displayLabel(doc, first.function)}`.slice(0, 80) : displayLabel(doc, first.function);
    const next = { ...doc, remix: { ...doc.remix, bypasses: doc.remix.bypasses.filter(value => value.instance !== instance.id || value.node !== group.id), functions: [...doc.remix.functions, { ...base.source, ...ref, source: input.source }], ownership: [...doc.remix.ownership,
      { kind: 'function', ref, owner: owned.ref.id, label } satisfies RemixOwnership] } };
    const changed = replacementSource(next, block, group, ref), admittedBlock = unwrapMath(createMathBlock({ ...changed, ...owned.ref, name: owned.label }, unwrapMath(admitRemixLibrary(next.remix.functions))));
    return { kind: 'applied', doc: admitted(saveBlock(next, instance, admittedBlock.source, owned.label)), copied: copyFunction || owned.copied ? { label: owned.copied ? owned.label : label } : null } as const;
  });
  if (result.ok) return result.value;
  const diagnostic = plainDiagnostic(result.error); return { kind: 'refused', doc, copied: null, reason: diagnostic.message, diagnostic };
}

export function setPaintLayer(doc: RemixDocument, input: { readonly expected: number; readonly layer: PaintLayer }): MathResult<RemixDocument> {
  return mathAttempt(() => {
    checkExpected(doc, input.expected);
    const existing = doc.paint.layers.find(layer => layer.id === input.layer.id);
    if (!existing && doc.objects.length + doc.paint.layers.length >= COMPOSITION_LIMITS.createdLayers) refuse('budget', 'Create at most eight top-level layers in this editor.', location(input.layer.id));
    const layers = existing ? doc.paint.layers.map(layer => layer.id === input.layer.id ? input.layer : layer) : [...doc.paint.layers, input.layer];
    return admitted({ ...doc, paint: { ...doc.paint, layers } });
  });
}
export function transitionLegacyPolicy(doc: RemixDocument, input: { readonly expected: number; readonly depthReady: boolean; readonly repairReady: boolean; readonly rendererReady: boolean }): MathResult<RemixDocument> {
  return mathAttempt(() => {
    checkExpected(doc, input.expected);
    if (doc.compositing === 'scene-depth') return doc;
    if (!input.depthReady || !input.repairReady || !input.rendererReady) refuse('context', 'Depth, background repair and the depth renderer must be ready before enabling painting.', location('compositing'));
    return admitted({ ...doc, compositing: 'scene-depth', policyTransition: { from: 'legacy-order', to: 'scene-depth', checkpoint: doc.remix.checkpoint.checkpointRevision + 1 } });
  });
}
