import { createMathLibrary, isPinnedMathPreset, mathRefKey, MATH_PRESET_FUNCTIONS, type MathFunctionDefinition, type MathFunctionLibrary } from '../core/math-definition.ts';
import { freezeMath, location, mathAttempt, mathRangeContains, mathTypeRange, MATH_FLOAT_MIN_NORMAL,
  MATH_LIBRARY_REVISION, MATH_LIMITS, refuse, sourceSpan, unwrapMath,
  type MathLocation, type MathRange, type MathResult, type MathType, type TypedMathExpression } from '../core/math-expression.ts';
import { createMathBlock, checkMathValueRange, GRAIN_BLOCK_SOURCE, mathGraphLocation, readMathValue, resolveMathParameters,
  type MathBinding, type MathBlockDefinition, type MathData, type MathValue } from '../core/math-graph.ts';
import { z } from '../core/zod.ts';
import { grainNoise, holdIndex } from './grain.ts';
import { mathBuiltinGlsl, mathSupportGlsl } from './shaders/math.ts';
import { head, labelLookup } from './shaders/shared.ts';

type Vec2 = readonly [number, number];
type Vec3 = readonly [number, number, number];
const numberOf = (data: MathData | undefined): number => {
  if (typeof data !== 'number') throw new Error('A validated math scalar was not a number.');
  return data;
};
const vec2Of = (data: MathData | undefined): Vec2 => {
  if (data === undefined || typeof data === 'number' || typeof data === 'boolean' || data.length !== 2) throw new Error('A validated math vec2 had the wrong shape.');
  return data;
};
const vec3Of = (data: MathData | undefined): Vec3 => {
  if (data === undefined || typeof data === 'number' || typeof data === 'boolean' || data.length !== 3) throw new Error('A validated math vec3 had the wrong shape.');
  return data;
};
const unit = (value: number): number => Math.min(1, Math.max(0, value));
const srgbToLinear = (v: number): number => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const linearToSrgb = (v: number): number => v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055;
/** Trusted CPU helpers transcribe the shader's powers and operation association, including signed cubes. */
function toOklab(rgb: Vec3): Vec3 {
  const [r, g, b] = rgb.map((v) => srgbToLinear(unit(v)));
  if (r === undefined || g === undefined || b === undefined) throw new Error('A color has three channels.');
  const l = (0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b) ** (1 / 3);
  const m = (0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b) ** (1 / 3);
  const s = (0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b) ** (1 / 3);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function fromOklab([L, a, b]: Vec3): Vec3 {
  const x = L + 0.3963377774 * a + 0.2158037573 * b, y = L - 0.1055613458 * a - 0.0638541728 * b,
    z = L - 0.0894841775 * a - 1.291485548 * b;
  const l = x * x * x, m = y * y * y, s = z * z * z;
  return [linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)];
}
function mapData(data: MathData, map: (value: number) => number): MathData {
  if (typeof data === 'boolean') return data;
  if (typeof data === 'number') return map(data);
  return data.length === 2 ? [map(data[0]), map(data[1])] : [map(data[0]), map(data[1]), map(data[2])];
}
function builtinEvaluation(name: string, args: readonly MathData[]): MathData {
  const a = (): number => numberOf(args[0]), b = (): number => numberOf(args[1]), c = (): number => numberOf(args[2]);
  switch (name) {
    case 'vec2': return [a(), b()];
    case 'vec3': return [a(), b(), c()];
    case 'coord': return mapData(vec2Of(args[0]), (n) => Math.max(-0x3fffffff, Math.min(0x3fffffff, n)));
    case 'cells': { const p = vec2Of(args[0]), size = Math.max(1, Math.floor(b())); return [Math.floor(p[0] / size) >>> 0, Math.floor(p[1] / size) >>> 0]; }
    case 'hashNoise': { const cell = vec2Of(args[2]); return grainNoise(a(), b(), cell[0], cell[1], Math.min(2, Math.max(0, Math.floor(numberOf(args[3]))))); }
    case 'holdAt': return holdIndex(a(), Math.min(0xffffff, Math.max(1, Math.floor(b()))), Math.min(0xffffff, Math.max(1, Math.floor(c()))));
    case 'noise': return Math.max(-1, Math.min(1, a()));
    case 'coverage': return unit(a());
    case 'value': return a();
    case 'rgb': case 'lab': case 'oklab': return vec3Of(args[0]);
    case 'srgb': case 'clampSrgb': return mapData(vec3Of(args[0]), unit);
    case 'toOklab': return toOklab(vec3Of(args[0]));
    case 'fromOklab': return fromOklab(vec3Of(args[0]));
    case 'toLinear': return mapData(vec3Of(args[0]), (v) => srgbToLinear(unit(v)));
    case 'fromLinear': return mapData(vec3Of(args[0]), linearToSrgb);
    case 'abs': return Math.abs(a());
    case 'floor': return Math.floor(a());
    case 'min': return Math.min(a(), b());
    case 'max': return Math.max(a(), b());
    case 'clamp': return Math.max(Math.min(b(), c()), Math.min(Math.max(b(), c()), a()));
    case 'step': return b() < a() ? 0 : 1;
    case 'smoothstep': {
      if (b() <= a()) return c() < a() ? 0 : 1;
      if (c() <= a()) return 0;
      if (c() >= b()) return 1;
      const width = b() * 0.5 - a() * 0.5;
      if (width < MATH_FLOAT_MIN_NORMAL) return c() < a() ? 0 : 1;
      const t = unit((c() * 0.5 - a() * 0.5) / width);
      return t * t * (3 - 2 * t);
    }
    case 'mix': return a() * (1 - c()) + b() * c();
    default: throw new Error(`Missing CPU implementation for trusted math builtin ${name}.`);
  }
}
/** The inspector and both executors use this exact registry. Support contains legacy hash/color GLSL. */
export const trustedMathLibrary = Object.freeze({ label: 'Built-in' as const, revision: MATH_LIBRARY_REVISION, support: mathSupportGlsl,
  builtins: Object.freeze(mathBuiltinGlsl.map((entry) => Object.freeze({ ...entry,
    evaluate: (args: readonly MathData[]): MathData => builtinEvaluation(entry.name, args) }))) });
