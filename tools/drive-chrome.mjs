#!/usr/bin/env node
// The browser driver: runs the scenarios of test/browser/scenarios/ in Chrome
// over the DevTools Protocol, each against its own dev server, and writes
// test-results/<run>/. Dependency-free; Node 25 runs the TypeScript modules
// under test/browser/ by type stripping.
//
//   node tools/drive-chrome.mjs [scenario ...] [--list] [--target <name>] [--base-url <url>]
//        [--headed] [--chrome <path>] [--dev-root <dir>] [--production-root <dir>] [--out <dir>]
//
// --help documents every flag; docs/ARCHITECTURE.md ("Browser driver")
// documents the output, the scenario API, and the checks every run makes.

import { main } from '../test/browser/driver/cli.ts';

process.exit(await main(process.argv.slice(2)));
