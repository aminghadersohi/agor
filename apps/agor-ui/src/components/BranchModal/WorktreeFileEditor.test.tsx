import type { AgorClient, Branch, FileListItem } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { makeBranch } from './testUtils';

vi.mock('react-resizable-panels', () => ({
  PanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PanelResizeHandle: () => <div />,
}));

vi.mock('../FileCollection/FileCollection', () => ({
  FileCollection: ({ onFileClick }: { onFileClick: (file: FileListItem) => void }) => (
    <button
      type="button"
      onClick={() =>
        onFileClick({
          path: 'src/index.ts',
          title: 'index.ts',
          size: 15,
          lastModified: '2026-08-25T12:00:00.000Z',
          isText: true,
        })
      }
    >
      src/index.ts
    </button>
  ),
}));

vi.mock('../CodeEditor', () => ({
  CodeEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea
      aria-label="Code editor"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

import { WorktreeFileEditor } from './WorktreeFileEditor';

describe('WorktreeFileEditor', () => {
  it('loads, edits, and optimistically saves a worktree file', async () => {
    const get = vi.fn().mockResolvedValue({
      path: 'src/index.ts',
      title: 'index.ts',
      size: 15,
      lastModified: '2026-08-25T12:00:00.000Z',
      isText: true,
      content: 'export const a = 1;',
      encoding: 'utf-8',
    });
    const patch = vi.fn().mockResolvedValue({
      path: 'src/index.ts',
      title: 'index.ts',
      size: 15,
      lastModified: '2026-08-25T12:01:00.000Z',
      isText: true,
      content: 'export const a = 2;',
      encoding: 'utf-8',
    });
    const client = { service: () => ({ get, patch }) } as unknown as AgorClient;
    const branch: Branch = makeBranch({ name: 'feature/editor' });
    const onFileSaved = vi.fn();

    render(
      <App>
        <WorktreeFileEditor
          branch={branch}
          client={client}
          files={[]}
          open
          onClose={vi.fn()}
          onFileSaved={onFileSaved}
        />
      </App>
    );

    fireEvent.click(screen.getByRole('button', { name: 'src/index.ts' }));
    const editor = await screen.findByRole('textbox', { name: 'Code editor' });
    fireEvent.change(editor, { target: { value: 'export const a = 2;' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(patch).toHaveBeenCalledOnce());
    expect(patch).toHaveBeenCalledWith(
      'src/index.ts',
      {
        content: 'export const a = 2;',
        expectedLastModified: '2026-08-25T12:00:00.000Z',
      },
      { query: { branch_id: branch.branch_id } }
    );
    expect(onFileSaved).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'export const a = 2;' })
    );
  });

  it('confirms a dirty reload once and then refreshes from disk', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        path: 'src/index.ts',
        title: 'index.ts',
        size: 19,
        lastModified: '2026-08-25T12:00:00.000Z',
        isText: true,
        content: 'export const a = 1;',
        encoding: 'utf-8',
      })
      .mockResolvedValueOnce({
        path: 'src/index.ts',
        title: 'index.ts',
        size: 19,
        lastModified: '2026-08-25T12:01:00.000Z',
        isText: true,
        content: 'export const a = 3;',
        encoding: 'utf-8',
      });
    const client = {
      service: () => ({ get, patch: vi.fn() }),
    } as unknown as AgorClient;

    render(
      <App>
        <WorktreeFileEditor
          branch={makeBranch({ name: 'feature/editor' })}
          client={client}
          files={[]}
          open
          onClose={vi.fn()}
          onFileSaved={vi.fn()}
        />
      </App>
    );

    fireEvent.click(screen.getByRole('button', { name: 'src/index.ts' }));
    const editor = await screen.findByRole('textbox', { name: 'Code editor' });
    fireEvent.change(editor, { target: { value: 'unsaved' } });
    fireEvent.click(screen.getByRole('button', { name: /reload/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(editor).toHaveValue('export const a = 3;'));
  });
});
