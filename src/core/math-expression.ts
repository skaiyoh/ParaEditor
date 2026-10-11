import { err, ok, type Result } from './result.ts';
import { z } from './zod.ts';

export const MATH_LIBRARY_REVISION = 1;
export const MATH_MAX_SOURCE_BYTES = 4 * 1024;
export const MATH_MAX_EXPRESSION_NODES = 128;
export const MATH_MAX_FUNCTION_NODES_PER_BLOCK = 16;
export const MATH_MAX_BLOCKS_PER_RACK = 8;
export const MATH_MAX_FUNCTION_REVISIONS_PER_PROJECT = 64;
export const MATH_MAX_DRAFT_BYTES = 16 * 1024;
export const MATH_MAX_RECIPE_BYTES = 512 * 1024;
export const MATH_FLOAT_MAX = 3.4028234663852886e38;
export const MATH_FLOAT_MIN_NORMAL = 2 ** -126;
export const MATH_LIMITS = Object.freeze({ sourceBytes: MATH_MAX_SOURCE_BYTES, expressionNodes: MATH_MAX_EXPRESSION_NODES,
  functionRevisions: MATH_MAX_FUNCTION_REVISIONS_PER_PROJECT, nodesPerBlock: MATH_MAX_FUNCTION_NODES_PER_BLOCK,
  blocksPerRack: MATH_MAX_BLOCKS_PER_RACK, recipeBytes: MATH_MAX_RECIPE_BYTES, draftBytes: MATH_MAX_DRAFT_BYTES,
  // A small DAG can expand exponentially when functions call dependencies twice.
  evaluationSteps: 65536 });

export const mathTypeSchema = z.enum(['scalar', 'bool', 'vec2', 'vec3', 'coord', 'cell', 'noise',
  'coverage', 'srgb', 'linear', 'oklab', 'pressure', 'seed', 'time', 'hold']);
export type MathType = z.infer<typeof mathTypeSchema>;
export type SourceSpan = { readonly start: number; readonly end: number; readonly line: number; readonly column: number };
export type MathLocation = { readonly sourceId: string; readonly span: SourceSpan; readonly path: string | null };
export type MathDiagnostic = MathLocation & {
  readonly kind: 'syntax' | 'type' | 'domain' | 'budget' | 'cycle' | 'missing' | 'context' | 'value' | 'revision';
  readonly message: string;
};
export type MathResult<T> = Result<T, MathDiagnostic>;
export function sourceSpan(source: string, start = 0, end = start): SourceSpan {
  const prefix = source.slice(0, start);
  return { start, end, line: prefix.split('\n').length, column: start - prefix.lastIndexOf('\n') };
}
export function location(sourceId: string, source = '', start = 0, end = start, path: string | null = null): MathLocation {
  return { sourceId, span: sourceSpan(source, start, end), path };
}
class MathFault extends Error {
  readonly diagnostic: MathDiagnostic;
  constructor(diagnostic: MathDiagnostic) { super(diagnostic.message); this.diagnostic = diagnostic; }
}
export function refuse(kind: MathDiagnostic['kind'], message: string, at: MathLocation): never {
  throw new MathFault({ kind, message, ...at });
}
export function mathAttempt<T>(work: () => T): MathResult<T> {
  try { return ok(work()); } catch (error) {
    if (error instanceof MathFault) return err(error.diagnostic);
    throw error;
  }
}
export function unwrapMath<T>(result: MathResult<T>): T {
  if (!result.ok) throw new MathFault(result.error);
  return result.value;
}
/** Only used on newly constructed, acyclic data, never on caller-owned objects. */
export function freezeMath<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeMath(child);
    Object.freeze(value);
  }
  return value;
}
export const byteLength = (value: string): number => new TextEncoder().encode(value).length;

export type MathSignature = { readonly inputs: readonly MathType[]; readonly output: MathType };
export type MathBuiltin = { readonly name: string; readonly signatures: readonly MathSignature[]; readonly description: string };
const signature = (inputs: readonly MathType[], output: MathType): MathSignature => ({ inputs, output });
const builtin = (name: string, inputs: readonly MathType[], output: MathType, description: string): MathBuiltin =>
  ({ name, signatures: [signature(inputs, output)], description });
