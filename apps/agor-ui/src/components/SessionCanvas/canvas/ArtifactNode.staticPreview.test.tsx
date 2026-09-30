import { render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../../contexts/ConnectionContext';
import { ArtifactNode, type ArtifactNodeData } from './ArtifactNode';

vi.mock('reactflow', () => ({ NodeResizer: () => null }));

vi.mock('@codesandbox/sandpack-react', () => ({
  SandpackProvider: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SandpackPreview: () => <div data-testid="sandpack-preview" />,
  useSandpack: () => ({
    sandpack: { files: {}, environment: 'static', clients: {}, status: 'idle', error: null },
    listen: () => () => undefined,
  }),
  useSandpackConsole: () => ({ logs: [] }),
}));

vi.mock('@/utils/sandpackCrypto', () => ({ ensureSandpackCryptoSubtle: vi.fn() }));

const connection = {
  connected: true,
  connecting: false,
  authGeneration: 1,
  outOfSync: false,
  capturedSha: null,
  currentSha: null,
};

const wrapper = ({ children }: { children: ReactNode }) => (
  <ConnectionProvider value={connection}>
    <AntApp>{children}</AntApp>
  </ConnectionProvider>
);

const data: ArtifactNodeData = {
  objectId: 'object-fixture',
  artifactId: 'artifact-fixture',
  width: 480,
  height: 320,
  canEdit: true,
  x: 0,
  y: 0,
  onUpdate: vi.fn(),
};

function stubPayload(template: string) {
  const payload = {
    artifact_id: data.artifactId,
    name: 'Fixture',
    template,
    files: {
      '/index.html':
        '<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body><main>Hi</main></body></html>',
      '/styles.css': 'main { font-weight: 600; }',
    },
    entry: '/index.html',
    content_hash: 'hash-1',
    trust_state: 'trusted',
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      String(url).endsWith('/payload')
        ? new Response(JSON.stringify(payload), { status: 200 })
        : new Response(null, { status: 204 })
    )
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ArtifactNode static template', () => {
  it('renders static HTML/CSS in a sandboxed iframe instead of the Sandpack bundler', async () => {
    stubPayload('static');
    render(<ArtifactNode data={data} />, { wrapper });

    const iframe = await screen.findByTitle('Fixture preview');
    expect(iframe.tagName).toBe('IFRAME');
    expect(iframe.getAttribute('srcdoc')).toContain('main { font-weight: 600; }');
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(screen.queryByTestId('sandpack-preview')).not.toBeInTheDocument();
  });

  it('keeps bundled templates on SandpackPreview', async () => {
    stubPayload('react');
    render(<ArtifactNode data={data} />, { wrapper });

    expect(await screen.findByTestId('sandpack-preview')).toBeInTheDocument();
    expect(screen.queryByTitle('Fixture preview')).not.toBeInTheDocument();
  });
});
