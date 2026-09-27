import type { AgorClient, Branch, Session, SessionID } from '@agor-live/client';
import { shortId } from '@agor-live/client';
import { PushpinFilled } from '@ant-design/icons';
import { Alert, Button, Descriptions, Popconfirm, Select, Space, Typography } from 'antd';
import { useMemo, useState } from 'react';
import { useConnectionDisabled } from '../../../contexts/ConnectionContext';
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
