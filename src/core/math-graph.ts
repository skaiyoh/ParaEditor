import { z } from './zod.ts';
import { createMathLibrary, mathFunctionClosure, mathRefKey, mathRefSchema, MATH_PRESET_FUNCTIONS, proveMathFunctionRanges,
  type MathFunctionDefinition, type MathFunctionLibrary, type MathRef } from './math-definition.ts';
import { byteLength, freezeMath, location, mathAttempt, mathTypeSchema, mathRangeSchema, mathTypeRange, mathExecutionRange, readMathRange,
  MATH_FLOAT_MAX, MATH_LIMITS, refuse, sourceSpan, unwrapMath, type MathFunctionRanges,
  type MathLocation, type MathRange, type MathResult, type MathType, type SourceSpan } from './math-expression.ts';

const finite = z.number().min(-MATH_FLOAT_MAX).max(MATH_FLOAT_MAX);
const unit = z.number().min(0).max(1), uint = z.number().int().min(0).max(0xffffffff);
const vec2 = z.tuple([finite, finite]).readonly(), vec3 = z.tuple([finite, finite, finite]).readonly();
export const mathValueSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('scalar'), value: finite }),
  z.strictObject({ type: z.literal('bool'), value: z.boolean() }),
  z.strictObject({ type: z.literal('noise'), value: z.number().min(-1).max(1) }),
  z.strictObject({ type: z.literal('coverage'), value: unit }),
  z.strictObject({ type: z.literal('pressure'), value: unit }),
  z.strictObject({ type: z.literal('seed'), value: uint }),
  z.strictObject({ type: z.literal('hold'), value: uint }),
  z.strictObject({ type: z.literal('time'), value: z.number().int().min(-0x7fffffff).max(0x7fffffff) }),
  z.strictObject({ type: z.literal('vec2'), value: vec2 }),
  z.strictObject({ type: z.literal('coord'), value: z.tuple([z.number().min(-0x3fffffff).max(0x3fffffff), z.number().min(-0x3fffffff).max(0x3fffffff)]).readonly() }),
  z.strictObject({ type: z.literal('cell'), value: z.tuple([uint, uint]).readonly() }),
  z.strictObject({ type: z.literal('vec3'), value: vec3 }),
  z.strictObject({ type: z.literal('srgb'), value: vec3 }),
  z.strictObject({ type: z.literal('linear'), value: vec3 }),
  z.strictObject({ type: z.literal('oklab'), value: vec3 }),
]).readonly();
export type MathValue = z.infer<typeof mathValueSchema>;
export type MathData = MathValue['value'];
export function readMathValue(input: unknown, at = location('value')): MathResult<MathValue> {
  return mathAttempt(() => {
    const parsed = mathValueSchema.safeParse(input);
    if (!parsed.success) refuse('value', `Invalid semantic value: ${parsed.error.issues[0]?.message ?? 'check its type and range'}.`, at);
    return parsed.data;
  });
}
const name = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
const portSchema = z.strictObject({ name, type: mathTypeSchema, range: mathRangeSchema.optional() }).readonly();
const parameterTypeSchema = z.enum(['scalar', 'coverage', 'noise', 'pressure']);
const parameterSchema = z.strictObject({ name, type: parameterTypeSchema, default: finite, min: finite, max: finite, integer: z.boolean() }).readonly();
export const mathBindingSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('input'), name }),
  z.strictObject({ kind: z.literal('parameter'), name }),
  z.strictObject({ kind: z.literal('node'), node: name }),
  z.strictObject({ kind: z.literal('literal'), value: mathValueSchema }),
]).readonly();
export type MathBinding = z.infer<typeof mathBindingSchema>;
const nodeSchema = z.strictObject({ id: name, function: mathRefSchema, args: z.array(mathBindingSchema).max(MATH_LIMITS.expressionNodes).readonly() }).readonly();
export const mathBlockSourceSchema = z.strictObject({
  ...mathRefSchema.shape, name: z.string().min(1).max(80), inputs: z.array(portSchema).max(16).readonly(),
  parameters: z.array(parameterSchema).max(16).readonly(), nodes: z.array(nodeSchema).max(MATH_LIMITS.nodesPerBlock).readonly(),
  output: mathBindingSchema, outputType: mathTypeSchema,
}).readonly();
export type MathBlockSource = z.infer<typeof mathBlockSourceSchema>;
const blockProof: unique symbol = Symbol('validated math block');
export type MathGraphNode = { readonly source: MathBlockSource['nodes'][number]; readonly index: number;
  readonly definition: MathFunctionDefinition; readonly ranges: MathFunctionRanges };
