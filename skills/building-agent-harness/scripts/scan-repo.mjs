#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { AGENT_SURFACES, KNOWN_WORKFLOW_PATTERNS, REGISTRY_VERSION } from './agent-surfaces.mjs';

const SCHEMA_VERSION = 1;
const DEFAULT_MAX_BYTES = 32 * 1024;
const MIN_MAX_BYTES = 4 * 1024;
const MAX_TEXT_FILE_BYTES = 1024 * 1024;
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
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

function portablePath(value) {
  return value.split(sep).join('/');
}

function sensitiveCategory(path) {
  const name = basename(path).toLowerCase();
  if (name === '.env' || name.startsWith('.env.')) return 'env';
  if (/^(id_rsa|id_dsa|id_ecdsa|id_ed25519)$/.test(name) || /\.(pem|key|p12|pfx)$/.test(name)) return 'keyLike';
  if (/(credential|credentials|secret|secrets|token|tokens)/.test(name)) return 'credentialLike';
  return null;
}

async function walk(root) {
  const files = [];
  const directories = new Set();
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const absolute = resolve(directory, entry.name);
      const path = portablePath(relative(root, absolute));
      if (entry.isDirectory()) {
        directories.add(path);
        if (!SKIP_DIRECTORIES.has(entry.name)) await visit(absolute);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        const info = await lstat(absolute);
        files.push({ path, absolute, bytes: info.size, category: sensitiveCategory(path) });
      }
    }
  }
  await visit(root);
  return { files, directories };
}

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) return null;
  return result.stdout;
}