const builtins = new Map(trustedMathLibrary.builtins.map((entry) => [entry.name, entry]));

function binary(operator: string, left: MathData, right: MathData): MathData {
  const operate = (a: number, b: number): number => {
    switch (operator) {
      case '+': return a + b;
      case '-': return a - b;
      case '*': return a * b;
      case '/': return a / b;
      default: throw new Error('A validated arithmetic operator is unavailable.');
    }
  };
  if (typeof left === 'number' && typeof right === 'number') {
    switch (operator) {
      case '<': return left < right; case '<=': return left <= right; case '>': return left > right; case '>=': return left >= right;
      case '==': return left === right; case '!=': return left !== right;
      default: return operate(left, right);
    }
  }
  if (typeof left === 'number') return mapData(right, (n) => operate(left, n));
  if (typeof right === 'number') return mapData(left, (n) => operate(n, right));
  if (typeof left === 'boolean' || typeof right === 'boolean') throw new Error('A validated vector operation received a bool.');
  return left.length === 2 ? [operate(left[0], right[0]), operate(left[1], right[1])] :
    [operate(left[0], right[0]), operate(left[1], right[1]), operate(left[2], vec3Of(right)[2])];
}

function runFunction(definition: MathFunctionDefinition, functions: ReadonlyMap<string, MathFunctionDefinition>, args: readonly MathData[]): MathData {
  const locals = new Map<string, MathData>();
  definition.parsed.inputs.forEach((input, index) => {
    const value = args[index];
    if (value === undefined) throw new Error('A validated function argument is missing.');
    locals.set(input.name, value);
  });
  const dependencies = new Map(definition.source.dependencies.map((dependency) => [dependency.name, mathRefKey(dependency.ref)]));
  function evaluate(expr: TypedMathExpression): MathData {
    switch (expr.kind) {
      case 'number': case 'boolean': return expr.value;
      case 'variable': {
        const value = locals.get(expr.name);
        if (value === undefined) throw new Error('A validated local is missing.');
        return value;
      }
      case 'call': {
        const args = expr.args.map(evaluate), builtin = builtins.get(expr.name);
        if (builtin) return builtin.evaluate(args);
        const target = functions.get(dependencies.get(expr.name) ?? '');
        if (!target) throw new Error('A pinned dependency is missing from the validated closure.');
        return runFunction(target, functions, args);
      }
      case 'unary': { const value = evaluate(expr.operand); return expr.operator === '!' ? !value : mapData(value, (n) => -n); }
      case 'binary': return binary(expr.operator, evaluate(expr.left), evaluate(expr.right));
      case 'choose': return evaluate(evaluate(expr.condition) ? expr.yes : expr.no);
      case 'component': {
        const value = evaluate(expr.vector);
        return expr.component === 'z' ? vec3Of(value)[2] : typeof value !== 'number' && typeof value !== 'boolean' ? value[expr.component === 'x' ? 0 : 1] : 0;
      }
      default: { const exhaustive: never = expr; return exhaustive; }
    }
  }
  for (const statement of definition.parsed.statements) locals.set(statement.name, evaluate(statement.expression));
  return evaluate(definition.parsed.result);
}

export function evaluateMathFunction(library: MathFunctionLibrary, definition: MathFunctionDefinition, inputs: readonly unknown[]): MathResult<MathValue> {
  return mathAttempt(() => {
    const at = { sourceId: mathRefKey(definition.ref), span: definition.parsed.span, path: null };
    if (inputs.length !== definition.signature.inputs.length) refuse('type', `This function needs ${definition.signature.inputs.length} inputs.`, at);
    const args = inputs.map((input, index) => {
      const value = unwrapMath(readMathValue(input, at));
      if (value.type !== definition.signature.inputs[index]) refuse('type', `Input ${index + 1} needs ${definition.signature.inputs[index]}, not ${value.type}.`, at);
      const port = definition.parsed.inputs[index]; if (!port) throw new Error('An admitted function input is missing.');
      checkMathValueRange(value, definition.ranges.inputs[index] ?? [], { ...at, span: port.span });
      return value.value;
    });
    // The supplied function must be part of the same immutable library.
    if (library.get(definition.ref) !== definition) refuse('revision', 'This function belongs to a different admitted library.', at);
    const result = runFunction(definition, new Map(library.definitions.map((fn) => [mathRefKey(fn.ref), fn])), args);
    return unwrapMath(readMathValue({ type: definition.signature.output, value: result }, at));
  });
}

