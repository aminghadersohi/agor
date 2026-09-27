import type {
  AgorClient,
  Branch,
  FrontDeskRetiredReason,
  Session,
  SessionID,
  TeammateAddressingPreview,
} from '@agor-live/client';
import { shortId } from '@agor-live/client';
import { PushpinFilled } from '@ant-design/icons';
import { Alert, Button, Descriptions, Popconfirm, Select, Space, Typography } from 'antd';
import { useMemo, useState } from 'react';
import { useConnectionDisabled } from '../../../contexts/ConnectionContext';
import { useTeammateAddressingPreview } from '../../../hooks/useTeammateAddressingPreview';
import { useTeammateFrontDesk } from '../../../hooks/useTeammateFrontDesk';
import { getSessionDisplayTitle } from '../../../utils/sessionTitle';
import { Tag } from '../../Tag';

interface TeammateFrontDeskSectionProps {
  branch: Branch;
  client?: AgorClient | null;
  /** The teammate branch's sessions — the candidates for the desk. */
  sessions: Session[];
}

function sessionLabel(session: Session | undefined, sessionId: SessionID): string {
  if (!session) return `Session ${shortId(sessionId)}`;
  return getSessionDisplayTitle(session, { includeAgentFallback: true, includeIdFallback: true });
}

const SKIPPED_DESK_REASON: Record<FrontDeskRetiredReason, string> = {
  archived: 'it was archived',
  dead: 'its executor stopped',
  context: 'it was retiring with nothing in flight',
  replaced: 'it moved to another branch',
  manual: 'it was unpinned',
};

/** Who a message sent to this teammate by name would reach right now, for you. */
const AddressingPreview: React.FC<{
  preview: TeammateAddressingPreview | null;
  loading: boolean;
  label: (sessionId: SessionID) => string;
}> = ({ preview, loading, label }) => {
  if (!preview) {
    return (
      <Typography.Text type="secondary">{loading ? 'Checking…' : 'Unavailable'}</Typography.Text>
    );
  }
  if (preview.via === 'needs_session' || !preview.session_id) {
    return (
      <Typography.Text type="secondary" data-testid="front-desk-reaches">
        No active session — a message by name is refused until one is started
      </Typography.Text>
    );
  }
  const skipped = preview.bypassed_front_desk;
  return (
    <Space orientation="vertical" size={0}>
      <Space wrap>
        <Typography.Text data-testid="front-desk-reaches">
          {label(preview.session_id)}
        </Typography.Text>
        {preview.via === 'front_desk' ? <Tag color="blue">Front desk</Tag> : <Tag>Most recent</Tag>}
      </Space>
      {skipped && (
        <Typography.Text type="warning">
          The pinned session is skipped because {SKIPPED_DESK_REASON[skipped.reason]}.
        </Typography.Text>
      )}
    </Space>
  );
};

/** The name that reaches this teammate for you, or why none does. */
const AddressAs: React.FC<{ preview: TeammateAddressingPreview | null }> = ({ preview }) => {
  if (!preview) return <Typography.Text type="secondary">—</Typography.Text>;
  const naming = preview.name_addressing;
  return naming.addressable ? (
    <Typography.Text code copyable data-testid="front-desk-address">
      {naming.address}
    </Typography.Text>
  ) : (
    <Typography.Text type="secondary" data-testid="front-desk-address">
      Not addressable by name for you. {naming.detail}
    </Typography.Text>
  );
};

/**
 * View and change which session teammate addressing reaches. Pin/unpin are
 * shown only when the daemon reports the caller may manage the desk.
 */
