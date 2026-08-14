export const REGISTRY_VERSION = '2026-08-14.2';

export const AGENT_SURFACES = Object.freeze([
  { agent: 'codex', kind: 'instruction-file-candidate', match: 'filename', value: 'AGENTS.md' },
  { agent: 'codex', kind: 'instruction-file-candidate', match: 'filename', value: 'AGENTS.override.md' },
  { agent: 'codex', kind: 'skill-directory-candidate', match: 'directory', value: '.agents/skills' },
  { agent: 'claude-code', kind: 'instruction-file-candidate', match: 'filename', value: 'CLAUDE.md' },
  { agent: 'claude-code', kind: 'skill-directory-candidate', match: 'directory', value: '.claude/skills' },
  { agent: 'gemini-cli', kind: 'instruction-file-candidate', match: 'filename', value: 'GEMINI.md' },
  { agent: 'gemini-cli', kind: 'skill-directory-candidate', match: 'directory', value: '.gemini/skills' },
  { agent: 'gemini-cli', kind: 'skill-directory-candidate', match: 'directory', value: '.agents/skills' },
]);

export const KNOWN_WORKFLOW_PATTERNS = Object.freeze([
  '.github/workflows/',
  '.gitlab-ci.yml',
  '.circleci/config.yml',
]);
