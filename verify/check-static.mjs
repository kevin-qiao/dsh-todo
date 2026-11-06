#!/usr/bin/env node
/**
 * verify/check-static.mjs — static (offline) validation for the
 * `dsh-sticker-todo` bundle.
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
 *   6. v1.7.0 memory release — version 1.7.0-era memory surface, memory actions / store / AI /
 *      tool / client strings, and the CONTRACT + docs/MEMORY.md documentation.
 *   7. v1.8.0 handoff release — version 1.8.0, the untagged-only `aiTag` contract, the five
 *      `note.handoff*` i18n strings in both languages and the client handoff implementation.
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

const EXPECTED_NAME = 'dsh-sticker-todo';
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

  // v1.8.0 is the handoff release; the version is asserted exactly so docs and
  // CHANGELOG entries cannot drift from the manifest.
  if (pkg.version === '1.8.0') pass('version is 1.8.0 (handoff release)');
  else fail('version is 1.8.0 (handoff release)', `expected "1.8.0", got ${JSON.stringify(pkg.version)}`);

  // The plugin must stay dependency-free: everything runs on Node built-ins.
  const dependencyFields = ['dependencies', 'peerDependencies', 'optionalDependencies'];
  const declared = dependencyFields.flatMap((field) => {
    const value = pkg[field];
    return value && typeof value === 'object' ? Object.keys(value).map((name) => `${field}:${name}`) : [];
  });
  if (declared.length === 0) pass('zero runtime dependencies');
  else fail('zero runtime dependencies', `declared: ${declared.join(', ')}`);

  if (pkg.private === true) fail('publishable', 'package.json must not be private when publishing to npm');
  else pass('publishable', 'not private');

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
 * 4b. v1.7.0 memory release
 * ------------------------------------------------------------------ */

/** Report one "all of these needles are present" check. */
function checkContains(label, text, needles) {
  const absent = needles.filter((needle) => !text.includes(needle));
  if (absent.length === 0) pass(label, `${needles.length} marker(s)`);
  else fail(label, `missing: ${absent.join(', ')}`);
}

