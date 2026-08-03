// Main-thread wrapper around the parser worker.
//
// Falls back to parsing inline if a Worker can't be constructed — a stricter
// CSP, an odd embedding, a browser that dislikes module workers. A frozen UI
// for a third of a second is much better than a viewer that refuses to open
// anything, so the fallback is silent apart from a console note.

import { parseGcode, type ParsedToolpath } from './parse.js';
import type { ParseResponse } from './parse-worker.js';

let workerUnavailable = false;

/**
 * Parse off the main thread.
 * @param onProgress 0..1, called as the parse advances.
 */
export function parseAsync(
  source: string,
  onProgress?: (fraction: number) => void,
): Promise<ParsedToolpath> {
  if (workerUnavailable || typeof Worker === 'undefined') {
    return Promise.resolve(parseInline(source, onProgress));
  }

  let worker: Worker;
  try {
    // Resolved against the document so it still works when the app is served
    // from a subdirectory, which it is when deployed to the Duet at /cnc/.
    worker = new Worker(new URL('parse-worker.js', document.baseURI), { type: 'module' });
  } catch (err) {
    console.warn('parser worker unavailable, parsing on the main thread:', err);
    workerUnavailable = true;
    return Promise.resolve(parseInline(source, onProgress));
  }

  return new Promise<ParsedToolpath>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<ParseResponse>) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        onProgress?.(msg.value);
      } else if (msg.type === 'done') {
        worker.terminate();
        resolve(msg.result);
      } else {
        worker.terminate();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      // A worker that fails to even start means the URL or the module type is
      // wrong; don't keep paying the cost of finding that out per file.
      workerUnavailable = true;
      console.warn('parser worker failed, falling back to the main thread:', e.message);
      try {
        resolve(parseInline(source, onProgress));
      } catch (err) {
        reject(err as Error);
      }
    };
    worker.postMessage({ source });
  });
}

function parseInline(source: string, onProgress?: (fraction: number) => void): ParsedToolpath {
  const result = parseGcode(source, onProgress);
  onProgress?.(1);
  return result;
}
