import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RunningSessionCount, runningSessionCountLabel } from './RunningSessionCount';

describe('RunningSessionCount', () => {
  it('keeps its fixed layout slot while hiding the zero badge', () => {
    const { container } = render(<RunningSessionCount count={0} />);

    expect(container.querySelector('[data-running-session-count-slot]')).toHaveStyle({
      width: '36px',
      minWidth: '36px',
      flexShrink: '0',
    });
    expect(container.querySelector('[data-running-session-count]')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/running session/)).not.toBeInTheDocument();
  });

  it('uses exact singular accessible copy and a matching tooltip', async () => {
    render(<RunningSessionCount count={1} />);
    const count = screen.getByLabelText('1 running session');

    fireEvent.mouseEnter(count);

    expect(await screen.findByRole('tooltip')).toHaveTextContent('1 running session');
    expect(count).toHaveTextContent('1');
  });

  it('uses plural copy and visually caps high counts at 99+', () => {
    render(<RunningSessionCount count={123} />);

    expect(screen.getByLabelText('123 running sessions')).toHaveTextContent('99+');
    expect(runningSessionCountLabel(2)).toBe('2 running sessions');
  });
});
