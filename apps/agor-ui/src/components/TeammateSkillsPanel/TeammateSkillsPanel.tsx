import type {
  AgorClient,
  Branch,
  SkillPinStatus,
  TeammateSkill,
  TeammateSkillGap,
  TeammateSkillGapList,
  TeammateSkillSource,
  TeammateSkillsReport,
} from '@agor-live/client';
import {
  getTeammateConfig,
  knowledgePath,
  shortId,
  TEAMMATE_SKILL_GAPS_PATH,
} from '@agor-live/client';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  CloseOutlined,
  CloudDownloadOutlined,
  ExclamationCircleOutlined,
  InfoCircleOutlined,
  ReloadOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import {
  Button,
  Checkbox,
  Descriptions,
  Drawer,
  Empty,
  Flex,
  Input,
  List,
  Select,
  Skeleton,
  Spin,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import type React from 'react';
import { useMemo, useState } from 'react';
import { useTeammateSkills } from '../../hooks/useTeammateSkills';
import { formatAbsoluteTime, formatRelativeTimeSafe } from '../../utils/time';
import { uiRouteHref } from '../../utils/uiRoutes';
import { CompactNotice } from '../CompactNotice';
import { Tag } from '../Tag';
import {
  filterTeammateSkillGaps,
  filterTeammateSkills,
  PIN_STATUS_LABELS,
  pinLabel,
  SKILL_SOURCE_COLORS,
  SKILL_SOURCE_LABELS,
  type SkillSourceFilter,
  statusLabel,
  summarizeTeammateSkills,
  webHref,
} from './teammateSkillsView';

export const NO_GAP_LIST_MESSAGE =
  "No gap list yet. Add skills/_gaps.md to this teammate's Knowledge namespace.";

const COMPACT_GAP_LIMIT = 5;

const GAP_PRIORITY_COLORS: Record<TeammateSkillGap['priority'], string | undefined> = {
  P0: 'error',
  P1: 'warning',
  P2: undefined,
};

const SOURCE_OPTIONS: Array<{ label: string; value: SkillSourceFilter }> = [
  { label: 'All sources', value: 'all' },
  { label: 'Knowledge', value: 'knowledge' },
  { label: 'Vendor', value: 'vendor' },
  { label: 'In-repo', value: 'in-repo' },
  { label: 'Harness', value: 'harness' },
];

export interface TeammateSkillsPanelProps {
  branch: Branch;
  client: AgorClient | null;
  /** `compact`: counts and open gaps only, for the teammate settings tab. */
  variant?: 'full' | 'compact';
  /** Compact only: open the full Skills view. */
  onOpenFull?: () => void;
  /** Opens this branch's Files tab, offered for in-repo skills. */
  onOpenFiles?: () => void;
  /** Hosted in a header-less drawer: show a close button in the panel's own header. */
  onClose?: () => void;
}

function knowledgeHref(slug: string | undefined, path: string | undefined): string | undefined {
  return slug && path ? uiRouteHref(knowledgePath(slug, path)) : undefined;
}

/** The first gap document, or the primary namespace's `skills/_gaps.md`. */
function gapListHref(report: TeammateSkillsReport): string | undefined {
  if (report.gaps.status === 'missing') return undefined;
  const first = report.gaps.documents?.[0];
  return first
    ? knowledgeHref(first.namespace_slug, first.path)
    : knowledgeHref(report.sources.knowledge.namespace_slug, TEAMMATE_SKILL_GAPS_PATH);
}

/** A Knowledge/vendor skill's namespace, shown so a shared namespace is visible. */
function namespaceLabel(skill: TeammateSkill): string | undefined {
  return skill.namespace_name ?? skill.namespace_slug;
}

const SourceTag: React.FC<{ source: TeammateSkillSource }> = ({ source }) => (
  <Tag color={SKILL_SOURCE_COLORS[source]} style={{ marginInlineEnd: 0, flexShrink: 0 }}>
    {SKILL_SOURCE_LABELS[source]}
  </Tag>
);

const StatusTag: React.FC<{ skill: TeammateSkill }> = ({ skill }) => {
  const label = statusLabel(skill);
  switch (skill.status) {
    case 'drift':
      return (
        <Tooltip title="This skill's content differs across the teammates you can read">
          <Tag color="warning" icon={<WarningOutlined />} style={{ marginInlineEnd: 0 }}>
            {label}
          </Tag>
        </Tooltip>
      );
    case 'unreviewed':
      return (
        <Tag color="warning" icon={<ExclamationCircleOutlined />} style={{ marginInlineEnd: 0 }}>
          {label}
        </Tag>
      );
    case 'synced':
      return (
        <Tooltip title="Loaded by the harness last run; Agor has no source for it">
          <Tag icon={<InfoCircleOutlined />} style={{ marginInlineEnd: 0 }}>
            {label}
          </Tag>
        </Tooltip>
      );
    default:
      return (
        <Tag color="success" icon={<CheckCircleOutlined />} style={{ marginInlineEnd: 0 }}>
          {label}
        </Tag>
      );
  }
};

const UpdatedText: React.FC<{ value?: string }> = ({ value }) => {
  const relative = formatRelativeTimeSafe(value);
  if (!value || !relative) return <span>—</span>;
  return (
    <Tooltip title={formatAbsoluteTime(value)}>
      <span>{relative}</span>
    </Tooltip>
  );
};

const PIN_STATUS_COLORS: Record<SkillPinStatus, string | undefined> = {
  current: undefined,
  update_available: 'warning',
  missing: 'error',
  hash_mismatch: 'error',
};

const PinTag: React.FC<{ skill: TeammateSkill }> = ({ skill }) =>
  skill.pin ? (
    <Tooltip title={pinLabel(skill)}>
      <Tag
        color={PIN_STATUS_COLORS[skill.pin.status]}
        style={{ marginInlineEnd: 0 }}
        data-testid="teammate-skill-pin"
      >
        {skill.pin.status === 'current'
          ? `r${skill.pin.release} · v${skill.pin.version_number}`
          : PIN_STATUS_LABELS[skill.pin.status]}
      </Tag>
    </Tooltip>
  ) : null;

const DeliveredMark: React.FC<{ skill: TeammateSkill }> = ({ skill }) => {
  const { token } = theme.useToken();
  return skill.delivered ? (
    <Tooltip title="Delivered in last session">
      <CloudDownloadOutlined
        aria-label="Delivered in last session"
        data-testid="teammate-skill-delivered"
        style={{ color: token.colorSuccess, flexShrink: 0 }}
      />
    </Tooltip>
  ) : null;
};

/** The equipped skill set release, its pin problems, and what the last session was given. */
const ReleaseLine: React.FC<{ report: TeammateSkillsReport }> = ({ report }) => {
  const { token } = theme.useToken();
  const release = report.release;
  if (!release) return null;
  const small = { fontSize: token.fontSizeSM };
  const delivered = release.delivered;
  return (
    <Flex wrap align="center" gap={token.marginXS} data-testid="teammate-skills-release">
      {!release.enabled && (
        <Tag style={{ marginInlineEnd: 0 }}>Skills delivery off for this teammate</Tag>
      )}
      {release.status === 'none' && (
        <Typography.Text type="secondary" style={small}>
          No skill set release yet.
        </Typography.Text>
      )}
      {release.status === 'unavailable' && (
        <Typography.Text type="warning" style={small}>
          {release.reason ?? 'The skill set release could not be read.'}
        </Typography.Text>
      )}
      {release.status === 'ok' && (
        <>
          <Tooltip title={`${release.namespace_slug ?? ''}/${release.path ?? ''}`}>
            <Tag color="blue" style={{ marginInlineEnd: 0 }}>
              Release r{release.release}
            </Tag>
          </Tooltip>
          {release.created_at && (
            <Typography.Text type="secondary" style={small}>
              cut <UpdatedText value={release.created_at} />
            </Typography.Text>
          )}
          {(['update_available', 'hash_mismatch', 'missing'] as const).map((status) =>
            release.counts?.[status] ? (
              <Tag key={status} color={PIN_STATUS_COLORS[status]} style={{ marginInlineEnd: 0 }}>
                {release.counts[status]} {PIN_STATUS_LABELS[status]}
              </Tag>
            ) : null
          )}
          {release.unreleased ? (
            <Typography.Text type="secondary" style={small}>
              · {release.unreleased} not in a release yet
            </Typography.Text>
          ) : null}
        </>
      )}
      {delivered && (
        <Typography.Text type="secondary" style={small} data-testid="teammate-skills-delivered">
          · Last session got r{delivered.release} ({delivered.skills}{' '}
          {delivered.skills === 1 ? 'skill' : 'skills'}, {delivered.harness}){' '}
          <UpdatedText value={delivered.delivered_at} />
        </Typography.Text>
      )}
    </Flex>
  );
};

const SkillsSummary: React.FC<{ report: TeammateSkillsReport; driftLoading: boolean }> = ({
  report,
  driftLoading,
}) => {
  const { token } = theme.useToken();
  const summary = summarizeTeammateSkills(report);
  const sources = (Object.keys(summary.bySource) as TeammateSkillSource[]).filter(
    (source) => summary.bySource[source] > 0
  );
  return (
    <Flex wrap align="center" gap={token.marginXS} data-testid="teammate-skills-summary">
      <Typography.Text strong>{summary.equipped} equipped</Typography.Text>
      {sources.map((source) => (
        <Typography.Text key={source} type="secondary">
          · {summary.bySource[source]} {SKILL_SOURCE_LABELS[source]}
        </Typography.Text>
      ))}
      {summary.drifted > 0 && (
        <Tag color="warning" icon={<WarningOutlined />} style={{ marginInlineEnd: 0 }}>
          {summary.drifted} drifted
        </Tag>
      )}
      {summary.unreviewed > 0 && (
        <Tag color="warning" icon={<ExclamationCircleOutlined />} style={{ marginInlineEnd: 0 }}>
          {summary.unreviewed} unreviewed
        </Tag>
      )}
      {summary.openGaps > 0 && (
        <Tag color="error" icon={<CloseCircleOutlined />} style={{ marginInlineEnd: 0 }}>
          {summary.openGaps} {summary.openGaps === 1 ? 'gap' : 'gaps'}
        </Tag>
      )}
      {driftLoading && (
        <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
          <Spin size="small" style={{ marginInlineEnd: token.marginXXS }} />
          Checking drift…
        </Typography.Text>
      )}
    </Flex>
  );
};

/** Sources that contributed nothing for a reason worth telling the reader. */
function sourceNotices(report: TeammateSkillsReport, driftLoading: boolean): string[] {
  const notices: string[] = [];
  const { knowledge, in_repo, drift } = report.sources;
  if (knowledge.status === 'unavailable' && knowledge.reason) {
    notices.push(`Knowledge: ${knowledge.reason}`);
  }
  if (in_repo.status === 'unavailable' && in_repo.reason) {
    notices.push(`In-repo: ${in_repo.reason}`);
  } else if (in_repo.truncated) {
    notices.push('In-repo: the worktree scan stopped at its file limit.');
  }
  if (!driftLoading && drift.status === 'ok' && drift.truncated) {
    notices.push('Drift: only some teammates were compared.');
  }
  return notices;
}

const GapRow: React.FC<{ gap: TeammateSkillGap }> = ({ gap }) => {
  const { token } = theme.useToken();
  const href = webHref(gap.source);
  return (
    <List.Item style={{ paddingInline: 0 }}>
      <Flex vertical gap={2} style={{ minWidth: 0, width: '100%' }}>
        <Flex align="center" gap={token.marginXS} style={{ minWidth: 0 }}>
          {gap.closed ? (
            <CheckCircleOutlined
              aria-label="Closed"
              style={{ color: token.colorSuccess, flexShrink: 0 }}
            />
          ) : (
            <CloseCircleOutlined
              aria-label="Open"
              style={{ color: token.colorError, flexShrink: 0 }}
            />
          )}
          <Tag
            color={gap.closed ? undefined : GAP_PRIORITY_COLORS[gap.priority]}
            style={{ marginInlineEnd: 0, flexShrink: 0 }}
          >
            {gap.priority}
          </Tag>
          <Typography.Text
            type={gap.closed ? 'secondary' : undefined}
            ellipsis={{ tooltip: gap.skill }}
            style={{ minWidth: 0 }}
          >
            {gap.skill}
          </Typography.Text>
          {gap.closed && (
            <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM, flexShrink: 0 }}>
              equipped
            </Typography.Text>
          )}
        </Flex>
        {(gap.note || gap.source) && (
          <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            {gap.note}
            {gap.note && gap.source ? ' · ' : ''}
            {href ? (
              <Typography.Link href={href} target="_blank" rel="noreferrer">
                source
              </Typography.Link>
            ) : (
              gap.source
            )}
          </Typography.Text>
        )}
      </Flex>
    </List.Item>
  );
};

