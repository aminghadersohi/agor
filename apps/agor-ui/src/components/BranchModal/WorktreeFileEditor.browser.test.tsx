import type { AgorClient, FileListItem } from '@agor-live/client';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App, theme as antdTheme, ConfigProvider } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { makeBranch } from './testUtils';
import { WorktreeFileEditor } from './WorktreeFileEditor';

const files: FileListItem[] = [
  {
    path: 'README.md',
    title: 'README.md',
    size: 84,
    lastModified: '2026-08-25T12:00:00.000Z',
    isText: true,
  },
  {
    path: 'src/index.ts',
    title: 'index.ts',
    size: 31,
    lastModified: '2026-08-25T12:00:00.000Z',
    isText: true,
  },
  {
    path: 'public/logo.png',
    title: 'logo.png',
    size: 2048,
    lastModified: '2026-08-25T12:00:00.000Z',
    isText: false,
  },
];

afterEach(cleanup);

describe('WorktreeFileEditor layout (real browser)', () => {
  it('keeps the explorer and editor usable at every supported viewport', async () => {
    const get = vi.fn(async () => ({
      ...files[0],
      content: '# Sample project\n\nEdit worktree files without leaving Agor.\n',
      encoding: 'utf-8' as const,
    }));
    const client = {
      service: vi.fn(() => ({ get, patch: vi.fn() })),
    } as unknown as AgorClient;

    render(
      <ThemeProvider>
        <ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm, token: { motion: false } }}>
          <App>
            <WorktreeFileEditor
              branch={makeBranch({ name: 'feature/workspace-editor' })}
              client={client}
              files={files}
              open
              onClose={vi.fn()}
              onFileSaved={vi.fn()}
            />
          </App>
        </ConfigProvider>
      </ThemeProvider>
    );

    const modal = document.querySelector('.ant-modal') as HTMLElement | null;
    expect(modal, 'workspace editor modal should exist').toBeTruthy();
    if (!modal) return;
    const modalRect = modal.getBoundingClientRect();
    expect(modalRect.left).toBeGreaterThanOrEqual(-1);
    expect(modalRect.right).toBeLessThanOrEqual(window.innerWidth + 1);

    const explorer = screen.getByRole('complementary', { name: 'Worktree files' });
    const editorPane = screen.getByRole('main');

    const explorerRect = explorer.getBoundingClientRect();
    const editorRect = editorPane.getBoundingClientRect();
    if (window.innerWidth < 768) {
      expect(editorRect.top).toBeGreaterThanOrEqual(explorerRect.bottom - 2);
    } else {
      expect(editorRect.left).toBeGreaterThanOrEqual(explorerRect.right - 2);
    }

    fireEvent.click(screen.getByText('README.md'));
    await waitFor(() => expect(get).toHaveBeenCalledOnce());
    await waitFor(() => {
      expect(editorPane.querySelector('.cm-editor, textarea')).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: 'Save file' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close workspace editor' })).toBeVisible();
  });
});
