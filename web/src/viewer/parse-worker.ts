// Parser worker.
//
// A 4 MiB program is ~120k lines and takes roughly a third of a second to
// parse. On the main thread that is a third of a second in which the DRO stops
// updating, the toolpath stops rendering and the STOP button does not respond —
// which is the part that actually matters on a machine.
//
// The three big outputs are typed arrays, so they come back as transferables:
// ownership moves to the main thread with no copy, whatever the file size.

import { parseGcode } from './parse.js';

export interface ParseRequest {
  source: string;
}

export type ParseResponse =
  | { type: 'progress'; value: number }
  | { type: 'done'; result: ReturnType<typeof parseGcode> }
  | { type: 'error'; message: string };

self.onmessage = (e: MessageEvent<ParseRequest>) => {
  const post = (msg: ParseResponse, transfer?: Transferable[]) =>
    (self as unknown as Worker).postMessage(msg, transfer ?? []);

  try {
    const result = parseGcode(e.data.source, (value) => post({ type: 'progress', value }));
    post({ type: 'done', result }, [
      result.positions.buffer,
      result.offsets.buffer,
      result.kinds.buffer,
    ]);
  } catch (err) {
    post({ type: 'error', message: (err as Error).message });
  }
};
