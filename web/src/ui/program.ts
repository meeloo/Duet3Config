// Preview / save / run pipeline shared by the probing and machining panels.
//
// Both packs produce a GeneratedProgram, and both want the same three things:
// look at it in the viewer before committing, write it to the controller, and
// run it. Keeping that in one place means a new operation is a generator plus a
// form, with no execution logic of its own.

import { signal } from '../core/signal.js';
import { actions, activeDriver, appendLog, capabilities, run } from '../core/store.js';
import type { GeneratedProgram } from '../cam/format.js';

/** Set by a panel to ask the viewer to render a generated program. */
export const previewProgram = signal<{ name: string; gcode: string } | null>(null);

/**
 * Whatever the viewer currently has parsed, published so other panels can work
 * on the same thing the operator is looking at. `controllerPath` is null for a
 * generated program that has not been written to the machine yet, which is what
 * tells preflight there is nothing to start.
 */
export const loadedProgram = signal<{
  name: string;
  controllerPath: string | null;
  path: import('../viewer/parse.js').ParsedToolpath;
} | null>(null);

export function preview(program: GeneratedProgram): void {
  previewProgram.set({ name: program.name, gcode: program.gcode });
  appendLog({ level: 'info', text: `Previewing ${program.name}`, time: new Date() });
}

/** Where a generated program belongs, by kind. */
function targetDir(program: GeneratedProgram): string {
  const caps = capabilities.peek();
  return program.name.endsWith('.g')
    ? `${caps.macroRoot ?? '/macros'}/generated`
    : `${caps.gcodeRoot ?? '/gcodes'}/generated`;
}

/** Write the program to the controller. Returns its full path, or null. */
export async function save(program: GeneratedProgram): Promise<string | null> {
  const driver = activeDriver();
  if (!driver) {
    appendLog({ level: 'error', text: 'Not connected', time: new Date() });
    return null;
  }

  const dir = targetDir(program);
  const path = `${dir}/${program.name}`;

  // The folder may not exist yet; a failure here is not fatal on its own, so
  // let the upload be the thing that actually reports a problem.
  try {
    await driver.makeDirectory(dir);
  } catch {
    /* already exists, or the controller doesn't need it */
  }

  const ok = await run(`save ${program.name}`, async (d) => {
    await d.writeFile(path, new TextEncoder().encode(program.gcode));
    return true;
  });
  if (!ok) return null;

  appendLog({ level: 'info', text: `Saved ${path}`, time: new Date() });
  return path;
}

/**
 * Save and run. Probe macros go through the macro path so they run inline;
 * machining programs start as a job so they get proper progress and pause.
 */
export async function saveAndRun(program: GeneratedProgram): Promise<void> {
  const isMacro = program.name.endsWith('.g');
  const detail = [program.summary, ...program.warnings].join('\n\n');
  if (!confirm(`${isMacro ? 'Run' : 'Start job'}:\n\n${detail}\n\nProceed?`)) return;

  const path = await save(program);
  if (!path) return;

  if (isMacro) await actions.runMacro(path);
  else await actions.startJob(path);
}
