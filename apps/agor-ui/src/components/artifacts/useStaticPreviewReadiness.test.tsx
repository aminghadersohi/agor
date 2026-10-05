import type { ArtifactSandpackReport } from '@agor/core/types';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactSandpackErrorReporter } from './ArtifactSandpackErrorReporter';
import { useStaticPreviewReadiness } from './useStaticPreviewReadiness';

const mock = vi.hoisted(() => ({
  fetch: vi.fn<typeof fetch>(),
  onReady: undefined as undefined | (() => void),
}));

vi.mock('@codesandbox/sandpack-react', () => ({
  useSandpack: () => ({
    sandpack: { status: 'running', error: null },
    listen: () => () => {},
  }),
}));
vi.mock('@/config/daemon', () => ({ getDaemonUrl: () => 'https://daemon.test' }));
vi.mock('@/utils/authHeaders', () => ({ getAuthHeaders: () => ({ Authorization: 'test-only' }) }));

/** The wiring shared by ArtifactNode and ArtifactFullscreenPage. */
function Harness({ hash, isStatic = true }: { hash: string; isStatic?: boolean }) {
  const { onReady, compilationStatusOverride } = useStaticPreviewReadiness(hash, isStatic);
  mock.onReady = onReady;
  return (
    <ArtifactSandpackErrorReporter
      artifactId="artifact-a"
      contentHash={hash}
      compilationStatusOverride={compilationStatusOverride}
    />
  );
}

function reports(hash: string): ArtifactSandpackReport[] {
  return mock.fetch.mock.calls
    .map(([, options]) => JSON.parse(String(options?.body)) as ArtifactSandpackReport)
    .filter((report) => report.content_hash === hash);
}
async function flush() {
  await act(() => vi.advanceTimersByTimeAsync(1000));
}
function iframeLoaded() {
  act(() => mock.onReady?.());
}

beforeEach(() => {
  vi.useFakeTimers();
  mock.fetch.mockReset().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', mock.fetch);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useStaticPreviewReadiness', () => {
  it('reports success only after the iframe for the current hash has loaded', async () => {
    const { rerender } = render(<Harness hash="revision-a" />);
    await flush();
    expect(reports('revision-a').some((r) => r.compilation_status === 'success')).toBe(false);
    iframeLoaded();
    await flush();
    expect(reports('revision-a').at(-1)?.compilation_status).toBe('success');

    // Republish: the new hash must not inherit the previous iframe's readiness.
    rerender(<Harness hash="revision-b" />);
    await flush();
    expect(reports('revision-b').length).toBeGreaterThan(0);
    expect(reports('revision-b').some((r) => r.compilation_status === 'success')).toBe(false);

    iframeLoaded();
    await flush();
    expect(reports('revision-b').at(-1)?.compilation_status).toBe('success');
  });

  it('never reports a static override for non-static templates', async () => {
    render(<Harness hash="revision-a" isStatic={false} />);
    iframeLoaded();
    await flush();
    expect(reports('revision-a').some((r) => r.compilation_status === 'success')).toBe(false);
  });
});
