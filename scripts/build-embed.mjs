#!/usr/bin/env node
/**
 * Builds the classic-script version of Orb.
 *
 *     node scripts/build-embed.mjs
 *     ->  src/orb.global.js  (served at /v1/orb.global.js)
 *
 * Orb ships as a real ES module and that is the preferred way in:
 *
 *     <script type="module" src="https://xyorb.vidome.app/v1/element.js"></script>
 *
 * Plenty of embedders cannot write that tag. Google Tag Manager injects classic
 * scripts. Squarespace, Wix, Webflow and older WordPress themes strip the type
 * attribute or refuse <script type="module"> outright. Enterprise CMS templates
 * still emit bare `<script src>`. So there has to be one file that loads with a
 * plain tag, leaves a single global behind, and registers <orb-js> itself:
 *
 *     <script src="https://xyorb.vidome.app/v1/orb.global.js"></script>
 *     <orb-js seed="agent-7" size="160"></orb-js>
 *
 * The output is committed. Vercel runs no build for this project (package.json
 * has no "build" script on purpose, since a build step is one more thing that
 * can fail between a customer's script tag and a working orb), so
 * src/orb.global.js is a real artifact in the repo and this is how you
 * regenerate it after touching src/.
 *
 * Zero dependencies: node:fs, node:path, node:url. No bundler, no parser. It
 * scans each source once to learn which lines begin in real code as opposed to
 * inside a block comment or a template literal, strips module syntax from those
 * lines only, and concatenates the two modules in dependency order into one
 * IIFE. `import` and `export` are only ever meaningful at the start of a
 * statement, and that one fact is enough to make the rest line-based and exact.
 * A naive /^export/ would maul the GLSL sitting inside template literals, or a
 * doc comment that talks about exports (src/orb.js line 68 is that trap).
 *
 * Bodies are copied byte for byte and never re-indented: most of src/orb.js by
 * volume is GLSL inside template literals.
 *
 * Each module keeps its OWN function scope instead of being flattened into one
 * shared scope. Both files declare a top-level `warn`, `signature` and friends,
 * and colliding `const` declarations are a SyntaxError that shows up at load
 * time in the customer's page, with no build step around to have caught it.
 * Per-module scope costs two function calls once and makes that impossible.
 *
 * The pieces are hung on the Orb class, which src/orb.js already publishes as
 * its own namespace object (`Object.assign(Orb, {...})` at the foot of that
 * file), and that class becomes `window.Orb`. One global, class and namespace
 * together, same as the module build.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* Dependency order: element.js imports orb.js. */
const MODULES = [
  { id: 'core', file: 'src/orb.js' },
  { id: 'element', file: 'src/element.js' },
];

// src/, not public/v1/: vercel.json rewrites /v1/:path* -> /src/:path* and
// outputDirectory is ".", so public/v1 would be unreachable at the /v1/ url
// the docs advertise.
const OUT_FILE = path.join(ROOT, 'src', 'orb.global.js');

/**
 * The self-reference on the global, so `window.Orb.Orb` holds whatever
 * `window.Orb` does and destructuring works:
 *     var Orb = window.Orb.Orb, createOrb = window.Orb.createOrb;
 */
const SELF_REF = 'Orb';

/**
 * Non-writable statics that exist on every function. Assigning one on a class
 * throws in strict mode, so an export called `name` would take the whole page
 * down. None are today. Tripwire, not a workaround.
 */
const FORBIDDEN_STATICS = new Set(['name', 'length', 'prototype', 'caller', 'arguments']);

/* 1. The scanner
 *
 * One pass, one character at a time, tracking just enough lexical state to
 * answer one question per line: does it start in ordinary code?
 *
 * Regex literals are deliberately not parsed. Telling `/` as division from `/`
 * as a regex needs real parser context, and getting it wrong desynchronises
 * everything after it. So `/` is only special when followed by `/` or `*`, a
 * comment opener. Safe as long as no regex literal in the sources contains one,
 * and the balance check at the end of the scan means a future source that
 * breaks the assumption fails the build rather than the browser.
 */

const CODE = 'code';
const BLOCK = 'block';
const TEMPLATE = 'template';

/**
 * @param {string} src
 * @param {string} label for errors
 * @returns {string[]} one state per line: CODE, BLOCK or TEMPLATE
 */
