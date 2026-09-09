import { getAgenticToolUIIntegration } from '@agor/agentic-tools/ui';
import type { AgorClient, Session } from '@agor-live/client';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSessionActions } from './useSessionActions';

describe('OpenCode session creation (real browser)', () => {
  it('submits one exact fictional provider/model pair to the sessions service', async () => {
    const session = {
      session_id: 'fictional-opencode-session',
      branch_id: 'fictional-branch',
      agentic_tool: 'opencode',
      status: 'idle',
    } as Session;
    const create = vi.fn(async () => session);
    const client = {
      service: vi.fn((name: string) => {
        if (name === 'sessions') return { create };
        throw new Error(`Unexpected service: ${name}`);
      }),
    } as unknown as AgorClient;
    const { result } = renderHook(() => useSessionActions(client));

    await act(async () => {
      await expect(
        result.current.createSession({
          branch_id: 'fictional-branch',
          agent: 'opencode',
          modelConfig: { mode: 'exact', provider: 'opencode', model: 'big-pickle' },
        })
      ).resolves.toBe(session);
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        agentic_tool: 'opencode',
        branch_id: 'fictional-branch',
        model_config: expect.objectContaining({
          mode: 'exact',
          provider: 'opencode',
          model: 'big-pickle',
        }),
      })
    );
  });

  it('keeps a fictional stored Ollama pair while healthy cloud choices survive its failure', async () => {
    const find = vi.fn(async () => ({
      runtimeVersion: '1.14.33',
      providers: [
        {
          id: 'openai',
          name: 'OpenAI',
          availableForSelection: true,
          availabilityStatus: 'available',
          models: [{ id: 'gpt-fictional', name: 'GPT Fictional', status: 'active' }],
        },
        {
          id: 'ollama',
          name: 'Ollama (local via OpenCode)',
          availableForSelection: false,
          availabilityStatus: 'unavailable',
          availabilityMessage: 'The local Ollama service could not be inspected safely.',
          models: [
            { id: 'qwen3-coder:30b', name: 'qwen3-coder:30b', status: 'active', tools: true },
          ],
        },
      ],
    }));
    const client = {
      get: vi.fn((key: string) => (key === 'authentication' ? 'fictional-auth-scope' : undefined)),
      service: vi.fn((name: string) => {
        if (name === 'opencode-models') return { find };
        throw new Error(`Unexpected service: ${name}`);
      }),
    } as unknown as AgorClient;
    const ModelSelector = getAgenticToolUIIntegration('opencode').ModelSelector!;
    const onChange = vi.fn();

    render(
      <ModelSelector
        client={client}
        value={{ provider: 'ollama', model: 'qwen3-coder:30b' }}
        onChange={onChange}
      />
    );

    expect(
      await screen.findByText('ollama/qwen3-coder:30b is not currently available')
    ).toBeVisible();
    expect(
      screen.getByText('The local Ollama service could not be inspected safely.')
    ).toBeVisible();
    expect(screen.getByLabelText('OpenCode provider ID')).toHaveValue('ollama');
    expect(screen.getByLabelText('OpenCode model ID')).toHaveValue('qwen3-coder:30b');
    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));
  });
});