const GapsBody: React.FC<{
  report: TeammateSkillsReport;
  gaps: TeammateSkillGap[];
  limit?: number;
}> = ({ report, gaps, limit }) => {
  const { token } = theme.useToken();
  const list: TeammateSkillGapList = report.gaps;
  if (report.sources.knowledge.status === 'unavailable') {
    return (
      <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
        Gaps live in this teammate's Knowledge namespace, which isn't readable here.
      </Typography.Text>
    );
  }
  if (list.status === 'missing') {
    return (
      <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
        {NO_GAP_LIST_MESSAGE}
      </Typography.Text>
    );
  }
  if (list.status === 'invalid') {
    return (
      <CompactNotice
        type="warning"
        message="The gap list could not be read."
        details={list.error ? [{ label: 'Problem', value: list.error }] : undefined}
      />
    );
  }
  if (gaps.length === 0) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
        {list.items.length === 0 ? 'The gap list is empty.' : 'No gaps match these filters.'}
      </Typography.Text>
    );
  }
  const shown = limit === undefined ? gaps : gaps.slice(0, limit);
  return (
    <>
      <List size="small" dataSource={shown} renderItem={(gap) => <GapRow gap={gap} />} />
      {shown.length < gaps.length && (
        <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
          +{gaps.length - shown.length} more
        </Typography.Text>
      )}
    </>
  );
};