/** Implementations are exposed by render's trustedMathLibrary, not editable source. */
export const MATH_BUILTINS: readonly MathBuiltin[] = freezeMath([
  builtin('vec2', ['scalar', 'scalar'], 'vec2', 'Construct a vector.'),
  builtin('vec3', ['scalar', 'scalar', 'scalar'], 'vec3', 'Construct a vector.'),
  builtin('coord', ['vec2'], 'coord', 'Explicit coordinates in composition or stroke-plane pixels.'),
  builtin('cells', ['coord', 'scalar'], 'cell', 'Floor pixel coordinates into integer cells; size is at least one whole pixel.'),
  builtin('hashNoise', ['seed', 'hold', 'cell', 'scalar'], 'noise', 'Legacy Grain hash; channel is clamped to integer 0, 1, or 2.'),
  builtin('holdAt', ['time', 'scalar', 'scalar'], 'hold', 'Composition frame, frame count, and hold length; positive whole counts.'),
  builtin('noise', ['scalar'], 'noise', 'Clamp a scalar to signed noise [-1, 1].'),
  builtin('coverage', ['scalar'], 'coverage', 'Clamp an explicitly remapped scalar to coverage [0, 1].'),
  { name: 'value', signatures: ['noise', 'coverage', 'pressure', 'time'].map((type) =>
    signature([mathTypeSchema.parse(type)], 'scalar')), description: 'Explicitly read a semantic scalar for arithmetic.' },
  builtin('rgb', ['srgb'], 'vec3', 'Read sRGB channels; this is not a color-space conversion.'),
  builtin('srgb', ['vec3'], 'srgb', 'Construct and clamp normalized sRGB channels.'),
  builtin('lab', ['oklab'], 'vec3', 'Read Oklab channels.'),
  builtin('oklab', ['vec3'], 'oklab', 'Construct Oklab channels.'),
  builtin('toOklab', ['srgb'], 'oklab', 'Clamp sRGB to [0, 1], then convert to Oklab using the legacy matrices.'),
  builtin('fromOklab', ['oklab'], 'srgb', 'Convert Oklab to sRGB, including out-of-gamut values.'),
  builtin('toLinear', ['srgb'], 'linear', 'Clamp sRGB to [0, 1], then convert to linear RGB.'),
  builtin('fromLinear', ['linear'], 'srgb', 'Convert linear RGB to sRGB.'),
  builtin('clampSrgb', ['srgb'], 'srgb', 'Clamp to the display gamut.'),
  builtin('abs', ['scalar'], 'scalar', 'Absolute value.'),
  builtin('floor', ['scalar'], 'scalar', 'Floor to a whole number.'),
  builtin('min', ['scalar', 'scalar'], 'scalar', 'Minimum.'),
  builtin('max', ['scalar', 'scalar'], 'scalar', 'Maximum.'),
  builtin('clamp', ['scalar', 'scalar', 'scalar'], 'scalar', 'Clamp with sorted bounds.'),
  builtin('step', ['scalar', 'scalar'], 'scalar', 'Zero below the edge, one at or above it.'),
  builtin('smoothstep', ['scalar', 'scalar', 'scalar'], 'scalar', 'Smooth remap; equal/reversed or subnormal half-width edges use a threshold; outside edges saturates.'),
  builtin('mix', ['scalar', 'scalar', 'scalar'], 'scalar', 'Linear interpolation.'),
]);

type ExpressionBody<E> =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'call'; readonly name: string; readonly args: readonly E[] }
  | { readonly kind: 'unary'; readonly operator: '-' | '!'; readonly operand: E }
  | { readonly kind: 'binary'; readonly operator: string; readonly left: E; readonly right: E }
  | { readonly kind: 'choose'; readonly condition: E; readonly yes: E; readonly no: E }
  | { readonly kind: 'component'; readonly vector: E; readonly component: 'x' | 'y' | 'z' };
export type MathExpression = { readonly span: SourceSpan } & (
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'call'; readonly name: string; readonly args: readonly MathExpression[] }
  | { readonly kind: 'unary'; readonly operator: '-' | '!'; readonly operand: MathExpression }
  | { readonly kind: 'binary'; readonly operator: string; readonly left: MathExpression; readonly right: MathExpression }
  | { readonly kind: 'choose'; readonly condition: MathExpression; readonly yes: MathExpression; readonly no: MathExpression }
  | { readonly kind: 'component'; readonly vector: MathExpression; readonly component: 'x' | 'y' | 'z' });
export type TypedMathExpression = { readonly span: SourceSpan; readonly type: MathType } & (
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'call'; readonly name: string; readonly args: readonly TypedMathExpression[] }
  | { readonly kind: 'unary'; readonly operator: '-' | '!'; readonly operand: TypedMathExpression }
  | { readonly kind: 'binary'; readonly operator: string; readonly left: TypedMathExpression; readonly right: TypedMathExpression }
  | { readonly kind: 'choose'; readonly condition: TypedMathExpression; readonly yes: TypedMathExpression; readonly no: TypedMathExpression }
  | { readonly kind: 'component'; readonly vector: TypedMathExpression; readonly component: 'x' | 'y' | 'z' });
export type MathInterval = { readonly min: number; readonly max: number };
/** One interval per component; scalar and bool ranges have one component. */
export type MathRange = readonly MathInterval[];
export type MathPort = { readonly name: string; readonly type: MathType; readonly range: MathRange; readonly span: SourceSpan };
export type MathStatement<E> = { readonly name: string; readonly span: SourceSpan; readonly expression: E };
export type ParsedMathFunction = {
  readonly name: string; readonly inputs: readonly MathPort[]; readonly output: MathType;
  readonly statements: readonly MathStatement<MathExpression>[]; readonly result: MathExpression; readonly span: SourceSpan;
  readonly expressionCount: number;
};
export type TypedMathFunction = Omit<ParsedMathFunction, 'statements' | 'result'> & {
  readonly statements: readonly MathStatement<TypedMathExpression>[]; readonly result: TypedMathExpression;
};
type Token = { readonly text: string; readonly start: number; readonly end: number; readonly kind: 'number' | 'name' | 'symbol' | 'end' };
const RESERVED = new Set(['fn', 'let', 'return', 'true', 'false', 'for', 'while', 'if', 'else', 'import']);
const PRECEDENCE: ReadonlyMap<string, number> = new Map([['==', 1], ['!=', 1], ['<', 2], ['<=', 2], ['>', 2], ['>=', 2], ['+', 3], ['-', 3], ['*', 4], ['/', 4]]);

