import { afterEach, describe, expect, it } from 'vitest';
import {
  getAgorSkillsIndex,
  MAX_SKILLS_INDEX_CHARS,
  setAgorSkillsIndex,
  setSkillLoadingEnabled,
  withAgorSkillsIndex,
} from './agor-skills-index.js';
import { PromptPayloadSchema } from './payload-types.js';

afterEach(() => setAgorSkillsIndex(undefined));

describe('agor skills index', () => {
  it('leaves the system prompt alone without an index', () => {
    expect(withAgorSkillsIndex('system')).toBe('system');
    setAgorSkillsIndex('   ');
    expect(getAgorSkillsIndex()).toBeUndefined();
    expect(withAgorSkillsIndex('system')).toBe('system');
  });

  it('appends the trimmed index after a blank line, bounded', () => {
    setAgorSkillsIndex('\n## Team skills (x r1)\n- a\n');
    expect(withAgorSkillsIndex('system')).toBe('system\n\n## Team skills (x r1)\n- a');
    setAgorSkillsIndex('x'.repeat(MAX_SKILLS_INDEX_CHARS + 50));
    expect(getAgorSkillsIndex()).toHaveLength(MAX_SKILLS_INDEX_CHARS);
  });

  it('accepts skillsIndex in the prompt payload and keeps it optional', () => {
    const base = {
      command: 'prompt',
      sessionToken: 't',
      daemonUrl: 'http://localhost:3030',
      params: {
        sessionId: '01a00000-0000-7000-8000-000000000001',
        taskId: '01a00000-0000-7000-8000-000000000002',
        prompt: 'hi',
        tool: 'codex',
        cwd: '/tmp',
      },
    };
    expect(PromptPayloadSchema.parse(base).params.skillsIndex).toBeUndefined();
    expect(
      PromptPayloadSchema.parse({
        ...base,
        params: { ...base.params, skillsIndex: '## Team skills' },
      }).params.skillsIndex
    ).toBe('## Team skills');
    expect(() =>
      PromptPayloadSchema.parse({
        ...base,
        params: { ...base.params, skillsIndex: 'x'.repeat(16_001) },
      })
    ).toThrow();
  });
});

it('script-runner mode drops even a supplied skills index; ordinary mode remains the default', () => {
  setSkillLoadingEnabled(false);
  try {
    setAgorSkillsIndex('Must not be delivered');
    expect(withAgorSkillsIndex('System')).toBe('System');
  } finally {
    setSkillLoadingEnabled(true);
  }
  setAgorSkillsIndex('Ordinary skills');
  expect(withAgorSkillsIndex('System')).toContain('Ordinary skills');
  setAgorSkillsIndex(undefined);
});
