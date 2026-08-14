export const REGISTRY_VERSION = '2026-08-14.1';

export const AGENT_SURFACES = Object.freeze([
  { agent: 'codex', kind: 'always-loaded-instructions', match: 'filename', value: 'AGENTS.md' },
  { agent: 'codex', kind: 'always-loaded-instructions', match: 'filename', value: 'AGENTS.override.md' },
  { agent: 'codex', kind: 'skills', match: 'directory', value: '.agents/skills' },
  { agent: 'claude-code', kind: 'always-loaded-instructions', match: 'filename', value: 'CLAUDE.md' },
  { agent: 'claude-code', kind: 'skills', match: 'directory', value: '.claude/skills' },
  { agent: 'gemini-cli', kind: 'always-loaded-instructions', match: 'filename', value: 'GEMINI.md' },
  { agent: 'gemini-cli', kind: 'skills', match: 'directory', value: '.gemini/skills' },
  { agent: 'gemini-cli', kind: 'skills-alias', match: 'directory', value: '.agents/skills' },
]);

export const KNOWN_WORKFLOW_PATTERNS = Object.freeze([
  '.github/workflows/',
  '.gitlab-ci.yml',
  '.circleci/config.yml',
]);
