import { describe, expect, it } from 'vitest';
import { getSurfacePath, hasExplicitEntityRouteTarget } from './routeTargets';

describe('hasExplicitEntityRouteTarget', () => {
  it.each([
    [{ sessionShortId: 'session' }, true],
    [{ branchShortId: 'branch' }, true],
    [{ artifactShortId: 'artifact' }, true],
    [{}, false],
  ])('returns the expected value for params %j', (params, expected) => {
    expect(hasExplicitEntityRouteTarget(params)).toBe(expected);
  });
});

describe('getSurfacePath', () => {
  it('returns the pathname on non-settings routes, ignoring history state', () => {
    expect(getSurfacePath({ pathname: '/b/alpha/', state: { settingsBackgroundPath: '/' } })).toBe(
      '/b/alpha/'
    );
  });

  it('resolves a settings route to the surface it was opened over', () => {
    expect(
      getSurfacePath({ pathname: '/settings/boards/', state: { settingsBackgroundPath: '/' } })
    ).toBe('/');
    expect(
      getSurfacePath({
        pathname: '/settings/mcp/',
        state: { settingsBackgroundPath: '/b/alpha/' },
      })
    ).toBe('/b/alpha/');
    expect(
      getSurfacePath({
        pathname: '/settings/mcp/',
        state: { settingsBackgroundPath: '/chats/019e99990000700080000000/' },
      })
    ).toBe('/chats/019e99990000700080000000/');
  });

  it('drops search and hash from the recorded origin', () => {
    expect(
      getSurfacePath({
        pathname: '/settings/boards/',
        state: { settingsBackgroundPath: '/b/alpha/?tab=x#frag' },
      })
    ).toBe('/b/alpha/');
  });

  it('falls back to the pathname when no usable origin was recorded', () => {
    // Cold-loaded settings URL (shared link / refresh) — nothing to preserve.
    expect(getSurfacePath({ pathname: '/settings/users/' })).toBe('/settings/users/');
    expect(getSurfacePath({ pathname: '/settings/users/', state: null })).toBe('/settings/users/');
    expect(
      getSurfacePath({ pathname: '/settings/users/', state: { settingsBackgroundPath: 42 } })
    ).toBe('/settings/users/');
    // Relative / non-path values are not surfaces.
    expect(
      getSurfacePath({
        pathname: '/settings/users/',
        state: { settingsBackgroundPath: 'https://example.test/elsewhere' },
      })
    ).toBe('/settings/users/');
    // Never resolve one settings route to another.
    expect(
      getSurfacePath({
        pathname: '/settings/users/',
        state: { settingsBackgroundPath: '/settings/mcp/' },
      })
    ).toBe('/settings/users/');
  });

  it('does not treat a path merely prefixed with "/settings" as a settings route', () => {
    expect(
      getSurfacePath({ pathname: '/settingsomething', state: { settingsBackgroundPath: '/' } })
    ).toBe('/settingsomething');
  });
});
