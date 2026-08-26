import type { ArtifactID, UserPreferences } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import {
  MAX_HOME_ARTIFACTS,
  readHomeArtifactIds,
  withHomeArtifactPin,
} from './homeArtifactPreferences';

const artifactId = (value: string) => value as ArtifactID;

describe('home artifact preferences', () => {
  it('deduplicates, bounds, and ignores malformed persisted values', () => {
    const ids = Array.from({ length: MAX_HOME_ARTIFACTS + 3 }, (_, index) =>
      artifactId(`artifact-${index}`)
    );
    const preferences = {
      home_artifact_ids: [ids[0], '', ids[0], ...ids.slice(1), 42],
    } as unknown as UserPreferences;

    expect(readHomeArtifactIds(preferences)).toEqual(ids.slice(0, MAX_HOME_ARTIFACTS));
  });

  it('pins to the front and preserves unrelated preferences', () => {
    const preferences = {
      home_artifact_ids: [artifactId('old')],
      theme: 'dark',
    } as UserPreferences;
    expect(withHomeArtifactPin(preferences, artifactId('new'), true)).toEqual({
      home_artifact_ids: [artifactId('new'), artifactId('old')],
      theme: 'dark',
    });
  });

  it('unpins without changing unrelated preferences', () => {
    const preferences = {
      home_artifact_ids: [artifactId('keep'), artifactId('remove')],
      theme: 'light',
    } as UserPreferences;
    expect(withHomeArtifactPin(preferences, artifactId('remove'), false)).toEqual({
      home_artifact_ids: [artifactId('keep')],
      theme: 'light',
    });
  });
});
