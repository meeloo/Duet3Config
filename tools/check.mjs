// Structural check on the config macros.
//
// There is no way to run these except on the machine, and the machine reports a
// mistake by refusing a line at boot with nobody watching, or by aborting a
// macro halfway through a tool change. So this catches the class of error that
// is invisible in a diff and expensive at the spindle:
//
//   unbalanced braces or quotes — the expression is refused, the line does
//     nothing, and RRF mostly carries straight on
//   `var.x` used before it is declared, or `set var.x` on an undeclared one
//   `global.x` that nothing in config/sys declares and no `exists()` guards —
//     usually a rename that missed a caller, and it fails only when that branch
//     is finally taken
//   indentation mixed between tabs and spaces in one file, which is what ends a
//     meta-command block early and silently moves the lines below it out of
//     their `if`
//   `else`/`elif` with no `if` above it
//
// It is NOT a G-code parser and will never catch a wrong parameter letter, a
// move in the wrong direction, or a command this firmware does not have. It
// catches typos, and only the ones that are quiet.
//
// Two rules are deliberately looser than they first look, because both were
// wrong on this repo's own working files before being loosened:
//
//   Indentation. RRF accepts tabs or spaces; what it does not accept is both.
//   XYZ-probe.g is space-indented throughout and is fine, so the check is
//   consistency within a file rather than a house style.
//
//   Optional globals. atcConfig.g declares `atcProbeSlot` in a COMMENT, to be
//   uncommented by whoever has a probe in a pocket, and guards every use with
//   `exists()`. That is a deliberate pattern and not a missing declaration, so
//   a commented declaration counts, and so does an `exists()` guard in the file
//   doing the reading.
//
//   node tools/check.mjs              all of config/sys
//   node tools/check.mjs a.g b.g      just those, listing what was checked

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sysDir = join(root, 'config/sys');
const verbose = process.argv.length > 2;
const files = verbose
  ? process.argv.slice(2)
  : readdirSync(sysDir).filter((f) => f.endsWith('.g')).sort().map((f) => join(sysDir, f));

// Every global name declared anywhere in config/sys, including the commented-out
// ones — see the note above.
const declaredGlobals = new Set();
for (const f of readdirSync(sysDir)) {
  if (!f.endsWith('.g')) continue;
  const text = readFileSync(join(sysDir, f), 'utf8');
  for (const m of text.matchAll(/^\s*;?\s*global\s+(\w+)/gm)) declaredGlobals.add(m[1]);
}

let bad = 0;
const fail = (f, n, msg) => { console.log(`FAIL ${f.replace(root + '/', '')}:${n}  ${msg}`); bad++; };

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');

  // Names this file has explicitly said may be absent. A guard anywhere in the
  // file is taken as covering the file, which is coarse but matches how the
  // pattern is actually written — declare-or-guard at the top, use below.
  const guarded = new Set([...text.matchAll(/exists\(\s*global\.(\w+)\s*\)/g)].map((m) => m[1]));

  const vars = new Set();
  let indentStyle = null;
  let indentFirstAt = 0;
  let seenControl = false;

  lines.forEach((raw, i) => {
    const n = i + 1;
    // Comments are stripped for the structural rules, but a `;` inside a quoted
    // string is not a comment — M118 and echo both carry them.
    const line = raw.replace(/"(?:[^"]|"")*"|;.*$/g, (m) => (m.startsWith('"') ? m : ''));
    if (!line.trim()) return;

    const open = (line.match(/\{/g) ?? []).length;
    const close = (line.match(/\}/g) ?? []).length;
    if (open !== close) fail(file, n, `unbalanced braces (${open} open, ${close} close): ${line.trim()}`);
    if (((raw.replace(/;.*$/, '').match(/"/g) ?? []).length) % 2) {
      fail(file, n, `odd number of quotes: ${raw.trim()}`);
    }

    const trimmed = line.trim();
    if (/^(if|while)\b/.test(trimmed)) seenControl = true;
    if (/^(elif|else)\b/.test(trimmed) && !seenControl) {
      fail(file, n, `${trimmed.split(/\s/)[0]} with no if above it`);
    }

    const indent = /^([ \t]+)/.exec(raw)?.[1];
    if (indent) {
      const style = indent.includes('\t') ? 'tab' : 'space';
      if (indent.includes('\t') && indent.includes(' ')) {
        fail(file, n, 'indented with both tabs and spaces on one line');
      } else if (indentStyle === null) {
        indentStyle = style;
        indentFirstAt = n;
      } else if (indentStyle !== style) {
        fail(file, n, `indented with ${style}s, but this file uses ${indentStyle}s (first at line ${indentFirstAt})`);
      }
    }

    for (const m of trimmed.matchAll(/^var\s+(\w+)/g)) vars.add(m[1]);
    for (const m of trimmed.matchAll(/\bvar\.(\w+)/g)) {
      if (!vars.has(m[1])) fail(file, n, `var.${m[1]} used before it is declared`);
    }
    const setVar = /^set\s+var\.(\w+)/.exec(trimmed);
    if (setVar && !vars.has(setVar[1])) fail(file, n, `set var.${setVar[1]} but it was never declared`);

    for (const m of trimmed.matchAll(/\bglobal\.(\w+)/g)) {
      if (!declaredGlobals.has(m[1]) && !guarded.has(m[1])) {
        fail(file, n, `global.${m[1]} is never declared in config/sys and is not guarded by exists()`);
      }
    }
  });

  if (verbose) console.log(`checked ${file.replace(root + '/', '')}  (${lines.length} lines)`);
}

console.log(bad ? `\n${bad} problem(s) in ${files.length} file(s)` : `no structural problems in ${files.length} file(s)`);
process.exit(bad ? 1 : 0);
