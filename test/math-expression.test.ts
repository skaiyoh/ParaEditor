import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMathLibrary } from '../src/core/math-definition.ts';
import { admitMathFunction, MATH_BUILTINS, MATH_LIMITS, MATH_OPERATOR_TABLE, MATH_MAX_SOURCE_BYTES,
  MATH_MAX_EXPRESSION_NODES, MATH_MAX_FUNCTION_NODES_PER_BLOCK, MATH_MAX_BLOCKS_PER_RACK,
  MATH_MAX_FUNCTION_REVISIONS_PER_PROJECT, MATH_MAX_DRAFT_BYTES, parseMathFunction, typecheckMathFunction,
  type MathResult } from '../src/core/math-expression.ts';
import { evaluateMathFunction } from '../src/render/math-program.ts';

function value<T>(result: MathResult<T>): T { assert.ok(result.ok, JSON.stringify(result)); return result.value; }
function execute(source: string, inputs: readonly unknown[] = []) {
  const library = value(createMathLibrary([{ id: 'test', revision: 1, libraryRevision: 1, source, dependencies: [] }]));
  const fn = library.get({ id: 'test', revision: 1 }); assert.ok(fn);
  return value(evaluateMathFunction(library, fn, inputs));
}
function typed(source: string) { return typecheckMathFunction(value(parseMathFunction(source, 'test@1')), 'test@1'); }

test('straight-line source executes precedence, local bindings, vectors and conditionals', () => {
  assert.deepEqual(execute(`fn gl_FragCoord(x: scalar[-10,10]) -> scalar {
  // GLSL-reserved names are harmless because the compiler generates private names.
  let uniform = vec3(1.0, 2.0, 3.0) * x;
  return x > 0.0 ? uniform.y + 3.0 * 4.0 : -uniform.z;
}`, [{ type: 'scalar', value: 2 }]), { type: 'scalar', value: 16 });
  assert.deepEqual(execute('fn f() -> scalar { return !(1.0 < 2.0) ? 7.0 : 8.0 / 2.0; }'), { type: 'scalar', value: 4 });
});

test('noise-to-coverage is explicit and source edits change the running function', () => {
  const input = [{ type: 'noise', value: 0.25 }];
  assert.deepEqual(execute('fn f(n: noise) -> coverage { return coverage(value(n) * .5 + .5); }', input), { type: 'coverage', value: 0.625 });
  assert.deepEqual(execute('fn f(n: noise) -> coverage { return coverage(step(.5, value(n))); }', input), { type: 'coverage', value: 0 });
});

test('syntax refusals carry a user sentence and an actual source position', () => {
  const sources = [
    'fn f() -> scalar { return Math.random(); }',
    'fn f() -> scalar { for (;;) {} return 0; }',
    'fn f() -> scalar { while (true) {} return 0; }',
    'import f; fn f() -> scalar { return 0; }',
    'uniform sampler2D x; fn f() -> scalar { return 0; }',
    'fn f() -> scalar { return 1; } fn g() -> scalar { return 2; }',
    'fn f() -> scalar { return 1; let x = 2; }',
    'fn f() -> scalar { return `danger`; }',
    'fn f() -> scalar { return 1 % 2; }',
  ];
  for (const source of sources) {
    const result = parseMathFunction(source, 'bad@1');
    assert.ok(!result.ok, source);
    assert.ok(result.error.message.length > 10);
    assert.equal(result.error.sourceId, 'bad@1');
    assert.ok(result.error.span.start >= 0 && result.error.span.end <= source.length);
    assert.ok(result.error.span.line >= 1 && result.error.span.column >= 1);
  }
  const source = 'fn f() -> scalar {\n  let x = 1;\n  return @;\n}';
  const result = parseMathFunction(source, 'bad@2'); assert.ok(!result.ok);
  assert.deepEqual(result.error.span, { start: source.indexOf('@'), end: source.indexOf('@') + 1, line: 3, column: 10 });
});

test('type checker rejects implicit semantic conversions, bad calls, shadowing and undefined names', () => {
  for (const source of [
    'fn f(n: noise) -> coverage { return n; }',
    'fn f(n: noise) -> scalar { return n + 1; }',
    'fn f(c: srgb) -> scalar { return c.x; }',
    'fn f(c: srgb) -> srgb { return toOklab(c); }',
    'fn f(n: noise) -> coverage { return coverage(n); }',
    'fn f() -> scalar { return vec2(1, 2).z; }',
    'fn f() -> scalar { return 1 ? 2 : 3; }',
    'fn f() -> scalar { return true ? 2 : vec2(1, 2); }',
    'fn f(x: scalar, x: scalar) -> scalar { return x; }',
    'fn f(x: scalar) -> scalar { let x = 2; return x; }',
    'fn f(min: scalar) -> scalar { return min; }',
    'fn f() -> scalar { return clamp(1, 2); }',
    'fn f() -> scalar { return missing; }',
    'fn f() -> scalar { return constructor(1); }',
    'fn f() -> scalar { return globalThis(1); }',
  ]) {
    const result = typed(source); assert.ok(!result.ok, source);
    assert.ok(['type', 'missing'].includes(result.error.kind));
    assert.equal(result.error.sourceId, 'test@1');
  }
  const recursion = typed('fn f(n: scalar) -> scalar { return f(n); }');
  assert.ok(!recursion.ok); assert.equal(recursion.error.kind, 'cycle');
});

