import { z } from './zod.ts';
import { byteLength, freezeMath, location, mathAttempt, mathCalls, MATH_BUILTINS, MATH_LIBRARY_REVISION,
  admitMathFunction, MATH_LIMITS, parseMathFunction, refuse, typecheckMathFunction, unwrapMath,
  type MathFunctionRanges, type MathLocation, type MathRange, type MathResult, type MathSignature,
  type ParsedMathFunction, type TypedMathFunction } from './math-expression.ts';

export const mathRefSchema = z.strictObject({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  revision: z.number().int().min(1).max(0x7fffffff) });
export type MathRef = Readonly<z.infer<typeof mathRefSchema>>;
export const mathRefKey = (ref: MathRef): string => `${ref.id}@${ref.revision}`;
const dependencySchema = z.strictObject({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), ref: mathRefSchema });
export const mathFunctionSourceSchema = z.strictObject({
  ...mathRefSchema.shape, libraryRevision: z.number().int(), source: z.string(),
  dependencies: z.array(dependencySchema).max(MATH_LIMITS.functionRevisions),
});
export type MathFunctionSource = Readonly<Omit<z.infer<typeof mathFunctionSourceSchema>, 'dependencies'>> & {
  readonly dependencies: readonly { readonly name: string; readonly ref: MathRef }[];
};
const functionProof: unique symbol = Symbol('validated math function');
export type MathFunctionDefinition = {
  readonly [functionProof]: true; readonly ref: MathRef; readonly source: MathFunctionSource;
  readonly label: 'Editable';
  readonly parsed: TypedMathFunction; readonly signature: MathSignature; readonly ranges: MathFunctionRanges;
  readonly evaluationSteps: number;
};
export type MathFunctionLibrary = {
  readonly definitions: readonly MathFunctionDefinition[];
  readonly sources: readonly MathFunctionSource[];
  readonly get: (ref: MathRef) => MathFunctionDefinition | undefined;
};

/** Admit external data from source only. There is no serialized AST to trust. */
export function createMathLibrary(input: unknown): MathResult<MathFunctionLibrary> {
  return mathAttempt(() => {
    const parsedSources = z.array(mathFunctionSourceSchema).safeParse(input);
    if (!parsedSources.success) {
      const issue = parsedSources.error.issues[0];
      refuse(issue?.code === 'too_big' ? 'budget' : 'syntax', `The function record is invalid: ${issue?.message ?? 'check its fields'}.`,
        location('library', '', 0, 0, '/' + (issue?.path ?? []).join('/')));
    }
    const pending = new Map<string, { source: MathFunctionSource; parsed: ParsedMathFunction }>();
    for (const source of parsedSources.data) {
      const key = mathRefKey(source), previous = pending.get(key);
      if (previous) {
        if (JSON.stringify(previous.source) !== JSON.stringify(source)) refuse('revision', `Revision ${key} has conflicting source. Save the edit under a new revision.`, location(key));
        continue;
      }
      if (source.libraryRevision !== MATH_LIBRARY_REVISION) refuse('revision', `Math library revision ${source.libraryRevision} is unavailable; this build supports revision ${MATH_LIBRARY_REVISION}.`, location(key));
      pending.set(key, { source, parsed: unwrapMath(parseMathFunction(source.source, key)) });
      if (pending.size > MATH_LIMITS.functionRevisions) refuse('budget', 'A project can include at most 64 unique function revisions.', location(key));
    }
    if (byteLength(JSON.stringify(parsedSources.data)) > MATH_LIMITS.recipeBytes) refuse('budget', 'The recipe exceeds 512 KiB.', location('library'));
    const completed = new Map<string, MathFunctionDefinition>(), visiting = new Set<string>();
    function visit(key: string): MathFunctionDefinition {
      const existing = completed.get(key);
      if (existing) return existing;
      const entry = pending.get(key);
      if (!entry) refuse('missing', `Function revision ${key} is missing.`, location(key));
      visiting.add(key);
      const signatures = new Map<string, MathSignature>(), costs = new Map<string, number>();
      const calls = mathCalls(entry.parsed);
      for (const dependency of entry.source.dependencies) {
        const span = calls.find((call) => call.name === dependency.name)?.span ?? entry.parsed.span;
        const at = { sourceId: key, span, path: `/dependencies/${dependency.name}` };
        if (signatures.has(dependency.name) || MATH_BUILTINS.some((fn) => fn.name === dependency.name)) refuse('type', `Dependency name ${dependency.name} is already in use.`, at);
        const target = mathRefKey(dependency.ref);
        if (visiting.has(target)) refuse('cycle', `Calling ${dependency.name} would create a function dependency cycle.`, at);
        if (!pending.has(target)) refuse('missing', `Pinned function ${target} is missing.`, at);
        const definition = visit(target);
        signatures.set(dependency.name, definition.signature); costs.set(dependency.name, definition.evaluationSteps);
      }
      const typed = unwrapMath(typecheckMathFunction(entry.parsed, key, signatures));
      let evaluationSteps = typed.expressionCount;
      for (const call of calls) {
        evaluationSteps += costs.get(call.name) ?? 0;
        if (evaluationSteps > MATH_LIMITS.evaluationSteps) refuse('budget', 'This function expands to more than 65536 expression evaluations. Simplify its dependency calls.', { sourceId: key, span: call.span, path: null });
      }
      const definition: MathFunctionDefinition = freezeMath({ [functionProof]: true, label: 'Editable', ref: { id: entry.source.id, revision: entry.source.revision },
        source: entry.source, parsed: typed, signature: { inputs: typed.inputs.map((input) => input.type), output: typed.output }, evaluationSteps,
        ranges: proveRanges(entry.source, typed, typed.inputs.map((port) => port.range), completed) });
      completed.set(key, definition); visiting.delete(key);
      return definition;
    }
    // Stable names and ordering regardless of import record ordering.
    [...pending.keys()].sort().forEach(visit);
    const definitions = Object.freeze([...completed.values()]);
    return Object.freeze({ definitions, sources: Object.freeze(definitions.map((definition) => definition.source)),
      get: (ref: MathRef) => completed.get(mathRefKey(ref)) });
  });
}

