import { describe, expect, it } from 'vitest';
import { DEFAULT_CLAUDE_MODEL } from './claude.js';
import { DEFAULT_CODEX_MODEL } from './codex.js';
import {
  findCrossAgenticToolModelOwner,
  getCrossAgenticToolModelError,
} from './cross-tool-model.js';
import { DEFAULT_GEMINI_MODEL } from './gemini-shared.js';

describe('findCrossAgenticToolModelOwner', () => {
  it('flags a Claude registry model on a Codex session', () => {
    expect(findCrossAgenticToolModelOwner('claude-opus-5-5', 'codex')).toBe('claude-code');
    expect(findCrossAgenticToolModelOwner('claude-opus-5-5[1m]', 'codex')).toBe('claude-code');
  });

  it('flags a Codex registry model on a Claude Code session', () => {
    expect(findCrossAgenticToolModelOwner('gpt-6-astra', 'claude-code')).toBe('codex');
    expect(findCrossAgenticToolModelOwner(DEFAULT_CODEX_MODEL, 'claude-code')).toBe('codex');
  });

  it('flags Gemini registry models on other first-party tools and vice versa', () => {
    expect(findCrossAgenticToolModelOwner(DEFAULT_GEMINI_MODEL, 'claude-code')).toBe('gemini');
    expect(findCrossAgenticToolModelOwner(`models/${DEFAULT_GEMINI_MODEL}`, 'codex')).toBe(
      'gemini'
    );
    expect(findCrossAgenticToolModelOwner(DEFAULT_CLAUDE_MODEL, 'gemini')).toBe('claude-code');
  });

  it('accepts each tool’s own registry models, case-insensitively', () => {
    expect(findCrossAgenticToolModelOwner('claude-opus-5-5', 'claude-code')).toBeUndefined();
    expect(findCrossAgenticToolModelOwner('Claude-Opus-5-5[1M]', 'claude-code')).toBeUndefined();
    expect(findCrossAgenticToolModelOwner('gpt-6-astra', 'codex')).toBeUndefined();
    expect(findCrossAgenticToolModelOwner(DEFAULT_GEMINI_MODEL, 'gemini')).toBeUndefined();
  });

  it('never rejects custom strings that are not another tool’s registry ID', () => {
    expect(findCrossAgenticToolModelOwner('claude-internal-finetune', 'codex')).toBeUndefined();
    expect(findCrossAgenticToolModelOwner('gpt-custom-proxy', 'claude-code')).toBeUndefined();
    expect(
      findCrossAgenticToolModelOwner('us.anthropic.claude-opus-5-5-v1:0', 'codex')
    ).toBeUndefined();
  });

  it('has no opinion for tools that proxy upstream providers', () => {
    for (const tool of ['copilot', 'opencode', 'cursor'] as const) {
      expect(findCrossAgenticToolModelOwner('claude-opus-5-5', tool)).toBeUndefined();
      expect(findCrossAgenticToolModelOwner('gpt-6-astra', tool)).toBeUndefined();
    }
  });

  it('has no opinion without a model', () => {
    expect(findCrossAgenticToolModelOwner(undefined, 'codex')).toBeUndefined();
    expect(findCrossAgenticToolModelOwner('', 'claude-code')).toBeUndefined();
  });
});

describe('getCrossAgenticToolModelError', () => {
  it('names the model, its owner and the session tool', () => {
    expect(getCrossAgenticToolModelError('codex', { model: 'claude-opus-5-5' })).toBe(
      'Model "claude-opus-5-5" is a claude-code model and cannot run on a codex session. ' +
        'Choose a codex model; a session keeps the agent it was created with.'
    );
  });

  it('returns undefined for a valid or absent selection', () => {
    expect(getCrossAgenticToolModelError('codex', { model: 'gpt-6-astra' })).toBeUndefined();
    expect(getCrossAgenticToolModelError('codex', null)).toBeUndefined();
  });
});

describe('exact provider-specific IDs', () => {
  const selection = { mode: 'exact' as const, model: 'claude-opus-5-5' };
  it('defers exact selection until the task provider is known', () => {
    expect(getCrossAgenticToolModelError('codex', selection)).toBeUndefined();
  });
  it('rejects an exact foreign model on the native provider', () => {
    expect(getCrossAgenticToolModelError('codex', selection, { useNativeAuth: true })).toContain(
      'cannot run on a codex'
    );
    expect(getCrossAgenticToolModelError('codex', selection, { useNativeAuth: false })).toContain(
      'cannot run on a codex'
    );
  });
  it.each(['https://compatible.example/v1', 'http://localhost:8123/v1'])(
    'allows an intentional exact ID on compatible endpoint %s',
    (OPENAI_BASE_URL) => {
      expect(
        getCrossAgenticToolModelError('codex', selection, {
          useNativeAuth: false,
          connection: { OPENAI_BASE_URL },
        })
      ).toBeUndefined();
    }
  );
  it.each([' ', 'not a url', 'file:///tmp/provider', 'https://api.openai.com/v1'])(
    'does not use %s as a custom endpoint escape hatch',
    (OPENAI_BASE_URL) => {
      expect(
        getCrossAgenticToolModelError('codex', selection, {
          useNativeAuth: false,
          connection: { OPENAI_BASE_URL },
        })
      ).toContain('cannot run on a codex');
    }
  );
  it('requires exact mode and the matching tool endpoint, not another bucket', () => {
    expect(
      getCrossAgenticToolModelError(
        'codex',
        { ...selection, mode: 'alias' },
        {
          useNativeAuth: false,
          connection: { OPENAI_BASE_URL: 'https://compatible.example' },
        }
      )
    ).toContain('cannot run on a codex');
    expect(
      getCrossAgenticToolModelError('codex', selection, {
        useNativeAuth: false,
        connection: { ANTHROPIC_BASE_URL: 'https://compatible.example' },
      })
    ).toContain('cannot run on a codex');
  });
  it('supports the explicit Claude-compatible endpoint without exempting native auth', () => {
    const model = { mode: 'exact' as const, model: 'gpt-6-astra' };
    const connection = { ANTHROPIC_BASE_URL: 'https://compatible.example' };
    expect(
      getCrossAgenticToolModelError('claude-code', model, { connection, useNativeAuth: false })
    ).toBeUndefined();
    expect(
      getCrossAgenticToolModelError('claude-code', model, { connection, useNativeAuth: true })
    ).toContain('cannot run on a claude-code');
  });
});