function scanLineStates(src, label) {
  const states = [CODE];
  let mode = CODE;
  // Inside a `${ ... }` hole we are back in code, and a code brace must not be
  // mistaken for the hole's closing brace. The stack tracks, per open hole, how
  // deep the plain braces go.
  const holes = [];

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];

    if (c === '\n') {
      // A line begins in whatever mode we are in after the newline. Line
      // comments end here, everything else carries over.
      if (mode === 'line') mode = CODE;
      states.push(mode === 'sq' || mode === 'dq' ? CODE : mode);
      continue;
    }

    switch (mode) {
      case CODE:
        if (c === '/' && n === '/') { mode = 'line'; i++; }
        else if (c === '/' && n === '*') { mode = BLOCK; i++; }
        else if (c === "'") mode = 'sq';
        else if (c === '"') mode = 'dq';
        else if (c === '`') { mode = TEMPLATE; holes.push(0); }
        else if (c === '{' && holes.length) holes[holes.length - 1]++;
        else if (c === '}' && holes.length) {
          if (holes[holes.length - 1] > 0) holes[holes.length - 1]--;
          else mode = TEMPLATE;             // closed a `${ ... }` hole
        }
        break;

      case 'line':
        break;                              // ends at the newline, handled above

      case BLOCK:
        if (c === '*' && n === '/') { mode = CODE; i++; }
        break;

      case 'sq':
        if (c === '\\') i++;
        else if (c === "'") mode = CODE;
        break;

      case 'dq':
        if (c === '\\') i++;
        else if (c === '"') mode = CODE;
        break;

      case TEMPLATE:
        if (c === '\\') i++;
        else if (c === '$' && n === '{') { mode = CODE; i++; }
        else if (c === '`') { mode = CODE; holes.pop(); }
        break;
    }
  }

  if (mode === BLOCK) throw new Error(`${label}: unterminated block comment`);
  if (mode === TEMPLATE || holes.length) {
    throw new Error(`${label}: unterminated template literal (backticks are unbalanced)`);
  }
  return states;
}

/* 2. Module-syntax removal */

const IDENT = /[A-Za-z_$][A-Za-z0-9_$]*/;

/** Keywords that may sit between `export` and the declared name. */
const DECL_KEYWORDS = ['async', 'const', 'let', 'var', 'function', 'class'];

/**
 * Name declared by `const X = ...` / `async function X(...)` and friends.
 * Destructuring patterns are refused loudly rather than guessed at.
 */
function declaredName(stmt, label, lineNo) {
  let s = stmt.trim();
  for (;;) {
    const kw = DECL_KEYWORDS.find(
      (k) => s === k || s.startsWith(k + ' ') || s.startsWith(k + '\t') || s.startsWith(k + '*'));
    if (!kw) break;
    s = s.slice(kw.length).trimStart();
    if (s.startsWith('*')) s = s.slice(1).trimStart();   // function* generator
  }
  if (s.startsWith('{') || s.startsWith('[')) {
    throw new Error(
      `${label}:${lineNo}: destructuring export is not supported, name it explicitly.\n  ${stmt.trim()}`);
  }
  const m = s.match(IDENT);
  if (!m || m.index !== 0) {
    throw new Error(`${label}:${lineNo}: cannot read the exported name from:\n  ${stmt.trim()}`);
  }
  return m[0];
}

/**
 * Reads the inside of `{ a, b as c }` from an import or export clause.
 * @returns {Array<{local: string, exported: string}>}
 */
function parseSpecifiers(body) {
  return body
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const parts = s.split(/\s+as\s+/);
      const a = parts[0].trim();
      const b = (parts[1] || parts[0]).trim();
      return { local: a, exported: b };
    });
}

/**
 * Collects a statement that may span lines, ending at the first `;`. Import and
 * export clauses are the only multi-line constructs this is needed for, and both
 * end with a semicolon in practice.
 */
function collectStatement(lines, start, states, label) {
  let text = '';
  for (let i = start; i < lines.length; i++) {
    // A continuation line starting inside a template or block comment means the
    // statement was mis-identified. Bail rather than eat the file.
    if (i > start && states[i] !== CODE) {
      throw new Error(`${label}:${i + 1}: module statement ran into a template literal or comment`);
    }
    text += (i > start ? '\n' : '') + lines[i];
    if (lines[i].includes(';')) return { text, end: i };
  }
  throw new Error(`${label}:${start + 1}: unterminated module statement`);
}

