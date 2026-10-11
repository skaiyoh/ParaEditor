// The import-graph checker: reads every module under a source root, finds each
// import (static, `export ... from`, dynamic `import()`, and `import('...')`
// types, type-only ones included), resolves it, and reports every edge the
// dependency direction forbids. docs/ARCHITECTURE.md ("Module map and the
// import graph") states the rules; test/import-graph.test.ts runs this on src/
// and on synthetic trees.
//
// The modules are parsed by the pinned TypeScript compiler, through its API
// (`typescript/unstable/sync`), and the imports are the ones the compiler
// collects for the file (`SourceFile.imports`), so an import is found exactly
// where the compiler finds one. A module the compiler cannot parse, a dynamic
// `import()` whose specifier is not a string literal, a `require()` call, and
// an import form this checker does not recognize are each reported as a
// violation.

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Node, SourceFile } from 'typescript/unstable/ast';
import { SyntaxKind } from 'typescript/unstable/ast';
import {
  isCallExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportTypeNode,
  isLiteralTypeNode,
  isNamedExports,
  isNamedImports,
  isStringLiteralLikeNode,
} from 'typescript/unstable/ast/is';
import { API, DiagnosticCategory } from 'typescript/unstable/sync';

export type ImportRecord = {
  readonly line: number;
  readonly specifier: string;
  readonly kind: 'static' | 'dynamic' | 're-export' | 'import-type';
  /** `import type`, `export type`, or an `import('...')` type; `import { type X }` is not, since it keeps a runtime import. */
  readonly typeOnly: boolean;
  /** The imported names of a `{ ... }` clause, or an `import('...')` type's qualifier, and nothing else; null for any other form. */
  readonly names: readonly string[] | null;
};

export type Violation = { readonly file: string; readonly line: number; readonly specifier: string | null; readonly rule: string };

/** What the compiler made of one module: its imports, or the reasons it cannot be checked. */
export type ModuleImports = { readonly imports: readonly ImportRecord[]; readonly unreadable: readonly { readonly line: number; readonly reason: string }[] };

