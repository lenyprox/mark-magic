// The worker side of the analysis protocol, as a plain message handler so a browser Worker, a Node worker_thread
// or an in-process shim can wrap it. Cancellation is cooperative: MC loops yield to the event loop every few trials
// and stop when their request has been cancelled.
import type { CardDef } from '../cards/types.js';
import { defTable, deserializeState, defKey } from '../engine/serialize.js';
import { analyzeQuick } from './analyzer.js';
import { runTrials } from './montecarlo.js';
import type { FromWorker, ToWorker } from './protocol.js';

export type Post = (m: FromWorker) => void;
export type Handler = (msg: ToWorker, post: Post) => Promise<void>;

const yieldToLoop = () => new Promise<void>(r => setTimeout(r, 0));

/** A stateful handler: holds the card-definition table and the set of cancelled request ids. */
export function createHandler(): Handler {
  let defs: Map<string, CardDef> = defTable([]);
  const cancelled = new Set<string>();
  const add = (list: CardDef[]) => { for (const d of list) defs.set(defKey(d), d); };
  return async (msg, post) => {
    try {
      switch (msg.type) {
        case 'init': defs = defTable(msg.defs); post({ type: 'ready' }); return;
        case 'add-defs': add(msg.defs); return;
        case 'cancel': if (msg.requestId) cancelled.add(msg.requestId); else cancelled.add('*'); return;
        case 'quick': {
          cancelled.delete('*');
          const state = deserializeState(msg.snapshot, defs);
          const report = await analyzeQuick({ state, viewer: msg.viewer, model: msg.model, myList: msg.myList, defs, baseSeed: msg.baseSeed, requestId: msg.requestId, maxCandidates: msg.maxCandidates, maxSims: msg.maxSims });
          if (!cancelled.has(msg.requestId)) post({ type: 'quick-result', requestId: msg.requestId, report });
          return;
        }
        case 'mc': {
          cancelled.delete('*');
          const state = deserializeState(msg.snapshot, defs);
          const stop = () => cancelled.has(msg.requestId) || cancelled.has('*');
          let n = 0;
          await runTrials({ snapshot: state, viewer: msg.viewer, model: msg.model, myList: msg.myList, defs }, msg.req, async results => {
            if (!stop()) post({ type: 'mc-batch', requestId: msg.requestId, candidateId: msg.req.candidateId, results });
            n += results.length; await yieldToLoop();
          }, 5, stop);
          post({ type: 'mc-done', requestId: msg.requestId, candidateId: msg.req.candidateId, trialStart: msg.req.trialStart, trialCount: n, cancelled: stop() });
          return;
        }
      }
    } catch (e) {
      post({ type: 'error', requestId: 'requestId' in msg ? msg.requestId : undefined, message: (e as Error).message });
    }
  };
}

/** Default shared handler for thin wrappers (`self.onmessage = e => handleMessage(e.data, m => self.postMessage(m))`). */
export const handleMessage: Handler = createHandler();