export type MathIdentityLowering = { readonly kind: 'pinned-identity'; readonly node: string; readonly from: string;
  readonly stage: string; readonly sourceIds: readonly string[] };
type LoweredBlock = { readonly aliases: ReadonlyMap<string, string>; readonly live: ReadonlySet<string>;
  readonly functions: readonly MathFunctionDefinition[]; readonly lowerings: readonly MathIdentityLowering[] };
const loweredBlocks = new WeakMap<MathBlockDefinition, LoweredBlock>();
/** Only the exact pinned conversion -> Identity -> conversion chain has signed no-op semantics. */
function lowerBlock(block: MathBlockDefinition): LoweredBlock {
  const existing = loweredBlocks.get(block); if (existing) return existing;
  const nodes = new Map(block.nodes.map((node) => [node.source.id, node])), aliases = new Map<string, string>();
  const candidates: MathIdentityLowering[] = [];
  for (const signed of block.nodes) {
    const stageBinding = signed.source.args[0];
    if (!isPinnedMathPreset(signed.definition, 'coverage-noise') || stageBinding?.kind !== 'node') continue;
    const stage = nodes.get(stageBinding.node), normalizedBinding = stage?.source.args[0];
    if (!stage || !isPinnedMathPreset(stage.definition, 'grain-remap') || normalizedBinding?.kind !== 'node') continue;
    const normalized = nodes.get(normalizedBinding.node), noiseBinding = normalized?.source.args[0];
    if (!normalized || !isPinnedMathPreset(normalized.definition, 'texture-coverage') || noiseBinding?.kind !== 'node') continue;
    aliases.set(signed.source.id, noiseBinding.node);
    candidates.push({ kind: 'pinned-identity', node: signed.source.id, from: noiseBinding.node, stage: stage.source.id,
      sourceIds: [normalized.definition, stage.definition, signed.definition].map((fn) => mathRefKey(fn.ref)) });
  }
  const live = new Set<string>(), rewritten = new Set<string>();
  function visit(binding: MathBinding): void {
    if (binding.kind !== 'node') return;
    const alias = aliases.get(binding.node);
    if (alias) { rewritten.add(binding.node); visit({ kind: 'node', node: alias }); return; }
    if (live.has(binding.node)) return;
    live.add(binding.node);
    const node = nodes.get(binding.node); if (!node) throw new Error('An admitted lowering node is missing.');
    node.source.args.forEach(visit);
  }
  visit(block.source.output);
  const needed = new Set<string>(), definitions = new Map(block.functions.map((fn) => [mathRefKey(fn.ref), fn]));
  function dependency(definition: MathFunctionDefinition): void {
    const key = mathRefKey(definition.ref); if (needed.has(key)) return;
    needed.add(key);
    for (const ref of definition.source.dependencies) {
      const target = definitions.get(mathRefKey(ref.ref)); if (!target) throw new Error('An admitted lowering dependency is missing.');
      dependency(target);
    }
  }
  block.nodes.filter((node) => live.has(node.source.id)).forEach((node) => dependency(node.definition));
  const result = { aliases, live, functions: block.functions.filter((fn) => needed.has(mathRefKey(fn.ref))),
    lowerings: freezeMath(candidates.filter((entry) => rewritten.has(entry.node))) };
  loweredBlocks.set(block, result); return result;
}
function loweredNode(lowered: LoweredBlock, id: string): string {
  const alias = lowered.aliases.get(id); return alias ? loweredNode(lowered, alias) : id;
}