export const TeammateFrontDeskSection: React.FC<TeammateFrontDeskSectionProps> = ({
  branch,
  client,
  sessions,
}) => {
  const disabled = useConnectionDisabled();
  const { view, error, loading, saving, pin, unpin } = useTeammateFrontDesk(client ?? null, branch);
  const [selected, setSelected] = useState<SessionID | undefined>(undefined);

  const sessionById = useMemo(
    () => new Map(sessions.map((session) => [session.session_id, session])),
    [sessions]
  );
  const desk = view?.front_desk ?? null;
  // Ask the daemon again whenever the pin or the set of active sessions moves.
  const activeSessionKey = sessions
    .filter((session) => !session.archived)
    .map((session) => session.session_id)
    .sort()
    .join(',');
  const addressing = useTeammateAddressingPreview(
    client ?? null,
    branch.archived ? null : branch.branch_id,
    `${desk?.session_id ?? ''}:${desk?.status ?? ''}:${activeSessionKey}`
  );
  const candidates = useMemo(
    () =>
      sessions
        .filter((session) => !session.archived && session.session_id !== desk?.session_id)
        .map((session) => ({
          value: session.session_id,
          label: sessionLabel(session, session.session_id),
        })),
    [sessions, desk?.session_id]
  );

  if (branch.archived) return null;

  const pinSelected = async () => {
    if (!selected) return;
    if (await pin(selected)) setSelected(undefined);
  };

  return (
    <Space orientation="vertical" size="small" style={{ width: '100%' }}>
      <Space>
        <PushpinFilled />
        <Typography.Text strong>Front desk</Typography.Text>
      </Space>
      <Typography.Text type="secondary">
        Messages addressed to this teammate by name reach the pinned session instead of the most
        recently active one. If the pinned session is archived or stops, they fall back to the most
        recent session.
      </Typography.Text>

      {error ? (
        <Alert type="warning" showIcon title={`Front desk unavailable: ${error.message}`} />
      ) : loading || !view ? (
        <Typography.Text type="secondary">Loading front desk…</Typography.Text>
      ) : (
        <>
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="Pinned session">
              {desk ? (
                <Space wrap>
                  <Typography.Text data-testid="front-desk-current">
                    {sessionLabel(sessionById.get(desk.session_id), desk.session_id)}
                  </Typography.Text>
                  {desk.status === 'retiring' && <Tag color="orange">Retiring</Tag>}
                  {view.can_manage && (
                    <Popconfirm
                      title="Unpin front desk?"
                      description="Messages will reach the teammate's most recently active session."
                      onConfirm={() => void unpin()}
                    >
                      <Button size="small" disabled={disabled || saving} loading={saving}>
                        Unpin
                      </Button>
                    </Popconfirm>
                  )}
                </Space>
              ) : (
                <Typography.Text type="secondary">
                  None — the most recently active session answers
                </Typography.Text>
              )}
            </Descriptions.Item>
            <Descriptions.Item label="Name addressing reaches">
              <AddressingPreview
                preview={addressing.preview}
                loading={addressing.loading}
                label={(sessionId) => sessionLabel(sessionById.get(sessionId), sessionId)}
              />
            </Descriptions.Item>
            <Descriptions.Item label="Address as">
              <AddressAs preview={addressing.preview} />
            </Descriptions.Item>
          </Descriptions>

          {view.can_manage ? (
            <Space.Compact style={{ width: '100%' }}>
              <Select
                aria-label="Session to pin as front desk"
                placeholder={
                  candidates.length > 0 ? 'Choose a session to pin' : 'No other active sessions'
                }
                value={selected}
                onChange={setSelected}
                options={candidates}
                disabled={disabled || saving || candidates.length === 0}
                showSearch={{ optionFilterProp: 'label' }}
                style={{ flex: 1 }}
              />
              <Button
                type="primary"
                icon={<PushpinFilled />}
                onClick={() => void pinSelected()}
                disabled={disabled || saving || !selected}
                loading={saving}
              >
                {desk ? 'Replace pin' : 'Pin'}
              </Button>
            </Space.Compact>
          ) : (
            <Typography.Text type="secondary">
              Only a Branch Manager can change the front desk.
            </Typography.Text>
          )}
        </>
      )}
    </Space>
  );
};
