import type { Session } from '@agor-live/client';
import { cleanup, render, screen } from '@testing-library/react';
import { App, theme as antdTheme, ConfigProvider, Input } from 'antd';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionFooter } from './SessionFooter';

afterEach(cleanup);

describe('SessionFooter simple mode layout (real browser)', () => {
  it('keeps the prompt and primary run controls aligned without horizontal overflow', () => {
    const session = {
      session_id: 'session-preview',
      branch_id: 'branch-preview',
      status: 'running',
      agentic_tool: 'claude-code',
      created_at: '2026-08-25T12:00:00.000Z',
      last_updated: '2026-08-25T12:00:00.000Z',
    } as unknown as Session;
    const props = {
      session,
      footerTimerTask: null,
      tokenBreakdown: {
        total: 12_480,
        input: 11_900,
        output: 580,
        cacheRead: 0,
        cacheCreation: 0,
        cost: 0,
      },
      latestContextWindow: null,
      sessionMcpServerIds: ['server-preview'],
      unauthedMcpServers: [],
      mcpServerById: new Map(),
      userAuthenticatedMcpServerIds: new Set<string>(),
      isRunning: true,
      isStopping: false,
      stopRequestInFlight: false,
      hasInput: true,
      connectionDisabled: false,
      effortLevel: 'high',
      permissionMode: 'default',
      codexSandboxMode: 'on',
      codexApprovalPolicy: 'auto',
      queuedTasks: [],
      client: null,
      onModelConfigChange: vi.fn(),
      onSendPrompt: vi.fn(),
      onStop: vi.fn(),
      onFork: vi.fn(),
      onBtwSend: vi.fn(),
      onSpawnOpen: vi.fn(),
      onAttachFiles: vi.fn(),
      onUploadOpen: vi.fn(),
      onEffortChange: vi.fn(),
      onPermissionModeChange: vi.fn(),
      onCodexPermissionChange: vi.fn(),
      promptInputSlot: (
        <Input.TextArea aria-label="Message" value="Ship the focused chat" readOnly />
      ),
      simple: true,
    } as unknown as ComponentProps<typeof SessionFooter>;

    render(
      <ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm, token: { motion: false } }}>
        <App>
          <div
            data-testid="simple-chat-shell"
            style={{
              width: 'min(680px, calc(100vw - 16px))',
              margin: '24px auto 0',
              padding: '0 16px',
              boxSizing: 'border-box',
            }}
          >
            <SessionFooter {...props} />
          </div>
        </App>
      </ConfigProvider>
    );

    expect(screen.getByRole('textbox', { name: 'Message' })).toBeVisible();
    expect(screen.getByRole('button', { name: /stop stop/i })).toBeVisible();
    expect(screen.getByRole('button', { name: /send queue/i })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Attach files' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More options' })).toBeVisible();

    const shell = screen.getByTestId('simple-chat-shell');
    expect(shell.scrollWidth).toBeLessThanOrEqual(shell.clientWidth + 1);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);

    const stopRect = screen.getByRole('button', { name: /stop stop/i }).getBoundingClientRect();
    const queueRect = screen.getByRole('button', { name: /send queue/i }).getBoundingClientRect();
    const stopCenter = stopRect.top + stopRect.height / 2;
    const queueCenter = queueRect.top + queueRect.height / 2;
    expect(Math.abs(stopCenter - queueCenter)).toBeLessThanOrEqual(1);
  });
});
