import type { AgorClient, Branch, TeammateSkillsReport } from '@agor-live/client';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '@/contexts/ConnectionContext';
import { NO_GAP_LIST_MESSAGE, TeammateSkillsPanel } from './TeammateSkillsPanel';

const branch = {
  branch_id: 'branch-1',
  name: 'larkspur',
  archived: false,
  custom_context: { teammate: { kind: 'teammate', displayName: 'Larkspur' } },
} as unknown as Branch;

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function baseReport(overrides: Partial<TeammateSkillsReport> = {}): TeammateSkillsReport {
  return {
    branch_id: 'branch-1' as TeammateSkillsReport['branch_id'],
    skills: [
      {
        name: 'connect-saas',
        source: 'in-repo',
        status: 'ok',
        path: 'skills/connect-saas/SKILL.md',
        sha256: SHA_A,
        version_label: 'sha aaaaaaa',
        updated_at: '2026-10-02T00:00:00.000Z',
      },
      {
        name: 'verifying-a-fix',
        source: 'knowledge',
        status: 'ok',
        path: 'skills/verifying-a-fix/SKILL.md',
        uri: 'agor://kb/document/doc-1',
        version_label: 'v3',
        description: 'Prove the fix before closing.',
        updated_at: '2026-10-09T00:00:00.000Z',
      },
      {
        name: 'django-perf-review',
        source: 'vendor',
        status: 'unreviewed',
        path: 'skills/django-perf-review/SKILL.md',
        version_label: 'example-org/skills@1a2b3c4',
        origin: { provider: 'git', license: 'Apache-2.0' },
      },
      { name: 'pdf', source: 'harness', status: 'synced', version_label: 'loaded last run' },
    ],
    gaps: {
      status: 'ok',
      items: [
        {
          skill: 'release-evidence-pack',
          priority: 'P0',
          note: 'no canonical skill',
          closed: false,
        },
        { skill: 'connect-saas', priority: 'P1', closed: true },
      ],
    },
    sources: {
      knowledge: { status: 'ok', namespace_slug: 'teammate-x' },
      in_repo: { status: 'ok' },
      harness: { status: 'ok', session_id: 'session-1' as never },
      drift: { status: 'unavailable', reason: 'Drift was not requested.', branches_scanned: 0 },
    },
    ...overrides,
  };
}

function withDrift(report: TeammateSkillsReport): TeammateSkillsReport {
  return {
    ...report,
    skills: report.skills.map((skill) =>
      skill.name === 'connect-saas'
        ? {
            ...skill,
            status: 'drift',
            drift: {
              variants: 2,
              shared_with: [{ branch_id: 'branch-2' as never, name: 'Bjorn', sha256: SHA_B }],
            },
          }
        : skill
    ),
    sources: { ...report.sources, drift: { status: 'ok', branches_scanned: 1 } },
  };
}

function clientAnswering(find: (params?: { query?: Record<string, unknown> }) => Promise<unknown>) {
  const service = vi.fn(() => ({ find }));
  return { client: { service } as unknown as AgorClient, service };
}

function renderPanel(
  client: AgorClient,
  props: Partial<React.ComponentProps<typeof TeammateSkillsPanel>> = {}
) {
  return render(
    <AntApp>
      <ConnectionProvider
        value={{
          connected: true,
          connecting: false,
          authGeneration: 1,
          outOfSync: false,
          capturedSha: null,
          currentSha: null,
        }}
      >
        <TeammateSkillsPanel branch={branch} client={client} {...props} />
      </ConnectionProvider>
    </AntApp>
  );
}

