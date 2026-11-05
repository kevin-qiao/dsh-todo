#!/usr/bin/env node
/**
 * verify/check-static.mjs — static (offline) validation for the
 * `@local/dsh-sticker-todo` bundle.
 *
 * Usage:
 *   node verify/check-static.mjs            # validate the bundle that owns this script
 *   node verify/check-static.mjs <rootDir>  # validate another bundle directory
 *
 * Node built-ins only. Performs no network access and writes no files.
 *
 * Checks:
 *   1. package.json — JSON shape, identity, exports, dsh manifest, files coverage.
 *   2. cordis.patch.yml — exactly one insert block naming this package with an id.
 *   3. locale/en.json + locale/zh.json — metadata completeness, locale-differentiated text.
 *   4. icon.svg — present, SVG-ish, within the 256 KiB limit.
 *   5. node --check on every .js file in the bundle root and lib/ (verify/ excluded).
 *
 * Files that other teammates may still be writing (client.js, lib/ai.js, README.md)
 * are reported as NOTE rather than FAIL while they are genuinely absent, so this
 * script is useful during a parallel build. Once a file exists it is checked for real.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  readdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  rmSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = process.argv[2] ? resolve(process.argv[2]) : resolve(SCRIPT_DIR, '..');

const EXPECTED_NAME = '@local/dsh-sticker-todo';
const ICON_MAX_BYTES = 256 * 1024;
const REQUIRED_EXPORTS = ['.', './client', './locale/*.json', './icon'];
const TEMPLATE_LEFTOVERS = ['My ', 'Composer Decoration', 'todo here'];
// Files still being authored by other owners: absent => NOTE, present => checked normally.
const IN_FLIGHT = new Set(['client.js', 'lib/ai.js', 'README.md']);

const tally = { pass: 0, fail: 0, note: 0 };
const failures = [];

function line(status, name, detail) {
  console.log(`[${status}] ${name}${detail ? ` — ${detail}` : ''}`);
}
function pass(name, detail = '') { tally.pass += 1; line('PASS', name, detail); }
function fail(name, detail = '') { tally.fail += 1; failures.push({ name, detail }); line('FAIL', name, detail); }
function note(name, detail = '') { tally.note += 1; line('NOTE', name, detail); }
function section(title) { console.log(`\n== ${title} ==`); }
function rel(abs) { return relative(ROOT, abs).split('\\').join('/'); }
function absOf(relPath) { return join(ROOT, relPath.replace(/^\.\//, '')); }

function inFlightMissing(relPath) {
  return IN_FLIGHT.has(relPath) && !existsSync(absOf(relPath));
}

/** List direct file children of a bundle-relative directory ('lib', 'locale', '.'). */
function listFiles(relDir) {
  const abs = relDir === '.' ? ROOT : join(ROOT, relDir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return [];
  const prefix = relDir === '.' ? '' : `${relDir}/`;
  return readdirSync(abs, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => `${prefix}${entry.name}`)
    .sort();
}

/* ------------------------------------------------------------------ *
 * Minimal, dependency-free helpers for the globs used in `exports`/`files`
 * and for the small subset of YAML the Cordis patch uses.
 * ------------------------------------------------------------------ */

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const globSegmentToRegex = (segment) =>
  new RegExp(`^${segment.split('*').map(escapeRegex).join('[^/]*')}$`);

/** Expand a bundle-relative glob such as `locale/*.json` into existing files. */
function expandGlob(pattern) {
  const segments = pattern.replace(/^\.\//, '').split('/').filter(Boolean);
  let current = [''];
  for (const segment of segments) {
    const next = [];
    for (const prefix of current) {
      const dir = prefix ? join(ROOT, prefix) : ROOT;
      if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
      const re = globSegmentToRegex(segment);
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (re.test(entry.name)) next.push(prefix ? `${prefix}/${entry.name}` : entry.name);
      }
    }
    current = next;
  }
  return current;
}

function patternMatchesAnything(pattern) {
  const clean = pattern.replace(/^\.\//, '');
  if (clean.includes('*')) return expandGlob(clean).length > 0;
  return existsSync(absOf(clean));
}

/** True when `files` covers `relFile` by exact name, directory name, or glob. */
function fileCoveredByFiles(relFile, patterns) {
  for (const raw of patterns) {
    const pattern = raw.replace(/^\.\//, '');
    if (pattern === relFile) return true;
    if (pattern.endsWith('/')) {
      if (relFile.startsWith(pattern)) return true;
      continue;
    }
    if (pattern.includes('*')) {
      if (expandGlob(pattern).includes(relFile)) return true;
      continue;
    }
    const abs = absOf(pattern);
    if (existsSync(abs) && statSync(abs).isDirectory() && relFile.startsWith(`${pattern}/`)) return true;
  }
  return false;
}

/** Flatten a package.json `exports` target into concrete path strings. */
function exportTargets(value, acc = []) {
  if (typeof value === 'string') acc.push(value);
  else if (Array.isArray(value)) value.forEach((item) => exportTargets(item, acc));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => exportTargets(item, acc));
  return acc;
}

function exportTargetExists(target) {
  const clean = target.replace(/^\.\//, '');
  if (clean.includes('*')) return expandGlob(clean).length > 0;
  return existsSync(absOf(clean));
}

function readText(relPath) {
  const abs = absOf(relPath);
  if (!existsSync(abs)) return { missing: true };
  try {
    return { ok: true, text: readFileSync(abs, 'utf8') };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function readJson(relPath) {
  const read = readText(relPath);
  if (read.missing) return { missing: true };
  if (!read.ok) return { ok: false, error: read.error };
  try {
    return { ok: true, data: JSON.parse(read.text) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/** Strip a YAML comment while respecting single/double quoted scalars. */
function stripYamlComment(text) {
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '#' && (index === 0 || /\s/.test(text[index - 1]))) {
      return text.slice(0, index);
    }
  }
  return text;
}

function parseYamlScalar(raw) {
  let value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      value = value.slice(1, -1);
    }
  }
  return value;
}

/** Parse `key: value` (optionally after a leading `- `) into `target`. */
function parseKeyValue(raw, target) {
  const match = raw.trim().match(/^-\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/)
    || raw.trim().match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
  if (!match) return false;
  target[match[1]] = parseYamlScalar(match[2]);
  return true;
}

/**
 * Extract every `insert:` block and the entries inside them.
 * Returns [{ line, entries: [{id?, name?, config?}] }].
 */
function parsePatchInserts(text) {
  const lines = text.split(/\r?\n/);
  const insertBlocks = [];
  let index = 0;

  while (index < lines.length) {
    const blockMatch = lines[index].match(/^(\s*)-\s*insert:\s*(.*)$/);
    if (!blockMatch) { index += 1; continue; }

    const insertIndent = blockMatch[1].length;
    const block = { line: index + 1, entries: [], inline: blockMatch[2].trim() };
    index += 1;

    while (index < lines.length) {
      const rawLine = lines[index];
      const cleaned = stripYamlComment(rawLine);
      if (cleaned.trim() === '') { index += 1; continue; }
      const indent = rawLine.match(/^\s*/)[0].length;
      if (indent <= insertIndent) break;

      const itemMatch = cleaned.match(/^(\s*)-\s*(.*)$/);
      if (itemMatch && itemMatch[1].length > insertIndent) {
        const entryIndent = itemMatch[1].length;
        const entry = {};
        parseKeyValue(itemMatch[2], entry);
        index += 1;

        while (index < lines.length) {
          const childLine = lines[index];
          const childCleaned = stripYamlComment(childLine);
          if (childCleaned.trim() === '') { index += 1; continue; }
          const childIndent = childLine.match(/^\s*/)[0].length;
          if (childIndent <= entryIndent) break;
          if (!parseKeyValue(childCleaned, entry)) index += 1;
          else index += 1;
        }
        block.entries.push(entry);
      } else {
        index += 1;
      }
    }
    insertBlocks.push(block);
  }
  return insertBlocks;
}

/* ------------------------------------------------------------------ *
 * 1. package.json
 * ------------------------------------------------------------------ */

function checkManifest() {
  section('Manifest: package.json');
  const result = readJson('package.json');
  if (result.missing) { fail('package.json exists', 'file not found'); return null; }
  if (!result.ok) { fail('package.json parses as JSON', result.error); return null; }
  pass('package.json parses as JSON');

  const pkg = result.data;
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
    fail('package.json is a JSON object');
    return null;
  }

  // Identity ---------------------------------------------------------
  const name = typeof pkg.name === 'string' ? pkg.name.trim() : '';
  if (name === EXPECTED_NAME) pass('name', EXPECTED_NAME);
  else fail('name', `expected "${EXPECTED_NAME}", got ${JSON.stringify(pkg.name)}`);

  if (typeof pkg.version === 'string' && /^\d+\.\d+\.\d+/.test(pkg.version)) pass('version', pkg.version);
  else fail('version', `expected a semver string, got ${JSON.stringify(pkg.version)}`);

  if (pkg.private === true) pass('private', 'true');
  else fail('private', `expected true, got ${JSON.stringify(pkg.private)}`);

  if (pkg.type === 'module') pass('type', 'module');
  else fail('type', `expected "module", got ${JSON.stringify(pkg.type)}`);

  // exports ----------------------------------------------------------
  const exportsField = pkg.exports;
  if (!exportsField || typeof exportsField !== 'object' || Array.isArray(exportsField)) {
    fail('exports is an object');
  } else {
    for (const key of REQUIRED_EXPORTS) {
      if (Object.prototype.hasOwnProperty.call(exportsField, key)) pass(`exports includes "${key}"`);
      else fail(`exports includes "${key}"`, 'missing key');
    }

    const targets = [];
    for (const value of Object.values(exportsField)) exportTargets(value, targets);
    const missingTargets = targets.filter((target) => !exportTargetExists(target));
    if (missingTargets.length === 0) {
      pass('every exported path exists', `${targets.length} target(s)`);
    } else {
      const excused = missingTargets.filter((target) => inFlightMissing(target.replace(/^\.\//, '')));
      const hard = missingTargets.filter((target) => !excused.includes(target));
      for (const target of excused) note(`exported path not yet written: ${target}`, 'in flight');
      if (hard.length > 0) fail('every exported path exists', `missing: ${hard.join(', ')}`);
    }
  }

  // dsh manifest ------------------------------------------------------
  const dsh = pkg.dsh;
  if (!dsh || typeof dsh !== 'object' || Array.isArray(dsh)) {
    fail('dsh manifest object present');
    return pkg;
  }
  pass('dsh manifest object present');

  const patchPath = dsh?.bundle?.patch;
  if (typeof patchPath === 'string' && patchPath.trim() !== '') {
    pass('dsh.bundle.patch', patchPath);
    if (existsSync(absOf(patchPath))) pass('dsh.bundle.patch file exists');
    else fail('dsh.bundle.patch file exists', `missing ${patchPath}`);
  } else {
    fail('dsh.bundle.patch', 'missing or not a string');
  }

  const client = dsh.client;
  if (!client || typeof client !== 'object' || Array.isArray(client)) {
    fail('dsh.client object present');
  } else {
    pass('dsh.client object present');
    if (client.platform === 'web') pass('dsh.client.platform', 'web');
    else fail('dsh.client.platform', `expected "web", got ${JSON.stringify(client.platform)}`);
    if (Array.isArray(client.inject) && client.inject.length > 0) {
      pass('dsh.client.inject is a non-empty array', `${client.inject.length} entries`);
    } else {
      fail('dsh.client.inject is a non-empty array', JSON.stringify(client.inject));
    }
  }

  // files -------------------------------------------------------------
  if (!Array.isArray(pkg.files)) {
    fail('files array present');
    return pkg;
  }
  const patterns = pkg.files.filter((entry) => typeof entry === 'string' && entry.trim() !== '');
  if (patterns.length === 0) { fail('files array has entries'); return pkg; }
  pass('files array present', `${patterns.length} pattern(s)`);

  const dangling = patterns.filter((pattern) => !patternMatchesAnything(pattern));
  if (dangling.length === 0) {
    pass('every files entry resolves to a path');
  } else {
    const excused = dangling.filter((pattern) => inFlightMissing(pattern.replace(/^\.\//, '')));
    const hard = dangling.filter((pattern) => !excused.includes(pattern));
    for (const pattern of excused) note(`files entry not yet written: ${pattern}`, 'in flight');
    if (hard.length > 0) fail('every files entry resolves to a path', `no match: ${hard.join(', ')}`);
  }

  const runtimeFiles = collectRuntimeFiles();
  const uncovered = runtimeFiles.filter((file) => !fileCoveredByFiles(file, patterns));
  if (uncovered.length === 0) {
    pass('files covers every runtime file', `${runtimeFiles.length} files`);
  } else {
    const excused = uncovered.filter((file) => inFlightMissing(file));
    const hard = uncovered.filter((file) => !excused.includes(file));
    for (const file of excused) note(`files missing in-flight file: ${file}`, 'not yet written');
    if (hard.length > 0) fail('files covers every runtime file', `uncovered: ${hard.join(', ')}`);
  }

  return pkg;
}

function collectRuntimeFiles() {
  const files = [
    'index.js',
    'client.js',
    'cordis.patch.yml',
    'icon.svg',
    ...listFiles('lib').filter((file) => file.endsWith('.js')),
    ...listFiles('locale').filter((file) => file.endsWith('.json')),
  ];
  return [...new Set(files)].sort();
}

/* ------------------------------------------------------------------ *
 * 2. cordis.patch.yml
 * ------------------------------------------------------------------ */

function checkPatch(pkg) {
  section('Cordis patch: cordis.patch.yml');
  const declared = typeof pkg?.dsh?.bundle?.patch === 'string' ? pkg.dsh.bundle.patch : './cordis.patch.yml';
  const patchPath = declared.replace(/^\.\//, '');
  const read = readText(patchPath);
  if (read.missing) { fail('patch file exists', `missing ${patchPath}`); return; }
  if (!read.ok) { fail('patch file is readable', read.error); return; }
  pass('patch file exists', patchPath);

  const inserts = parsePatchInserts(read.text);
  if (inserts.length === 1) pass('exactly one insert block');
  else fail('exactly one insert block', `found ${inserts.length}`);

  const entries = inserts.flatMap((block) => block.entries);
  const named = entries.filter((entry) => entry.name === EXPECTED_NAME);
  if (named.length === 1) pass('insert entry name matches package name', EXPECTED_NAME);
  else if (named.length === 0) {
    fail('insert entry name matches package name', `no entry named "${EXPECTED_NAME}" (found: ${entries.map((entry) => entry.name).join(', ') || 'none'})`);
  } else {
    fail('insert entry name matches package name', `${named.length} entries named "${EXPECTED_NAME}"`);
  }

  const target = named[0];
  if (!target) return;
  if (typeof target.id === 'string' && target.id.trim() !== '') pass('insert entry id', target.id);
  else fail('insert entry id', 'missing or empty');
  if (target.config === undefined) note('insert entry has no config', 'ok if the plugin needs none');
  else if (target.config === '') note('insert entry config is empty', 'ok if the plugin needs none');
}

/* ------------------------------------------------------------------ *
 * 3. locales
 * ------------------------------------------------------------------ */

function checkLocales() {
  section('Locales: locale/en.json, locale/zh.json');
  const parsed = {};

  for (const code of ['en', 'zh']) {
    const read = readJson(`locale/${code}.json`);
    if (read.missing) { fail(`locale/${code}.json exists`, 'file not found'); continue; }
    if (!read.ok) { fail(`locale/${code}.json parses as JSON`, read.error); continue; }
    pass(`locale/${code}.json parses as JSON`);
    parsed[code] = read.data;

    const meta = read.data?.meta;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
      fail(`locale/${code}.json meta object present`);
      continue;
    }
    pass(`locale/${code}.json meta object present`);

    let title = null;
    if (typeof meta.title === 'string' && meta.title.trim() !== '') {
      title = meta.title.trim();
      pass(`locale/${code}.json meta.title is non-empty`, title);
    } else {
      fail(`locale/${code}.json meta.title is non-empty`, JSON.stringify(meta.title));
    }

    let description = null;
    if (typeof meta.description === 'string' && meta.description.trim() !== '') {
      description = meta.description.trim();
      pass(`locale/${code}.json meta.description is non-empty`, description);
    } else {
      fail(`locale/${code}.json meta.description is non-empty`, JSON.stringify(meta.description));
    }

    const leftovers = TEMPLATE_LEFTOVERS.filter((needle) =>
      `${title ?? ''} ${description ?? ''}`.includes(needle));
    if (leftovers.length === 0) pass(`locale/${code}.json meta has no template leftovers`);
    else fail(`locale/${code}.json meta has no template leftovers`, `found: ${leftovers.join(', ')}`);
  }

  const english = parsed.en?.meta;
  const chinese = parsed.zh?.meta;
  if (english && chinese) {
    if (typeof english.title === 'string' && typeof chinese.title === 'string'
      && english.title.trim() !== chinese.title.trim()) {
      pass('meta.title differs between locales');
    } else {
      fail('meta.title differs between locales', 'en and zh titles are equal or missing');
    }
    if (typeof english.description === 'string' && typeof chinese.description === 'string'
      && english.description.trim() !== chinese.description.trim()) {
      pass('meta.description differs between locales');
    } else {
      fail('meta.description differs between locales', 'en and zh descriptions are equal or missing');
    }
  }
}

/* ------------------------------------------------------------------ *
 * 4. icon
 * ------------------------------------------------------------------ */

function checkIcon() {
  section('Icon: icon.svg');
  const abs = absOf('icon.svg');
  if (!existsSync(abs)) { fail('icon.svg exists', 'file not found'); return; }
  pass('icon.svg exists', rel(abs));

  let stats;
  try {
    stats = statSync(abs);
  } catch (error) {
    fail('icon.svg is readable', error.message);
    return;
  }
  if (stats.size > 0 && stats.size <= ICON_MAX_BYTES) {
    pass('icon.svg size within 256 KiB', `${stats.size} bytes`);
  } else if (stats.size === 0) {
    fail('icon.svg size within 256 KiB', 'file is empty');
  } else {
    fail('icon.svg size within 256 KiB', `${stats.size} bytes > ${ICON_MAX_BYTES}`);
  }

  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch (error) {
    fail('icon.svg is readable as UTF-8', error.message);
    return;
  }
  if (text.includes('<svg')) pass('icon.svg contains an <svg> root');
  else fail('icon.svg contains an <svg> root', 'text does not contain "<svg"');
  if (text.includes('</svg>')) pass('icon.svg is closed');
  else note('icon.svg has no closing </svg>', 'only an XML-ish check is possible offline');
  if (/xmlns\s*=\s*["'][^"']+["']/.test(text)) pass('icon.svg declares an xmlns');
  else note('icon.svg has no xmlns attribute', 'browsers may still render it, but it is not portable SVG');
}

/* ------------------------------------------------------------------ *
 * 5. JavaScript syntax via `node --check`
 * ------------------------------------------------------------------ */

function checkJavaScript() {
  section('JavaScript syntax (node --check)');
  const jsFiles = [
    ...listFiles('.').filter((file) => file.endsWith('.js')),
    ...listFiles('lib').filter((file) => file.endsWith('.js')),
  ];

  if (jsFiles.length === 0) {
    fail('found .js files to syntax-check', 'none in bundle root or lib/');
    return;
  }

  for (const file of jsFiles) {
    const outcome = syntaxCheckFile(file);
    if (outcome.ok) {
      pass(`node --check ${file}`, outcome.esmFallback ? 'parsed as ESM' : '');
    } else {
      fail(`node --check ${file}`, outcome.detail || 'syntax error');
    }
  }
}

/**
 * Run `node --check` with output capture that also works inside confined
 * sandboxes where piped stdio is refused (EPERM). A first attempt uses a
 * normal pipe; if that is blocked, stderr is redirected to a temp file.
 */
function spawnCheck(args) {
  let result;
  try {
    result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 60_000 });
  } catch (error) {
    return { status: null, error, stderr: '' };
  }
  if (!isEperm(result.error)) {
    return { status: result.status, signal: result.signal, error: result.error, stderr: result.stderr || '' };
  }
  return spawnCheckNoPipes(args);
}

function spawnCheckNoPipes(args) {
  let dir = null;
  try {
    dir = mkdtempSync(join(tmpdir(), 'dsh-todo-check-'));
    const stderrPath = join(dir, 'stderr.log');
    const stderrFd = openSync(stderrPath, 'w');
    let result;
    try {
      result = spawnSync(process.execPath, args, { stdio: ['ignore', 'ignore', stderrFd], timeout: 60_000 });
    } finally {
      closeSync(stderrFd);
    }
    let stderr = '';
    try { stderr = readFileSync(stderrPath, 'utf8'); } catch { /* keep empty */ }
    return { status: result.status, signal: result.signal, error: result.error, stderr };
  } catch {
    // Last resort: exit status only, no captured diagnostics.
    const result = spawnSync(process.execPath, args, { stdio: 'ignore', timeout: 60_000 });
    return { status: result.status, signal: result.signal, error: result.error, stderr: '' };
  } finally {
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

function syntaxCheckFile(file) {
  const abs = absOf(file);
  let result = spawnCheck(['--check', abs]);
  let detail = firstLine(result.stderr);

  // A never-executed `node --check` may still parse .js as CommonJS in some
  // Node builds; retry an .mjs copy so ESM is unambiguously accepted.
  if (result.error) {
    return { ok: false, detail: `could not run node --check: ${result.error.message}` };
  }
  if (result.status !== 0 && isEsmMisparse(detail)) {
    const esmResult = checkEsmCopy(abs);
    if (esmResult.status === 0) return { ok: true, esmFallback: true };
    if (esmResult.error) return { ok: false, detail: esmResult.error.message };
    return { ok: false, detail: firstLine(esmResult.stderr) || detail };
  }
  if (result.status === 0) return { ok: true };
  if (result.signal) return { ok: false, detail: `killed by signal ${result.signal}` };
  return { ok: false, detail: detail || `node --check exited ${result.status}` };
}

function checkEsmCopy(absPath) {
  let dir = null;
  try {
    dir = mkdtempSync(join(tmpdir(), 'dsh-todo-esm-'));
    const copy = join(dir, 'check.mjs');
    writeFileSync(copy, readFileSync(absPath));
    return spawnCheck(['--check', copy]);
  } catch (error) {
    return { status: null, error, stderr: '' };
  } finally {
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

function isEperm(error) {
  return Boolean(error) && (error.code === 'EPERM' || /EPERM/.test(String(error.message || '')));
}

function firstLine(text) {
  return (text || '').trim().split(/\r?\n/).find((candidate) => candidate.trim() !== '') || '';
}

function isEsmMisparse(detail) {
  return /Cannot use import statement outside a module|may appear only with 'sourceType: module'|Unexpected token 'export'/i.test(detail);
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

function main() {
  console.log('Sticker TODO — static bundle checks');
  console.log(`Root: ${ROOT}`);
  if (!existsSync(ROOT)) {
    fail('bundle root exists', ROOT);
    summarize();
    return;
  }

  const pkg = checkManifest();
  checkPatch(pkg);
  checkLocales();
  checkIcon();

  // Presence of the declared runtime files (in-flight files are notes while absent).
  section('Runtime files present');
  for (const file of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'locale/en.json', 'locale/zh.json']) {
    if (existsSync(absOf(file))) pass(`${file} exists`);
    else if (inFlightMissing(file)) note(`${file} not yet written`, 'in flight');
    else fail(`${file} exists`, 'file not found');
  }

  checkJavaScript();
  summarize();
}

function summarize() {
  section('Summary');
  console.log(`checks: ${tally.pass} passed, ${tally.fail} failed, ${tally.note} note(s)`);
  if (failures.length > 0) {
    console.log('failures:');
    for (const item of failures) {
      console.log(`  - ${item.name}${item.detail ? `: ${item.detail}` : ''}`);
    }
  }
  console.log(tally.fail === 0 ? 'RESULT: PASS' : 'RESULT: FAIL');
  process.exitCode = tally.fail === 0 ? 0 : 1;
}

main();