function gitEvidence(root) {
  const topLevel = git(root, ['rev-parse', '--show-toplevel'])?.trim();
  if (!topLevel || realpathSync(topLevel) !== realpathSync(root)) {
    return {
      available: false,
      tracked: new Set(),
      untracked: new Set(),
      history: { commitsInspected: 0, commitKeywordCounts: { fix: 0, revert: 0 }, fileFrequency: [] },
      warning: 'Git metadata unavailable; tracked status and history are incomplete.',
    };
  }
  const tracked = new Set((git(root, ['ls-files', '-z']) ?? '').split('\0').filter(Boolean).map(portablePath));
  const status = (git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']) ?? '').split('\0').filter(Boolean);
  const untracked = new Set();
  for (const entry of status) {
    if (entry.startsWith('?? ')) untracked.add(portablePath(entry.slice(3)));
  }
  const subjects = (git(root, ['log', '--format=%s', '--all']) ?? '').split('\n').filter(Boolean);
  const names = (git(root, ['log', '--name-only', '--format=', '--all']) ?? '').split('\n').map((value) => value.trim()).filter(Boolean);
  const frequencies = new Map();
  for (const name of names) frequencies.set(portablePath(name), (frequencies.get(portablePath(name)) ?? 0) + 1);
  const fileFrequency = [...frequencies].map(([path, commits]) => ({ path, commits })).sort((left, right) => right.commits - left.commits || left.path.localeCompare(right.path));
  return {
    available: true,
    tracked,
    untracked,
    history: {
      commitsInspected: subjects.length,
      commitKeywordCounts: {
        fix: subjects.filter((subject) => /\bfix(?:e[ds])?\b/i.test(subject)).length,
        revert: subjects.filter((subject) => /\brevert(?:ed|s|ing)?\b/i.test(subject)).length,
      },
      fileFrequency,
    },
    warning: null,
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
  return matches.sort((left, right) => left.path.localeCompare(right.path) || left.agent.localeCompare(right.agent));
}

function normalizeReference(target) {
  const cleaned = target.trim().replace(/^<|>$/g, '').split('#')[0].split('?')[0];
  if (!cleaned || isAbsolute(cleaned) || /^[a-z]+:/i.test(cleaned)) return null;
  const normalized = portablePath(cleaned.replace(/^\.\//, ''));
  if (normalized.startsWith('../')) return null;
  return normalized;
}

function extractReferences(sourcePath, text) {
  const values = [];
  const seen = new Set();
  const add = (target, syntax) => {
    const normalized = normalizeReference(target);
    if (!normalized) return;
    const key = `${normalized}\0${syntax}`;
    if (seen.has(key)) return;
    seen.add(key);
    values.push({ sourcePath, target: normalized, syntax });
  };
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) add(match[1], 'markdown-link');
  for (const match of text.matchAll(/`((?:\.?\.?\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+)`/g)) add(match[1], 'literal-path');
  for (const line of text.split(/\r?\n/)) {
    const include = line.match(/^\s*@((?:\.?\.?\/)?[^\s#]+)\s*$/);
    if (include) add(include[1], 'known-include');
    const checklist = line.match(/^\s*[-*]\s+((?:\.?\.?\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+)\s*$/);
    if (checklist) add(checklist[1], 'startup-checklist-path');
  }
  return values;
}

async function inducedReading(files, surfaces) {
  const alwaysLoaded = new Set(surfaces.filter((item) => item.kind === 'always-loaded-instructions').map((item) => item.path));
  const references = [];
  for (const file of files) {
    if (!alwaysLoaded.has(file.path) || file.category || file.bytes > MAX_TEXT_FILE_BYTES) continue;
    const text = await readFile(file.absolute, 'utf8');
    references.push(...extractReferences(file.path, text));
  }
  references.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath) || left.target.localeCompare(right.target) || left.syntax.localeCompare(right.syntax));
  return { total: references.length, references };
}

async function packageScripts(files) {
  const manifest = files.find((file) => file.path === 'package.json' && !file.category && file.bytes <= MAX_TEXT_FILE_BYTES);
  if (!manifest) return [];
  try {
    const parsed = JSON.parse(await readFile(manifest.absolute, 'utf8'));
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
    + report.inducedReading.references.length
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
  const sections = [
    ['files.largest', report.files.largest, 50],
    ['history.fileFrequency', report.history.fileFrequency, 50],
    ['inducedReading.references', report.inducedReading.references, 50],
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
    guard += 1;
  }
  report.truncation.totalMatchingItems = totalMatchingItems;
  report.truncation.itemsReturned = itemCount(report);
  if (Buffer.byteLength(serialize(report)) > maxBytes) throw new Error(`minimum report exceeds ${maxBytes} bytes`);
  return serialize(report);
}

async function scan(options) {
  const root = resolve(options.root);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory()) throw new Error('--root must identify a directory');
  const { files, directories } = await walk(root);
  const gitData = gitEvidence(root);
  gitData.history.fileFrequency = gitData.history.fileFrequency.filter((item) => !sensitiveCategory(item.path));
  const agentSurfaces = registryMatches(files, directories);
  const sensitive = files.filter((file) => file.category);
  const report = {
    schemaVersion: SCHEMA_VERSION,
    registryVersion: REGISTRY_VERSION,
    repository: {
      name: basename(root),
      gitAvailable: gitData.available,
      trackedFiles: gitData.tracked.size,
      untrackedFiles: gitData.untracked.size,
    },
    files: {
      total: files.length,
      totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
      largest: files.filter((file) => !file.category).map(({ path, bytes }) => ({ path, bytes })).sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path)),
    },
    agentSurfaces,
    inducedReading: await inducedReading(files, agentSurfaces),
    packageScripts: await packageScripts(files),
    workflows: workflowFiles(files),
    history: gitData.history,
    sensitiveIndicators: {
      envFiles: sensitive.filter((file) => file.category === 'env').length,
      keyLikeFiles: sensitive.filter((file) => file.category === 'keyLike').length,
      credentialLikeFiles: sensitive.filter((file) => file.category === 'credentialLike').length,
      trackedSensitiveFiles: sensitive.filter((file) => gitData.tracked.has(file.path)).length,
      untrackedSensitiveFiles: sensitive.filter((file) => !gitData.tracked.has(file.path)).length,
      ...(options.includeSensitivePaths ? { paths: sensitive.map((file) => file.path).sort() } : {}),
    },
    warnings: gitData.warning ? [gitData.warning] : [],
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
