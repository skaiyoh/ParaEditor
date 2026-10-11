// Pure view queries use the reducer's actual admission path, not a second rule set.
import { createMathLibrary, mathRefKey, type MathRef } from './math-definition.ts';
import { mathAttempt, type MathType } from './math-expression.ts';
import { createMathBlock } from './math-graph.ts';
import { applyRemixOperation, displayLabel, flowWords, isBuiltIn, remixBlock, remixInstance, remixInsertionSlots, remixNodeGroups,
  type RemixOperation, type RemixParameterGesture } from './remix.ts';
import { type RemixDocument, type RemixTarget, type Site } from './remix-schema.ts';
export { grainBinding, withDerivedGrainStyle } from './remix-schema.ts';
export { displayLabel, isBuiltIn, flowWords, typeWord } from './remix.ts';
export type Availability = { readonly kind: 'available' } | { readonly kind: 'unavailable'; readonly reason: string };
export type CandidatePlace = { readonly kind: 'node'; readonly node: string } | { readonly kind: 'slot'; readonly slot: string };
export type RemixCandidate = { readonly ref: MathRef; readonly label: string; readonly builtIn: boolean;
  readonly origin: 'this-block' | 'other-block' | 'yours'; readonly available: Availability;
  readonly apply: { readonly kind: 'replace'; readonly replacement: MathRef } | { readonly kind: 'borrow'; readonly from: MathRef; readonly node: string } };
const unavailable = (reason: string): Availability => ({ kind: 'unavailable', reason });
const AVAILABLE: Availability = { kind: 'available' };

