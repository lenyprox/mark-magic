// Worker-thread entry: registers tsx's loader for this thread (loader hooks from the main thread are not inherited)
// and then loads the TypeScript worker module.
import { register } from 'tsx/esm/api';
register();
await import('./poolWorker.ts');