/** fn name(x: noise) -> coverage { let y = value(x) * 0.5; return coverage(y + 0.5); } */
export function parseMathFunction(source: string, sourceId = 'draft'): MathResult<ParsedMathFunction> {
  return mathAttempt(() => {
    if (byteLength(source) > MATH_LIMITS.sourceBytes) refuse('budget', 'A function can contain at most 4096 UTF-8 bytes.', location(sourceId));
    const tokens: Token[] = [];
    let cursor = 0;
    while (cursor < source.length) {
      const rest = source.slice(cursor);
      const skip = /^(?:\s+|\/\/[^\n]*(?:\n|$))/.exec(rest);
      if (skip) { cursor += skip[0].length; continue; }
      const numeric = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
      const symbol = /^(?:->|<=|>=|==|!=|[(){}\[\]:;,?.+*/!<>=-])/.exec(rest);
      const text = numeric?.[0] ?? name?.[0] ?? symbol?.[0];
      if (!text) refuse('syntax', `The character ${JSON.stringify(source[cursor])} is not supported in a math function.`, location(sourceId, source, cursor, cursor + 1));
      tokens.push({ text, start: cursor, end: cursor + text.length, kind: numeric ? 'number' : name ? 'name' : 'symbol' });
      cursor += text.length;
    }
    const end: Token = { text: '', start: source.length, end: source.length, kind: 'end' };
    let index = 0, count = 0;
    const peek = (): Token => tokens[index] ?? end;
    const take = (): Token => { const token = peek(); index++; return token; };
    const at = (token: Token): MathLocation => location(sourceId, source, token.start, token.end);
    const expect = (text: string): Token => {
      const token = take();
      if (token.text !== text) refuse('syntax', `Expected ${JSON.stringify(text)} here.`, at(token));
      return token;
    };
    const identifier = (): Token => {
      const token = take();
      if (token.kind !== 'name' || RESERVED.has(token.text)) refuse('syntax', 'Use a name made of letters, digits, and underscores here.', at(token));
      return token;
    };
    const readType = (): MathType => {
      const token = take(), parsed = mathTypeSchema.safeParse(token.text);
      if (!parsed.success) refuse('type', `Unknown semantic type ${JSON.stringify(token.text)}.`, at(token));
      return parsed.data;
    };
    const node = (body: ExpressionBody<MathExpression>, start: number, finish: number): MathExpression => {
      if (++count > MATH_LIMITS.expressionNodes) refuse('budget', 'A function can contain at most 128 expression nodes.', location(sourceId, source, start, finish));
      return { ...body, span: sourceSpan(source, start, finish) };
    };
    function expression(minimum = 0, depth = 0): MathExpression {
      if (depth > MATH_LIMITS.expressionNodes) refuse('budget', 'This expression is nested too deeply.', at(peek()));
      const token = take();
      let left: MathExpression;
      if (token.kind === 'number') {
        const value = Number(token.text);
        if (!Number.isFinite(value) || Math.abs(value) > MATH_FLOAT_MAX) refuse('value', 'Use a finite number within the high-precision float range.', at(token));
        left = node({ kind: 'number', value }, token.start, token.end);
      } else if (token.text === 'true' || token.text === 'false') {
        left = node({ kind: 'boolean', value: token.text === 'true' }, token.start, token.end);
      } else if (token.text === '-' || token.text === '!') {
        const operand = expression(5, depth + 1);
        left = node({ kind: 'unary', operator: token.text, operand }, token.start, operand.span.end);
      } else if (token.text === '(') {
        left = expression(0, depth + 1); expect(')');
      } else if (token.kind === 'name' && !RESERVED.has(token.text)) {
        if (peek().text === '(') {
          take();
          const args: MathExpression[] = [];
          if (peek().text !== ')') {
            do { args.push(expression(0, depth + 1)); if (peek().text !== ',') break; take(); } while (true);
          }
          left = node({ kind: 'call', name: token.text, args }, token.start, expect(')').end);
        } else left = node({ kind: 'variable', name: token.text }, token.start, token.end);
      } else refuse('syntax', 'Expected a number, input, or math expression here.', at(token));
      while (true) {
        if (peek().text === '.') {
          take(); const component = take();
          if (component.text !== 'x' && component.text !== 'y' && component.text !== 'z') refuse('type', 'Vector components are x, y, and z.', at(component));
          left = node({ kind: 'component', vector: left, component: component.text }, left.span.start, component.end);
          continue;
        }
        const precedence = PRECEDENCE.get(peek().text);
        if (precedence === undefined || precedence < minimum) break;
        const operator = take().text, right = expression(precedence + 1, depth + 1);
        left = node({ kind: 'binary', operator, left, right }, left.span.start, right.span.end);
      }
      if (minimum === 0 && peek().text === '?') {
        take(); const yes = expression(0, depth + 1); expect(':'); const no = expression(0, depth + 1);
        left = node({ kind: 'choose', condition: left, yes, no }, left.span.start, no.span.end);
      }
      return left;
    }
    expect('fn'); const name = identifier(); expect('(');
    const inputs: MathPort[] = [];
    if (peek().text !== ')') {
      do {
        const port = identifier(); expect(':'); const type = readType();
        let range = mathTypeRange(type);
        if (peek().text === '[') {
          const begin = take();
          const bound = (): number => {
            const negative = peek().text === '-'; if (negative) take();
            const token = take(), value = Number(token.text) * (negative ? -1 : 1);
            if (token.kind !== 'number' || !Number.isFinite(value) || Math.abs(value) > MATH_FLOAT_MAX)
              refuse('domain', 'Use finite numeric input bounds within the float range.', at(token));
            return value;
          };
          const min = bound(); expect(','); const max = bound(); const finish = expect(']');
          const boundsAt = location(sourceId, source, begin.start, finish.end);
          range = unwrapMath(readMathRange(type, range.map(() => ({ min, max })), boundsAt));
        }
        inputs.push({ name: port.text, type, range, span: sourceSpan(source, port.start, (tokens[index - 1] ?? port).end) });
        if (peek().text !== ',') break; take();
      } while (true);
    }
    expect(')'); expect('->'); const output = readType(); expect('{');
    const statements: MathStatement<MathExpression>[] = [];
    while (peek().text === 'let') {
      const begin = take(), variable = identifier(); expect('='); const value = expression(); const finish = expect(';');
      statements.push({ name: variable.text, expression: value, span: sourceSpan(source, begin.start, finish.end) });
    }
    expect('return'); const result = expression(); expect(';'); expect('}');
    if (peek().kind !== 'end') refuse('syntax', 'A definition contains exactly one function.', at(peek()));
    return freezeMath({ name: name.text, inputs, output, statements, result, span: sourceSpan(source, 0, source.length), expressionCount: count });
  });
}