test('UTF-8 bytes, expression count, nesting and finite literals are bounded before execution', () => {
  const cases = [
    'fn f() -> scalar { return 0; } //' + 'a'.repeat(MATH_LIMITS.sourceBytes),
    'fn f() -> scalar { return 0; } //' + '😀'.repeat(1100),
    'fn f() -> scalar { return ' + Array.from({ length: 65 }, () => '1').join('+') + '; }',
    'fn f() -> scalar { return ' + '('.repeat(130) + '1' + ')'.repeat(130) + '; }',
  ];
  for (const source of cases) {
    const result = parseMathFunction(source); assert.ok(!result.ok);
    assert.equal(result.error.kind, 'budget');
  }
  const boundary = value(parseMathFunction('fn f() -> scalar { return ' + Array.from({ length: 64 }, () => '1').join('+') + '; }'));
  assert.equal(boundary.expressionCount, 127);
  for (const literal of ['1e999', '3.5e38']) {
    const result = parseMathFunction(`fn f() -> scalar { return ${literal}; }`); assert.ok(!result.ok); assert.equal(result.error.kind, 'value');
  }
});

test('numerical admission refuses unsafe or unprovable intermediates with source spans, never zero recovery', () => {
  const cases = [
    ['fn f(x: scalar) -> scalar { return 1.0 / x; }', '1.0 / x', /divisor may be zero/],
    ['fn f() -> scalar { return 1e38 * 1e38; }', '1e38 * 1e38', /multiplication/],
    ['fn f() -> vec2 { return vec2(1.0, 2.0) / 0.0; }', 'vec2(1.0, 2.0) / 0.0', /divisor may be zero/],
    ['fn f() -> scalar { return 1.0 / 1e-40; }', '1.0 / 1e-40', /underflow/],
    ['fn f() -> scalar { return 1.0 / ((1.0 + 0.00000001) - 1.0); }', '(1.0 + 0.00000001) - 1.0', /divisor may be zero/],
    ['fn f() -> scalar { return 1.0 / ((1e-38 * 0.1) * 1e38); }', '(1e-38 * 0.1) * 1e38', /underflow/],
    ['fn f() -> scalar { return 1.0 / (1e-40 * 1e38); }', '1e-40 * 1e38', /underflow/],
    ['fn f(x: scalar[1e-40,2e-40]) -> scalar { return 1.0 / (x * 1e38); }', 'x * 1e38', /underflow/],
    ['fn f() -> coverage { return coverage(1e38 * 1e38); }', '1e38 * 1e38', /multiplication/],
    ['fn f(x: scalar[-1,1]) -> scalar { return x == 0.0 ? 0.0 : 1.0 / x; }', '1.0 / x', /divisor may be zero/],
    ['fn f() -> srgb { return fromOklab(oklab(vec3(1e20, 0.0, 0.0))); }', 'fromOklab(', /multiplication/],
    ['fn f(c: linear) -> srgb { return fromLinear(c); }', 'fromLinear(', /multiplication/],
    ['fn f() -> scalar { return mix(1e38, 1e38, 1e38); }', 'mix(', /multiplication/],
  ] satisfies readonly (readonly [string, string, RegExp])[];
  for (const [source, marker, explanation] of cases) {
    assert.ok(parseMathFunction(source).ok, source); // Parsing alone is not admission.
    const result = createMathLibrary([{ id: 'bad', revision: 1, libraryRevision: 1, source, dependencies: [] }]);
    assert.ok(!result.ok, source); assert.match(result.error.message, explanation);
    assert.ok(['domain', 'type'].includes(result.error.kind)); assert.equal(result.error.sourceId, 'bad@1');
    assert.ok(source.slice(result.error.span.start, result.error.span.end).includes(marker), JSON.stringify(result));
    assert.ok(result.error.span.line >= 1 && result.error.span.column >= 1);
  }
  const source = 'fn f() -> scalar { return 1.0 / 0.0; }';
  const ast = value(typed(source)); assert.ok(!admitMathFunction(ast, 'bad@2').ok);
});