const SkillRow: React.FC<{ skill: TeammateSkill; onOpen: () => void }> = ({ skill, onOpen }) => {
  const { token } = theme.useToken();
  return (
    <List.Item
      onClick={onOpen}
      style={{ paddingInline: 0, cursor: 'pointer' }}
      data-testid="teammate-skill-row"
    >
      <Flex vertical gap={2} style={{ minWidth: 0, width: '100%' }}>
        <Flex align="center" gap={token.marginXS} style={{ minWidth: 0 }}>
          <Button
            type="link"
            size="small"
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
            style={{ padding: 0, minWidth: 0, flex: '0 1 auto', height: 'auto' }}
          >
            <Typography.Text ellipsis={{ tooltip: skill.name }} style={{ color: 'inherit' }}>
              {skill.name}
            </Typography.Text>
          </Button>
          <SourceTag source={skill.source} />
          <DeliveredMark skill={skill} />
          <span style={{ flex: 1 }} />
          <Flex gap={token.marginXXS} style={{ flexShrink: 0 }}>
            <PinTag skill={skill} />
            <StatusTag skill={skill} />
          </Flex>
        </Flex>
        <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
          {skill.version_label} · <UpdatedText value={skill.updated_at} />
          {namespaceLabel(skill) && (
            <>
              {' · '}
              <Tooltip title={`Knowledge namespace ${skill.namespace_slug ?? ''}`}>
                <span data-testid="teammate-skill-namespace">{namespaceLabel(skill)}</span>
              </Tooltip>
            </>
          )}
        </Typography.Text>
      </Flex>
    </List.Item>
  );
};

