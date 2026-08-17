#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { devNull } from 'node:os';
import { basename, posix, resolve, sep } from 'node:path';
import { AGENT_SURFACES, KNOWN_WORKFLOW_PATTERNS, REGISTRY_VERSION } from './agent-surfaces.mjs';

const SCHEMA_VERSION = 3;
const DEFAULT_MAX_BYTES = 32 * 1024;
const MIN_MAX_BYTES = 4 * 1024;
const MAX_TEXT_FILE_BYTES = 1024 * 1024;
const MAX_REFERENCE_ROOTS = 64;
const MAX_REFERENCE_FACTS = 128;
const MAX_REFERENCE_CONTENT_READS = 64;
const GIT_TIMEOUT_MS = 1000;
const GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const REGULAR_FILE_MODES = new Set(['100644', '100755']);

function fail(message) {
  process.stderr.write(`scan-repo: ${message}\n`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    maxOutputBytes: DEFAULT_MAX_BYTES,
    includeSensitivePaths: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') {
      options.root = argv[++index];
      if (!options.root) throw new Error('--root requires a path');
    } else if (argument === '--max-output-bytes') {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < MIN_MAX_BYTES) {
        throw new Error(`--max-output-bytes must be an integer of at least ${MIN_MAX_BYTES} bytes`);
      }
      options.maxOutputBytes = value;
    } else if (argument === '--include-sensitive-paths') {
      options.includeSensitivePaths = true;
    } else if (argument === '--help' || argument === '-h') {
      process.stdout.write('Usage: node scan-repo.mjs --root <repository> [--max-output-bytes <bytes>] [--include-sensitive-paths]\n');
      process.exit(0);
    } else {
      throw new Error('unknown argument');
    }
  }
  return options;
}

function portablePath(value) {
  return value.split(sep).join('/');
}

function codeUnitCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isolatedGitEnvironment() {
  const environment = { ...process.env };
  const exact = new Set([
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_CEILING_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_CONFIG',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_NOSYSTEM',
    'GIT_CONFIG_PARAMETERS',
    'GIT_CONFIG_SYSTEM',
    'GIT_DIR',
    'GIT_DISCOVERY_ACROSS_FILESYSTEM',
    'GIT_GRAFT_FILE',
    'GIT_INDEX_FILE',
    'GIT_INDEX_VERSION',
    'GIT_IMPLICIT_WORK_TREE',
    'GIT_NAMESPACE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_PREFIX',
    'GIT_REPLACE_REF_BASE',
    'GIT_SHALLOW_FILE',
    'GIT_WORK_TREE',
  ]);
  for (const name of Object.keys(environment)) {
    if (exact.has(name) || name.startsWith('GIT_CONFIG_') || name.startsWith('GIT_TRACE')) delete environment[name];
  }
  Object.assign(environment, {
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: devNull,
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PROTOCOL_FROM_USER: '0',
    GIT_TERMINAL_PROMPT: '0',
  });
  return environment;
}

function git(root, args, options = {}) {
  const result = spawnSync('git', [
    '--no-optional-locks',
    '-c', `core.hooksPath=${devNull}`,
    '-c', 'core.fsmonitor=false',
    '-c', 'protocol.allow=never',
    '-c', 'credential.interactive=never',
    '-c', 'fetch.recurseSubmodules=false',
    '-c', 'submodule.recurse=false',
    '-c', 'maintenance.auto=false',
    '-c', 'gc.auto=0',
    '-C', root,
    ...args,
  ], {
    encoding: options.encoding ?? 'utf8',
    env: isolatedGitEnvironment(),
    input: options.input,
    killSignal: 'SIGKILL',
    maxBuffer: options.maxBuffer ?? GIT_MAX_BUFFER_BYTES,
    timeout: GIT_TIMEOUT_MS,
  });
  if (result.status !== 0) return null;
  return result.stdout;
}

function sensitiveCategory(path) {
  const names = portablePath(path).split('/').filter(Boolean).reverse();
  for (const name of names) {
    const category = sensitiveNameCategory(name.toLowerCase());
    if (category) return category;
  }
  return null;
}

function sensitiveNameCategory(name) {
  if (name === '.env' || name.startsWith('.env.')) return 'env';
  if (/^(id_rsa|id_dsa|id_ecdsa|id_ed25519)$/.test(name) || /\.(pem|key|p12|pfx)$/.test(name)) return 'keyLike';
  if (/(credential|credentials|secret|secrets|token|tokens)/.test(name)) return 'credentialLike';
  return null;
}

