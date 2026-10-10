// The one module under src/ that imports the zod package; every other module
// imports `z` from here (test/import-graph.test.ts enforces it).
//
// zod 4.6.5 compiles object parsers with `new Function` unless told not to,
// and probes whether it may by calling it once, when a bundle creates its
// first object schema. Under the CSP (no 'unsafe-eval') that probe is blocked
// and reported as a script-src violation. jitless skips the probe. An ES
// module runs after the modules it imports, so this call runs before any
// module that imports `z` from here can create a schema.

import { z } from 'zod';

z.config({ jitless: true });

export { z };