function proveRanges(source: MathFunctionSource, parsed: TypedMathFunction, inputs: readonly MathRange[],
  definitions: ReadonlyMap<string, MathFunctionDefinition>): MathFunctionRanges {
  return unwrapMath(admitMathFunction(parsed, mathRefKey(source), (name, args, at) => {
    const dependency = source.dependencies.find((entry) => entry.name === name);
    const target = dependency && definitions.get(mathRefKey(dependency.ref));
    if (!target) refuse('missing', `Pinned range proof for ${name} is missing.`, at);
    return proveRanges(target.source, target.parsed, args, definitions).output;
  }, inputs));
}

/** Re-proves the complete pinned closure over a graph's narrower input/parameter intervals. */
export function proveMathFunctionRanges(definition: MathFunctionDefinition, library: MathFunctionLibrary,
  inputs: readonly MathRange[] = definition.parsed.inputs.map((port) => port.range)): MathResult<MathFunctionRanges> {
  return mathAttempt(() => {
    if (library.get(definition.ref) !== definition) refuse('missing', 'Use the admitted function from this library for its range proof.', location(mathRefKey(definition.ref)));
    return proveRanges(definition.source, definition.parsed, inputs, new Map(library.definitions.map((fn) => [mathRefKey(fn.ref), fn])));
  });
}

/** Dependency-first closure, containing every pinned dependency exactly once. */
export function mathFunctionClosure(library: MathFunctionLibrary, roots: readonly MathRef[]): MathResult<readonly MathFunctionDefinition[]> {
  return mathAttempt(() => {
    const found = new Map<string, MathFunctionDefinition>();
    function visit(ref: MathRef): void {
      const key = mathRefKey(ref);
      if (found.has(key)) return;
      const definition = library.get(ref);
      if (!definition) refuse('missing', `Pinned function ${key} is missing.`, location(key));
      definition.source.dependencies.forEach((dependency) => visit(dependency.ref));
      found.set(key, definition);
    }
    roots.forEach(visit);
    return Object.freeze([...found.values()]);
  });
}