export function operationAvailability(doc: RemixDocument, target: RemixTarget, operation: RemixOperation): Availability {
  const result = applyRemixOperation(doc, { expected: doc.remix.checkpoint.appliedRevision, target, operation });
  return result.kind === 'refused' ? unavailable(result.reason) : AVAILABLE;
}
export function compatibility(doc: RemixDocument, input: { readonly instance: string; readonly at: CandidatePlace; readonly candidate: MathRef }): Availability {
  const instance = doc.remix.instances.find(value => value.id === input.instance);
  if (!instance) return unavailable('This rack instance no longer exists.');
  const operation: RemixOperation = input.at.kind === 'node'
    ? { kind: 'replace', at: { kind: 'function', instance: input.instance, node: input.at.node }, replacement: input.candidate }
    : { kind: 'insert', at: { instance: input.instance, slot: input.at.slot }, fn: input.candidate };
  return operationAvailability(doc, instance.target, operation);
}
export function candidates(doc: RemixDocument, input: { readonly instance: string; readonly at: CandidatePlace }): readonly RemixCandidate[] {
  const instance = doc.remix.instances.find(value => value.id === input.instance);
  const block = instance && doc.remix.blocks.find(value => mathRefKey(value) === mathRefKey(instance.block));
  if (!instance || !block) return [];
  return doc.remix.functions.map(fn => {
    const ref = { id: fn.id, revision: fn.revision };
    const own = doc.remix.ownership.some(value => value.kind === 'function' && mathRefKey(value.ref) === mathRefKey(ref));
    const here = remixNodeGroups(block).find(group => group.nodes.some(node => mathRefKey(node.function) === mathRefKey(ref)));
    const other = doc.remix.blocks.flatMap(source => mathRefKey(source) === mathRefKey(block) ? [] : remixNodeGroups(source).flatMap(group =>
      group.nodes.some(node => mathRefKey(node.function) === mathRefKey(ref)) ? [{ block: source, node: group.id }] : []))[0];
    return { ref, label: displayLabel(doc, ref), builtIn: isBuiltIn(doc, ref), origin: here ? 'this-block' : own ? 'yours' : 'other-block',
      apply: !here && !own && other ? { kind: 'borrow', from: { id: other.block.id, revision: other.block.revision }, node: other.node }
        : { kind: 'replace', replacement: ref }, available: compatibility(doc, { ...input, candidate: ref }) } satisfies RemixCandidate;
  });
}
export function insertionSlots(doc: RemixDocument, instance: string): readonly { readonly id: string; readonly after: string; readonly required: MathType; readonly flow: string; readonly available: Availability }[] {
  const result = mathAttempt(() => remixInsertionSlots(doc, instance));
  return result.ok ? result.value.map(slot => ({ id: slot.id, after: slot.after, required: slot.required,
    flow: flowWords([slot.required], slot.required), available: candidates(doc, { instance, at: { kind: 'slot', slot: slot.id } }).some(value => value.available.kind === 'available')
      ? AVAILABLE : unavailable('No available function fits this flow and the remaining recipe budget.') })) : [];
}
export function allowedOperations(doc: RemixDocument, at: Site): Readonly<Record<'replace' | 'moveUp' | 'moveDown' | 'bypass' | 'remove' | 'rename', Availability>> {
  const instance = doc.remix.instances.find(value => value.id === at.instance);
  const missing = unavailable('This rack instance no longer exists.');
  if (!instance) return { replace: missing, moveUp: missing, moveDown: missing, bypass: missing, remove: missing, rename: missing };
  const block = remixBlock(doc, instance.block), order = at.kind === 'block'
    ? doc.remix.instances.filter(value => value.target === instance.target).map(value => value.id) : remixNodeGroups(block).map(value => value.id);
  const index = order.indexOf(at.kind === 'block' ? at.instance : at.node);
  const check = (operation: RemixOperation) => operationAvailability(doc, instance.target, operation);
  const replacement = at.kind === 'block' ? instance.block : remixNodeGroups(block).find(group => group.id === at.node)?.nodes[0]?.function;
  return { replace: replacement ? check({ kind: 'replace', at, replacement }) : unavailable('Choose the whole channel group.'),
    moveUp: index > 0 ? check({ kind: 'reorder', at, index: index - 1 }) : unavailable('This is already the first item.'),
    moveDown: index >= 0 && index < order.length - 1 ? check({ kind: 'reorder', at, index: index + 1 }) : unavailable('This is already the last item.'),
    bypass: check({ kind: 'bypass', at, bypassed: true }), remove: check({ kind: 'remove', at }),
    rename: at.kind === 'block' ? check({ kind: 'rename', instance: at.instance, name: block.name }) : unavailable('Name the owned block instead.') };
}
export function addableBlocks(doc: RemixDocument, target: RemixTarget): readonly { readonly ref: MathRef; readonly label: string; readonly builtIn: boolean; readonly available: Availability }[] {
  const index = doc.remix.instances.filter(instance => instance.target === target).length;
  return doc.remix.blocks.map(block => { const ref = { id: block.id, revision: block.revision }; return { ref, label: displayLabel(doc, ref), builtIn: isBuiltIn(doc, ref),
    available: operationAvailability(doc, target, { kind: 'add', block: ref, index }) }; });
}
/** The photo Grain's normalized stage is a shareable texture, even though its block returns color. */
export function canUseInBrush(doc: RemixDocument, instanceId: string): Availability {
  const result = mathAttempt(() => {
    const instance = remixInstance(doc, instanceId), block = remixBlock(doc, instance.block);
    const library = createMathLibrary(doc.remix.functions); if (!library.ok) return unavailable(library.error.message);
    const admitted = createMathBlock(block, library.value); if (!admitted.ok) return unavailable(admitted.error.message);
    const availableContext = new Set(['position', 'seed', 'hold', 'pressure', 'time', 'coverage']);
    const hasCoverage = admitted.value.nodes.some(node => node.definition.signature.output === 'coverage' && (() => {
      const visited = new Set<string>();
      function dependsOnlyOnBrush(id: string): boolean {
        if (visited.has(id)) return true; visited.add(id);
        const source = block.nodes.find(value => value.id === id); if (!source) return false;
        return source.args.every(binding => binding.kind === 'input' ? availableContext.has(binding.name) : binding.kind === 'node' ? dependsOnlyOnBrush(binding.node) : true);
      }
      return dependsOnlyOnBrush(node.source.id);
    })());
    return hasCoverage ? AVAILABLE : unavailable('This block has no amount output that can run with brush inputs.');
  });
  return result.ok ? result.value : unavailable(result.error.message);
}
export function functionSites(doc: RemixDocument, instanceId: string): readonly { readonly id: string; readonly label: string; readonly builtIn: boolean; readonly channels: number; readonly flow: string; readonly operations: ReturnType<typeof allowedOperations> }[] {
  const instance = doc.remix.instances.find(value => value.id === instanceId); if (!instance) return [];
  const block = remixBlock(doc, instance.block), library = createMathLibrary(doc.remix.functions); if (!library.ok) return [];
  return remixNodeGroups(block).flatMap(group => { const node = group.nodes[0], fn = node && library.value.get(node.function); return node && fn ? [{
    id: group.id, label: displayLabel(doc, node.function), builtIn: isBuiltIn(doc, node.function), channels: group.channels,
    flow: flowWords(fn.signature.inputs, fn.signature.output), operations: allowedOperations(doc, { kind: 'function', instance: instanceId, node: group.id }) }] : []; });
}
const PARAMETER_LABELS: Readonly<Record<string, string>> = { amount: 'Grain', colorNoise: 'Color noise', grainSize: 'Grain size', grainHold: 'Grain hold', strength: 'Strength' };
export function parameters(doc: RemixDocument, instanceId: string): readonly { readonly name: string; readonly label: string; readonly value: number; readonly min: number; readonly max: number; readonly step: number; readonly integer: boolean; readonly gesture: RemixParameterGesture }[] {
  const instance = doc.remix.instances.find(value => value.id === instanceId); if (!instance) return [];
  return remixBlock(doc, instance.block).parameters.map(parameter => {
    const value = instance.parameters[parameter.name] ?? parameter.default;
    return { name: parameter.name, label: PARAMETER_LABELS[parameter.name] ?? parameter.name, value, min: parameter.min, max: parameter.max,
      step: parameter.integer ? 1 : (parameter.max - parameter.min) / 100 || .01, integer: parameter.integer,
      gesture: { kind: 'remix-parameter', target: instance.target, instance: instance.id, name: parameter.name, value } };
  });
}
