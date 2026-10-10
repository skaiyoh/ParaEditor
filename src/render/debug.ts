import type { RendererDebug } from './types.ts';

export type CellReadback = {
  readonly label: number; readonly entry: number; readonly band: number; readonly tone: number;
  readonly glyphIndex: number; readonly inkBand: number; readonly paperBand: number;
  readonly ink: readonly number[]; readonly paper: readonly number[];
};
export type LoopDebug = {
  geometryPixel(x: number, y: number): { readonly color: readonly number[]; readonly label: number };
  geometryEdgesCovered(): boolean;
  exportFrame(frame: number): Promise<Blob>;
  loopTiming(): { readonly frame: number | null; readonly lastMs: number };
};
export type SymbolsDebug = { readCellTable(cx: number, cy: number): CellReadback };

type ProbeSources = {
  readonly readPatch: RendererDebug['readSimplifiedPatch'];
  readonly finish: () => void;
  readonly profileCamera: () => Readonly<Record<string, number>>;
  readonly hashCells: () => readonly number[];
  readonly readCellTable: SymbolsDebug['readCellTable'];
  readonly exportFrame: LoopDebug['exportFrame'];
  readonly geometryEdgesCovered: LoopDebug['geometryEdgesCovered'];
  readonly geometryPixel: LoopDebug['geometryPixel'];
};

/** Clock access is isolated in this dev-only probe; it never feeds render inputs. */
export function createRenderProbe({ readPatch, finish, profileCamera, hashCells, readCellTable, exportFrame, geometryEdgesCovered, geometryPixel }: ProbeSources) {
  let lastMs = 0;
  let simplifyMs = 0;
  let frame: number | null = null;
  const debug: RendererDebug & SymbolsDebug & LoopDebug & { profileCamera(): Readonly<Record<string, number>>; hashCells(): readonly number[] } = {
    readSimplifiedPatch: readPatch, timings: () => ({ lastMs, simplifyMs }), profileCamera, hashCells, readCellTable,
    exportFrame, geometryEdgesCovered, geometryPixel, loopTiming: () => ({ frame, lastMs }),
  };
  return {
    debug,
    begin: (): number => performance.now(),
    end(start: number, index: number | null): void { finish(); lastMs = performance.now() - start; frame = index; },
    measure(draw: () => void, complete: () => void): number {
      const start = performance.now(); draw(); complete(); return performance.now() - start;
    },
    simplify(draw: () => void, complete: () => void): void {
      const start = performance.now();
      draw(); complete();
      simplifyMs = performance.now() - start;
    },
  };
}
