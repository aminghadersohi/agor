import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RestartRecoverySummary } from './AboutTab';

describe('RestartRecoverySummary', () => {
  it('says interrupted tasks are not resumed when recovery is off', () => {
    render(
      <RestartRecoverySummary
        settings={{ enabled: false, delayMs: 2000, maxTasksPerStart: 50, resumeAfterCrash: false }}
      />
    );
    expect(screen.getByText('Off')).toBeInTheDocument();
    expect(screen.getByText(/not resumed automatically/)).toBeInTheDocument();
  });

  it('shows the resolved pacing, cap and crash policy when on', () => {
    render(
      <RestartRecoverySummary
        settings={{ enabled: true, delayMs: 2500, maxTasksPerStart: 10, resumeAfterCrash: true }}
      />
    );
    expect(screen.getByText('On')).toBeInTheDocument();
    expect(
      screen.getByText(
        /Continues up to 10 interrupted tasks per start, one every 2.5s; also after a crash/
      )
    ).toBeInTheDocument();
  });
});