export type MathGraphDocument = { readonly text: string; readonly locations: readonly { readonly path: string; readonly span: SourceSpan }[] };
export type MathBlockDefinition = {
  readonly [blockProof]: true; readonly ref: MathRef; readonly source: MathBlockSource; readonly document: MathGraphDocument;
  readonly nodes: readonly MathGraphNode[]; readonly functions: readonly MathFunctionDefinition[]; readonly evaluationSteps: number;
  readonly inputRanges: readonly MathRange[]; readonly parameterRanges: Readonly<Record<string, MathRange>>; readonly outputRange: MathRange;
};

export function mathValueRange(value: MathValue): MathRange {
  const data = typeof value.value === 'boolean' ? Number(value.value) : value.value;
  return (typeof data === 'number' ? [data] : data).map((n) => ({ min: n, max: n }));
}
/** CPU/reference boundary checks the declared ranges used by numerical admission. */
export function checkMathValueRange(value: MathValue, range: MathRange, at: MathLocation): void {
  const values = mathValueRange(value);
  if (values.length !== range.length || values.some((v, index) => {
    const bound = range[index]; return !bound || v.min < bound.min || v.max > bound.max;
  })) refuse('domain', 'This value is outside the input range used to admit the function or block.', at);
}

/** Canonical JSON is the graph's source document. Paths and offsets refer to this text. */
export function mathGraphDocument(source: MathBlockSource): MathGraphDocument {
  let text = '';
  const ranges: { path: string; start: number; end: number }[] = [];
  function write(value: unknown, path: string): void {
    const start = text.length;
    if (Array.isArray(value)) {
      text += '[';
      value.forEach((child: unknown, index) => { if (index) text += ','; write(child, `${path}/${index}`); });
      text += ']';
    } else if (value !== null && typeof value === 'object') {
      text += '{';
      Object.entries(value).forEach(([key, child], index) => {
        if (index) text += ','; text += JSON.stringify(key) + ':'; write(child, `${path}/${key}`);
      });
      text += '}';
    } else text += JSON.stringify(value);
    ranges.push({ path, start, end: text.length });
  }
  write(source, '');
  return freezeMath({ text, locations: ranges.map(({ path, start, end }) => ({ path, span: sourceSpan(text, start, end) })) });
}
export function mathGraphLocation(block: Pick<MathBlockDefinition, 'ref' | 'document'>, path: string): MathLocation {
  return { sourceId: `block:${mathRefKey(block.ref)}`, path, span: block.document.locations.find((entry) => entry.path === path)?.span ?? sourceSpan(block.document.text) };
}

