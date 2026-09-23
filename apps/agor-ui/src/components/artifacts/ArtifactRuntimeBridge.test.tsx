import { render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactRuntimeBridge } from './ArtifactRenderSupport';
import { ArtifactStaticPreview } from './ArtifactStaticPreview';

const sandpackClients: Record<string, { iframe: HTMLIFrameElement | null }> = {};

vi.mock('@codesandbox/sandpack-react', () => ({
  useSandpack: () => ({ sandpack: { clients: sandpackClients, error: null, status: 'idle' } }),
  useSandpackConsole: () => ({ logs: [] }),
}));
vi.mock('@/config/daemon', () => ({ getDaemonUrl: () => 'http://daemon.test:3030' }));
vi.mock('@/utils/authHeaders', () => ({
  getAuthHeaders: () => ({ Authorization: 'Bearer test-token' }),
  getCurrentUserIdFromJwt: () => 'user-fixture',
}));

const ARTIFACT_ID = 'artifact-fixture-1';

const files = {
  '/index.html': '<!doctype html><html><body><main>Static artifact</main></body></html>',
};

/** Mirrors the daemon → parent-page hop that `ArtifactRuntimeBridge` listens for. */
function dispatchQuery(artifactId: string, requestId: string) {
  window.dispatchEvent(
    new CustomEvent('agor:artifact-runtime-query', {
      detail: { request_id: requestId, artifact_id: artifactId, kind: 'document_html', args: {} },
    })
  );
}

/** Mirrors the `agor-runtime.js` reply posted back from inside the preview iframe. */
function dispatchIframeResult(source: Window, requestId: string, result: unknown) {
  const event = new MessageEvent('message', {
    data: { type: 'agor:result', requestId, ok: true, result },
  });
  // jsdom's MessageEvent constructor drops `source`; the bridge compares it
  // against the window it posted to, so set it explicitly.
  Object.defineProperty(event, 'source', { value: source });
  window.dispatchEvent(event);
}

function StaticHarness() {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  return (
    <>
      <ArtifactStaticPreview files={files} entry="/index.html" iframeRef={iframeRef} />
      <ArtifactRuntimeBridge artifactId={ARTIFACT_ID} fallbackIframe={iframeRef} />
    </>
  );
}

describe('ArtifactRuntimeBridge', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    for (const key of Object.keys(sandpackClients)) delete sandpackClients[key];
    fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('answers a query against a static artifact, which registers no Sandpack client', async () => {
    const { getByTitle } = render(<StaticHarness />);
    const target = (getByTitle('Static artifact preview') as HTMLIFrameElement).contentWindow;
    expect(target).toBeTruthy();
    const postMessage = vi.spyOn(target as Window, 'postMessage');

    expect(Object.keys(sandpackClients)).toHaveLength(0);
    dispatchQuery(ARTIFACT_ID, 'req-static');

    expect(postMessage).toHaveBeenCalledWith(
      { type: 'agor:query', requestId: 'req-static', kind: 'document_html', args: {} },
      '*'
    );

    dispatchIframeResult(target as Window, 'req-static', '<main>Static artifact</main>');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `http://daemon.test:3030/artifacts/${ARTIFACT_ID}/runtime-response/req-static`
    );
    expect(JSON.parse(init.body)).toEqual({ ok: true, result: '<main>Static artifact</main>' });
  });

  it('still answers through the Sandpack client when one is registered', async () => {
    const clientIframe = document.createElement('iframe');
    document.body.append(clientIframe);
    sandpackClients.client_a = { iframe: clientIframe };

    const { getByTitle } = render(<StaticHarness />);
    const clientWindow = clientIframe.contentWindow as Window;
    const fallbackWindow = (getByTitle('Static artifact preview') as HTMLIFrameElement)
      .contentWindow as Window;
    const clientPost = vi.spyOn(clientWindow, 'postMessage');
    const fallbackPost = vi.spyOn(fallbackWindow, 'postMessage');

    dispatchQuery(ARTIFACT_ID, 'req-client');

    expect(clientPost).toHaveBeenCalledOnce();
    // The fallback is a fallback: a live client must win.
    expect(fallbackPost).not.toHaveBeenCalled();

    dispatchIframeResult(clientWindow, 'req-client', '<div id="root"></div>');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      ok: true,
      result: '<div id="root"></div>',
    });

    clientIframe.remove();
  });

  it('drops a query that arrives before the preview iframe mounts', async () => {
    function UnmountedHarness() {
      const iframeRef = useRef<HTMLIFrameElement | null>(null);
      return <ArtifactRuntimeBridge artifactId={ARTIFACT_ID} fallbackIframe={iframeRef} />;
    }
    render(<UnmountedHarness />);

    // jsdom swallows a listener throw into an `error` event rather than
    // propagating it out of dispatchEvent, so assert on that instead.
    const onError = vi.fn();
    window.addEventListener('error', onError);
    dispatchQuery(ARTIFACT_ID, 'req-unmounted');
    window.removeEventListener('error', onError);

    expect(onError).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ignores a query addressed to a different artifact', async () => {
    const { getByTitle } = render(<StaticHarness />);
    const target = (getByTitle('Static artifact preview') as HTMLIFrameElement)
      .contentWindow as Window;
    const postMessage = vi.spyOn(target, 'postMessage');

    dispatchQuery('artifact-fixture-2', 'req-other');

    expect(postMessage).not.toHaveBeenCalled();
    // A reply carrying the foreign request id must not be relayed either.
    dispatchIframeResult(target, 'req-other', '<main>Static artifact</main>');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