function runBlock(block: MathBlockDefinition, parameters: Readonly<Record<string, MathValue>>, inputs: ReadonlyMap<string, MathData>): MathData {
  const lowered = lowerBlock(block), functions = new Map(lowered.functions.map((fn) => [mathRefKey(fn.ref), fn])), nodes = new Map<string, MathData>();
  function read(binding: MathBinding): MathData {
    let value: MathData | undefined;
    switch (binding.kind) {
      case 'literal': return binding.value.value;
      case 'input': value = inputs.get(binding.name); break;
      case 'parameter': value = parameters[binding.name]?.value; break;
      case 'node': value = nodes.get(loweredNode(lowered, binding.node)); break;
      default: { const exhaustive: never = binding; return exhaustive; }
    }
    if (value === undefined) throw new Error('A validated block binding is missing.');
    return value;
  }
  for (const node of block.nodes) if (lowered.live.has(node.source.id)) nodes.set(node.source.id, runFunction(node.definition, functions, node.source.args.map(read)));
  return read(block.source.output);
}
export function evaluateMathBlock(block: MathBlockDefinition, options: { readonly inputs: Readonly<Record<string, unknown>>; readonly parameters?: unknown }): MathResult<MathValue> {
  return mathAttempt(() => {
    const parameters = unwrapMath(resolveMathParameters(block, options.parameters)), inputs = new Map<string, MathData>();
    for (const key of Object.keys(options.inputs)) if (!block.source.inputs.some((port) => port.name === key)) refuse('context', `This block does not declare ${key}.`, mathGraphLocation(block, '/inputs'));
    block.source.inputs.forEach((port, index) => {
      const at = mathGraphLocation(block, `/inputs/${index}`), value = unwrapMath(readMathValue(Object.hasOwn(options.inputs, port.name) ? options.inputs[port.name] : undefined, at));
      if (value.type !== port.type) refuse('type', `Input ${port.name} needs ${port.type}, not ${value.type}.`, at);
      checkMathValueRange(value, block.inputRanges[index] ?? [], at);
      inputs.set(port.name, value.value);
    });
    return unwrapMath(readMathValue({ type: block.source.outputType, value: runBlock(block, parameters, inputs) }, mathGraphLocation(block, '/output')));
  });
}

export type MathSourceMapEntry = { readonly generated: { readonly start: number; readonly end: number; readonly line: number; readonly column: number }; readonly original: MathLocation };
export type MathSourceDocument = { readonly id: string; readonly text: string };
export type MathShaderSource = { readonly fragment: string; readonly sourceMap: readonly MathSourceMapEntry[]; readonly sources: readonly MathSourceDocument[] };
class Writer {
  text = '';
  readonly mappings: MathSourceMapEntry[] = [];
  readonly documents = new Map<string, string>();
  add(text: string): void { this.text += text; }
  mapped(at: MathLocation, work: () => void): void {
    const start = this.text.length; work();
    this.mappings.push({ generated: sourceSpan(this.text, start, this.text.length), original: at });
  }
  source(): MathShaderSource {
    return freezeMath({ fragment: this.text, sourceMap: this.mappings,
      sources: [...this.documents].map(([id, text]) => ({ id, text })) });
  }
}
export function mathSourceAt(shader: MathShaderSource, line: number, column = 1): MathLocation | null {
  if (!Number.isInteger(line) || !Number.isInteger(column) || line < 1 || column < 1) return null;
  const lines = shader.fragment.split('\n'), text = lines[line - 1];
  if (text === undefined || column > text.length + 1) return null;
  const offset = lines.slice(0, line - 1).reduce((sum, row) => sum + row.length + 1, 0) + column - 1;
  const candidates = shader.sourceMap.filter((entry) => entry.generated.start <= offset && offset < entry.generated.end);
  candidates.sort((a, b) => (a.generated.end - a.generated.start) - (b.generated.end - b.generated.start));
  return candidates[0]?.original ?? null;
}
export function mathShaderDiagnostic(shader: MathShaderSource, line: number, column: number, driverMessage: string): MathLocation & { readonly message: string } {
  return { ...(mathSourceAt(shader, line, column) ?? location('adapter')), message: `The math shader could not compile: ${driverMessage}` };
}
const glslType = (type: MathType): string => {
  switch (type) {
    case 'scalar': case 'coverage': case 'noise': case 'pressure': return 'float';
    case 'seed': case 'hold': return 'uint';
    case 'time': return 'int';
    case 'bool': return 'bool';
    case 'cell': return 'uvec2';
    case 'coord': case 'vec2': return 'vec2';
    case 'vec3': case 'srgb': case 'linear': case 'oklab': return 'vec3';
    default: { const exhaustive: never = type; return exhaustive; }
  }
};
const functionName = (definition: MathFunctionDefinition): string => `m_f_${[...definition.ref.id].map((char) => char.charCodeAt(0).toString(16).padStart(2, '0')).join('')}_${definition.ref.revision}`;
const floatLiteral = (value: number): string => { const text = String(value); return /[.eE]/.test(text) ? text : text + '.0'; };
function valueLiteral(value: MathValue): string {
  switch (value.type) {
    case 'seed': case 'hold': return `${value.value}u`;
    case 'time': return String(value.value);
    case 'bool': return String(value.value);
    case 'cell': return `uvec2(${value.value[0]}u, ${value.value[1]}u)`;
    case 'coord': case 'vec2': case 'vec3': case 'srgb': case 'linear': case 'oklab': return `${glslType(value.type)}(${value.value.map(floatLiteral).join(', ')})`;
    case 'scalar': case 'noise': case 'coverage': case 'pressure': return floatLiteral(value.value);
    default: { const exhaustive: never = value; return exhaustive; }
  }
}

