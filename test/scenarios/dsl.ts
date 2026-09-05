// The scenario DSL itself lives in src/verify/scenarioDsl.ts so that the typechecked src tree (the JSON scenario
// loader src/verify/scenarioFiles.ts and the sharded runner's worker src/verify/scenarioWorker.ts) can use it;
// tsconfig's rootDir is src/, so src cannot import test/. This file keeps the historical import path for every
// scenario suite in this directory: `import { attackWith, type Scenario } from './dsl.js'`.
// See ./README.md for the DSL reference.
export * from '../../src/verify/scenarioDsl.js';