export function createMathBlock(input: unknown, library: MathFunctionLibrary): MathResult<MathBlockDefinition> {
  return mathAttempt(() => {
    const parsed = mathBlockSourceSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      refuse(issue?.code === 'too_big' ? 'budget' : 'syntax', `The block record is invalid: ${issue?.message ?? 'check its fields'}.`, location('block', '', 0, 0, '/' + (issue?.path ?? []).join('/')));
    }
    const source = parsed.data, ref = { id: source.id, revision: source.revision }, document = mathGraphDocument(source);
    const at = (path: string): MathLocation => mathGraphLocation({ ref, document }, path);
    const inputs = new Map<string, MathType>(), parameters = new Map<string, MathType>(), inputRanges = new Map<string, MathRange>(), parameterRanges = new Map<string, MathRange>();
    source.inputs.forEach((input, index) => {
      if (inputs.has(input.name)) refuse('type', `Input ${input.name} is declared twice.`, at(`/inputs/${index}`));
      inputs.set(input.name, input.type);
      inputRanges.set(input.name, mathExecutionRange(input.type,
        unwrapMath(readMathRange(input.type, input.range ?? mathTypeRange(input.type), at(`/inputs/${index}`)))));
    });
    source.parameters.forEach((parameter, index) => {
      if (parameters.has(parameter.name) || inputs.has(parameter.name)) refuse('type', `Parameter ${parameter.name} duplicates a port.`, at(`/parameters/${index}`));
      if (parameter.min > parameter.max || parameter.default < parameter.min || parameter.default > parameter.max ||
        (parameter.integer && !Number.isInteger(parameter.default))) refuse('value', `Parameter ${parameter.name} needs ordered bounds and a default within them.`, at(`/parameters/${index}`));
      for (const value of [parameter.min, parameter.default, parameter.max]) unwrapMath(readMathValue({ type: parameter.type, value }, at(`/parameters/${index}`)));
      parameters.set(parameter.name, parameter.type);
      parameterRanges.set(parameter.name, mathExecutionRange(parameter.type, [{ min: parameter.min, max: parameter.max }]));
    });
    const pending = new Map<string, { source: MathBlockSource['nodes'][number]; index: number }>();
    source.nodes.forEach((node, index) => {
      if (pending.has(node.id)) refuse('type', `Node ${node.id} is declared twice.`, at(`/nodes/${index}`));
      pending.set(node.id, { source: node, index });
    });
    const complete = new Map<string, MathGraphNode>(), visiting = new Set<string>();
    function bindingRange(binding: MathBinding): MathRange {
      switch (binding.kind) {
        case 'literal': return mathExecutionRange(binding.value.type, mathValueRange(binding.value));
        case 'input': { const range = inputRanges.get(binding.name); if (!range) throw new Error('A typed input range is missing.'); return range; }
        case 'parameter': { const range = parameterRanges.get(binding.name); if (!range) throw new Error('A typed parameter range is missing.'); return range; }
        case 'node': return visit(binding.node).ranges.output;
        default: { const exhaustive: never = binding; return exhaustive; }
      }
    }
    function bindingType(binding: MathBinding, path: string): MathType {
      switch (binding.kind) {
        case 'literal': return binding.value.type;
        case 'input': {
          const type = inputs.get(binding.name);
          if (!type) refuse('context', `Input ${binding.name} is not declared by this block.`, at(path));
          return type;
        }
        case 'parameter': {
          const type = parameters.get(binding.name);
          if (!type) refuse('missing', `Parameter ${binding.name} is missing.`, at(path));
          return type;
        }
        case 'node': {
          if (visiting.has(binding.node)) refuse('cycle', `Connecting ${binding.node} here creates a cycle.`, at(path));
          if (!pending.has(binding.node)) refuse('missing', `Node ${binding.node} is missing.`, at(path));
          return visit(binding.node).definition.signature.output;
        }
        default: { const exhaustive: never = binding; return exhaustive; }
      }
    }
    function visit(id: string): MathGraphNode {
      const existing = complete.get(id);
      if (existing) return existing;
      const entry = pending.get(id);
      if (!entry) refuse('missing', `Node ${id} is missing.`, at('/nodes'));
      const definition = library.get(entry.source.function);
      if (!definition) refuse('missing', `Pinned function ${mathRefKey(entry.source.function)} is missing.`, at(`/nodes/${entry.index}/function`));
      visiting.add(id);
      if (entry.source.args.length !== definition.signature.inputs.length) refuse('type', `Node ${id} needs ${definition.signature.inputs.length} inputs.`, at(`/nodes/${entry.index}/args`));
      entry.source.args.forEach((binding, index) => {
        const path = `/nodes/${entry.index}/args/${index}`, type = bindingType(binding, path), expected = definition.signature.inputs[index];
        if (type !== expected) refuse('type', `Node ${id} expects ${expected} here, but this connection supplies ${type}.`, at(path));
      });
      visiting.delete(id);
      const ranges = unwrapMath(proveMathFunctionRanges(definition, library, entry.source.args.map(bindingRange)));
      const node = { ...entry, definition, ranges }; complete.set(id, node); return node;
    }
    source.nodes.forEach((node) => visit(node.id));
    const type = bindingType(source.output, '/output');
    if (type !== source.outputType) refuse('type', `The block promises ${source.outputType} but its output is ${type}.`, at('/output'));
    const nodes = [...complete.values()], evaluationSteps = nodes.reduce((sum, node) => sum + node.definition.evaluationSteps, 0);
    if (evaluationSteps > MATH_LIMITS.evaluationSteps) refuse('budget', 'This block exceeds 65536 expression evaluations.', at('/nodes'));
    const functions = unwrapMath(mathFunctionClosure(library, source.nodes.map((node) => node.function)));
    return freezeMath({ [blockProof]: true, ref, source, document, nodes, functions, evaluationSteps,
      inputRanges: source.inputs.map((port) => inputRanges.get(port.name) ?? []), parameterRanges: Object.fromEntries(parameterRanges),
      outputRange: bindingRange(source.output) });
  });
}

