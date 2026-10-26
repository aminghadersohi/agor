import type { Session, SessionID } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { guardTaskModelSelection } from './task-model-selection.js';

const sessionId = 'session-1' as SessionID;
function fixture(model = 'gpt-6-astra', endpoint?: string) {
  const session = { model_config: { mode: 'exact', model, updated_at: '' } } as Session;
  const sessions = { findById: async (_id: SessionID) => session };
  guardTaskModelSelection(sessions, sessionId, 'codex', {
    source: 'user',
    apiKey: 'synthetic-key',
    useNativeAuth: false,
    connection: endpoint ? { OPENAI_BASE_URL: endpoint } : {},
  });
  return { session, sessions };
}

describe('actual SDK model selection', () => {
  it('rejects an asynchronous model edit before SDK consumption and on every reread', async () => {
    const { session, sessions } = fixture();
    const first = await sessions.findById(sessionId);
    await Promise.resolve();
    session.model_config!.model = 'claude-opus-5-5';
    expect(first?.model_config?.model).toBe('gpt-6-astra');
    await expect(sessions.findById(sessionId)).rejects.toThrow('cannot run on a codex');
  });
  it('accepts a corrected selection rather than rejecting an earlier stale model', async () => {
    const { session, sessions } = fixture('claude-opus-5-5');
    await Promise.resolve();
    session.model_config!.model = 'gpt-6-astra';
    await expect(sessions.findById(sessionId)).resolves.toMatchObject({
      model_config: { model: 'gpt-6-astra' },
    });
  });
  it('accepts intentional exact models at the actual caller compatible endpoint', async () => {
    const { sessions } = fixture('claude-opus-5-5', 'https://caller.example/v1');
    await expect(sessions.findById(sessionId)).resolves.toMatchObject({
      model_config: { model: 'claude-opus-5-5' },
    });
  });
  it('does not validate a parent Session used only for fork metadata', async () => {
    const { sessions } = fixture('claude-opus-5-5');
    await expect(sessions.findById('parent-session' as SessionID)).resolves.toBeTruthy();
  });
});