/**
 * Strips the ES-module syntax from one source file. The body comes back
 * verbatim apart from the module statements, along with the export map and
 * import list the caller needs to wire the modules together.
 *
 * @param {string} src
 * @param {string} label
 * @returns {{body: string, exports: Array<{local:string, exported:string}>,
 *            imports: Array<{local:string, imported:string, from:string}>,
 *            defaultLocal: string|null, stripped: number}}
 */
function stripModuleSyntax(src, label) {
  const states = scanLineStates(src, label);
  const lines = src.split('\n');
  const out = [];
  const exports = [];
  const imports = [];
  let defaultLocal = null;
  let stripped = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Module syntax is top-level only, so always at column 0 of a line that
    // begins in code. Anything else saying "export" is prose or GLSL.
    if (states[i] !== CODE || !(line.startsWith('import') || line.startsWith('export'))) {
      out.push(line);
      continue;
    }

    /* import */
    if (/^import\b/.test(line)) {
      const stmt = collectStatement(lines, i, states, label);
      const text = stmt.text;
      const fromAt = text.lastIndexOf(' from ');
      const src2 = text.match(/['"]([^'"]+)['"]\s*;?\s*$/);
      if (!src2) throw new Error(`${label}:${i + 1}: cannot read the import source:\n  ${text}`);
      const from = src2[1];

      if (fromAt !== -1) {
        const clause = text.slice('import'.length, fromAt).trim();
        const braced = clause.match(/\{([\s\S]*)\}/);
        if (braced) {
          for (const s of parseSpecifiers(braced[1])) {
            // In an import clause the pair reads `exported as local`.
            imports.push({ imported: s.local, local: s.exported, from });
          }
        }
        const head = (braced ? clause.slice(0, braced.index) : clause).replace(/,\s*$/, '').trim();
        if (head) {
          const ns = head.match(/^\*\s+as\s+(.+)$/);
          if (ns) imports.push({ imported: '*', local: ns[1].trim(), from });
          else imports.push({ imported: 'default', local: head, from });
        }
      }
      // A bare `import './x.js';` is side effects only, which concatenation
      // already gives us. Nothing to bind.

      stripped++;
      i = stmt.end;
      continue;
    }

    /* export */
    const after = line.slice('export'.length);
    if (!/^[\s{*]/.test(after)) { out.push(line); continue; }   // e.g. `exportFoo()`
    const rest = after.trim();

    // export default <expr>;
    if (/^default\b/.test(rest)) {
      const stmt = collectStatement(lines, i, states, label);
      const expr = stmt.text.slice(stmt.text.indexOf('default') + 'default'.length).trim();
      const bare = expr.replace(/;+\s*$/, '').trim();
      if (IDENT.test(bare) && bare.match(IDENT)[0] === bare) {
        defaultLocal = bare;                       // `export default Orb;`
        stripped++;
        i = stmt.end;
        continue;
      }
      // `export default function foo() {}` / `export default class Foo {}`
      defaultLocal = declaredName(bare, label, i + 1);
      out.push(line.replace(/^export\s+default\s+/, ''));
      stripped++;
      continue;
    }

    // export { a, b as c };  /  export * from '...';
    if (rest.startsWith('{') || rest.startsWith('*')) {
      const stmt = collectStatement(lines, i, states, label);
      if (rest.startsWith('*')) {
        throw new Error(`${label}:${i + 1}: 'export *' is not supported, list the names.`);
      }
      if (/\bfrom\b/.test(stmt.text)) {
        throw new Error(`${label}:${i + 1}: re-export with 'from' is not supported.`);
      }
      const braced = stmt.text.match(/\{([\s\S]*)\}/);
      for (const s of parseSpecifiers(braced ? braced[1] : '')) exports.push(s);
      stripped++;
      i = stmt.end;
      continue;
    }

    // export const / let / var / function / async function / class
    const name = declaredName(rest, label, i + 1);
    exports.push({ local: name, exported: name });
    out.push(line.replace(/^export\s+/, ''));
    stripped++;
  }

  return { body: out.join('\n'), exports, imports, defaultLocal, stripped };
}

/* 3. Emit */

