import { useMemo } from 'react';

interface ArtifactStaticPreviewProps {
  files: Record<string, string>;
  entry?: string;
  externalResources?: string[];
  title?: string;
  onReady?: () => void;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  css: 'text/css',
  gif: 'image/gif',
  html: 'text/html',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  js: 'text/javascript',
  json: 'application/json',
  mjs: 'text/javascript',
  png: 'image/png',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

function normalizeFilePath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

function isExternalReference(reference: string): boolean {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(reference);
}

function resolveLocalPath(reference: string, entryPath: string): string | null {
  const trimmed = reference.trim();
  if (!trimmed || isExternalReference(trimmed)) return null;
  try {
    return new URL(trimmed, `https://artifact.invalid${normalizeFilePath(entryPath)}`).pathname;
  } catch {
    return null;
  }
}

function fileDataUrl(path: string, content: string): string {
  const extension = path.split('.').pop()?.toLowerCase() ?? 'txt';
  const mime = MIME_BY_EXTENSION[extension] ?? 'text/plain';
  return `data:${mime};charset=utf-8,${encodeURIComponent(content)}`;
}

function rewriteCssUrls(css: string, cssPath: string, files: ReadonlyMap<string, string>): string {
  return css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, _quote, reference) => {
    const path = resolveLocalPath(String(reference), cssPath);
    const content = path ? files.get(path) : undefined;
    return path && content !== undefined ? `url("${fileDataUrl(path, content)}")` : match;
  });
}

/**
 * Build a self-contained static artifact document without invoking a JS
 * bundler or Sandpack's service-worker-backed static preview relay.
 */
export function buildStaticArtifactDocument({
  files,
  entry = '/index.html',
  externalResources = [],
}: Pick<ArtifactStaticPreviewProps, 'files' | 'entry' | 'externalResources'>): string {
  const normalizedEntry = normalizeFilePath(entry);
  const normalizedFiles = new Map(
    Object.entries(files).map(([path, content]) => [normalizeFilePath(path), content])
  );
  const html = normalizedFiles.get(normalizedEntry) ?? normalizedFiles.get('/index.html');
  if (html === undefined) throw new Error(`Static artifact entry not found: ${normalizedEntry}`);

  const document = new DOMParser().parseFromString(html, 'text/html');

  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]')) {
    const path = resolveLocalPath(link.getAttribute('href') ?? '', normalizedEntry);
    const css = path ? normalizedFiles.get(path) : undefined;
    if (!path || css === undefined) continue;
    const style = document.createElement('style');
    style.dataset.agorSource = path;
    style.textContent = rewriteCssUrls(css, path, normalizedFiles);
    link.replaceWith(style);
  }

  for (const script of document.querySelectorAll<HTMLScriptElement>('script[src]')) {
    const path = resolveLocalPath(script.getAttribute('src') ?? '', normalizedEntry);
    const source = path ? normalizedFiles.get(path) : undefined;
    if (!path || source === undefined) continue;
    script.removeAttribute('src');
    script.dataset.agorSource = path;
    script.textContent = source;
  }

  const resourceAttributes = [
    ['img[src]', 'src'],
    ['source[src]', 'src'],
    ['video[src]', 'src'],
    ['video[poster]', 'poster'],
    ['audio[src]', 'src'],
    ['link[rel~="icon"][href]', 'href'],
  ] as const;
  for (const [selector, attribute] of resourceAttributes) {
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      const path = resolveLocalPath(element.getAttribute(attribute) ?? '', normalizedEntry);
      const content = path ? normalizedFiles.get(path) : undefined;
      if (path && content !== undefined)
        element.setAttribute(attribute, fileDataUrl(path, content));
    }
  }

  for (const resource of externalResources) {
    if (resource.endsWith('.css') || resource.includes('fonts.googleapis')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = resource;
      document.head.append(link);
    } else if (resource.endsWith('.js') || resource.includes('#agor-runtime.js')) {
      const script = document.createElement('script');
      script.src = resource;
      document.head.append(script);
    }
  }

  return `<!doctype html>\n${document.documentElement.outerHTML}`;
}

/**
 * Sandboxed HTML-first renderer for the static template.
 *
 * Do not add `allow-same-origin`: srcdoc inherits the parent origin, so pairing
 * it with `allow-scripts` would let artifact code reach the Agor UI. The opaque
 * origin keeps the same isolation boundary as Sandpack's remote preview.
 */
export function ArtifactStaticPreview({
  files,
  entry,
  externalResources,
  title = 'Static artifact preview',
  onReady,
}: ArtifactStaticPreviewProps) {
  const srcDoc = useMemo(
    () => buildStaticArtifactDocument({ files, entry, externalResources }),
    [entry, externalResources, files]
  );

  return (
    <iframe
      title={title}
      srcDoc={srcDoc}
      sandbox="allow-downloads allow-forms allow-modals allow-pointer-lock allow-popups allow-presentation allow-scripts"
      onLoad={onReady}
      style={{ width: '100%', height: '100%', flex: 1, border: 0 }}
    />
  );
}
