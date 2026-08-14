#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { constants as fsConstants, realpathSync } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { basename, posix, relative, resolve, sep } from 'node:path';
import { devNull } from 'node:os';
import { AGENT_SURFACES, KNOWN_WORKFLOW_PATTERNS, REGISTRY_VERSION } from './agent-surfaces.mjs';

const SCHEMA_VERSION = 2;
const DEFAULT_MAX_BYTES = 32 * 1024;
const MIN_MAX_BYTES = 4 * 1024;
const MAX_TEXT_FILE_BYTES = 1024 * 1024;
const GIT_TIMEOUT_MS = 1000;
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules']);

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
    if (exact.has(name) || name.startsWith('GIT_CONFIG_')) delete environment[name];
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

async function walk(root) {
  const files = [];
  const directories = new Set();
  let skippedSymbolicLinks = 0;
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => codeUnitCompare(left.name, right.name));
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const absolute = resolve(directory, entry.name);
      const path = portablePath(relative(root, absolute));
      if (entry.isSymbolicLink()) {
        skippedSymbolicLinks += 1;
      } else if (entry.isDirectory()) {
        directories.add(path);
        if (!SKIP_DIRECTORIES.has(entry.name)) await visit(absolute);
      } else if (entry.isFile()) {
        const info = await lstat(absolute);
        files.push({ path, absolute, bytes: info.size, category: sensitiveCategory(path) });
      }
    }
  }
  await visit(root);
  return { files, directories, skippedSymbolicLinks };
}

function git(root, args) {
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
    encoding: 'utf8',
    env: isolatedGitEnvironment(),
    killSignal: 'SIGKILL',
    maxBuffer: 8 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
  });
  if (result.status !== 0) return null;
  return result.stdout;
}