const q = (s) => JSON.stringify(String(s));

/** `{ a: a, b: b, "default": X }`. Quoted keys, so reserved words are safe. */
function objectLiteral(pairs) {
  if (!pairs.length) return '{}';
  return '{\n' + pairs.map(([k, v]) => `    ${q(k)}: ${v}`).join(',\n') + '\n  }';
}

function banner(version, exportNames) {
  return `/*!
 * Orb ${version} — classic-script build.  (c) Earl Balai.  MIT.
 *
 * GENERATED FILE. Do not edit by hand; edit src/orb.js and src/element.js and
 * run:  node scripts/build-embed.mjs
 *
 * It is committed to the repository on purpose: this project is served by Vercel
 * with no build step, so whatever is in git is what customers download.
 *
 *   <script src="https://xyorb.vidome.app/v1/orb.global.js"></script>
 *   <orb-js seed="agent-7" size="160"></orb-js>
 *
 * No module syntax, no bundler runtime, no globals besides window.Orb. The
 * <orb-js> element registers itself as soon as this file runs. window.Orb is
 * both the orb class and the namespace:
 *
 *   var Orb = window.Orb, createOrb = Orb.createOrb;
 *   var orb = Orb.mount(document.getElementById('orb'), { seed: 'a' });
 *
 * Namespace: ${exportNames.join(', ')}
 *
 * Prefer the ES module where you can write one:
 *   <script type="module" src="https://xyorb.vidome.app/v1/element.js"></script>
 */`;
}

function emit(version, modules) {
  const parts = [];
  const byId = new Map(modules.map((m) => [m.id, m]));

  parts.push(';(function (globalScope) {');
  parts.push("  'use strict';");
  parts.push('');

  for (const mod of modules) {
    const argNames = mod.id === 'core' ? [] : ['__core'];
    const returned = mod.parsed.exports.map((e) => [e.exported, e.local]);
    if (mod.parsed.defaultLocal) returned.push(['default', mod.parsed.defaultLocal]);

    parts.push(`  /* ══ ${mod.file} ${'═'.repeat(Math.max(2, 68 - mod.file.length))} */`);
    parts.push(`  var ${mod.varName} = (function (${argNames.join(', ')}) {`);
    parts.push("  'use strict';");

    // Bind imports to the exports of the module they came from.
    for (const imp of mod.parsed.imports) {
      const dep = byId.get('core');
      if (!dep) throw new Error(`${mod.file}: no module satisfies ${q(imp.from)}`);
      const has = imp.imported === 'default'
        ? !!dep.parsed.defaultLocal
        : dep.parsed.exports.some((e) => e.exported === imp.imported);
      if (!has) {
        throw new Error(`${mod.file}: imports ${q(imp.imported)} from ${q(imp.from)}, which does not export it`);
      }
      parts.push(`  var ${imp.local} = __core[${q(imp.imported)}];`);
    }
    if (mod.parsed.imports.length) parts.push('');

    // Byte for byte, never re-indented. Most of src/orb.js is GLSL inside
    // template literals.
    parts.push(mod.parsed.body);

    parts.push(`  return ${objectLiteral(returned)};`);
    // Parameter is __core, argument is the core module's own variable.
    parts.push(`  })(${argNames.length ? byId.get('core').varName : ''});`);
    parts.push('');
  }

  const core = byId.get('core');
  const element = byId.get('element');

  parts.push('  /* ══ the single global ═══════════════════════════════════════════════ */');
  parts.push('');
  parts.push('  // src/orb.js already makes the class its own namespace object; the classic');
  parts.push('  // build simply finishes the job with everything both modules export.');
  parts.push(`  var Orb = ${core.varName}[${q('default')}];`);
  parts.push('  var ns = {};');
  parts.push(`  var api = [${core.varName}${element ? ', ' + element.varName : ''}];`);
  parts.push('  for (var i = 0; i < api.length; i++) {');
  parts.push('    for (var k in api[i]) {');
  parts.push('      if (!Object.prototype.hasOwnProperty.call(api[i], k)) continue;');
  parts.push(`      if (k === ${q('default')}) continue;`);
  parts.push('      ns[k] = api[i][k];');
  parts.push('    }');
  parts.push('  }');
  parts.push(`  ns[${q(SELF_REF)}] = Orb;`);
  parts.push('');
  parts.push('  // Hang the namespace on the class. `name`, `length` and `prototype` are');
  parts.push('  // non-writable on every function, and assigning one throws in strict mode,');
  parts.push('  // so they are skipped — the build refuses such an export name anyway.');
  parts.push(`  var skip = ${JSON.stringify([...FORBIDDEN_STATICS])};`);
  parts.push('  for (var key in ns) {');
  parts.push('    if (!Object.prototype.hasOwnProperty.call(ns, key)) continue;');
  parts.push('    if (skip.indexOf(key) !== -1) continue;');
  parts.push('    try { Orb[key] = ns[key]; } catch (e) { /* frozen host, nothing to do */ }');
  parts.push('  }');
  parts.push('');
  parts.push('  if (globalScope) globalScope.Orb = Orb;');
  parts.push('  return Orb;');
  parts.push('})(typeof globalThis !== \'undefined\' ? globalThis');
  parts.push('  : typeof window !== \'undefined\' ? window');
  parts.push('  : typeof self !== \'undefined\' ? self : this);');
  parts.push('');

  return parts.join('\n');
}