function checkMemoryRelease() {
  section('v1.7.0 memory release');

  // Host HTTP actions ------------------------------------------------
  const indexRead = readText('index.js');
  if (indexRead.missing) { fail('index.js exists for the memory release', 'file not found'); return; }
  if (!indexRead.ok) { fail('index.js is readable', indexRead.error); return; }
  const memoryActions = ['remember', 'updateFact', 'forget', 'review', 'memoryCandidates', 'clearMemory'];
  const missingActions = memoryActions.filter((name) => !new RegExp(`case '${name}':`).test(indexRead.text));
  if (missingActions.length === 0) pass('index.js implements the six memory actions', memoryActions.join(' / '));
  else fail('index.js implements the six memory actions', `missing: ${missingActions.join(', ')}`);
  checkContains('index.js exposes the state.memory block', indexRead.text, ['memory: store.memory()']);
  checkContains('index.js builds the AI memory context', indexRead.text, ['memoryContext', 'lastAdvice']);

  // Store: document v2 + memory API ---------------------------------
  const storeRead = readText('lib/store.js');
  if (storeRead.missing) { fail('lib/store.js exists for the memory release', 'file not found'); }
  else if (!storeRead.ok) { fail('lib/store.js is readable', storeRead.error); }
  else {
    checkContains('lib/store.js persists document v2', storeRead.text, ['const VERSION = 2', 'events:', 'memory:', 'facts:', 'threads:']);
    checkContains('lib/store.js implements the memory API', storeRead.text, [
      'async function addFact(', 'async function updateFact(', 'async function forgetFact(',
      'async function saveThread(', 'async function clearMemory(',
      'export function deriveStats(', 'export function derivePostpones(', 'export function duePostponed(',
    ]);
    checkContains('lib/store.js migrates / removes history safely', storeRead.text, ['MEMORY_LIMITS', 'events: 2000', 'facts: 50', 'threads: 200', 'parsed?.events', 'parsed?.memory']);
  }

  // AI layer: pure helpers + review / memoryCandidates --------------
  const aiRead = readText('lib/ai.js');
  if (aiRead.missing) { fail('lib/ai.js exists for the memory release', 'file not found'); }
  else if (!aiRead.ok) { fail('lib/ai.js is readable', aiRead.error); }
  else {
    checkContains('lib/ai.js exports the memory pure helpers', aiRead.text, [
      'export function memoryPromptBlock(', 'export function heuristicReview(', 'export function normalizeReview(',
      'export function heuristicMemoryCandidates(', 'export function normalizeMemoryCandidates(',
    ]);
    checkContains('lib/ai.js wires review / memoryCandidates into the layer', aiRead.text, [
      'async review(input)', 'async memoryCandidates(input)', 'async noteAdvice(todo, history = [], memory = null)',
    ]);
  }

  // Tool: four memory actions + memory echo -------------------------
  const toolsRead = readText('lib/tools.js');
  if (toolsRead.missing) { fail('lib/tools.js exists for the memory release', 'file not found'); }
  else if (!toolsRead.ok) { fail('lib/tools.js is readable', toolsRead.error); }
  else {
    const actionsMatch = /const ACTIONS = \[([\s\S]*?)\]/.exec(toolsRead.text);
    if (!actionsMatch) fail('lib/tools.js declares the tool action list', 'ACTIONS array not found');
    else {
      const declared = [...actionsMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
      const missingToolActions = ['remember', 'forget', 'memories', 'review'].filter((name) => !declared.includes(name));
      if (missingToolActions.length === 0) pass('lib/tools.js exposes the four memory tool actions', declared.length + ' actions');
      else fail('lib/tools.js exposes the four memory tool actions', `missing: ${missingToolActions.join(', ')}`);
    }
    checkContains('lib/tools.js echoes the memory on read results', toolsRead.text, ['memory: { facts: memoryFacts', 'state.memory?.stats']);
  }

  // Client: dialog strings, dialog component, postpone badge --------
  const clientRead = readText('client.js');
  if (clientRead.missing) { fail('client.js exists for the memory release', 'file not found'); }
  else if (!clientRead.ok) { fail('client.js is readable', clientRead.error); }
  else {
    const memoryKeys = [
      'memory.button', 'memory.title', 'memory.factsTitle', 'memory.reviewTitle', 'memory.candidatesTitle',
      'memory.clear', 'memory.clearConfirm', 'memory.postponeTimes', 'memory.continueThread',
      'memory.stats.completed', 'memory.stats.postponed',
    ];
    const missingKeys = memoryKeys.filter((key) => !clientRead.text.includes(`'${key}':`));
    if (missingKeys.length === 0) pass('client.js ships the memory dialog + postpone badge strings', `${memoryKeys.length} keys`);
    else fail('client.js ships the memory dialog + postpone badge strings', `missing: ${missingKeys.join(', ')}`);
    checkContains('client.js renders the memory dialog and the postponement badge', clientRead.text, [
      'function MemoryDialog(', 'stk-modal--memory', 'stk-memory-section', 'stk-chip--postpone', 'threadHistory(',
    ]);
  }

  // Documentation ---------------------------------------------------
  const contractRead = readText('CONTRACT.md');
  if (contractRead.missing) fail('CONTRACT.md documents round 7', 'file not found');
  else if (!contractRead.ok) fail('CONTRACT.md is readable', contractRead.error);
  else {
    checkContains('CONTRACT.md documents round 7', contractRead.text, [
      '## Round 7 (v1.7.0', '### Persisted document v2', '### Derived values', 'memoryCandidates', 'clearMemory',
    ]);
  }
  const memoryDoc = readText('docs/MEMORY.md');
  if (memoryDoc.missing) fail('docs/MEMORY.md documents the memory model', 'file not found');
  else if (!memoryDoc.ok) fail('docs/MEMORY.md is readable', memoryDoc.error);
  else if (memoryDoc.text.trim().length < 500) fail('docs/MEMORY.md documents the memory model', `suspiciously short (${memoryDoc.text.length} chars)`);
  else {
    checkContains('docs/MEMORY.md documents the memory model', memoryDoc.text, ['facts', 'threads', 'events', 'postpones', 'clearMemory']);
  }
}

/* ------------------------------------------------------------------ *
 * 4c. v1.8.0 handoff release
 * ------------------------------------------------------------------ */

/** The five new i18n keys and their expected zh/en values (CONTRACT.md round 8). */
const HANDOFF_TEXT = {
  'note.handoff': ['交给 DSH', 'Ask DSH'],
  'note.handoffHint': ['把这条便签放进 DSH 主对话框（不自动发送）', 'Put this note into the DSH chat draft (does not send)'],
  'note.handoffDraft': ['已放进主对话框，检查后按回车发送', 'Added to the chat draft — review, then press Enter'],
  'note.handoffCopied': ['已复制，粘贴到主对话框即可', 'Copied — paste it into the chat'],
  'note.handoffFailed': ['无法放入主对话框，请手动复制', 'Could not add it to the chat — please copy manually'],
};

function checkHandoffRelease() {
  section('v1.8.0 handoff release');

  // Host: aiTag classifies only untagged notes ----------------------
  const aiRead = readText('lib/ai.js');
  if (aiRead.missing) { fail('lib/ai.js exists for the handoff release', 'file not found'); }
  else if (!aiRead.ok) { fail('lib/ai.js is readable', aiRead.error); }
  else {
    checkContains('lib/ai.js classifies only notes without tags', aiRead.text, [
      '!Array.isArray(todo.tags) || todo.tags.length === 0',
      "所有未完成便签都已经有标签，不用再分类。",
      "当前没有待办，暂时不用整理标签。",
    ]);
  }

  // Client: five handoff strings, both languages --------------------
  const clientRead = readText('client.js');
  if (clientRead.missing) { fail('client.js exists for the handoff release', 'file not found'); }
  else if (!clientRead.ok) { fail('client.js is readable', clientRead.error); }
  else {
    const missingStrings = Object.entries(HANDOFF_TEXT)
      .filter(([key, [zh, en]]) => !clientRead.text.includes(`'${key}':`)
        || !clientRead.text.includes(zh) || !clientRead.text.includes(en));
    if (missingStrings.length === 0) pass('client.js ships the five handoff strings in both languages', Object.keys(HANDOFF_TEXT).length + ' keys');
    else fail('client.js ships the five handoff strings in both languages', `missing: ${missingStrings.map(([key]) => key).join(', ')}`);
    checkContains('client.js implements the handoff draft + clipboard fallback', clientRead.text, [
      'function buildHandoffPrompt(',
      'function resolveUiWorkspace(',
      "get('uiWorkspace')",
      'pluginContext = ctx',
      "startSession(undefined, { prompt, whenDraftExists: 'append' })",
      'navigator.clipboard',
      'writeText(',
      'stk-note-action--handoff',
    ]);
  }

  // Documentation: CONTRACT round 8 --------------------------------
  const contractRead = readText('CONTRACT.md');
  if (contractRead.missing) fail('CONTRACT.md documents round 8', 'file not found');
  else if (!contractRead.ok) fail('CONTRACT.md is readable', contractRead.error);
  else {
    checkContains('CONTRACT.md documents round 8', contractRead.text, [
      '## Round 8 (v1.8.0', '### `aiTag` only classifies untagged notes',
      'whenDraftExists', 'note.handoff',
    ]);
  }
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
  checkMemoryRelease();
  checkHandoffRelease();

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