export function resolveMathParameters(block: MathBlockDefinition, input: unknown = {}): MathResult<Readonly<Record<string, MathValue>>> {
  return mathAttempt(() => {
    const parsed = z.record(z.string(), z.number()).safeParse(input);
    if (!parsed.success) refuse('value', 'Block parameters must be finite numbers keyed by parameter name.', mathGraphLocation(block, '/parameters'));
    for (const key of Object.keys(parsed.data)) if (!block.source.parameters.some((parameter) => parameter.name === key)) refuse('missing', `Parameter ${key} is not part of ${block.source.name}.`, mathGraphLocation(block, '/parameters'));
    return freezeMath(Object.fromEntries(block.source.parameters.map((parameter, index) => {
      const value = Object.hasOwn(parsed.data, parameter.name) ? parsed.data[parameter.name] ?? parameter.default : parameter.default;
      const at = mathGraphLocation(block, `/parameters/${index}`);
      if (parameter.integer && !Number.isInteger(value)) refuse('value', `${parameter.name} must be a whole number between ${parameter.min} and ${parameter.max}.`, at);
      const semantic = unwrapMath(readMathValue({ type: parameter.type, value }, at));
      checkMathValueRange(semantic, block.parameterRanges[parameter.name] ?? [], at);
      return [parameter.name, semantic];
    })));
  });
}

export function packageMathBlock(block: MathBlockDefinition): { readonly block: MathBlockSource; readonly functions: MathFunctionLibrary['sources'] } {
  return freezeMath({ block: block.source, functions: block.functions.map((definition) => definition.source) });
}
export function reopenMathBlock(input: unknown): MathResult<MathBlockDefinition> {
  return mathAttempt(() => {
    const envelope = z.strictObject({ block: z.unknown(), functions: z.unknown() }).safeParse(input);
    if (!envelope.success) refuse('syntax', 'A packaged block needs its block source and complete function closure.', location('package'));
    const library = unwrapMath(createMathLibrary(envelope.data.functions));
    return unwrapMath(createMathBlock(envelope.data.block, library));
  });
}
export function replaceMathNode(options: { readonly block: MathBlockDefinition; readonly node: string; readonly replacement: MathRef;
  readonly ref: MathRef; readonly library: MathFunctionLibrary }): MathResult<MathBlockDefinition> {
  return mathAttempt(() => {
    if (options.ref.id === options.block.ref.id && options.ref.revision <= options.block.ref.revision) refuse('revision', 'Save the changed block under a new revision or fork id.', mathGraphLocation(options.block, '/revision'));
    if (!options.block.nodes.some((node) => node.source.id === options.node)) refuse('missing', `Node ${options.node} is missing.`, mathGraphLocation(options.block, '/nodes'));
    return unwrapMath(createMathBlock({ ...options.block.source, ...options.ref, nodes: options.block.source.nodes.map((node) =>
      node.id === options.node ? { ...node, function: options.replacement } : node) }, options.library));
  });
}

export function admitMathRecipeBytes(recipeText: string, drafts: readonly string[]): MathResult<number> {
  return mathAttempt(() => {
    for (let index = 0; index < drafts.length; index++) if (byteLength(drafts[index] ?? '') > MATH_LIMITS.draftBytes) refuse('budget', 'A recoverable draft can contain at most 16 KiB.', location(`draft:${index}`));
    const total = byteLength(recipeText) + drafts.reduce((sum, draft) => sum + byteLength(draft), 0);
    if (total > MATH_LIMITS.recipeBytes) refuse('budget', 'The recipe and drafts together exceed 512 KiB.', location('recipe'));
    return total;
  });
}