function writeFunction(writer: Writer, definition: MathFunctionDefinition, functions: ReadonlyMap<string, MathFunctionDefinition>): void {
  const sourceId = mathRefKey(definition.ref), names = new Map<string, string>();
  writer.documents.set(sourceId, definition.source.source);
  definition.parsed.inputs.forEach((input, index) => names.set(input.name, `m_a${index}`));
  function emit(expr: TypedMathExpression): void {
    writer.mapped({ sourceId, span: expr.span, path: null }, () => {
      switch (expr.kind) {
        case 'number': writer.add(floatLiteral(expr.value)); break;
        case 'boolean': writer.add(String(expr.value)); break;
        case 'variable': writer.add(names.get(expr.name) ?? ''); break;
        case 'call': {
          const builtin = builtins.get(expr.name), dependency = definition.source.dependencies.find((entry) => entry.name === expr.name);
          const target = dependency ? functions.get(mathRefKey(dependency.ref)) : undefined;
          if (!builtin && !target) throw new Error('A validated compiler dependency is missing.');
          writer.add((builtin?.glslName ?? (target ? functionName(target) : '')) + '(');
          expr.args.forEach((arg, index) => { if (index) writer.add(', '); emit(arg); }); writer.add(')'); break;
        }
        case 'unary': writer.add(expr.operator === '-' ? '(-(' : '!('); emit(expr.operand); writer.add(expr.operator === '-' ? '))' : ')'); break;
        case 'binary': {
          writer.add('('); emit(expr.left); writer.add(` ${expr.operator} `); emit(expr.right); writer.add(')');
          break;
        }
        case 'choose': writer.add('('); emit(expr.condition); writer.add(' ? '); emit(expr.yes); writer.add(' : '); emit(expr.no); writer.add(')'); break;
        case 'component': writer.add('('); emit(expr.vector); writer.add(`).${expr.component}`); break;
        default: { const exhaustive: never = expr; return exhaustive; }
      }
    });
  }
  writer.mapped({ sourceId, span: definition.parsed.span, path: null }, () => {
    writer.add(`${glslType(definition.parsed.output)} ${functionName(definition)}(`);
    writer.add(definition.parsed.inputs.map((input, index) => `${glslType(input.type)} m_a${index}`).join(', ') + ') {\n');
    definition.parsed.statements.forEach((statement, index) => {
      writer.mapped({ sourceId, span: statement.span, path: null }, () => {
        writer.add(`  ${glslType(statement.expression.type)} m_v${index} = `); emit(statement.expression); writer.add(';\n');
      });
      names.set(statement.name, `m_v${index}`);
    });
    writer.add('  return '); emit(definition.parsed.result); writer.add(';\n}\n');
  });
}

function writeBlock(writer: Writer, block: MathBlockDefinition, parameters: Readonly<Record<string, MathValue>>, uniformParameters = false): void {
  const lowered = lowerBlock(block);
  const supportId = `builtin:support@${MATH_LIBRARY_REVISION}`;
  const support = trustedMathLibrary.support;
  writer.documents.set(supportId, support);
  writer.mapped(location(supportId, support, 0, support.length), () => writer.add(support + '\n'));
  for (const builtin of trustedMathLibrary.builtins) {
    const id = `builtin:${builtin.name}@${builtin.revision}`;
    writer.documents.set(id, builtin.source);
    writer.mapped(location(id, builtin.source, 0, builtin.source.length), () => writer.add(builtin.source + '\n'));
  }
  const functions = new Map(lowered.functions.map((fn) => [mathRefKey(fn.ref), fn]));
  for (const definition of lowered.functions) writeFunction(writer, definition, functions);
  writer.documents.set(`block:${mathRefKey(block.ref)}`, block.document.text);
  // Photo controls remain uniforms, as in legacy Grain. Constant-folding a zero
  // color channel otherwise changes the driver's float association by one byte.
  if (uniformParameters) block.source.parameters.forEach((parameter, index) => {
    writer.mapped(mathGraphLocation(block, `/parameters/${index}`), () => writer.add(`uniform ${glslType(parameter.type)} m_p${index};\n`));
  });
  writer.add(`${glslType(block.source.outputType)} m_block(`);
  writer.add(block.source.inputs.map((port, index) => `${glslType(port.type)} m_i${index}`).join(', ') + ') {\n');
  const nodeNames = new Map(block.nodes.map((node, index) => [node.source.id, `m_n${index}`]));
  function binding(value: MathBinding, path: string): void {
    writer.mapped(mathGraphLocation(block, path), () => {
      switch (value.kind) {
        case 'literal': writer.add(valueLiteral(value.value)); break;
        case 'node': writer.add(nodeNames.get(loweredNode(lowered, value.node)) ?? ''); break;
        case 'input': writer.add(`m_i${block.source.inputs.findIndex((input) => input.name === value.name)}`); break;
        case 'parameter': {
          const parameter = parameters[value.name];
          if (!parameter) throw new Error('A validated compiler parameter is missing.');
          writer.add(uniformParameters ? `m_p${block.source.parameters.findIndex((entry) => entry.name === value.name)}` : valueLiteral(parameter)); break;
        }
        default: { const exhaustive: never = value; return exhaustive; }
      }
    });
  }
  block.nodes.forEach((node, index) => {
    if (!lowered.live.has(node.source.id)) return;
    writer.mapped(mathGraphLocation(block, `/nodes/${node.index}`), () => {
      writer.add(`  ${glslType(node.definition.signature.output)} m_n${index} = ${functionName(node.definition)}(`);
      node.source.args.forEach((arg, index) => { if (index) writer.add(', '); binding(arg, `/nodes/${node.index}/args/${index}`); });
      writer.add(');\n');
    });
  });
  writer.add('  return '); binding(block.source.output, '/output'); writer.add(';\n}\n');
}