/* 4. Verify
 *
 * node --check catches a syntax error but not the failure mode this transform
 * can actually produce, which is a template literal whose contents got damaged.
 * So check the two things that are cheap and exact: no module syntax survives at
 * the start of a code line, and every character of every source body is still
 * present in the output.
 */

function verify(out, modules) {
  const states = scanLineStates(out, 'output');
  const lines = out.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (states[i] !== CODE) continue;
    const t = lines[i].trimStart();
    if (/^(import|export)\b/.test(t)) {
      throw new Error(`output:${i + 1}: module syntax survived:\n  ${lines[i]}`);
    }
  }
  for (const mod of modules) {
    if (!out.includes(mod.parsed.body)) {
      throw new Error(`${mod.file}: body was not copied through verbatim`);
    }
  }
  if (!out.includes('customElements.define')) {
    throw new Error('output: the <orb-js> self-registration went missing');
  }
}

/* 5. Main */

async function main() {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version || '0.0.0';

  const modules = [];
  for (const m of MODULES) {
    const src = await readFile(path.join(ROOT, m.file), 'utf8');
    // Normalise line endings so the committed artifact is byte-identical on
    // Windows and on CI. A stray CR inside a GLSL template literal is legal and
    // churns the file in git for no reason.
    const parsed = stripModuleSyntax(src.replace(/\r\n/g, '\n'), m.file);
    modules.push({ ...m, parsed, varName: '__orb_' + m.id });
    console.log(
      `  ${m.file.padEnd(18)} ${String(parsed.stripped).padStart(2)} module statements removed, ` +
      `${parsed.exports.length} exports` +
      (parsed.defaultLocal ? ` + default (${parsed.defaultLocal})` : '') +
      (parsed.imports.length ? `, ${parsed.imports.length} imports bound` : ''));
  }

  for (const mod of modules) {
    for (const e of mod.parsed.exports) {
      if (FORBIDDEN_STATICS.has(e.exported)) {
        throw new Error(
          `${mod.file}: export named ${q(e.exported)} cannot be hung on the class, rename it`);
      }
    }
  }

  const names = new Set([SELF_REF]);
  for (const mod of modules) for (const e of mod.parsed.exports) names.add(e.exported);
  const sorted = [...names].sort((a, b) => a.localeCompare(b));

  const out = banner(version, sorted) + '\n' + emit(version, modules);
  verify(out, modules);

  await mkdir(path.dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, out, 'utf8');

  const bytes = Buffer.byteLength(out, 'utf8');
  const rel = path.relative(ROOT, OUT_FILE).split(path.sep).join('/');
  console.log('');
  console.log(`  namespace (${sorted.length}): ${sorted.join(', ')}`);
  console.log('');
  console.log(`  ${rel}  ${bytes} bytes (${(bytes / 1024).toFixed(1)} KiB)`);
  console.log('');
  console.log(`OK  built ${rel}: classic <script src> build, exposes window.Orb, self-registers <orb-js>.`);
  console.log('    verify with:  node --check ' + rel);
}

main().catch((err) => {
  console.error('FAILED  ' + (err && err.message ? err.message : err));
  process.exitCode = 1;
});