export function typecheckMathFunction(parsed: ParsedMathFunction, sourceId: string,
  dependencies: ReadonlyMap<string, MathSignature> = new Map()): MathResult<TypedMathFunction> {
  return mathAttempt(() => {
    const variables = new Map<string, MathType>();
    const functions = new Map(MATH_BUILTINS.map((entry) => [entry.name, entry.signatures]));
    for (const [name, signature] of dependencies) {
      if (functions.has(name)) refuse('type', `Dependency ${name} shadows a built-in function.`, { sourceId, span: parsed.span, path: null });
      functions.set(name, [signature]);
    }
    const at = (span: SourceSpan): MathLocation => ({ sourceId, span, path: null });
    const bind = (name: string, type: MathType, span: SourceSpan): void => {
      if (variables.has(name) || functions.has(name)) refuse('type', `The name ${name} is already in use.`, at(span));
      variables.set(name, type);
    };
    for (const input of parsed.inputs) bind(input.name, input.type, input.span);
    const vector = (type: MathType): boolean => type === 'vec2' || type === 'vec3';
    function check(expr: MathExpression): TypedMathExpression {
      switch (expr.kind) {
        case 'number': return { ...expr, type: 'scalar' };
        case 'boolean': return { ...expr, type: 'bool' };
        case 'variable': {
          const type = variables.get(expr.name);
          if (!type) refuse('missing', `The input or earlier local ${expr.name} does not exist.`, at(expr.span));
          return { ...expr, type };
        }
        case 'call': {
          const signatures = functions.get(expr.name);
          if (!signatures) refuse(expr.name === parsed.name ? 'cycle' : 'missing', expr.name === parsed.name
            ? 'A function cannot call itself.' : `Function ${expr.name} is not a built-in or pinned dependency.`, at(expr.span));
          const args = expr.args.map(check);
          const match = signatures.find((sig) => sig.inputs.length === args.length && sig.inputs.every((type, i) => type === args[i]?.type));
          if (!match) refuse('type', `${expr.name} cannot accept (${args.map((arg) => arg.type).join(', ')}); use its declared semantic input types.`, at(expr.span));
          return { ...expr, args, type: match.output };
        }
        case 'unary': {
          const operand = check(expr.operand);
          if (expr.operator === '!' ? operand.type !== 'bool' : operand.type !== 'scalar' && !vector(operand.type)) refuse('type', `Operator ${expr.operator} cannot be used with ${operand.type}.`, at(expr.span));
          return { ...expr, operand, type: operand.type };
        }
        case 'binary': {
          const left = check(expr.left), right = check(expr.right);
          let type: MathType | null = null;
          if (['<', '<=', '>', '>=', '==', '!='].includes(expr.operator)) {
            if (left.type === 'scalar' && right.type === 'scalar') type = 'bool';
          } else if (left.type === 'scalar' && right.type === 'scalar') type = 'scalar';
          else if (left.type === right.type && vector(left.type) && expr.operator !== '/') type = left.type;
          else if (vector(left.type) && right.type === 'scalar' && ['*', '/'].includes(expr.operator)) type = left.type;
          else if (left.type === 'scalar' && vector(right.type) && expr.operator === '*') type = right.type;
          if (type === null) refuse('type', `Operator ${expr.operator} cannot combine ${left.type} and ${right.type}; convert semantic values explicitly.`, at(expr.span));
          return { ...expr, left, right, type };
        }
        case 'component': {
          const value = check(expr.vector);
          if (!vector(value.type) || (value.type === 'vec2' && expr.component === 'z')) refuse('type', 'Read components of vec2 or vec3; convert semantic vectors explicitly first.', at(expr.span));
          return { ...expr, vector: value, type: 'scalar' };
        }
        case 'choose': {
          const condition = check(expr.condition), yes = check(expr.yes), no = check(expr.no);
          if (condition.type !== 'bool' || yes.type !== no.type) refuse('type', 'A conditional needs a bool and two results of the same semantic type.', at(expr.span));
          return { ...expr, condition, yes, no, type: yes.type };
        }
        default: { const exhaustive: never = expr; return exhaustive; }
      }
    }
    const statements = parsed.statements.map((statement) => {
      const expression = check(statement.expression); bind(statement.name, expression.type, statement.span);
      return { ...statement, expression };
    });
    const result = check(parsed.result);
    if (result.type !== parsed.output) refuse('type', `This function promises ${parsed.output} but returns ${result.type}.`, at(result.span));
    return freezeMath({ ...parsed, statements, result });
  });
}