describe('TeammateSkillsPanel', () => {
  it('loads the view, then enriches it with drift', async () => {
    const report = baseReport();
    const find = vi.fn(async (params?: { query?: Record<string, unknown> }) =>
      params?.query?.include_drift ? withDrift(report) : report
    );
    const { client, service } = clientAnswering(find);

    renderPanel(client);

    expect(screen.getByTestId('teammate-skills-loading')).toBeInTheDocument();
    const summary = await screen.findByTestId('teammate-skills-summary');
    expect(service).toHaveBeenCalledWith('branches/branch-1/skills');
    expect(within(summary).getByText('4 equipped')).toBeInTheDocument();
    expect(within(summary).getByText('1 gap')).toBeInTheDocument();
    expect(within(summary).getByText('1 unreviewed')).toBeInTheDocument();
    await waitFor(() => expect(within(summary).getByText('1 drifted')).toBeInTheDocument());
    expect(find).toHaveBeenLastCalledWith({ query: { include_drift: true } });
    expect(screen.getByText('2 variants')).toBeInTheDocument();
    expect(screen.getByText('Skills — Larkspur')).toBeInTheDocument();
  });

  it('filters by search, source and problems', async () => {
    const { client } = clientAnswering(async () => baseReport());
    renderPanel(client);
    await screen.findByTestId('teammate-skills-summary');
    expect(screen.getAllByTestId('teammate-skill-row')).toHaveLength(4);

    fireEvent.change(screen.getByLabelText('Search skills'), { target: { value: 'fix' } });
    expect(screen.getAllByTestId('teammate-skill-row')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'verifying-a-fix' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search skills'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Only problems' }));
    expect(screen.getAllByTestId('teammate-skill-row')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'django-perf-review' })).toBeInTheDocument();
    // Closed gaps are not problems.
    expect(screen.queryByText('equipped')).not.toBeInTheDocument();
    expect(screen.getByText('release-evidence-pack')).toBeInTheDocument();
  });

  it('opens a drawer with provenance and a Knowledge link', async () => {
    const { client } = clientAnswering(async () => baseReport());
    renderPanel(client);
    await screen.findByTestId('teammate-skills-summary');

    fireEvent.click(screen.getByRole('button', { name: 'verifying-a-fix' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('Prove the fix before closing.')).toBeInTheDocument();
    expect(within(drawer).getByText('agor://kb/document/doc-1')).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: 'Open in Knowledge' })).toHaveAttribute(
      'href',
      expect.stringContaining('/kb/teammate-x/skills/verifying-a-fix/SKILL.md')
    );
  });

  it('shows which namespace a shared Knowledge skill comes from, and links there', async () => {
    const report = baseReport();
    report.skills[1] = {
      ...report.skills[1],
      path: 'skills/larkspur/verifying-a-fix.md',
      namespace_slug: 'team-skills',
      namespace_name: 'Team skills',
    };
    report.gaps.documents = [
      {
        uri: 'agor://kb/document/gaps',
        path: 'skills/larkspur/_gaps.md',
        namespace_slug: 'team-skills',
      },
    ];
    const { client } = clientAnswering(async () => report);
    renderPanel(client);
    await screen.findByTestId('teammate-skills-summary');

    expect(screen.getByTestId('teammate-skill-namespace')).toHaveTextContent('Team skills');
    expect(screen.getByRole('link', { name: 'Open gap list' })).toHaveAttribute(
      'href',
      expect.stringContaining('/kb/team-skills/skills/larkspur/_gaps.md')
    );
    fireEvent.click(screen.getByRole('button', { name: 'verifying-a-fix' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('team-skills')).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: 'Open in Knowledge' })).toHaveAttribute(
      'href',
      expect.stringContaining('/kb/team-skills/skills/larkspur/verifying-a-fix.md')
    );
  });

  it('shows a vendored skill as not reviewed in the drawer', async () => {
    const { client } = clientAnswering(async () => baseReport());
    renderPanel(client);
    await screen.findByTestId('teammate-skills-summary');

    fireEvent.click(screen.getByRole('button', { name: 'django-perf-review' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('Apache-2.0')).toBeInTheDocument();
    expect(within(drawer).getByText('Not reviewed')).toBeInTheDocument();
  });

  it('offers the Files tab for an in-repo skill', async () => {
    const onOpenFiles = vi.fn();
    const { client } = clientAnswering(async () => baseReport());
    renderPanel(client, { onOpenFiles });
    await screen.findByTestId('teammate-skills-summary');

    fireEvent.click(screen.getByRole('button', { name: 'connect-saas' }));
    const drawer = await screen.findByRole('dialog');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Open Files tab' }));
    expect(onOpenFiles).toHaveBeenCalledTimes(1);
  });

  it('explains a missing gap list and unreadable sources', async () => {
    const report = baseReport({
      gaps: { status: 'missing', items: [] },
      sources: {
        ...baseReport().sources,
        in_repo: {
          status: 'unavailable',
          reason: 'You do not have file read access to this branch.',
        },
      },
    });
    const { client } = clientAnswering(async () => report);
    renderPanel(client);

    expect(await screen.findByText(NO_GAP_LIST_MESSAGE)).toBeInTheDocument();
    expect(
      screen.getByText('In-repo: You do not have file read access to this branch.')
    ).toBeInTheDocument();
  });

  it('shows an empty state when the teammate has no skills', async () => {
    const report = baseReport({ skills: [], gaps: { status: 'missing', items: [] } });
    const { client } = clientAnswering(async () => report);
    renderPanel(client);
    expect(await screen.findByText('No skills found for this teammate.')).toBeInTheDocument();
  });

  it('shows an error with a retry that asks again', async () => {
    let fail = true;
    const find = vi.fn(async () => {
      if (fail) throw new Error('daemon unreachable');
      return baseReport();
    });
    const { client } = clientAnswering(find);
    renderPanel(client);

    expect(await screen.findByText("Couldn't load this teammate's skills.")).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('teammate-skills-summary')).toBeInTheDocument();
  });

  it('keeps the first answer when the drift pass fails', async () => {
    const find = vi.fn(async (params?: { query?: Record<string, unknown> }) => {
      if (params?.query?.include_drift) throw new Error('scan timed out');
      return baseReport();
    });
    const { client } = clientAnswering(find);
    renderPanel(client);

    await screen.findByTestId('teammate-skills-summary');
    await waitFor(() => expect(find).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Checking drift…')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('teammate-skill-row')).toHaveLength(4);
  });

  it('compact variant shows counts and open gaps and opens the full view', async () => {
    const onOpenFull = vi.fn();
    const { client } = clientAnswering(async () => baseReport());
    renderPanel(client, { variant: 'compact', onOpenFull });

    await screen.findByTestId('teammate-skills-summary');
    expect(screen.getByText('release-evidence-pack')).toBeInTheDocument();
    // Closed gaps and the skill list belong to the full view.
    expect(screen.queryByTestId('teammate-skill-row')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Search skills')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Skills' }));
    expect(onOpenFull).toHaveBeenCalledTimes(1);
  });
});
