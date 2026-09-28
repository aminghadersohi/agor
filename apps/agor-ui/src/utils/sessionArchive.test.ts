import { describe, expect, it } from 'vitest';
import { archivedReasonLabel } from './sessionArchive';

describe('archivedReasonLabel', () => {
  it('labels every known reason and falls back for unknown ones', () => {
    expect(archivedReasonLabel('manual')).toBe('Archived manually');
    expect(archivedReasonLabel('parent_archived')).toBe('Archived with its parent session');
    expect(archivedReasonLabel(undefined)).toBe('Archived');
  });
});