const input = (name: string): MathBinding => ({ kind: 'input', name });
const parameter = (name: string): MathBinding => ({ kind: 'parameter', name });
const node = (node: string): MathBinding => ({ kind: 'node', node });
const scalar = (value: number): MathBinding => ({ kind: 'literal', value: { type: 'scalar', value } });
const functionNode = (id: string, fn: string, args: readonly MathBinding[]): MathBlockSource['nodes'][number] =>
  ({ id, function: { id: fn, revision: 1 }, args });
const grainSize = { name: 'grainSize', type: 'scalar', default: 1, min: 1, max: 4, integer: true } satisfies MathBlockSource['parameters'][number];
const grainNodes = [functionNode('cells', 'grain-cells', [input('position'), parameter('grainSize')]),
  ...[0, 1, 2].map((channel) => functionNode(`noise${channel}`, 'grain-noise', [input('seed'), input('hold'), node('cells'), scalar(channel)])),
  ...[0, 1, 2].map((channel) => functionNode(`normalized${channel}`, 'texture-coverage', [node(`noise${channel}`)])),
  ...[0, 1, 2].map((channel) => functionNode(`remap${channel}`, 'grain-remap', [node(`normalized${channel}`)])),
  ...[0, 1, 2].map((channel) => functionNode(`signed${channel}`, 'coverage-noise', [node(`remap${channel}`)]))];
export const GRAIN_BLOCK_SOURCE: MathBlockSource = freezeMath({ id: 'authored-grain', revision: 1, name: 'Grain',
  inputs: [{ name: 'color', type: 'srgb', range: Array.from({ length: 3 }, () => ({ min: 0, max: 1 })) },
    { name: 'position', type: 'coord', range: [{ min: 0, max: 2047 }, { min: 0, max: 2047 }] }, { name: 'seed', type: 'seed' },
    { name: 'hold', type: 'hold' }, { name: 'clarity', type: 'coverage' }],
  parameters: [grainSize, { name: 'amount', type: 'coverage', default: 0.5, min: 0, max: 1, integer: false },
    { name: 'colorNoise', type: 'coverage', default: 0.3, min: 0, max: 1, integer: false }],
  nodes: [...grainNodes, functionNode('color', 'grain-color', [input('color'), node('signed0'), node('signed1'), node('signed2'),
    parameter('amount'), parameter('colorNoise'), input('clarity')])], output: node('color'), outputType: 'srgb' });
export const CONTRAST_BLOCK_SOURCE: MathBlockSource = freezeMath({ id: 'authored-contrast', revision: 1, name: 'Contrast',
  inputs: [{ name: 'color', type: 'srgb', range: Array.from({ length: 3 }, () => ({ min: 0, max: 1 })) }], parameters: [{ name: 'strength', type: 'scalar', default: 1.6, min: 0, max: 3, integer: false }],
  nodes: [functionNode('contrast', 'photo-contrast', [input('color'), parameter('strength')])], output: node('contrast'), outputType: 'srgb' });
export const TEXTURE_BLOCK_SOURCE: MathBlockSource = freezeMath({ id: 'grain-texture', revision: 1, name: 'Grain texture',
  inputs: [{ name: 'position', type: 'coord' }, { name: 'seed', type: 'seed' }, { name: 'hold', type: 'hold' }],
  parameters: [grainSize], nodes: [functionNode('cells', 'grain-cells', [input('position'), parameter('grainSize')]),
    functionNode('noise', 'grain-noise', [input('seed'), input('hold'), node('cells'), scalar(0)]),
    functionNode('normalized', 'texture-coverage', [node('noise')]), functionNode('remap', 'grain-remap', [node('normalized')])],
  output: node('remap'), outputType: 'coverage' });

export function createMathPresets(): MathResult<{ readonly library: MathFunctionLibrary; readonly grain: MathBlockDefinition;
  readonly contrast: MathBlockDefinition; readonly texture: MathBlockDefinition }> {
  return mathAttempt(() => {
    const library = unwrapMath(createMathLibrary(MATH_PRESET_FUNCTIONS));
    return Object.freeze({ library, grain: unwrapMath(createMathBlock(GRAIN_BLOCK_SOURCE, library)),
      contrast: unwrapMath(createMathBlock(CONTRAST_BLOCK_SOURCE, library)), texture: unwrapMath(createMathBlock(TEXTURE_BLOCK_SOURCE, library)) });
  });
}
