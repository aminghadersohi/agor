import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ArtifactStaticPreview, buildStaticArtifactDocument } from './ArtifactStaticPreview';

describe('ArtifactStaticPreview', () => {
  const files = {
    '/index.html':
      '<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body><main>Static artifact</main></body></html>',
    '/styles.css': 'main { font-weight: 600; }',
  };

  it('renders a two-file HTML/CSS artifact without adding JavaScript', () => {
    const document = buildStaticArtifactDocument({ files, entry: '/index.html' });

    expect(document).toContain('<main>Static artifact</main>');
    expect(document).toContain('main { font-weight: 600; }');
    expect(document).not.toContain('<script');
    expect(document).not.toContain('index.js');
  });

  it('reports ready from the sandboxed iframe load event', () => {
    const onReady = vi.fn();
    const { getByTitle } = render(
      <ArtifactStaticPreview files={files} entry="/index.html" onReady={onReady} />
    );
    const iframe = getByTitle('Static artifact preview');

    expect(iframe).not.toHaveAttribute('sandbox', expect.stringContaining('allow-same-origin'));
    fireEvent.load(iframe);
    expect(onReady).toHaveBeenCalledOnce();
  });
});