export type CompiledMathBlock = MathShaderSource & { readonly block: MathBlockDefinition;
  readonly parameters: Readonly<Record<string, MathValue>>; readonly lowerings: readonly MathIdentityLowering[] };
/** Emits a GLSL library with entry m_block; adapters supply a version header and main. */
export function compileMathBlock(block: MathBlockDefinition, values: unknown = {}): MathResult<CompiledMathBlock> {
  return mathAttempt(() => {
    const parameters = unwrapMath(resolveMathParameters(block, values)), writer = new Writer();
    writeBlock(writer, block, parameters);
    return Object.freeze({ ...writer.source(), block, parameters, lowerings: lowerBlock(block).lowerings });
  });
}
const PHOTO_CONTEXT: ReadonlyMap<string, MathType> = new Map([['color', 'srgb'], ['position', 'coord'], ['seed', 'seed'],
  ['hold', 'hold'], ['clarity', 'coverage'], ['time', 'time']]);
const BRUSH_CONTEXT: ReadonlyMap<string, MathType> = new Map([['position', 'coord'], ['seed', 'seed'], ['hold', 'hold'],
  ['time', 'time'], ['pressure', 'pressure']]);
const normalizedColor: MathRange = Array.from({ length: 3 }, () => ({ min: 0, max: 1 }));
export const MATH_PHOTO_CONTEXT_RANGES: Readonly<Record<string, MathRange>> = freezeMath({ color: normalizedColor,
  position: [{ min: 0, max: 2047 }, { min: 0, max: 2047 }], seed: mathTypeRange('seed'), hold: mathTypeRange('hold'),
  clarity: mathTypeRange('coverage'), time: mathTypeRange('time') });
export const MATH_BRUSH_CONTEXT_RANGES: Readonly<Record<string, MathRange>> = freezeMath({ position: mathTypeRange('coord'),
  seed: mathTypeRange('seed'), hold: mathTypeRange('hold'), time: mathTypeRange('time'), pressure: mathTypeRange('pressure') });
function checkAdapter(block: MathBlockDefinition, kind: 'photo' | 'brush'): void {
  const context = kind === 'photo' ? PHOTO_CONTEXT : BRUSH_CONTEXT, output = kind === 'photo' ? 'srgb' : 'coverage';
  const ranges = kind === 'photo' ? MATH_PHOTO_CONTEXT_RANGES : MATH_BRUSH_CONTEXT_RANGES;
  if (block.source.outputType !== output) refuse('type', `${kind === 'photo' ? 'Photo' : 'Brush'} needs ${output} output; use an explicit texture adapter.`, mathGraphLocation(block, '/output'));
  block.source.inputs.forEach((port, index) => {
    if (context.get(port.name) !== port.type) refuse('context', `${kind === 'photo' ? 'Photo' : 'Brush'} does not provide ${port.name}: ${port.type}.`, mathGraphLocation(block, `/inputs/${index}`));
    if (!mathRangeContains(block.inputRanges[index] ?? [], ranges[port.name] ?? []))
      refuse('domain', `${kind === 'photo' ? 'Photo' : 'Brush'} may provide ${port.name} outside this block's declared range.`, mathGraphLocation(block, `/inputs/${index}`));
  });
}
function adapterSource(writer: Writer, id: string, source: string): void {
  writer.documents.set(id, source);
  writer.mapped(location(id, source, 0, source.length), () => writer.add(source));
}
function adapterCall(block: MathBlockDefinition): string {
  const names: ReadonlyMap<string, string> = new Map([['color', 'm_color'], ['position', 'm_position'], ['seed', 'seed'],
    ['hold', 'hold'], ['clarity', 'm_clarity'], ['time', 'compositionFrame'], ['pressure', 'pressure']]);
  return `m_block(${block.source.inputs.map((port) => names.get(port.name)).join(', ')})`;
}

