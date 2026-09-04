// Worker-thread entry: registers tsx's loader for this thread (loader hooks from the main thread are not inherited)
// and then loads the TypeScript worker module. Same shape as poolWorker.boot.mjs, which hard-codes its own module.
import { register } from 'tsx/esm/api';
register();
await import('./fuzzWorker.ts');