export function mathCalls(fn: ParsedMathFunction | TypedMathFunction): readonly { readonly name: string; readonly span: SourceSpan }[] {
  const calls: { name: string; span: SourceSpan }[] = [];
  function visit(expr: MathExpression): void {
    switch (expr.kind) {
      case 'call': calls.push({ name: expr.name, span: expr.span }); expr.args.forEach(visit); break;
      case 'unary': visit(expr.operand); break;
      case 'binary': visit(expr.left); visit(expr.right); break;
      case 'choose': visit(expr.condition); visit(expr.yes); visit(expr.no); break;
      case 'component': visit(expr.vector); break;
      case 'number': case 'boolean': case 'variable': break;
      default: { const exhaustive: never = expr; return exhaustive; }
    }
  }
  fn.statements.forEach((statement) => visit(statement.expression)); visit(fn.result);
  return calls;
}

export const mathIntervalSchema = z.strictObject({ min: z.number().min(-MATH_FLOAT_MAX).max(MATH_FLOAT_MAX),
  max: z.number().min(-MATH_FLOAT_MAX).max(MATH_FLOAT_MAX) }).readonly();
export const mathRangeSchema = z.array(mathIntervalSchema).min(1).max(3).readonly();
export function mathTypeRange(type: MathType): MathRange {
  const count = ['coord', 'cell', 'vec2'].includes(type) ? 2 : ['vec3', 'srgb', 'linear', 'oklab'].includes(type) ? 3 : 1;
  let min = -MATH_FLOAT_MAX, max = MATH_FLOAT_MAX;
  switch (type) {
    case 'noise': min = -1; max = 1; break;
    case 'coverage': case 'pressure': case 'bool': min = 0; max = 1; break;
    case 'seed': case 'hold': case 'cell': min = 0; max = 0xffffffff; break;
    case 'time': min = -0x7fffffff; max = 0x7fffffff; break;
    case 'coord': min = -0x3fffffff; max = 0x3fffffff; break;
    case 'scalar': case 'vec2': case 'vec3': case 'srgb': case 'linear': case 'oklab': break;
    default: { const exhaustive: never = type; return exhaustive; }
  }
  return freezeMath(Array.from({ length: count }, () => ({ min, max })));
}
export function mathRangeContains(domain: MathRange, range: MathRange): boolean {
  return domain.length === range.length && domain.every((interval, index) => {
    const value = range[index]; return value !== undefined && interval.min <= value.min && interval.max >= value.max;
  });
}
export function readMathRange(type: MathType, input: unknown, at = location('range')): MathResult<MathRange> {
  return mathAttempt(() => {
    const parsed = mathRangeSchema.safeParse(input);
    if (!parsed.success || parsed.data.some((bound) => bound.min > bound.max) || !mathRangeContains(mathTypeRange(type), parsed.data))
      refuse('domain', `Declare ordered finite bounds for every ${type} component within its semantic range.`, at);
    return parsed.data;
  });
}

export type MathOperatorRangeRule = { readonly name: string; readonly kind: 'operator' | 'builtin';
  readonly inputDomain: string; readonly outputRange: string; readonly refusalRule: string };