function gitEvidence(root) {
  const topLevel = git(root, ['rev-parse', '--show-toplevel'])?.trim();
  let ownsRepository = false;
  try {
    ownsRepository = Boolean(topLevel) && realpathSync(topLevel) === realpathSync(root);
  } catch {
    ownsRepository = false;
  }
  if (!ownsRepository) {
    return {
      available: false,
      tracked: null,
      untracked: null,
      ignored: null,
      history: { commitsInspected: 0, commitKeywordCounts: { fix: 0, revert: 0 }, fileFrequency: [] },
      warnings: ['Git metadata unavailable; tracked status and history are incomplete.'],
    };
  }
  const warnings = [];
  const pathSet = (args, label) => {
    const output = git(root, args);
    if (output === null) {
      warnings.push(`Git ${label} evidence unavailable; ${label} facts are incomplete.`);
      return null;
    }
    return new Set(output.split('\0').filter(Boolean).map(portablePath));
  };
  const tracked = pathSet(['ls-files', '-z', '--cached', '--'], 'tracked-file');
  const untracked = pathSet(['ls-files', '-z', '--others', '--exclude-standard', '--'], 'untracked-file');
  const ignored = pathSet(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--'], 'ignored-file');
  const subjectOutput = git(root, ['log', '--format=%s', '--all', '--']);
  const nameOutput = git(root, ['log', '--name-only', '--format=', '--all', '--']);
  if (subjectOutput === null || nameOutput === null) warnings.push('Git history evidence unavailable; history facts are incomplete.');
  const subjects = (subjectOutput ?? '').split('\n').filter(Boolean);
  const names = (nameOutput ?? '').split('\n').map((value) => value.trim()).filter(Boolean);
  const frequencies = new Map();
  for (const name of names) frequencies.set(portablePath(name), (frequencies.get(portablePath(name)) ?? 0) + 1);
  const fileFrequency = [...frequencies].map(([path, commits]) => ({ path, commits })).sort((left, right) => right.commits - left.commits || codeUnitCompare(left.path, right.path));
  return {
    available: true,
    tracked,
    untracked,
    ignored,
    history: {
      commitsInspected: subjects.length,
      commitKeywordCounts: {
        fix: subjects.filter((subject) => /\bfix(?:e[ds])?\b/i.test(subject)).length,
        revert: subjects.filter((subject) => /\brevert(?:ed|s|ing)?\b/i.test(subject)).length,
      },
      fileFrequency,
    },
    warnings,
  };
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
  const add = (target, syntax) => {
    const normalized = normalizeReference(sourcePath, target);
    if (!normalized || sensitiveCategory(normalized)) return;
    const key = `${normalized}\0${syntax}`;
    if (seen.has(key)) return;
    seen.add(key);
    values.push({ sourcePath, target: normalized, syntax });
  };
  for (const match of text.matchAll(/\[[^\]]*\]\(\s*(?:<([^>]+)>|([^)\s]+))\s*\)/g)) add(match[1] ?? match[2], 'markdown-link');
  for (const match of text.matchAll(/`((?:\.?\.?\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+)`/g)) add(match[1], 'literal-path');
  for (const line of text.split(/\r?\n/)) {
    const include = line.match(/^\s*@((?:\.?\.?\/)?[^\s#]+)\s*$/);
    if (include) add(include[1], 'known-include');
    const checklist = line.match(/^\s*[-*]\s+((?:\.?\.?\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+)\s*$/);
    if (checklist) add(checklist[1], 'startup-checklist-path');
  }
  return values;
}

async function inducedReading(files, surfaces, state) {
  const alwaysLoaded = new Set(surfaces.filter((item) => item.kind === 'instruction-file-candidate').map((item) => item.path));
  const references = [];
  for (const file of files) {
    if (!alwaysLoaded.has(file.path) || file.category || file.bytes > MAX_TEXT_FILE_BYTES) continue;
    const text = await readTextFileWithoutFollowingLinks(file, state);
    if (text === null) continue;
    references.push(...extractReferences(file.path, text));
  }
  references.sort((left, right) => codeUnitCompare(left.sourcePath, right.sourcePath) || codeUnitCompare(left.target, right.target) || codeUnitCompare(left.syntax, right.syntax));
  return { total: references.length, references };
}

async function readTextFileWithoutFollowingLinks(file, state) {
  let handle;
  try {
    handle = await open(file.absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === 'ELOOP') state.skippedSymbolicLinks += 1;
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    return await handle.readFile('utf8');
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

async function packageScripts(files, state) {
  const manifest = files.find((file) => file.path === 'package.json' && !file.category && file.bytes <= MAX_TEXT_FILE_BYTES);
  if (!manifest) return [];
  try {
    const text = await readTextFileWithoutFollowingLinks(manifest, state);
    if (text === null) return [];
    const parsed = JSON.parse(text);
    return Object.keys(parsed.scripts ?? {}).sort();
  } catch {
    return [];
  }
}

function workflowFiles(files) {
  return files.map((file) => file.path).filter((path) => KNOWN_WORKFLOW_PATTERNS.some((pattern) => pattern.endsWith('/') ? path.startsWith(pattern) : path === pattern)).sort();
}

function itemCount(report) {
  return report.files.largest.length
    + report.agentSurfaces.length
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
    ['files.largest', report.files.largest, 50],
    ['history.fileFrequency', report.history.fileFrequency, 50],
    ['syntacticReferences.references', report.syntacticReferences.references, 50],
    ['agentSurfaces', report.agentSurfaces, 50],
    ['workflows', report.workflows, 25],
    ['packageScripts', report.packageScripts, 50],
    ['sensitiveIndicators.paths', report.sensitiveIndicators.paths, 25],
  ].filter(([, array]) => Array.isArray(array));
  const mark = (name) => {
    if (!report.truncation.sectionsTruncated.includes(name)) report.truncation.sectionsTruncated.push(name);
  };
  if (Buffer.byteLength(serialize(report)) > maxBytes) {
    report.truncation.truncated = true;
    for (const [name, array, cap] of sections) {
      if (array.length > cap) {
        array.splice(cap);
        mark(name);
      }
    }
  }
  let guard = 0;
  while (Buffer.byteLength(serialize(report)) > maxBytes && guard < 100000) {
    const candidate = sections.find(([, array]) => array.length > 0);
    if (!candidate) break;
    candidate[1].pop();
    mark(candidate[0]);
    report.truncation.truncated = true;
    report.truncation.itemsReturned = itemCount(report);
    guard += 1;
  }
  report.truncation.itemsReturned = itemCount(report);
  if (Buffer.byteLength(serialize(report)) > maxBytes) throw new Error(`minimum report exceeds ${maxBytes} bytes`);
  return serialize(report);
}

async function scan(options) {
  const root = resolve(options.root);
  let rootInfo;
  try {
    rootInfo = await lstat(root);
  } catch {
    throw new Error('--root must identify a readable directory');
  }
  if (!rootInfo.isDirectory()) throw new Error('--root must identify a readable directory');
  let walkData;
  try {
    walkData = await walk(root);
  } catch {
    throw new Error('repository traversal failed');
  }
  const { files, directories, skippedSymbolicLinks } = walkData;
  const gitData = gitEvidence(root);
  gitData.history.fileFrequency = gitData.history.fileFrequency.filter((item) => !sensitiveCategory(item.path));
  const agentSurfaces = registryMatches(
    files.filter((file) => !file.category),
    new Set([...directories].filter((path) => !sensitiveCategory(path))),
  );
  const sensitive = files.filter((file) => file.category);
  const scanState = { skippedSymbolicLinks };
  const syntacticReferences = await inducedReading(files, agentSurfaces, scanState);
  const scripts = await packageScripts(files, scanState);
  const report = {
    schemaVersion: SCHEMA_VERSION,
    registryVersion: REGISTRY_VERSION,
    repository: {
      name: sensitiveCategory(basename(root)) ? '[redacted-sensitive-path]' : basename(root),
      gitAvailable: gitData.available,
      trackedFiles: gitData.tracked?.size ?? null,
      untrackedFiles: gitData.untracked?.size ?? null,
      ignoredFiles: gitData.ignored?.size ?? null,
    },
    files: {
      total: files.length,
      totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
      skippedSymbolicLinks: scanState.skippedSymbolicLinks,
      largest: files.filter((file) => !file.category).map(({ path, bytes }) => ({ path, bytes })).sort((left, right) => right.bytes - left.bytes || codeUnitCompare(left.path, right.path)),
    },
    agentSurfaces,
    syntacticReferences,
    packageScripts: scripts,
    workflows: workflowFiles(files.filter((file) => !file.category)),
    history: gitData.history,
    sensitiveIndicators: {
      envFiles: sensitive.filter((file) => file.category === 'env').length,
      keyLikeFiles: sensitive.filter((file) => file.category === 'keyLike').length,
      credentialLikeFiles: sensitive.filter((file) => file.category === 'credentialLike').length,
      trackedSensitiveFiles: sensitive.filter((file) => gitData.tracked?.has(file.path)).length,
      untrackedSensitiveFiles: sensitive.filter((file) => gitData.untracked?.has(file.path)).length,
      ignoredSensitiveFiles: sensitive.filter((file) => gitData.ignored?.has(file.path)).length,
      unknownSensitiveFiles: sensitive.filter((file) => !gitData.tracked?.has(file.path) && !gitData.untracked?.has(file.path) && !gitData.ignored?.has(file.path)).length,
      ...(options.includeSensitivePaths ? { paths: sensitive.map((file) => file.path).sort() } : {}),
    },
    warnings: [
      ...gitData.warnings,
      ...(scanState.skippedSymbolicLinks > 0 ? [`Skipped ${scanState.skippedSymbolicLinks} symbolic ${scanState.skippedSymbolicLinks === 1 ? 'link' : 'links'}; symbolic links are never followed.`] : []),
    ],
    truncation: {
      truncated: false,
      maxOutputBytes: options.maxOutputBytes,
      sectionsTruncated: [],
      totalMatchingItems: 0,
      itemsReturned: 0,
    },
  };
  return enforceBudget(report, options.maxOutputBytes);
}

try {
  const options = parseArgs(process.argv.slice(2));
  process.stdout.write(await scan(options));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