/** Forks are additive: neither the original library nor its existing references change. */
export function forkMathFunction(options: { readonly library: MathFunctionLibrary; readonly from: MathRef;
  readonly id: string; readonly source: string }): MathResult<MathFunctionLibrary> {
  return mathAttempt(() => {
    const base = options.library.get(options.from);
    if (!base) refuse('missing', `Function ${mathRefKey(options.from)} is missing.`, location(mathRefKey(options.from)));
    if (options.library.sources.some((source) => source.id === options.id)) refuse('revision', 'Give the fork a new definition id so existing uses stay pinned.', location(options.id));
    return unwrapMath(createMathLibrary([...options.library.sources, { ...base.source, id: options.id, revision: 1, source: options.source }]));
  });
}

/** Adds a revision without changing any existing pinned use. */
export function reviseMathFunction(options: { readonly library: MathFunctionLibrary; readonly from: MathRef;
  readonly revision: number; readonly source: string }): MathResult<MathFunctionLibrary> {
  return mathAttempt(() => {
    const base = options.library.get(options.from), at: MathLocation = location(mathRefKey(options.from));
    if (!base) refuse('missing', 'The function to revise is missing.', at);
    const latest = Math.max(...options.library.sources.filter((fn) => fn.id === base.ref.id).map((fn) => fn.revision));
    if (options.revision <= latest) refuse('revision', 'Save the edit under a revision newer than every existing revision of this function.', at);
    return unwrapMath(createMathLibrary([...options.library.sources, { ...base.source, revision: options.revision, source: options.source }]));
  });
}

const preset = (id: string, source: string): MathFunctionSource => ({ id, revision: 1, libraryRevision: MATH_LIBRARY_REVISION, source, dependencies: [] });
/** These strings, rather than a second handwritten algorithm, are the presets. */
export const MATH_PRESET_FUNCTIONS: readonly MathFunctionSource[] = freezeMath([
  preset('grain-cells', `fn grainCells(position: coord, size: scalar[1,4]) -> cell {
  return cells(position, size);
}`),
  preset('grain-noise', `fn grainNoise(seed: seed, hold: hold, cell: cell, channel: scalar[0,2]) -> noise {
  return hashNoise(seed, hold, cell, channel);
}`),
  preset('grain-remap', `fn identity(n: coverage) -> coverage {
  return n;
}`),
  preset('grain-curve', `fn curve(n: coverage) -> coverage {
  return coverage(smoothstep(0.0, 1.0, value(n)));
}`),
  preset('grain-threshold', `fn threshold(n: coverage) -> coverage {
  return coverage(step(0.5, value(n)));
}`),
  preset('texture-coverage', `fn textureCoverage(n: noise) -> coverage {
  return coverage(value(n) * 0.5 + 0.5);
}`),
  preset('coverage-noise', `fn signedNoise(n: coverage) -> noise {
  return noise(value(n) * 2.0 - 1.0);
}`),
  preset('grain-color', `fn grainColor(color: srgb[0,1], l: noise, a: noise, b: noise, amount: coverage, colorNoise: coverage, clarity: coverage) -> srgb {
  let scale = 1.0 - 0.5 * value(clarity);
  let original = lab(toOklab(color));
  let delta = vec3(0.12 * value(amount) * value(l), 0.06 * value(colorNoise) * value(a), 0.06 * value(colorNoise) * value(b));
  return clampSrgb(fromOklab(oklab(original + scale * delta)));
}`),
  preset('photo-contrast', `fn contrast(color: srgb[0,1], strength: scalar[0,3]) -> srgb {
  let middle = vec3(0.5, 0.5, 0.5);
  return srgb((rgb(color) - middle) * strength + middle);
}`),
]);
export const MATH_IDENTITY_REF: MathRef = Object.freeze({ id: 'grain-remap', revision: 1 });
/** Content as well as id/revision is checked; a fork or new revision is ordinary source. */
export function isPinnedMathPreset(definition: MathFunctionDefinition, id: string): boolean {
  const preset = MATH_PRESET_FUNCTIONS.find((entry) => entry.id === id);
  return preset !== undefined && JSON.stringify(definition.source) === JSON.stringify(preset);
}