const arithmeticRefusal = 'Refuse when any intermediate float32 interval (including rounding and permitted subnormal flush to zero) is unbounded, nonfinite, or exceeds the finite float range.';
const helperRules: Readonly<Record<string, readonly [string, string, string]>> = {
  vec2: ['Two finite scalars.', 'Their component intervals.', arithmeticRefusal],
  vec3: ['Three finite scalars.', 'Their component intervals.', arithmeticRefusal],
  coord: ['Finite vec2.', 'Each component clamped to [-1073741823,1073741823].', 'Refuse nonfinite inputs.'],
  cells: ['Bounded coordinates; any finite size. Size is floored and raised to at least 1.', 'Wrapped uint32 integer cells.', 'Refuse coordinates outside the declared coordinate domain.'],
  hashNoise: ['Uint32 seed, hold and cells; finite channel floored and clamped to 0..2.', 'Signed noise [-1,1].', 'Refuse invalid semantic inputs; uint32 arithmetic wraps.'],
  holdAt: ['Integer composition time; finite count/length floored and clamped to 1..16777215.', 'Hold [0,16777214]; negative time wraps.', 'Refuse invalid time; clamped counts cannot be zero.'],
  noise: ['Finite scalar.', '[-1,1], clamped including out-of-range inputs.', 'Refuse nonfinite inputs.'],
  coverage: ['Finite scalar.', '[0,1], clamped including out-of-range inputs.', 'Refuse nonfinite inputs.'],
  value: ['Noise, coverage, pressure or integer time.', 'The same interval (time encloses float32 conversion).', 'Refuse implicit semantic conversion.'],
  rgb: ['Finite sRGB channels.', 'Unchanged channel intervals.', 'Refuse nonfinite channels.'],
  srgb: ['Finite vec3.', '[0,1] per channel, clamped.', 'Refuse nonfinite channels.'],
  lab: ['Finite Oklab.', 'Unchanged channel intervals.', 'Refuse nonfinite channels.'],
  oklab: ['Finite vec3.', 'Unchanged channel intervals.', 'Refuse nonfinite channels.'],
  toOklab: ['Finite sRGB clamped to [0,1] before transfer and positive LMS powers.', 'Bounds propagated through the legacy transfer and Oklab matrices.', arithmeticRefusal],
  fromOklab: ['Oklab whose root sums, cubes, inverse matrix and transfer are provably finite.', 'Out-of-gamut sRGB intervals; caller explicitly clamps.', arithmeticRefusal],
  toLinear: ['Finite sRGB clamped to [0,1] before transfer.', '[0,1] with float32 rounding enclosure.', arithmeticRefusal],
  fromLinear: ['Finite linear channels with provably finite transfer intermediates; power uses max(channel,0).', 'Propagated sRGB intervals, including negative channels.', arithmeticRefusal],
  clampSrgb: ['Finite sRGB.', '[0,1] per channel.', 'Refuse nonfinite channels.'],
  abs: ['Finite scalar.', 'Absolute interval.', arithmeticRefusal],
  floor: ['Finite scalar.', 'Floored interval.', arithmeticRefusal],
  min: ['Two finite scalars.', 'Componentwise minimum interval.', arithmeticRefusal],
  max: ['Two finite scalars.', 'Componentwise maximum interval.', arithmeticRefusal],
  clamp: ['Finite value and edges; edges are sorted, including equal/reversed edges.', 'The value constrained by the sorted edges.', 'Refuse nonfinite inputs.'],
  step: ['Finite edge and value.', '0 below edge; 1 at/above edge.', 'Refuse nonfinite inputs.'],
  smoothstep: ['Finite edges/value. Equal/reversed or zero/subnormal half-width edges use step(firstEdge,value); outside edges saturates.', '[0,1]; guarded half-scaled ratio prevents width overflow.', 'Refuse nonfinite inputs; helper defines every edge case.'],
  mix: ['Finite a,b,t with finite intermediates a*(1-t), b*t and their sum.', 'Interval of a*(1-t)+b*t; extrapolation is explicit.', arithmeticRefusal],
};
/** Admission rules, also exposed on the trusted shader registry. No partial transcendental operator is public. */
export const MATH_OPERATOR_TABLE: readonly MathOperatorRangeRule[] = freezeMath([
  { name: '+', kind: 'operator', inputDomain: 'Finite scalars or matching generic vectors; semantic values must be explicitly converted.',
    outputRange: '[a.min+b.min,a.max+b.max] per component, enclosed for float32 rounding/flush.', refusalRule: arithmeticRefusal },
  { name: '-', kind: 'operator', inputDomain: 'Finite scalars or matching generic vectors; unary minus accepts either.',
    outputRange: 'Binary [a.min-b.max,a.max-b.min]; unary [-a.max,-a.min], enclosed per component.', refusalRule: arithmeticRefusal },
  { name: '*', kind: 'operator', inputDomain: 'Finite scalars, matching generic vectors, or a vector and scalar.',
    outputRange: 'Hull of a.min*b.min, a.min*b.max, a.max*b.min, a.max*b.max, enclosed per component.', refusalRule: arithmeticRefusal },
  { name: '/', kind: 'operator', inputDomain: 'Finite numerator; divisor interval strictly positive or negative, at least the smallest normal float from zero.',
    outputRange: 'Hull of a.min/b.min, a.min/b.max, a.max/b.min, a.max/b.max, enclosed per component.', refusalRule: 'Refuse a divisor that may be zero, underflow to zero, or an unbounded/nonfinite quotient.' },
  ...['<', '<=', '>', '>=', '==', '!='].map((name): MathOperatorRangeRule => ({ name, kind: 'operator', inputDomain: 'Finite scalars.', outputRange: 'Bool [0,1].', refusalRule: 'Refuse incompatible semantic types.' })),
  { name: '!', kind: 'operator', inputDomain: 'Boolean truth value.', outputRange: 'Bool [0,1].', refusalRule: 'Refuse non-bool inputs.' },
  { name: '?:', kind: 'operator', inputDomain: 'Bool condition; both branches independently admitted with matching types.',
    outputRange: 'Union of the branch intervals.', refusalRule: 'Refuse an unsafe or unprovable branch; a condition is not a range proof.' },
  { name: '.', kind: 'operator', inputDomain: 'An available component of a generic vec2/vec3.', outputRange: 'That component interval.', refusalRule: 'Refuse unavailable or implicit semantic components.' },
  ...MATH_BUILTINS.map((entry): MathOperatorRangeRule => {
    const rule = helperRules[entry.name]; if (!rule) throw new Error(`Missing range rule for ${entry.name}.`);
    return { name: entry.name, kind: 'builtin', inputDomain: rule[0], outputRange: rule[1], refusalRule: rule[2] };
  }),
]);

function nextFloat(value: number, up: boolean): number {
  if (value === 0) return up ? 2 ** -149 : -(2 ** -149);
  const view = new DataView(new ArrayBuffer(4)); view.setFloat32(0, value);
  view.setUint32(0, view.getUint32(0) + ((value > 0) === up ? 1 : -1));
  return view.getFloat32(0);
}
function encloseFloat(bound: MathInterval): MathInterval {
  const low = Math.fround(bound.min), high = Math.fround(bound.max);
  const min = low > bound.min ? nextFloat(low, false) : low, max = high < bound.max ? nextFloat(high, true) : high;
  // GLSL ES implementations may flush subnormal inputs or intermediates to zero.
  return { min: min > 0 && min < MATH_FLOAT_MIN_NORMAL ? 0 : min,
    max: max < 0 && max > -MATH_FLOAT_MIN_NORMAL ? 0 : max };
}
const floatRange = (range: MathRange): MathRange => range.map(encloseFloat);
/** Canonical execution envelope of validated bounds, including float rounding/flush. Integer domains remain exact. */
export function mathExecutionRange(type: MathType, range: MathRange): MathRange {
  return freezeMath(['seed', 'hold', 'cell', 'time', 'bool'].includes(type) ? range.map((bound) => ({ ...bound })) : floatRange(range));
}
export type MathFunctionRanges = { readonly inputs: readonly MathRange[]; readonly output: MathRange;
  readonly expressions: readonly { readonly span: SourceSpan; readonly range: MathRange }[] };
export type MathRangeResolver = (name: string, args: readonly MathRange[], at: MathLocation) => MathRange;