const lineOf = (sf: SourceFile, node: Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

/** The record for one specifier node of `SourceFile.imports`, or null when its form is not one this checker knows. */
function recordOf(sf: SourceFile, specifier: Node): ImportRecord | null {
  if (!isStringLiteralLikeNode(specifier)) return null;
  const { parent } = specifier;
  const text = specifier.text;
  if (isImportDeclaration(parent)) {
    const clause = parent.importClause;
    const bindings = clause?.namedBindings;
    return {
      line: lineOf(sf, parent),
      specifier: text,
      kind: 'static',
      typeOnly: clause?.phaseModifier === SyntaxKind.TypeKeyword,
      names: bindings !== undefined && isNamedImports(bindings) ? bindings.elements.map((e) => (e.propertyName ?? e.name).text) : null,
    };
  }
  if (isExportDeclaration(parent)) {
    const clause = parent.exportClause;
    return {
      line: lineOf(sf, parent),
      specifier: text,
      kind: 're-export',
      typeOnly: parent.isTypeOnly,
      names: clause !== undefined && isNamedExports(clause) ? clause.elements.map((e) => (e.propertyName ?? e.name).text) : null,
    };
  }
  if (isCallExpression(parent) && parent.expression.kind === SyntaxKind.ImportKeyword) {
    return { line: lineOf(sf, parent), specifier: text, kind: 'dynamic', typeOnly: false, names: null };
  }
  if (isLiteralTypeNode(parent) && isImportTypeNode(parent.parent)) {
    const { qualifier } = parent.parent;
    return { line: lineOf(sf, parent.parent), specifier: text, kind: 'import-type', typeOnly: true, names: qualifier !== undefined && isIdentifier(qualifier) ? [qualifier.text] : null };
  }
  if (isExternalModuleReference(parent) && isImportEqualsDeclaration(parent.parent)) {
    return { line: lineOf(sf, parent.parent), specifier: text, kind: 'static', typeOnly: parent.parent.isTypeOnly, names: null };
  }
  return null;
}

/** Calls the compiler leaves out of `SourceFile.imports` that still load a module: a computed `import()` and `require()`. */
function uncheckableCalls(sf: SourceFile): readonly { readonly line: number; readonly reason: string }[] {
  const found: { readonly line: number; readonly reason: string }[] = [];
  const visit = (node: Node): undefined => {
    if (isCallExpression(node)) {
      const [first] = node.arguments;
      if (node.expression.kind === SyntaxKind.ImportKeyword && (first === undefined || !isStringLiteralLikeNode(first))) {
        found.push({ line: lineOf(sf, node), reason: 'a dynamic import() whose specifier is not a string literal cannot be checked' });
      } else if (isIdentifier(node.expression) && node.expression.text === 'require') {
        found.push({ line: lineOf(sf, node), reason: 'a module loads others with import, never require()' });
      }
    }
    return node.forEachChild(visit);
  };
  sf.forEachChild(visit);
  return found;
}

/**
 * Parses `rels` (paths under `root`) in one compiler session. The project is a
 * tsconfig served from memory that lists exactly these files and resolves
 * nothing, so only parsing happens.
 */
export function readImports(root: string, rels: readonly string[]): ReadonlyMap<string, ModuleImports> {
  const config = path.join(root, '__import-graph.tsconfig.json');
  const json = JSON.stringify({
    compilerOptions: { noLib: true, noResolve: true, types: [], jsx: 'preserve', module: 'preserve', target: 'esnext', allowImportingTsExtensions: true, noEmit: true },
    files: rels.map((rel) => path.join(root, rel)),
  });
  const api = new API({
    cwd: root,
    fs: { readFile: (name) => (name === config ? json : undefined), fileExists: (name) => (name === config ? true : undefined) },
  });
  try {
    const project = api.updateSnapshot({ openProjects: [config] }).getProject(config);
    if (project === undefined) throw new Error(`the compiler did not open ${config}`);
    const result = new Map<string, ModuleImports>();
    for (const rel of rels) {
      const file = path.join(root, rel);
      const sf = project.program.getSourceFile(file);
      if (sf === undefined) throw new Error(`the compiler did not load ${file}`);
      const unreadable = project.program
        .getSyntacticDiagnostics(file)
        .filter((d) => d.category === DiagnosticCategory.Error)
        .map((d) => ({ line: sf.getLineAndCharacterOfPosition(d.pos).line + 1, reason: `the module does not parse: ${d.text}` }));
      const imports: ImportRecord[] = [];
      for (const specifier of sf.imports) {
        const record = recordOf(sf, specifier);
        if (record === null) unreadable.push({ line: lineOf(sf, specifier), reason: 'an import of a form this checker does not recognize' });
        else imports.push(record);
      }
      unreadable.push(...uncheckableCalls(sf));
      result.set(rel, { imports, unreadable });
    }
    return result;
  } finally {
    api.close();
  }
}

// The module map.

const LEAVES = ['photo', 'analysis', 'render', 'export', 'store', 'scenefile', 'projects'] as const;
type Leaf = (typeof LEAVES)[number];
const DIRECTORIES = ['app', 'core', 'platform', 'session', 'ui', 'dev', ...LEAVES] as const;
type ModuleName = 'main' | (typeof DIRECTORIES)[number];
type ModuleFile = { readonly rel: string; readonly module: ModuleName };

const isLeaf = (m: ModuleName): m is Leaf => LEAVES.some((l) => l === m);
const isDirectory = (top: string): top is (typeof DIRECTORIES)[number] => DIRECTORIES.some((d) => d === top);

function moduleOf(rel: string): ModuleName | null {
  if (rel === 'main.tsx' || rel === 'gallery.ts') return 'main';
  const [top, ...rest] = rel.split('/');
  return top !== undefined && rest.length > 0 && isDirectory(top) ? top : null;
}

/** The modules that may use preact, and so the only ones that may be .tsx (JSX imports preact/jsx-runtime). */
const PREACT_MODULES: ReadonlySet<ModuleName> = new Set(['ui', 'app', 'main', 'dev']);

/** Each package a source may import, and who may import it; any other package is a violation. */
type PackageRule = { readonly allowed: (f: ModuleFile) => boolean; readonly rule: string };
const PACKAGES: ReadonlyMap<string, PackageRule> = new Map([
  ['zod', { allowed: (f) => f.rel === 'core/zod.ts', rule: 'only core/zod.ts imports the zod package; import `z` from core/zod.ts' }],
  ['preact', { allowed: (f) => PREACT_MODULES.has(f.module), rule: 'only ui/, app/, main.tsx, and dev/ import preact' }],
  ['mediabunny', { allowed: (f) => f.module === 'export', rule: 'only export/ imports mediabunny' }],
  ['noisy:vendor-ort', { allowed: (f) => f.module === 'analysis' || f.module === 'dev', rule: 'only analysis/ and dev/ import noisy:vendor-ort' }],
] satisfies readonly (readonly [string, PackageRule])[]);

function packageName(specifier: string): string {
  if (specifier.includes(':')) return specifier;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

/** The rule an edge between two modules of the map breaks, or null when the direction allows it. */
function edgeRule(from: ModuleFile, to: ModuleFile, imp: ImportRecord): string | null {
  if (to.module === 'main') return `nothing imports ${to.rel}`;
  if (to.module === 'dev' && from.module !== 'dev') return 'the dev pages are entries: nothing outside dev/ imports them';
  if (to.module === 'app') {
    if (from.module === 'main' || from.module === 'app') return null;
    if (from.module === 'dev') return imp.typeOnly ? null : 'a dev page imports app/ with `import type` only';
    return 'only main.tsx imports app/';
  }
  const within = (...allowed: readonly ModuleName[]): boolean => allowed.includes(to.module);
  switch (from.module) {
    case 'main':
    case 'app':
      return null;
    case 'core':
      return within('core') ? null : 'core imports only core';
    case 'platform':
      return within('platform') || to.rel === 'core/ids.ts' ? null : 'platform imports only platform and core/ids.ts';
    case 'session':
      return within('session', 'core', 'platform') || isLeaf(to.module) ? null : 'session imports only session, the leaves, core, and platform';
    case 'ui':
      return within('ui', 'session', 'core') ? null : 'ui imports only ui, session, and core';
    case 'dev':
      return within('dev', 'core', 'platform', 'analysis', 'store') ? null : 'a dev page imports only dev/, core, platform, analysis, store, and app/ types';
    case 'photo':
    case 'analysis':
    case 'render':
    case 'export':
    case 'store':
    case 'scenefile':
    case 'projects': {
      if (within(from.module, 'core', 'platform')) return null;
      if (from.module === 'export' && to.module === 'render') {
        const onlyRenderer = imp.typeOnly && imp.names !== null && imp.names.length > 0 && imp.names.every((n) => n === 'Renderer');
        return onlyRenderer ? null : 'export imports from render only `import type { Renderer }`';
      }
      return `a leaf imports only itself, core, and platform`;
    }
    default: {
      const exhaustive: never = from.module;
      return exhaustive;
    }
  }
}

async function listFiles(root: string, dir = ''): Promise<readonly string[]> {
  const entries = await readdir(path.join(root, dir), { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((e) => {
      const rel = dir === '' ? e.name : `${dir}/${e.name}`;
      return e.isDirectory() ? listFiles(root, rel) : Promise.resolve([rel]);
    }),
  );
  return nested.flat().sort();
}

const SCRIPT = /\.(?:[cm]?[jt]sx?)$/;

/** Every violation of the dependency direction under `root`, in file and line order; empty when the graph holds. */
export async function checkImportGraph(root: string): Promise<readonly Violation[]> {
  const files = await listFiles(root);
  const present = new Set(files);
  const violations: Violation[] = [];
  const modules: ModuleFile[] = [];
  for (const rel of files) {
    if (!SCRIPT.test(rel) || rel.endsWith('.d.ts')) continue;
    if (!rel.endsWith('.ts') && !rel.endsWith('.tsx')) {
      violations.push({ file: rel, line: 0, specifier: null, rule: 'modules under the source root are .ts or .tsx' });
      continue;
    }
    const module = moduleOf(rel);
    if (module === null) {
      violations.push({ file: rel, line: 0, specifier: null, rule: 'the file is outside the module map' });
      continue;
    }
    if (rel.endsWith('.tsx') && !PREACT_MODULES.has(module)) {
      violations.push({ file: rel, line: 0, specifier: null, rule: 'a .tsx module uses JSX, which imports preact, and only ui/, app/, main.tsx, and dev/ import preact' });
    }
    modules.push({ rel, module });
  }
  const parsed = modules.length === 0 ? new Map<string, ModuleImports>() : readImports(root, modules.map((m) => m.rel));
  for (const from of modules) {
    const { rel } = from;
    const found = parsed.get(rel);
    if (found === undefined) throw new Error(`no parse of ${rel}`);
    const own: Violation[] = found.unreadable.map((u) => ({ file: rel, line: u.line, specifier: null, rule: `the checker cannot read the module: ${u.reason}` }));
    const report = (imp: ImportRecord, rule: string): void => {
      own.push({ file: rel, line: imp.line, specifier: imp.specifier, rule });
    };
    for (const imp of found.imports) {
      const { specifier } = imp;
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), specifier));
        if (target.startsWith('../')) {
          report(imp, 'the import leaves the source root');
          continue;
        }
        if (!present.has(target) || !SCRIPT.test(target) || target.endsWith('.d.ts')) {
          report(imp, 'the import does not name a module file, extension and case exact');
          continue;
        }
        const targetModule = moduleOf(target);
        if (targetModule === null) continue; // reported as outside the module map at its own file
        const rule = edgeRule(from, { rel: target, module: targetModule }, imp);
        if (rule !== null) report(imp, rule);
        continue;
      }
      if (specifier.startsWith('/')) {
        report(imp, 'the import is an absolute path');
        continue;
      }
      const name = packageName(specifier);
      const pkg = PACKAGES.get(name);
      if (pkg === undefined) report(imp, `${name} is not a package any module may import`);
      else if (!pkg.allowed(from)) report(imp, pkg.rule);
    }
    violations.push(...own.sort((a, b) => a.line - b.line));
  }
  // Gallery has the same composition rules as main, with the additional view-only boundary.
  // Check every reachable import, including types and re-exports, so an app/session hop cannot hide analysis.
  for (const first of parsed.get('gallery.ts')?.imports ?? []) {
    if (!first.specifier.startsWith('./') && !first.specifier.startsWith('../')) continue;
    const pending = [path.posix.normalize(first.specifier)];
    const seen = new Set<string>();
    for (let rel = pending.pop(); rel !== undefined; rel = pending.pop()) {
      if (seen.has(rel)) continue;
      seen.add(rel);
      if (moduleOf(rel) === 'analysis') {
        violations.push({ file: 'gallery.ts', line: first.line, specifier: first.specifier, rule: 'gallery entry cannot reach analysis/' });
        break;
      }
      for (const imp of parsed.get(rel)?.imports ?? []) {
        if (imp.specifier.startsWith('./') || imp.specifier.startsWith('../')) {
          pending.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), imp.specifier)));
        }
      }
    }
  }
  return violations.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
}