test('declared input ranges prove division and all vector intermediates and constrain runtime inputs', () => {
  const source = 'fn f(x: scalar[2,4]) -> scalar { let y = vec2(8.0, 16.0) / x; return y.x; }';
  const ast = value(typed(source)), proof = value(admitMathFunction(ast, 'safe@1'));
  assert.deepEqual(proof.inputs, [[{ min: 2, max: 4 }]]); assert.deepEqual(proof.output, [{ min: 2, max: 4 }]);
  assert.ok(proof.expressions.some((entry) => entry.range.length === 2));
  assert.deepEqual(execute(source, [{ type: 'scalar', value: 4 }]), { type: 'scalar', value: 2 });
  assert.deepEqual(execute('fn f(x: scalar[-4,-2]) -> scalar { return 8.0 / x; }', [{ type: 'scalar', value: -2 }]), { type: 'scalar', value: -4 });
  const library = value(createMathLibrary([{ id: 'safe', revision: 1, libraryRevision: 1, source, dependencies: [] }]));
  const fn = library.get({ id: 'safe', revision: 1 }); assert.ok(fn);
  const rejected = evaluateMathFunction(library, fn, [{ type: 'scalar', value: 0 }]); assert.ok(!rejected.ok); assert.equal(rejected.error.kind, 'domain');
  for (const bad of ['scalar[4,2]', 'noise[-2,1]', 'coverage[0,2]', 'vec3[0,1e999]']) assert.ok(!parseMathFunction(`fn f(x: ${bad}) -> scalar { return 0.0; }`).ok);
});

test('trusted remap/color helpers define equal, reversed, zero-width and out-of-range behavior', () => {
  assert.deepEqual(execute('fn f() -> scalar { return smoothstep(1.0, 0.0, 1.0); }'), { type: 'scalar', value: 1 });
  assert.deepEqual(execute('fn f() -> scalar { return smoothstep(0.5, 0.5, 0.4); }'), { type: 'scalar', value: 0 });
  assert.deepEqual(execute('fn f() -> scalar { return smoothstep(0.5, 0.5, 0.5); }'), { type: 'scalar', value: 1 });
  assert.deepEqual(execute('fn f() -> scalar { return smoothstep(1e-40, 2e-40, 1.5e-40); }'), { type: 'scalar', value: 1 });
  assert.deepEqual(execute('fn f() -> scalar { return smoothstep(0.0, 1.0, -3e38); }'), { type: 'scalar', value: 0 });
  assert.deepEqual(execute('fn f() -> scalar { return smoothstep(0.0, 1.0, 3e38); }'), { type: 'scalar', value: 1 });
  assert.deepEqual(execute('fn f() -> scalar { return clamp(2.0, 3.0, 1.0); }'), { type: 'scalar', value: 2 });
  assert.deepEqual(execute('fn f() -> scalar { return smoothstep(-3e38, 3e38, 3e38); }'), { type: 'scalar', value: 1 });
  assert.deepEqual(execute('fn f() -> scalar { return smoothstep(-3e38, 3e38, 0.0); }'), { type: 'scalar', value: 0.5 });
  assert.deepEqual(execute('fn f() -> oklab { return toOklab(fromOklab(oklab(vec3(-1.0, 0.0, 0.0)))); }'), { type: 'oklab', value: [0, 0, 0] });
});

test('public operator table covers every admitted operator/helper and named limits match the contract', () => {
  for (const name of ['+', '-', '*', '/', '<', '<=', '>', '>=', '==', '!=', '!', '?:', '.', ...MATH_BUILTINS.map((entry) => entry.name)]) {
    const rule = MATH_OPERATOR_TABLE.find((entry) => entry.name === name); assert.ok(rule, name);
    assert.ok(rule.inputDomain.length > 10 && rule.outputRange.length > 5 && rule.refusalRule.length > 10);
  }
  assert.deepEqual([MATH_MAX_SOURCE_BYTES, MATH_MAX_EXPRESSION_NODES, MATH_MAX_FUNCTION_NODES_PER_BLOCK,
    MATH_MAX_BLOCKS_PER_RACK, MATH_MAX_FUNCTION_REVISIONS_PER_PROJECT, MATH_MAX_DRAFT_BYTES], [4096, 128, 16, 8, 64, 16384]);
  const text = 'fn f() -> scalar { return 0; } //';
  assert.ok(parseMathFunction(text + 'a'.repeat(MATH_MAX_SOURCE_BYTES - text.length)).ok);
  assert.ok(!parseMathFunction(text + 'a'.repeat(MATH_MAX_SOURCE_BYTES - text.length + 1)).ok);
  const boundary = value(parseMathFunction('fn f() -> scalar { return -' + Array.from({ length: 64 }, () => '1').join('+') + '; }'));
  assert.equal(boundary.expressionCount, MATH_MAX_EXPRESSION_NODES);
});