const SkillDrawer: React.FC<{
  report: TeammateSkillsReport;
  skill: TeammateSkill | null;
  onClose: () => void;
  onOpenFiles?: () => void;
}> = ({ report, skill, onClose, onOpenFiles }) => {
  const { token } = theme.useToken();
  const kbHref =
    skill && skill.source !== 'in-repo'
      ? knowledgeHref(skill.namespace_slug ?? report.sources.knowledge.namespace_slug, skill.path)
      : undefined;
  const origin = skill?.origin;
  const harnessSession = report.sources.harness.session_id;
  return (
    <Drawer
      open={skill !== null}
      onClose={onClose}
      title={skill?.name}
      placement="right"
      destroyOnHidden
      extra={
        kbHref ? (
          <Button href={kbHref} target="_blank" rel="noreferrer" size="small">
            Open in Knowledge
          </Button>
        ) : skill?.source === 'in-repo' && onOpenFiles ? (
          <Button size="small" onClick={onOpenFiles}>
            Open Files tab
          </Button>
        ) : null
      }
    >
      {skill && (
        <Flex vertical gap={token.margin}>
          <Flex align="center" gap={token.marginXS} wrap>
            <SourceTag source={skill.source} />
            <StatusTag skill={skill} />
            <PinTag skill={skill} />
          </Flex>
          {skill.description ? (
            <Typography.Paragraph style={{ margin: 0 }}>{skill.description}</Typography.Paragraph>
          ) : (
            <Typography.Text type="secondary">No description.</Typography.Text>
          )}
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="Version">
              {skill.version_label}
              {skill.version_id && (
                <>
                  {' · '}
                  <Typography.Text code copyable={{ text: skill.version_id }}>
                    {shortId(skill.version_id)}
                  </Typography.Text>
                </>
              )}
            </Descriptions.Item>
            {namespaceLabel(skill) && (
              <Descriptions.Item label="Namespace">
                {namespaceLabel(skill)}
                {skill.namespace_name && skill.namespace_slug && (
                  <>
                    {' '}
                    <Typography.Text code>{skill.namespace_slug}</Typography.Text>
                  </>
                )}
              </Descriptions.Item>
            )}
            {skill.pin && (
              <Descriptions.Item label="Release">
                {pinLabel(skill)} ({PIN_STATUS_LABELS[skill.pin.status]})
              </Descriptions.Item>
            )}
            {skill.delivered && report.release?.delivered && (
              <Descriptions.Item label="Delivered">
                In the last session, as part of r{report.release.delivered.release} (
                {formatAbsoluteTime(report.release.delivered.delivered_at)})
              </Descriptions.Item>
            )}
            <Descriptions.Item label="Updated">
              {skill.updated_at ? formatAbsoluteTime(skill.updated_at) : '—'}
            </Descriptions.Item>
            {skill.path && (
              <Descriptions.Item label="Path">
                <Typography.Text code copyable style={{ wordBreak: 'break-all' }}>
                  {skill.path}
                </Typography.Text>
              </Descriptions.Item>
            )}
            {skill.uri && (
              <Descriptions.Item label="URI">
                <Typography.Text code copyable style={{ wordBreak: 'break-all' }}>
                  {skill.uri}
                </Typography.Text>
              </Descriptions.Item>
            )}
            {skill.sha256 && (
              <Descriptions.Item label="sha256">
                <Typography.Text code copyable={{ text: skill.sha256 }}>
                  {skill.sha256.slice(0, 16)}…
                </Typography.Text>
              </Descriptions.Item>
            )}
            {origin?.provider && (
              <Descriptions.Item label="Origin">{origin.provider}</Descriptions.Item>
            )}
            {origin?.uri && (
              <Descriptions.Item label="Upstream">
                {webHref(origin.uri) ? (
                  <Typography.Link
                    href={origin.uri}
                    target="_blank"
                    rel="noreferrer"
                    style={{ wordBreak: 'break-all' }}
                  >
                    {origin.uri}
                  </Typography.Link>
                ) : (
                  <Typography.Text style={{ wordBreak: 'break-all' }}>{origin.uri}</Typography.Text>
                )}
              </Descriptions.Item>
            )}
            {origin?.commit && (
              <Descriptions.Item label="Commit">
                <Typography.Text code copyable={{ text: origin.commit }}>
                  {origin.commit.slice(0, 12)}
                </Typography.Text>
              </Descriptions.Item>
            )}
            {origin?.license && (
              <Descriptions.Item label="License">{origin.license}</Descriptions.Item>
            )}
            {origin && (
              <Descriptions.Item label="Reviewed by">
                {origin.reviewed_by ? (
                  `${origin.reviewed_by}${origin.reviewed_at ? ` on ${origin.reviewed_at}` : ''}`
                ) : (
                  <Typography.Text type="warning">Not reviewed</Typography.Text>
                )}
              </Descriptions.Item>
            )}
            {skill.source === 'harness' && (
              <Descriptions.Item label="Reported by">
                {harnessSession ? `Session ${shortId(harnessSession)}` : 'The last session'}
              </Descriptions.Item>
            )}
          </Descriptions>
          {skill.drift && (
            <Flex vertical gap={token.marginXS}>
              <Typography.Text strong>Other teammates with this skill</Typography.Text>
              {skill.drift.shared_with.length === 0 ? (
                <Typography.Text type="secondary">
                  No other teammate you can read has it.
                </Typography.Text>
              ) : (
                <List
                  size="small"
                  dataSource={skill.drift.shared_with}
                  renderItem={(peer) => (
                    <List.Item style={{ paddingInline: 0 }}>
                      <Flex align="center" gap={token.marginXS} style={{ width: '100%' }}>
                        <Typography.Text ellipsis={{ tooltip: peer.name }} style={{ minWidth: 0 }}>
                          {peer.name}
                        </Typography.Text>
                        <span style={{ flex: 1 }} />
                        <Typography.Text code>{peer.sha256.slice(0, 7)}</Typography.Text>
                        {peer.sha256 === skill.sha256 ? (
                          <Tag color="success" style={{ marginInlineEnd: 0 }}>
                            same
                          </Tag>
                        ) : (
                          <Tag color="warning" style={{ marginInlineEnd: 0 }}>
                            differs
                          </Tag>
                        )}
                      </Flex>
                    </List.Item>
                  )}
                />
              )}
            </Flex>
          )}
        </Flex>
      )}
    </Drawer>
  );
};

