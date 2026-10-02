import type { Branch } from '@agor-live/client';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  branches: new Map<string, unknown>(),
  saver: vi.fn((_props: unknown) => null),
}));

vi.mock('../../store/agorStore', () => ({ useAgorStore: () => mocks.branches }));
vi.mock('../../store/selectors', () => ({ selectBranchById: {} }));
vi.mock('./IdleGlyphScreensaver', () => ({
  IdleGlyphScreensaver: mocks.saver,
  resolveScreensaverIdleMinutes: () => 5,
}));

import { IdleScreensaverHost } from './IdleScreensaverHost';

const teammate = (id: string, name: string, activePhotoTheme?: string, archived = false) =>
  ({
    branch_id: id,
    name,
    archived,
    custom_context: { teammate: { kind: 'teammate', displayName: name, activePhotoTheme } },
  }) as unknown as Branch;

describe('IdleScreensaverHost', () => {
  it("hands each visible teammate's active photo theme to the slideshow", () => {
    mocks.branches.set('a', teammate('a', 'Ada', 'Winter'));
    mocks.branches.set('b', teammate('b', 'Bo'));
    mocks.branches.set('c', teammate('c', 'Cy', 'Summer', true));
    mocks.branches.set('d', { branch_id: 'd', name: 'plain', custom_context: {} });

    render(<IdleScreensaverHost preferences={{ enabled: true }} />);

    const props = mocks.saver.mock.calls.at(-1)?.[0] as { teammates: object[] };
    expect(props).toMatchObject({
      teammates: [
        { id: 'a', name: 'Ada', activeTheme: 'Winter' },
        { id: 'b', name: 'Bo' },
      ],
    });
    expect(props.teammates[1]).not.toHaveProperty('activeTheme');
  });
});