export type MathPhotoInstance = { readonly block: MathBlockDefinition; readonly parameters: Readonly<Record<string, number>>; readonly enabled: boolean };
export type MathPhotoPass = CompiledMathBlock & { readonly kind: 'photo-color'; readonly enabled: boolean; readonly bypass: boolean; readonly targetFormat: 'rgba8' };
export type MathPhotoRack = { readonly passes: readonly MathPhotoPass[]; readonly targetFormat: 'rgba8'; readonly maxAdditionalTargets: 2 };
const admittedPhotoRacks = new WeakSet<MathPhotoRack>();
/** Compiled GLSL is executable input: only immutable results admitted here may reach WebGL. */
export function admitPhotoRack(rack: MathPhotoRack): MathResult<MathPhotoRack> {
  return mathAttempt(() => {
    if (!admittedPhotoRacks.has(rack)) refuse('context', 'Prepare a photo rack returned by compilePhotoRack; copied or unadmitted shaders cannot run.', location('photo-rack'));
    // Rebuild proofs from source: callers cannot smuggle a forged typed AST through compilation.
    const canonical = unwrapMath(compilePhotoRack(rack.passes.map((pass) => {
      const library = unwrapMath(createMathLibrary(pass.block.functions.map((fn) => fn.source)));
      const block = unwrapMath(createMathBlock(pass.block.source, library));
      const parameters: Record<string, number> = {};
      for (const [name, value] of Object.entries(pass.parameters)) {
        if (typeof value.value !== 'number') refuse('type', 'Photo parameters must be numeric.', mathGraphLocation(block, '/parameters'));
        parameters[name] = value.value;
      }
      const length = parameters['grainHold'];
      if (length !== undefined && (!Number.isInteger(length) || length < 1 || length > 0xffffff))
        refuse('domain', 'Grain hold must be a positive integer no greater than 16777215.', mathGraphLocation(block, '/parameters'));
      return { block, parameters, enabled: pass.enabled };
    })));
    if (canonical.passes.some((pass, index) => pass.fragment !== rack.passes[index]?.fragment))
      refuse('revision', 'The compiled photo rack differs from its admitted source; compile it again.', location('photo-rack'));
    return canonical;
  });
}
function legacyGrain(block: MathBlockDefinition): boolean {
  return JSON.stringify(block.source) === JSON.stringify(GRAIN_BLOCK_SOURCE) && block.functions.every((fn) =>
    MATH_PRESET_FUNCTIONS.some((preset) => mathRefKey(preset) === mathRefKey(fn.ref) && JSON.stringify(preset) === JSON.stringify(fn.source)));
}
/** One output pass per enabled block. Integration must ping-pong RGBA8, never fuse passes. */
export function compilePhotoRack(instances: readonly MathPhotoInstance[]): MathResult<MathPhotoRack> {
  return mathAttempt(() => {
    if (instances.length > MATH_LIMITS.blocksPerRack) refuse('budget', 'A photo rack can contain at most eight blocks.', location('photo-rack'));
    const definitions = new Map<string, string>(), blocks = new Map<string, string>();
    let steps = 0;
    const passes = instances.map((instance) => {
      const { block } = instance; checkAdapter(block, 'photo');
      const blockKey = mathRefKey(block.ref), previous = blocks.get(blockKey);
      if (previous !== undefined && previous !== block.document.text) refuse('revision', `Block ${blockKey} has conflicting content; save a new revision.`, mathGraphLocation(block, '/revision'));
      blocks.set(blockKey, block.document.text);
      for (const fn of block.functions) {
        const key = mathRefKey(fn.ref), source = JSON.stringify(fn.source), previous = definitions.get(key);
        if (previous !== undefined && previous !== source) refuse('revision', `Function ${key} has conflicting pinned source across the rack.`, location(key));
        definitions.set(key, source);
      }
      if (definitions.size > MATH_LIMITS.functionRevisions) refuse('budget', 'The rack includes more than 64 unique function revisions.', location('photo-rack'));
      steps += instance.enabled ? block.evaluationSteps : 0;
      if (steps > MATH_LIMITS.evaluationSteps) refuse('budget', 'The photo rack exceeds 65536 expression evaluations per pixel.', location('photo-rack'));
      const parameters = unwrapMath(resolveMathParameters(block, instance.parameters));
      const bypass = !instance.enabled || (legacyGrain(block) && parameters['amount']?.value === 0 && parameters['colorNoise']?.value === 0);
      const writer = new Writer();
      adapterSource(writer, 'adapter:photo-header@1', head + labelLookup);
      writeBlock(writer, block, parameters, true);
      adapterSource(writer, 'adapter:photo-color@1', `
uniform sampler2D src;
uniform sampler2D label;
uniform uint seed;
uniform uint hold;
uniform int compositionFrame;
uniform float clarity[256];
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy), sz = textureSize(src, 0);
  vec2 m_position = vec2(p);
  vec3 m_color = texelFetch(src, p, 0).rgb;
  int id = int(floor(labelOf(label, p, sz) * 255. + 0.5));
  float m_clarity = clarity[id];
  o = vec4(${bypass ? 'm_color' : `clamp(${adapterCall(block)}, 0., 1.)`}, 1.);
}
`);
      return Object.freeze({ ...writer.source(), block, parameters, lowerings: lowerBlock(block).lowerings,
        kind: 'photo-color', enabled: instance.enabled, bypass, targetFormat: 'rgba8' } satisfies MathPhotoPass);
    });
    const rack: MathPhotoRack = Object.freeze({ passes: Object.freeze(passes), targetFormat: 'rgba8', maxAdditionalTargets: 2 });
    admittedPhotoRacks.add(rack);
    return rack;
  });
}