/**
 * Read-only view of one teammate's skills: Knowledge and vendored skills,
 * in-repo skill files, skills the harness loaded last run, drift across
 * teammates, and the teammate's declared gaps. Shared by the board's teammate
 * sidebar (full) and the teammate settings tab (compact).
 */
export const TeammateSkillsPanel: React.FC<TeammateSkillsPanelProps> = ({
  branch,
  client,
  variant = 'full',
  onOpenFull,
  onOpenFiles,
  onClose,
}) => {
  const { token } = theme.useToken();
  const { report, loading, driftLoading, error, reload } = useTeammateSkills(
    client,
    branch.branch_id
  );
  const [search, setSearch] = useState('');
  const [source, setSource] = useState<SkillSourceFilter>('all');
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const skills = useMemo(
    () => (report ? filterTeammateSkills(report.skills, { search, source, onlyProblems }) : []),
    [report, search, source, onlyProblems]
  );
  const gaps = useMemo(
    () =>
      report
        ? filterTeammateSkillGaps(report.gaps.items, {
            search: variant === 'compact' ? '' : search,
            onlyProblems: variant === 'compact' || onlyProblems,
          })
        : [],
    [report, search, onlyProblems, variant]
  );
  const skillKey = (skill: TeammateSkill) => `${skill.source}:${skill.path ?? skill.name}`;
  const selected = report?.skills.find((skill) => skillKey(skill) === selectedKey) ?? null;
  const displayName = getTeammateConfig(branch)?.displayName ?? branch.name;

  const body = (() => {
    if (loading) {
      return (
        <div data-testid="teammate-skills-loading">
          <Skeleton active title={false} paragraph={{ rows: variant === 'compact' ? 2 : 5 }} />
        </div>
      );
    }
    if (error || !report) {
      return (
        <CompactNotice
          type="error"
          role="alert"
          message="Couldn't load this teammate's skills."
          actions={[{ label: 'Try again', onClick: reload }]}
          details={error ? [{ label: 'Error', value: error.message, code: true }] : undefined}
        />
      );
    }

    if (variant === 'compact') {
      return (
        <Flex vertical gap={token.marginXS}>
          <SkillsSummary report={report} driftLoading={driftLoading} />
          <ReleaseLine report={report} />
          <GapsBody report={report} gaps={gaps} limit={COMPACT_GAP_LIMIT} />
        </Flex>
      );
    }

    const notices = sourceNotices(report, driftLoading);
    return (
      <Flex vertical gap={token.marginSM}>
        <SkillsSummary report={report} driftLoading={driftLoading} />
        <ReleaseLine report={report} />
        {notices.map((notice) => (
          <CompactNotice key={notice} type="info" message={notice} />
        ))}
        <Flex wrap gap={token.marginXS} align="center">
          <Input.Search
            allowClear
            size="small"
            placeholder="Search skills…"
            aria-label="Search skills"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            style={{ flex: '1 1 160px', minWidth: 0 }}
          />
          <Select
            size="small"
            aria-label="Filter by source"
            value={source}
            onChange={setSource}
            options={SOURCE_OPTIONS}
            style={{ width: 130 }}
          />
          <Checkbox
            checked={onlyProblems}
            onChange={(event) => setOnlyProblems(event.target.checked)}
          >
            Only problems
          </Checkbox>
        </Flex>

        <Typography.Text type="secondary" strong style={{ fontSize: token.fontSizeSM }}>
          EQUIPPED
        </Typography.Text>
        {skills.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              report.skills.length === 0
                ? 'No skills found for this teammate.'
                : 'No skills match these filters.'
            }
            style={{ margin: `${token.marginXS}px 0` }}
          />
        ) : (
          <List
            size="small"
            dataSource={skills}
            rowKey={skillKey}
            renderItem={(skill) => (
              <SkillRow skill={skill} onOpen={() => setSelectedKey(skillKey(skill))} />
            )}
          />
        )}

        <Flex align="center" justify="space-between">
          <Typography.Text type="secondary" strong style={{ fontSize: token.fontSizeSM }}>
            GAPS
          </Typography.Text>
          {gapListHref(report) && (
            <Button
              type="link"
              size="small"
              href={gapListHref(report)}
              target="_blank"
              rel="noreferrer"
              style={{ padding: 0 }}
            >
              Open gap list
            </Button>
          )}
        </Flex>
        <GapsBody report={report} gaps={gaps} />

        <SkillDrawer
          report={report}
          skill={selected}
          onClose={() => setSelectedKey(null)}
          onOpenFiles={onOpenFiles}
        />
      </Flex>
    );
  })();

  return (
    <Flex
      vertical
      gap={token.marginSM}
      style={variant === 'full' ? { padding: token.padding } : undefined}
      data-testid={`teammate-skills-${variant}`}
    >
      <Flex align="center" justify="space-between" gap={token.marginXS}>
        <Typography.Text strong ellipsis={{ tooltip: displayName }} style={{ minWidth: 0 }}>
          {variant === 'compact' ? 'Skills' : `Skills — ${displayName}`}
        </Typography.Text>
        <Flex gap={token.marginXXS} style={{ flexShrink: 0 }}>
          <Tooltip title="Refresh">
            <Button
              type="text"
              size="small"
              aria-label="Refresh skills"
              icon={<ReloadOutlined />}
              onClick={reload}
              disabled={loading}
            />
          </Tooltip>
          {variant === 'compact' && onOpenFull && (
            <Button size="small" onClick={onOpenFull}>
              Open Skills
            </Button>
          )}
          {onClose && (
            <Button
              type="text"
              size="small"
              aria-label="Close skills"
              icon={<CloseOutlined />}
              onClick={onClose}
            />
          )}
        </Flex>
      </Flex>
      {body}
    </Flex>
  );
};

export default TeammateSkillsPanel;