function normalizedRepositoryPath(value) {
  const portable = portablePath(value);
  if (!portable || portable.startsWith('/') || /^[a-z]:\//i.test(portable)) return null;
  const normalized = posix.normalize(portable);
  if (normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

function parseNulPaths(output) {
  const paths = new Set();
  for (const value of output.split('\0')) {
    const path = normalizedRepositoryPath(value);
    if (path) paths.add(path);
  }
  return paths;
}

function collectIndexEntries(root, warnings) {
  const output = git(root, ['ls-files', '--stage', '-z', '--']);
  if (output === null) {
    warnings.push('Git index snapshot unavailable; tracked paths and content are incomplete.');
    return null;
  }
  const entries = [];
  for (const record of output.split('\0')) {
    if (!record) continue;
    const separator = record.indexOf('\t');
    if (separator < 0) continue;
    const metadata = record.slice(0, separator).split(' ');
    const path = normalizedRepositoryPath(record.slice(separator + 1));
    if (metadata.length !== 3 || !path) continue;
    const [mode, oid, stage] = metadata;
    entries.push({ mode, oid, stage: Number(stage), path, bytes: null });
  }
  return entries;
}

function addBlobSizes(root, entries, warnings) {
  const regular = entries.filter((entry) => entry.stage === 0 && REGULAR_FILE_MODES.has(entry.mode));
  const oids = [...new Set(regular.map((entry) => entry.oid))];
  if (oids.length === 0) return true;
  const output = git(root, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], {
    input: `${oids.join('\n')}\n`,
  });
  if (output === null) {
    warnings.push('Git blob-size evidence unavailable; tracked content metadata is incomplete.');
    return false;
  }
  const sizes = new Map();
  for (const line of output.split('\n')) {
    const [oid, type, sizeText] = line.split(' ');
    const size = Number(sizeText);
    if (oid && type === 'blob' && Number.isSafeInteger(size) && size >= 0) sizes.set(oid, size);
  }
  for (const entry of regular) entry.bytes = sizes.get(entry.oid) ?? null;
  if (regular.some((entry) => entry.bytes === null)) {
    warnings.push('Some Git blob-size evidence is unavailable; tracked content metadata is incomplete.');
    return false;
  }
  return true;
}

function pathFact(root, args, label, warnings) {
  const output = git(root, args);
  if (output === null) {
    warnings.push(`Git ${label} evidence unavailable; ${label} facts are incomplete.`);
    return null;
  }
  return parseNulPaths(output);
}

function collectHeadState(root, warnings) {
  const output = git(root, [
    'status',
    '--porcelain=v2',
    '--branch',
    '-z',
    '--untracked-files=no',
    '--ignore-submodules=all',
    '--',
  ]);
  const oidRecord = output?.split('\0').find((record) => record.startsWith('# branch.oid '));
  const oid = oidRecord?.slice('# branch.oid '.length);
  if (oid === '(initial)') return 'unborn';
  if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(oid ?? '')) return 'present';
  warnings.push('Git HEAD-state evidence unavailable; HEAD state is incomplete.');
  return null;
}

function collectHistory(root, regularPaths, warnings) {
  const subjectOutput = git(root, ['log', '--format=%s', '--all', '--']);
  const nameOutput = git(root, ['log', '--name-only', '--format=', '--all', '--']);
  const available = subjectOutput !== null && nameOutput !== null;
  if (!available) {
    warnings.push('Git history evidence unavailable; history facts are incomplete.');
  }
  const subjects = (subjectOutput ?? '').split('\n').filter(Boolean);
  const frequencies = new Map();
  for (const value of (nameOutput ?? '').split('\n')) {
    const path = normalizedRepositoryPath(value.trim());
    if (!path || !regularPaths.has(path) || sensitiveCategory(path)) continue;
    frequencies.set(path, (frequencies.get(path) ?? 0) + 1);
  }
  return {
    available,
    value: {
      commitsInspected: subjects.length,
      commitKeywordCounts: {
        fix: subjects.filter((subject) => /\bfix(?:e[ds])?\b/i.test(subject)).length,
        revert: subjects.filter((subject) => /\brevert(?:ed|s|ing)?\b/i.test(subject)).length,
      },
      fileFrequency: [...frequencies]
        .map(([path, commits]) => ({ path, commits }))
        .sort((left, right) => right.commits - left.commits || codeUnitCompare(left.path, right.path)),
    },
  };
}

function collectGitEvidence(root) {
  const topLevel = git(root, ['rev-parse', '--show-toplevel'])?.trim();
  if (!topLevel || resolve(topLevel) !== root) return null;
  const warnings = [];
  const entries = collectIndexEntries(root, warnings);
  const tracked = entries === null ? null : new Set(entries.map((entry) => entry.path));
  const regularEntries = (entries ?? []).filter((entry) => entry.stage === 0 && REGULAR_FILE_MODES.has(entry.mode));
  const regularPaths = new Set(regularEntries.map((entry) => entry.path));
  const symlinkPaths = new Set((entries ?? []).filter((entry) => entry.stage === 0 && entry.mode === '120000').map((entry) => entry.path));
  const unsupportedPaths = new Set((entries ?? []).filter((entry) => entry.stage === 0 && !REGULAR_FILE_MODES.has(entry.mode) && entry.mode !== '120000').map((entry) => entry.path));
  const sizesAvailable = entries === null ? false : addBlobSizes(root, entries, warnings);
  const untracked = pathFact(root, ['ls-files', '-z', '--others', '--exclude-standard', '--'], 'untracked-file', warnings);
  const ignored = pathFact(root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--'], 'ignored-file', warnings);
  const dirty = pathFact(root, ['diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv', '--'], 'dirty-file', warnings);
  const headState = collectHeadState(root, warnings);
  const staged = pathFact(root, ['diff', '--cached', '--name-only', '-z', '--no-ext-diff', '--no-textconv', '--'], 'staged-file', warnings);
  const history = collectHistory(root, regularPaths, warnings);
  return {
    entries,
    tracked,
    regularEntries,
    regularPaths,
    symlinkPaths,
    unsupportedPaths,
    sizesAvailable,
    untracked,
    ignored,
    dirty,
    staged,
    headState,
    history: history.value,
    historyAvailable: history.available,
    warnings,
  };
}

function inferredDirectories(files) {
  const directories = new Set();
  for (const file of files) {
    let directory = posix.dirname(file.path);
    while (directory !== '.') {
      directories.add(directory);
      directory = posix.dirname(directory);
    }
  }
  return directories;
}

function registryMatches(files, directories) {
  const matches = [];
  for (const surface of AGENT_SURFACES) {
    if (surface.match === 'filename') {
      for (const file of files.filter((item) => basename(item.path) === surface.value)) {
        matches.push({ agent: surface.agent, kind: surface.kind, path: file.path, source: 'registry' });
      }
    } else {
      for (const directory of directories) {
        if (directory === surface.value || directory.endsWith(`/${surface.value}`)) {
          matches.push({ agent: surface.agent, kind: surface.kind, path: directory, source: 'registry' });
        }
      }
    }
  }
  return matches.sort((left, right) => codeUnitCompare(left.path, right.path) || codeUnitCompare(left.agent, right.agent));
}

function isInstructionFilename(path) {
  const name = basename(path);
  return AGENT_SURFACES.some((surface) => (
    surface.kind === 'instruction-file-candidate'
      && surface.match === 'filename'
      && surface.value === name
  ));
}

function withheldInstructionCandidates(entries) {
  const sensitivePaths = new Set();
  const symbolicLinkPaths = new Set();
  for (const entry of entries ?? []) {
    if (entry.stage !== 0 || !isInstructionFilename(entry.path)) continue;
    if (sensitiveCategory(entry.path)) sensitivePaths.add(entry.path);
    else if (entry.mode === '120000') symbolicLinkPaths.add(entry.path);
  }
  return {
    sensitive: sensitivePaths.size,
    symbolicLinks: symbolicLinkPaths.size,
  };
}

function normalizeReference(sourcePath, target) {
  const cleaned = target.trim().replace(/^<|>$/g, '').split('#')[0].split('?')[0];
  const portable = portablePath(cleaned);
  if (!portable || portable.startsWith('/') || /^[a-z]:\//i.test(portable) || /^[a-z][a-z0-9+.-]*:/i.test(portable)) return null;
  const normalized = posix.normalize(posix.join(posix.dirname(sourcePath), portable));
  if (normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

function extractReferences(sourcePath, text) {
  const values = [];
  const seen = new Set();
  const add = (target, syntax, sourceLine) => {
    const normalized = normalizeReference(sourcePath, target);
    if (!normalized) return;
    const key = `${sourceLine}\0${normalized}\0${syntax}`;
    if (seen.has(key)) return;
    seen.add(key);
    values.push({ sourcePath, sourceLine, targetPath: normalized, syntax });
  };
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const sourceLine = index + 1;
    for (const match of line.matchAll(/\[[^\]]*\]\(\s*(?:<([^>]+)>|([^)\s]+))\s*\)/g)) add(match[1] ?? match[2], 'markdown-link', sourceLine);
    for (const match of line.matchAll(/`((?:\.?\.?\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+)`/g)) add(match[1], 'literal-path', sourceLine);
    const include = line.match(/^\s*@((?:\.?\.?\/)?[^\s#]+)\s*$/);
    if (include) add(include[1], 'known-include', sourceLine);
    const checklist = line.match(/^\s*[-*]\s+((?:\.?\.?\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+)\s*$/);
    if (checklist) add(checklist[1], 'startup-checklist-path', sourceLine);
  }
  return values;
}

function createBlobReader(root) {
  const cache = new Map();
  const inspectedPaths = new Set();
  const skippedPaths = new Set();
  const limitSkippedPaths = new Set();
  const failedPaths = new Set();
  return {
    readWithStatus(entry) {
      if (entry.bytes === null || entry.bytes > MAX_TEXT_FILE_BYTES) {
        skippedPaths.add(entry.path);
        if (entry.bytes !== null) limitSkippedPaths.add(entry.path);
        return { text: null, reason: entry.bytes === null ? 'bytes-unavailable' : 'size-admission-refused' };
      }
      let result = cache.get(entry.oid);
      if (result === undefined) {
        result = { text: git(root, ['cat-file', 'blob', entry.oid], { maxBuffer: MAX_TEXT_FILE_BYTES + 1024 }) };
        cache.set(entry.oid, result);
      }
      if (result.text === null) failedPaths.add(entry.path);
      else inspectedPaths.add(entry.path);
      return { text: result.text, reason: result.text === null ? 'git-read-failed' : null };
    },
    read(entry) {
      return this.readWithStatus(entry).text;
    },
    stats() {
      return {
        inspected: inspectedPaths.size,
        skipped: skippedPaths.size,
        limitSkipped: limitSkippedPaths.size,
        failed: failedPaths.size,
      };
    },
  };
}

function instructionSurfaceCandidates(files, surfaces, pathsAvailable, withheld) {
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const candidates = surfaces
    .filter((surface) => surface.kind === 'instruction-file-candidate')
    .map((surface) => ({
      path: surface.path,
      bytes: filesByPath.get(surface.path)?.bytes ?? null,
      agent: surface.agent,
      kind: surface.kind,
      source: surface.source,
      scopePath: posix.dirname(surface.path),
    }));
  const incompleteness = [];
  if (withheld.sensitive > 0) incompleteness.push({ reason: 'sensitive-path-withheld', count: withheld.sensitive });
  if (withheld.symbolicLinks > 0) incompleteness.push({ reason: 'symbolic-link-withheld', count: withheld.symbolicLinks });
  const withheldTotal = withheld.sensitive + withheld.symbolicLinks;
  return {
    complete: pathsAvailable && withheldTotal === 0 && candidates.every((candidate) => candidate.bytes !== null),
    total: pathsAvailable ? candidates.length + withheldTotal : null,
    retained: candidates.length,
    candidates,
    incompleteness,
  };
}

function incrementReason(counts, reason, count = 1) {
  counts.set(reason, (counts.get(reason) ?? 0) + count);
}

function syntacticReferences(entries, candidates, reader, pathsAvailable, withheld) {
  const entriesByPath = new Map(entries.filter((entry) => entry.stage === 0).map((entry) => [entry.path, entry]));
  const allRootPaths = [...new Set(candidates.candidates.map((item) => item.path))].sort(codeUnitCompare);
  const rootPaths = allRootPaths.slice(0, MAX_REFERENCE_ROOTS);
  const references = [];
  const incomplete = new Map();
  if (!pathsAvailable) incrementReason(incomplete, 'git-snapshot-unavailable');
  if (withheld.sensitive > 0) incrementReason(incomplete, 'sensitive-instruction-content-withheld', withheld.sensitive);
  if (withheld.symbolicLinks > 0) incrementReason(incomplete, 'symbolic-link-instruction-content-withheld', withheld.symbolicLinks);
  if (allRootPaths.length > rootPaths.length) {
    incrementReason(incomplete, 'traversal-budget', allRootPaths.length - rootPaths.length);
  }
  const visited = new Set(rootPaths);
  const queue = rootPaths.map((path) => ({ path, hop: 0 }));
  let contentReads = 0;
  let referenceFacts = 0;
  traversal: for (let index = 0; index < queue.length; index += 1) {
    if (contentReads >= MAX_REFERENCE_CONTENT_READS) {
      incrementReason(incomplete, 'traversal-budget', queue.length - index);
      break;
    }
    const source = queue[index];
    const sourceEntry = entriesByPath.get(source.path);
    if (!sourceEntry || !REGULAR_FILE_MODES.has(sourceEntry.mode)) {
      incrementReason(incomplete, 'unsupported-or-missing-object');
      continue;
    }
    contentReads += 1;
    const read = reader.readWithStatus(sourceEntry);
    if (read.text === null) {
      incrementReason(incomplete, read.reason);
      continue;
    }
    const extracted = extractReferences(source.path, read.text);
    if (source.hop === 3) {
      const retainedFacts = Math.min(extracted.length, MAX_REFERENCE_FACTS - referenceFacts);
      if (retainedFacts > 0) incrementReason(incomplete, 'hop-limit', retainedFacts);
      referenceFacts += retainedFacts;
      if (retainedFacts < extracted.length) {
        incrementReason(incomplete, 'traversal-budget', extracted.length - retainedFacts);
        break;
      }
      continue;
    }
    for (let referenceIndex = 0; referenceIndex < extracted.length; referenceIndex += 1) {
      if (referenceFacts >= MAX_REFERENCE_FACTS) {
        incrementReason(incomplete, 'traversal-budget', extracted.length - referenceIndex);
        break traversal;
      }
      referenceFacts += 1;
      const reference = extracted[referenceIndex];
      const hop = source.hop + 1;
      if (sensitiveCategory(reference.targetPath)) {
        incrementReason(incomplete, 'sensitive-target-refused');
        continue;
      }
      const target = entriesByPath.get(reference.targetPath);
      const targetIsRegular = target && REGULAR_FILE_MODES.has(target.mode);
      references.push({
        ...reference,
        hop,
        targetBytes: targetIsRegular ? target.bytes : null,
      });
      if (!target) {
        incrementReason(incomplete, 'unsupported-or-missing-object');
        continue;
      }
      if (!targetIsRegular) {
        incrementReason(incomplete, target.mode === '120000' ? 'symbolic-link-refused' : 'unsupported-or-missing-object');
        continue;
      }
      if (target.bytes === null) {
        incrementReason(incomplete, 'bytes-unavailable');
        continue;
      }
      if (target.bytes > MAX_TEXT_FILE_BYTES) {
        incrementReason(incomplete, 'size-admission-refused');
        continue;
      }
      if (!visited.has(target.path)) {
        visited.add(target.path);
        queue.push({ path: target.path, hop });
      }
    }
  }
  references.sort((left, right) => codeUnitCompare(left.sourcePath, right.sourcePath)
    || left.sourceLine - right.sourceLine
    || codeUnitCompare(left.targetPath, right.targetPath)
    || codeUnitCompare(left.syntax, right.syntax)
    || left.hop - right.hop);
  const incompleteness = [...incomplete]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => codeUnitCompare(left.reason, right.reason));
  return {
    complete: incompleteness.length === 0,
    total: pathsAvailable ? references.length : null,
    retained: references.length,
    references,
    incompleteness,
  };
}

function packageScripts(files, reader) {
  const manifest = files.find((file) => file.path === 'package.json' && !sensitiveCategory(file.path));
  if (!manifest) return [];
  try {
    const text = reader.read(manifest);
    if (text === null) return [];
    const parsed = JSON.parse(text);
    return Object.keys(parsed.scripts ?? {}).sort(codeUnitCompare);
  } catch {
    return [];
  }
}

function workflowFiles(files) {
  return files
    .map((file) => file.path)
    .filter((path) => KNOWN_WORKFLOW_PATTERNS.some((pattern) => pattern.endsWith('/') ? path.startsWith(pattern) : path === pattern))
    .sort(codeUnitCompare);
}

function itemCount(report) {
  return report.files.largest.length
    + report.agentSurfaces.length
    + report.instructionSurfaceCandidates.candidates.length
    + report.syntacticReferences.references.length
    + report.packageScripts.length
    + report.workflows.length
    + report.history.fileFrequency.length
    + (report.sensitiveIndicators.paths?.length ?? 0);
}

function serialize(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function enforceBudget(report, maxBytes) {
  const totalMatchingItems = itemCount(report);
  report.truncation.totalMatchingItems = totalMatchingItems;
  report.truncation.itemsReturned = totalMatchingItems;
  const sections = [
    ['files.largest', report.files.largest],
    ['history.fileFrequency', report.history.fileFrequency],
    ['agentSurfaces', report.agentSurfaces],
    ['workflows', report.workflows],
    ['packageScripts', report.packageScripts],
    ['sensitiveIndicators.paths', report.sensitiveIndicators.paths],
    ['syntacticReferences.references', report.syntacticReferences.references],
    ['instructionSurfaceCandidates.candidates', report.instructionSurfaceCandidates.candidates],
  ].filter(([, array]) => Array.isArray(array));
  const mark = (name) => {
    if (!report.truncation.sectionsTruncated.includes(name)) report.truncation.sectionsTruncated.push(name);
    if (name === 'instructionSurfaceCandidates.candidates') {
      report.instructionSurfaceCandidates.complete = false;
      report.instructionSurfaceCandidates.retained = report.instructionSurfaceCandidates.candidates.length;
    }
    if (name === 'syntacticReferences.references') {
      report.syntacticReferences.complete = false;
      report.syntacticReferences.retained = report.syntacticReferences.references.length;
      const outputBudget = report.syntacticReferences.incompleteness.find((item) => item.reason === 'output-budget');
      const omitted = report.syntacticReferences.total - report.syntacticReferences.references.length;
      if (outputBudget) outputBudget.count = omitted;
      else report.syntacticReferences.incompleteness.push({ reason: 'output-budget', count: omitted });
      report.syntacticReferences.incompleteness.sort((left, right) => codeUnitCompare(left.reason, right.reason));
    }
  };
  const synchronizeCounts = () => {
    report.instructionSurfaceCandidates.retained = report.instructionSurfaceCandidates.candidates.length;
    report.syntacticReferences.retained = report.syntacticReferences.references.length;
    report.truncation.itemsReturned = itemCount(report);
  };
  const setPrefix = (name, array, items, length) => {
    array.length = 0;
    for (let index = 0; index < length; index += 1) array.push(items[index]);
    mark(name);
    synchronizeCounts();
  };
  let bytes = Buffer.byteLength(serialize(report));
  if (bytes > maxBytes) report.truncation.truncated = true;
  for (const [name, array] of sections) {
    if (bytes <= maxBytes) break;
    if (array.length === 0) continue;
    const items = array.slice();
    setPrefix(name, array, items, 0);
    bytes = Buffer.byteLength(serialize(report));
    if (bytes > maxBytes) continue;
    let lower = 0;
    let upper = items.length;
    while (lower < upper) {
      const middle = Math.ceil((lower + upper) / 2);
      setPrefix(name, array, items, middle);
      bytes = Buffer.byteLength(serialize(report));
      if (bytes <= maxBytes) lower = middle;
      else upper = middle - 1;
    }
    setPrefix(name, array, items, lower);
    bytes = Buffer.byteLength(serialize(report));
    break;
  }
  synchronizeCounts();
  const output = serialize(report);
  if (Buffer.byteLength(output) > maxBytes) throw new Error(`minimum report exceeds ${maxBytes} bytes`);
  return output;
}

function emptyHistory() {
  return { commitsInspected: 0, commitKeywordCounts: { fix: 0, revert: 0 }, fileFrequency: [] };
}

function nonGitReport(rootName, options) {
  return {
    schemaVersion: SCHEMA_VERSION,
    registryVersion: REGISTRY_VERSION,
    repository: {
      name: sensitiveCategory(rootName) ? '[redacted-sensitive-path]' : rootName,
      gitAvailable: false,
      trackedFiles: null,
      untrackedFiles: null,
      ignoredFiles: null,
      dirtyFiles: null,
      stagedFiles: null,
    },
    evidenceProvenance: {
      snapshot: {
        kind: 'git-index-blob-snapshot',
        available: false,
        trackedPaths: null,
        contentFilesInspected: 0,
        contentFilesSkipped: 0,
        contentFilesFailed: 0,
      },
      livePathStatus: {
        kind: 'path-status-only-live-facts',
        available: false,
        contentRead: false,
        headState: null,
        dirtyPaths: null,
        stagedPaths: null,
        untrackedPaths: null,
        ignoredPaths: null,
      },
    },
    nativeLiveInspectionRequired: { required: true, reasons: ['git-snapshot-unavailable', 'live-filesystem-not-inspected'] },
    contentBlindSpots: { dirtyFiles: null, untrackedFiles: null, ignoredFiles: null, total: null },
    files: { total: null, totalBytes: null, skippedSymbolicLinks: 0, largest: [] },
    agentSurfaces: [],
    instructionSurfaceCandidates: { complete: false, total: null, retained: 0, candidates: [], incompleteness: [{ reason: 'git-snapshot-unavailable', count: 1 }] },
    syntacticReferences: { complete: false, total: null, retained: 0, references: [], incompleteness: [{ reason: 'git-snapshot-unavailable', count: 1 }] },
    packageScripts: [],
    workflows: [],
    history: emptyHistory(),
    sensitiveIndicators: {
      envFiles: null,
      keyLikeFiles: null,
      credentialLikeFiles: null,
      trackedSensitiveFiles: null,
      untrackedSensitiveFiles: null,
      ignoredSensitiveFiles: null,
      unknownSensitiveFiles: null,
      ...(options.includeSensitivePaths ? { paths: [] } : {}),
    },
    warnings: [
      'Git snapshot unavailable; live filesystem content was not inspected.',
      'Native live inspection is required for current repository evidence.',
    ],
    truncation: { truncated: false, maxOutputBytes: options.maxOutputBytes, sectionsTruncated: [], totalMatchingItems: 0, itemsReturned: 0 },
  };
}

function factSize(value) {
  return value === null ? null : value.size;
}

function blindSpotTotal(dirty, untracked, ignored) {
  if (dirty === null || untracked === null || ignored === null) return null;
  return dirty.size + untracked.size + ignored.size;
}

function buildGitReport(rootName, root, gitData, options) {
  const regularFiles = gitData.regularEntries;
  const visibleFiles = regularFiles.filter((file) => !sensitiveCategory(file.path));
  const visibleDirectories = new Set([...inferredDirectories(visibleFiles)].filter((path) => !sensitiveCategory(path)));
  const agentSurfaces = registryMatches(visibleFiles, visibleDirectories);
  const withheldCandidates = withheldInstructionCandidates(gitData.entries);
  const instructionCandidates = instructionSurfaceCandidates(visibleFiles, agentSurfaces, gitData.entries !== null, withheldCandidates);
  const reader = createBlobReader(root);
  const references = syntacticReferences(gitData.entries ?? [], instructionCandidates, reader, gitData.entries !== null, withheldCandidates);
  const scripts = packageScripts(visibleFiles, reader);
  const readerStats = reader.stats();
  const knownPaths = new Set([
    ...(gitData.tracked ?? []),
    ...(gitData.untracked ?? []),
    ...(gitData.ignored ?? []),
  ]);
  for (const path of gitData.symlinkPaths) knownPaths.delete(path);
  const sensitive = [...knownPaths]
    .map((path) => ({ path, category: sensitiveCategory(path) }))
    .filter((item) => item.category)
    .sort((left, right) => codeUnitCompare(left.path, right.path));
  const sensitivePathUniverseAvailable = [gitData.tracked, gitData.untracked, gitData.ignored].every((value) => value !== null);
  const pathStatusAvailable = gitData.headState !== null
    && [gitData.dirty, gitData.staged, gitData.untracked, gitData.ignored].every((value) => value !== null);
  const snapshotAvailable = gitData.entries !== null && gitData.sizesAvailable;
  const reasons = [];
  if (!snapshotAvailable) reasons.push('git-evidence-incomplete');
  if ((gitData.dirty?.size ?? 0) > 0) reasons.push('dirty-content-not-inspected');
  if ((gitData.untracked?.size ?? 0) > 0) reasons.push('untracked-content-not-inspected');
  if ((gitData.ignored?.size ?? 0) > 0) reasons.push('ignored-content-not-inspected');
  if (!pathStatusAvailable) reasons.push('path-status-evidence-incomplete');
  if (gitData.dirty === null) reasons.push('dirty-path-status-evidence-incomplete');
  if (gitData.staged === null) reasons.push('staged-path-status-evidence-incomplete');
  if (gitData.untracked === null) reasons.push('untracked-path-status-evidence-incomplete');
  if (gitData.ignored === null) reasons.push('ignored-path-status-evidence-incomplete');
  if (gitData.headState === null) reasons.push('head-state-evidence-incomplete');
  if (!gitData.historyAvailable) reasons.push('history-evidence-incomplete');
  if (gitData.unsupportedPaths.size > 0) reasons.push('unsupported-index-entry-content');
  if (withheldCandidates.sensitive > 0) reasons.push('sensitive-instruction-content-withheld');
  if (withheldCandidates.symbolicLinks > 0) reasons.push('symbolic-link-instruction-content-withheld');
  if (readerStats.limitSkipped > 0) reasons.push('snapshot-content-limit-exceeded');
  if (readerStats.failed > 0) reasons.push('snapshot-content-read-failed');
  const skippedSymbolicLinks = gitData.symlinkPaths.size;
  const warnings = [
    ...gitData.warnings,
    ...(skippedSymbolicLinks > 0 ? [`Skipped ${skippedSymbolicLinks} symbolic ${skippedSymbolicLinks === 1 ? 'link' : 'links'}; symbolic links are never followed.`] : []),
    ...(readerStats.limitSkipped > 0 ? ['Some snapshot content candidates exceeded the inspection limit; content evidence is incomplete.'] : []),
    ...(readerStats.failed > 0 ? ['Some snapshot content candidates could not be read from Git objects; content evidence is incomplete.'] : []),
    ...(reasons.length > 0 ? ['Native live inspection is required for current repository evidence.'] : []),
  ];
  const categoryCount = (category) => sensitivePathUniverseAvailable
    ? sensitive.filter((file) => file.category === category).length
    : null;
  const factCount = (fact) => fact === null
    ? null
    : sensitive.filter((file) => fact.has(file.path)).length;
  return {
    schemaVersion: SCHEMA_VERSION,
    registryVersion: REGISTRY_VERSION,
    repository: {
      name: sensitiveCategory(rootName) ? '[redacted-sensitive-path]' : rootName,
      gitAvailable: true,
      trackedFiles: factSize(gitData.tracked),
      untrackedFiles: factSize(gitData.untracked),
      ignoredFiles: factSize(gitData.ignored),
      dirtyFiles: factSize(gitData.dirty),
      stagedFiles: factSize(gitData.staged),
    },
    evidenceProvenance: {
      snapshot: {
        kind: 'git-index-blob-snapshot',
        available: snapshotAvailable,
        trackedPaths: factSize(gitData.tracked),
        contentFilesInspected: readerStats.inspected,
        contentFilesSkipped: readerStats.skipped,
        contentFilesFailed: readerStats.failed,
      },
      livePathStatus: {
        kind: 'path-status-only-live-facts',
        available: pathStatusAvailable,
        contentRead: false,
        headState: gitData.headState,
        dirtyPaths: factSize(gitData.dirty),
        stagedPaths: factSize(gitData.staged),
        untrackedPaths: factSize(gitData.untracked),
        ignoredPaths: factSize(gitData.ignored),
      },
    },
    nativeLiveInspectionRequired: { required: reasons.length > 0, reasons },
    contentBlindSpots: {
      dirtyFiles: factSize(gitData.dirty),
      untrackedFiles: factSize(gitData.untracked),
      ignoredFiles: factSize(gitData.ignored),
      total: blindSpotTotal(gitData.dirty, gitData.untracked, gitData.ignored),
    },
    files: {
      total: gitData.entries === null ? null : regularFiles.length,
      totalBytes: snapshotAvailable ? regularFiles.reduce((sum, file) => sum + file.bytes, 0) : null,
      skippedSymbolicLinks,
      largest: visibleFiles
        .filter((file) => file.bytes !== null)
        .map(({ path, bytes }) => ({ path, bytes }))
        .sort((left, right) => right.bytes - left.bytes || codeUnitCompare(left.path, right.path)),
    },
    agentSurfaces,
    instructionSurfaceCandidates: instructionCandidates,
    syntacticReferences: references,
    packageScripts: scripts,
    workflows: workflowFiles(visibleFiles),
    history: gitData.history,
    sensitiveIndicators: {
      envFiles: categoryCount('env'),
      keyLikeFiles: categoryCount('keyLike'),
      credentialLikeFiles: categoryCount('credentialLike'),
      trackedSensitiveFiles: factCount(gitData.tracked),
      untrackedSensitiveFiles: factCount(gitData.untracked),
      ignoredSensitiveFiles: factCount(gitData.ignored),
      unknownSensitiveFiles: sensitivePathUniverseAvailable
        ? sensitive.filter((file) => !gitData.tracked.has(file.path) && !gitData.untracked.has(file.path) && !gitData.ignored.has(file.path)).length
        : null,
      ...(options.includeSensitivePaths ? { paths: sensitive.map((file) => file.path) } : {}),
    },
    warnings,
    truncation: { truncated: false, maxOutputBytes: options.maxOutputBytes, sectionsTruncated: [], totalMatchingItems: 0, itemsReturned: 0 },
  };
}

async function scan(options) {
  const suppliedRoot = resolve(options.root);
  let rootInfo;
  let root;
  try {
    rootInfo = await lstat(suppliedRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('invalid root');
    root = await realpath(suppliedRoot);
  } catch {
    throw new Error('--root must identify a readable directory');
  }
  const rootName = basename(suppliedRoot);
  const gitData = collectGitEvidence(root);
  let currentRoot;
  try {
    currentRoot = await lstat(root);
  } catch {
    throw new Error('repository changed during scan');
  }
  if (!currentRoot.isDirectory() || currentRoot.dev !== rootInfo.dev || currentRoot.ino !== rootInfo.ino) {
    throw new Error('repository changed during scan');
  }
  const report = gitData === null
    ? nonGitReport(rootName, options)
    : buildGitReport(rootName, root, gitData, options);
  return enforceBudget(report, options.maxOutputBytes);
}

try {
  const options = parseArgs(process.argv.slice(2));
  process.stdout.write(await scan(options));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