export type MathBrushProgram = CompiledMathBlock & { readonly kind: 'brush-coverage'; readonly colorFormat: 'premultiplied-srgb' };
/** The tip texture comes from the stroke sampler. The effect's photo color is never sampled for alpha. */
export function compileBrushCoverage(block: MathBlockDefinition, values: unknown = {}): MathResult<MathBrushProgram> {
  return mathAttempt(() => {
    checkAdapter(block, 'brush');
    const parameters = unwrapMath(resolveMathParameters(block, values)), writer = new Writer();
    adapterSource(writer, 'adapter:brush-header@1', head);
    writeBlock(writer, block, parameters);
    adapterSource(writer, 'adapter:brush-coverage@1', `
uniform sampler2D tip;
uniform vec2 planeOrigin;
uniform float pixelScale;
uniform uint seed;
uniform uint hold;
uniform int compositionFrame;
uniform float pressure;
uniform float opacity;
uniform vec3 ink;
void main() {
  vec2 m_position = planeOrigin + (gl_FragCoord.xy - vec2(0.5)) * pixelScale;
  float roundTip = texelFetch(tip, ivec2(gl_FragCoord.xy), 0).r;
  float alpha = clamp(${adapterCall(block)}, 0., 1.) * clamp(roundTip, 0., 1.) * clamp(opacity, 0., 1.);
  o = vec4(clamp(ink, 0., 1.) * alpha, alpha);
}
`);
    return Object.freeze({ ...writer.source(), block, parameters, lowerings: lowerBlock(block).lowerings,
      kind: 'brush-coverage', colorFormat: 'premultiplied-srgb' });
  });
}
const unitSchema = z.number().min(0).max(1), uintSchema = z.number().int().min(0).max(0xffffffff);
const positionSchema = z.tuple([z.number().min(-0x3fffffff).max(0x3fffffff), z.number().min(-0x3fffffff).max(0x3fffffff)]);
const colorSchema = z.tuple([unitSchema, unitSchema, unitSchema]);
const contextShape = { position: positionSchema, seed: uintSchema, hold: uintSchema,
  time: z.number().int().min(-0x7fffffff).max(0x7fffffff).default(0) };
const photoSampleSchema = z.strictObject({ ...contextShape,
  position: z.tuple([z.number().int().min(0).max(2047), z.number().int().min(0).max(2047)]), color: colorSchema, clarity: unitSchema });
const brushSampleSchema = z.strictObject({ ...contextShape, roundTip: unitSchema, opacity: unitSchema,
  ink: colorSchema, pressure: unitSchema.default(1) });
export type MathPhotoSample = z.input<typeof photoSampleSchema>;
export type MathBrushSample = z.input<typeof brushSampleSchema>;
export type MathPhotoPixel = { readonly color: Vec3; readonly bytes: readonly [number, number, number, number] };
/** CPU reference for the same authored graph, with RGBA8 quantization after every active pass. */
export function evaluatePhotoRack(rack: MathPhotoRack, input: unknown): MathResult<MathPhotoPixel> {
  return mathAttempt(() => {
    const parsed = photoSampleSchema.safeParse(input);
    if (!parsed.success) refuse('value', `Invalid photo context: ${parsed.error.issues[0]?.message ?? 'check the sample'}.`, location('adapter:photo-color@1'));
    const sample = parsed.data;
    let color: Vec3 = sample.color;
    const context = new Map<string, MathData>([['position', [Math.trunc(sample.position[0]), Math.trunc(sample.position[1])]],
      ['seed', sample.seed], ['hold', sample.hold], ['clarity', sample.clarity], ['time', sample.time]]);
    for (const pass of rack.passes) {
      if (pass.bypass) continue;
      context.set('color', color);
      const output = vec3Of(runBlock(pass.block, pass.parameters, context));
      color = [Math.round(unit(output[0]) * 255) / 255, Math.round(unit(output[1]) * 255) / 255, Math.round(unit(output[2]) * 255) / 255];
    }
    return freezeMath({ color, bytes: [Math.round(color[0] * 255), Math.round(color[1] * 255), Math.round(color[2] * 255), 255] });
  });
}
export type MathBrushPixel = { readonly texture: number; readonly coverage: number; readonly premultiplied: readonly [number, number, number, number] };
export function evaluateBrushCoverage(program: MathBrushProgram, input: unknown): MathResult<MathBrushPixel> {
  return mathAttempt(() => {
    const parsed = brushSampleSchema.safeParse(input);
    if (!parsed.success) refuse('value', `Invalid brush context: ${parsed.error.issues[0]?.message ?? 'check the sample'}.`, location('adapter:brush-coverage@1'));
    const sample = parsed.data;
    const context = new Map<string, MathData>([['position', sample.position], ['seed', sample.seed], ['hold', sample.hold], ['time', sample.time], ['pressure', sample.pressure]]);
    const texture = unit(numberOf(runBlock(program.block, program.parameters, context))), coverage = texture * sample.roundTip * sample.opacity;
    return freezeMath({ texture, coverage, premultiplied: [sample.ink[0] * coverage, sample.ink[1] * coverage, sample.ink[2] * coverage, coverage] });
  });
}
