// Every scenario file, by file name, in run order. The driver refuses to run
// when a *.scenario.ts file in this directory is missing here, so a new file
// cannot be skipped silently. shell.isolated runs first and checks
// crossOriginIsolated before anything else, so that is row 1 of checks.jsonl
// in a run of every scenario; a run filtered to other scenarios starts with
// their rows instead.

import type { Scenario } from '../scenario.ts';
import { scenarios as creativeC1 } from './creative-c1.scenario.ts';
import { scenarios as boot } from './boot.scenario.ts';
import { scenarios as checklist } from './checklist.scenario.ts';
import { scenarios as demo } from './demo.scenario.ts';
import { scenarios as importMemory } from './import-memory.scenario.ts';
import { scenarios as decoder } from './decoder.scenario.ts';
import { scenarios as driver } from './driver.scenario.ts';
// driver also registers D3's real-model import, plate and fault scenarios.
import { scenarios as harness } from './harness.scenario.ts';
import { scenarios as gallery } from './gallery.scenario.ts';
import { scenarios as galleryUi } from './gallery-ui.scenario.ts';
import { scenarios as hosted } from './hosted.scenario.ts';
import { scenarios as levers } from './levers.scenario.ts';
import { scenarios as objects } from './objects.scenario.ts';
import { scenarios as models } from './models.scenario.ts';
import { scenarios as production } from './production.scenario.ts';
import { scenarios as render } from './render.scenario.ts';
import { scenarios as cameraStage } from './camera-stage.scenario.ts';
import { scenarios as motionEdges } from './motion-edges.scenario.ts';
import { scenarios as loop } from './loop.scenario.ts';
import { scenarios as view } from './view.scenario.ts';
import { scenarios as parallaxReal } from './parallax-real.scenario.ts';
import { scenarios as parallax } from './parallax.scenario.ts';
import { scenarios as parallaxControls } from './parallax-controls.scenario.ts';
import { scenarios as windowScenarios } from './window.scenario.ts';
import { scenarios as phone } from './phone.scenario.ts';
import { scenarios as rs1Compact } from './rs1-compact.scenario.ts';
import { scenarios as rs1Shell } from './rs1-shell.scenario.ts';
import { scenarios as projects } from './projects.scenario.ts';
import { scenarios as stereo } from './stereo.scenario.ts';
import { scenarios as symbols } from './symbols.scenario.ts';
import { scenarios as surface } from './surface.scenario.ts';
import { scenarios as sequence } from './sequence.scenario.ts';
import { scenarios as service } from './service.scenario.ts';
import { scenarios as shell } from './shell.scenario.ts';
import { scenarios as store } from './store.scenario.ts';
import { scenarios as story } from './story.scenario.ts';
import { scenarios as threads } from './threads.scenario.ts';

export const SCENARIO_FILES = {
  'shell.scenario.ts': shell,
  'boot.scenario.ts': boot,
  'demo.scenario.ts': demo,
  'import-memory.scenario.ts': importMemory,
  'levers.scenario.ts': levers,
  'threads.scenario.ts': threads,
  'story.scenario.ts': story,
  'models.scenario.ts': models,
  'objects.scenario.ts': objects,
  'sequence.scenario.ts': sequence,
  'service.scenario.ts': service,
  'decoder.scenario.ts': decoder,
  'store.scenario.ts': store,
  'driver.scenario.ts': driver,
  'harness.scenario.ts': harness,
  'gallery.scenario.ts': gallery,
  'gallery-ui.scenario.ts': galleryUi,
  'checklist.scenario.ts': checklist,
  'production.scenario.ts': production,
  'hosted.scenario.ts': hosted,
  'render.scenario.ts': render,
  'camera-stage.scenario.ts': cameraStage,
  'symbols.scenario.ts': symbols,
  'surface.scenario.ts': surface,
  'loop.scenario.ts': loop,
  'motion-edges.scenario.ts': motionEdges,
  'view.scenario.ts': view,
  'window.scenario.ts': windowScenarios,
  'parallax-controls.scenario.ts': parallaxControls,
  'parallax.scenario.ts': parallax,
  'parallax-real.scenario.ts': parallaxReal,
  'phone.scenario.ts': phone,
  'rs1-shell.scenario.ts': rs1Shell,
  'rs1-compact.scenario.ts': rs1Compact,
  'creative-c1.scenario.ts': creativeC1,
  'projects.scenario.ts': projects,
  'stereo.scenario.ts': stereo,
} as const satisfies Readonly<Record<string, readonly Scenario[]>>;
