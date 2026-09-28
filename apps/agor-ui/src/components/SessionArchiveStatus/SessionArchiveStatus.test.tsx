import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SessionArchiveStatus } from './SessionArchiveStatus';

describe('SessionArchiveStatus', () => {
  it('says why an archived session was archived', () => {
    render(
      <SessionArchiveStatus session={{ archived: true, archived_reason: 'auto_completed' }} />
    );
    expect(screen.getByTestId('session-archive-status')).toHaveTextContent(
      'Archived automatically after completion'
    );
  });

  it('counts down to a pending automatic archival', () => {
    const at = new Date(Date.now() + 5 * 60_000 + 30_000).toISOString();
    render(<SessionArchiveStatus session={{ archived: false, auto_archive_at: at }} />);
    expect(screen.getByTestId('session-archive-status')).toHaveTextContent('Archives in 5m');
  });

  it('renders nothing for an active session with no deadline', () => {
    const { container } = render(<SessionArchiveStatus session={{ archived: false }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