/** A typed AST is not admitted until this proof succeeds over all declared inputs. */
export function admitMathFunction(parsed: TypedMathFunction, sourceId: string,
  dependencies?: MathRangeResolver, inputs: readonly MathRange[] = parsed.inputs.map((port) => port.range)): MathResult<MathFunctionRanges> {
  return mathAttempt(() => {
    const at = (span: SourceSpan): MathLocation => ({ sourceId, span, path: null });
    const checked = (min: number, max: number, where: MathLocation, operation: string): MathInterval => {
      if (!Number.isFinite(min) || !Number.isFinite(max) || min < -MATH_FLOAT_MAX || max > MATH_FLOAT_MAX)
        refuse('domain', `Cannot prove ${operation} stays finite within the float range for every declared input. Narrow its input ranges.`, where);
      return encloseFloat({ min, max });
    };
    const constant = (n: number): MathInterval => encloseFloat({ min: n, max: n });
    const scalar = (range: MathRange): MathInterval => {
      const first = range[0]; if (!first || range.length !== 1) throw new Error('A typed scalar range had the wrong shape.'); return first;
    };
    function operation(name: string, a: MathInterval, b: MathInterval, where: MathLocation): MathInterval {
      switch (name) {
        case '+': return checked(a.min + b.min, a.max + b.max, where, 'addition');
        case '-': return checked(a.min - b.max, a.max - b.min, where, 'subtraction');
        case '*': { const products = [a.min * b.min, a.min * b.max, a.max * b.min, a.max * b.max]; return checked(Math.min(...products), Math.max(...products), where, 'multiplication'); }
        case '/': {
          if (b.min <= 0 && b.max >= 0) refuse('domain', 'The divisor may be zero after float rounding or underflow. Use a range that stays away from zero or a trusted remap helper.', where);
          if (Math.min(Math.abs(b.min), Math.abs(b.max)) < MATH_FLOAT_MIN_NORMAL) refuse('domain', 'The divisor may underflow to zero on the GPU. Use a normal nonzero range or a trusted remap helper.', where);
          const quotients = [a.min / b.min, a.min / b.max, a.max / b.min, a.max / b.max];
          return checked(Math.min(...quotients), Math.max(...quotients), where, 'division');
        }
        default: throw new Error('A typed interval operator is unavailable.');
      }
    }
    const clipped = (a: MathInterval, min: number, max: number): MathInterval => ({ min: Math.max(min, Math.min(max, a.min)), max: Math.max(min, Math.min(max, a.max)) });
    const hull = (a: MathInterval, b: MathInterval): MathInterval => ({ min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) });
    const dot = (values: MathRange, coefficients: readonly number[], where: MathLocation): MathInterval => {
      const terms = values.map((value, index) => operation('*', value, constant(coefficients[index] ?? 0), where));
      const first = terms[0]; if (!first) throw new Error('A color matrix row had no components.');
      return terms.slice(1).reduce((sum, term) => operation('+', sum, term, where), first);
    };
    const power = (base: MathInterval, exponent: MathInterval, where: MathLocation): MathInterval => {
      if (base.min < 0 || exponent.min <= 0) refuse('domain', 'The trusted color power needs a nonnegative base and a positive exponent.', where);
      const values = [base.min ** exponent.min, base.min ** exponent.max, base.max ** exponent.min, base.max ** exponent.max];
      return checked(Math.min(...values), Math.max(...values), where, 'color power');
    };
    const transfer = (a: MathInterval, where: MathLocation): MathInterval => {
      // Both GLSL mix branches are bounded; the power's base is explicitly max(v,0).
      const lower = operation('*', a, constant(12.92), where);
      const raised = power({ min: Math.max(0, a.min), max: Math.max(0, a.max) }, operation('/', constant(1), constant(2.4), where), where);
      const upper = operation('-', operation('*', raised, constant(1.055), where), constant(0.055), where);
      return hull(lower, upper);
    };
    const forwardTransfer = (a: MathInterval, where: MathLocation): MathInterval => {
      const normalized = clipped(a, 0, 1), lower = operation('/', normalized, constant(12.92), where);
      const base = operation('/', operation('+', normalized, constant(0.055), where), constant(1.055), where);
      const upper = power(base, constant(2.4), where);
      return hull(lower, upper);
    };
    function builtinRange(name: string, args: readonly MathRange[], where: MathLocation): MathRange {
      const arg = (index: number): MathRange => { const range = args[index]; if (!range) throw new Error('A typed builtin argument is missing.'); return range; };
      const a = (): MathInterval => scalar(arg(0)), b = (): MathInterval => scalar(arg(1)), c = (): MathInterval => scalar(arg(2));
      switch (name) {
        case 'vec2': case 'vec3': return args.map(scalar);
        case 'value': return floatRange(arg(0));
        case 'rgb': case 'lab': case 'oklab': return arg(0);
        case 'coord': return arg(0).map((v) => encloseFloat(clipped(v, -0x3fffffff, 0x3fffffff)));
        case 'cells': return mathTypeRange('cell');
        case 'hashNoise': return mathTypeRange('noise');
        case 'holdAt': return [{ min: 0, max: 0xfffffe }];
        case 'noise': return [clipped(a(), -1, 1)];
        case 'coverage': return [clipped(a(), 0, 1)];
        case 'srgb': case 'clampSrgb': return arg(0).map((v) => clipped(v, 0, 1));
        case 'toLinear': return arg(0).map((v) => forwardTransfer(v, where));
        case 'toOklab': {
          const linear = arg(0).map((v) => forwardTransfer(v, where));
          const roots = [[0.4122214708, 0.5363325363, 0.0514459929], [0.2119034982, 0.6806995451, 0.1073969566],
            [0.0883024619, 0.2817188376, 0.6299787005]].map((row) => {
            return power(dot(linear, row, where), operation('/', constant(1), constant(3), where), where);
          });
          return [[0.2104542553, 0.793617785, -0.0040720468], [1.9779984951, -2.428592205, 0.4505937099],
            [0.0259040371, 0.7827717662, -0.808675766]].map((row) => dot(roots, row, where));
        }
        case 'fromOklab': {
          const roots = [[1, 0.3963377774, 0.2158037573], [1, -0.1055613458, -0.0638541728], [1, -0.0894841775, -1.291485548]]
            .map((row) => dot(arg(0), row, where));
          const cubes = roots.map((v) => operation('*', operation('*', v, v, where), v, where));
          return [[4.0767416621, -3.3077115913, 0.2309699292], [-1.2684380046, 2.6097574011, -0.3413193965],
            [-0.0041960863, -0.7034186147, 1.707614701]].map((row) => transfer(dot(cubes, row, where), where));
        }
        case 'fromLinear': return arg(0).map((v) => transfer(v, where));
        case 'abs': return [checked(a().min <= 0 && a().max >= 0 ? 0 : Math.min(Math.abs(a().min), Math.abs(a().max)), Math.max(Math.abs(a().min), Math.abs(a().max)), where, 'absolute value')];
        case 'floor': return [checked(Math.floor(a().min), Math.floor(a().max), where, 'floor')];
        case 'min': return [{ min: Math.min(a().min, b().min), max: Math.min(a().max, b().max) }];
        case 'max': return [{ min: Math.max(a().min, b().min), max: Math.max(a().max, b().max) }];
        case 'clamp': {
          const clamp = (n: number, x: number, y: number): number => Math.max(Math.min(x, y), Math.min(Math.max(x, y), n));
          return [{ min: clamp(a().min, b().min, c().min), max: clamp(a().max, b().max, c().max) }];
        }
        case 'step': return [{ min: b().min >= a().max ? 1 : 0, max: b().max < a().min ? 0 : 1 }];
        case 'smoothstep': return [{ min: 0, max: 1 }];
        case 'mix': return [operation('+', operation('*', a(), operation('-', constant(1), c(), where), where), operation('*', b(), c(), where), where)];
        default: throw new Error(`Missing range proof for builtin ${name}.`);
      }
    }
    if (inputs.length !== parsed.inputs.length) refuse('domain', 'Provide a range for every function input.', at(parsed.span));
    const variables = new Map<string, MathRange>();
    const executionInputs: MathRange[] = [];
    parsed.inputs.forEach((port, index) => {
      const range = inputs[index], valid = mathRangeSchema.safeParse(range);
      if (!valid.success || valid.data.some((v) => v.min > v.max)) refuse('domain', `Provide ordered finite component ranges for input ${port.name}.`, at(port.span));
      if (!range || !mathRangeContains(mathExecutionRange(port.type, port.range), mathExecutionRange(port.type, range)))
        refuse('domain', `Input ${port.name} is outside this function's declared range.`, at(port.span));
      const execution = mathExecutionRange(port.type, range); executionInputs.push(execution); variables.set(port.name, execution);
    });
    const expressions: { span: SourceSpan; range: MathRange }[] = [];
    function analyze(expr: TypedMathExpression): MathRange {
      const where = at(expr.span);
      let range: MathRange;
      switch (expr.kind) {
        case 'number': range = [constant(expr.value)]; break;
        case 'boolean': range = [{ min: Number(expr.value), max: Number(expr.value) }]; break;
        case 'variable': { const value = variables.get(expr.name); if (!value) throw new Error('A typed range variable is missing.'); range = value; break; }
        case 'call': {
          const args = expr.args.map(analyze);
          if (MATH_BUILTINS.some((fn) => fn.name === expr.name)) range = builtinRange(expr.name, args, where);
          else if (dependencies) range = dependencies(expr.name, args, where);
          else refuse('missing', `Pinned range proof for ${expr.name} is missing.`, where);
          break;
        }
        case 'unary': range = expr.operator === '!' ? [{ min: 0, max: 1 }] : analyze(expr.operand).map((v) => checked(-v.max, -v.min, where, 'negation'));
          if (expr.operator === '!') analyze(expr.operand); break;
        case 'binary': {
          const left = analyze(expr.left), right = analyze(expr.right);
          if (expr.type === 'bool') range = [{ min: 0, max: 1 }];
          else range = Array.from({ length: Math.max(left.length, right.length) }, (_, index) => {
            const a = left[left.length === 1 ? 0 : index], b = right[right.length === 1 ? 0 : index];
            if (!a || !b) throw new Error('A typed vector interval is missing.'); return operation(expr.operator, a, b, where);
          });
          break;
        }
        case 'component': { const vector = analyze(expr.vector), value = vector[{ x: 0, y: 1, z: 2 }[expr.component]];
          if (!value) throw new Error('A typed component interval is missing.'); range = [value]; break; }
        case 'choose': {
          analyze(expr.condition); const yes = analyze(expr.yes), no = analyze(expr.no);
          range = yes.map((value, index) => { const other = no[index]; if (!other) throw new Error('A typed branch interval is missing.'); return hull(value, other); }); break;
        }
        default: { const exhaustive: never = expr; return exhaustive; }
      }
      expressions.push({ span: expr.span, range }); return range;
    }
    parsed.statements.forEach((statement) => variables.set(statement.name, analyze(statement.expression)));
    const output = analyze(parsed.result);
    return freezeMath({ inputs: executionInputs, output, expressions });
  });
}
