import type { AgorClient, Session, SessionID } from '@agor-live/client';
import { shortId } from '@agor-live/client';
import { Button, Flex, Select, Typography } from 'antd';
import { useMemo, useState } from 'react';
import { useSessionActions } from '../../hooks/useSessionActions';
import { useAgorStore } from '../../store/agorStore';
import { makeSessionsForBranchSelector, selectSessionById } from '../../store/selectors';
import { useThemedMessage } from '../../utils/message';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';

const ROOT_VALUE = '__root__';

function sessionOption(session: Session) {
  return {
    value: session.session_id,
    label: `${getSessionDisplayTitle(session, { includeAgentFallback: true })} · ${shortId(session.session_id)}`,
  };
}

/** Sessions whose genealogy chain reaches `rootId` — choosing one as parent would form a cycle. */
function descendantIds(rootId: string, branchSessions: Session[]): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const s of branchSessions) {
    const parent = s.genealogy?.parent_session_id;
    if (!parent) continue;
    childrenByParent.set(parent, [...(childrenByParent.get(parent) ?? []), s.session_id]);
  }
  const found = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    for (const child of childrenByParent.get(stack.pop()!) ?? []) {
      if (!found.has(child)) {
        found.add(child);
        stack.push(child);
      }
    }
  }
  return found;
}

export interface SessionRoutingControlsProps {
  client: AgorClient;
  session: Session;
}

/**
 * Human controls for the two transfers agents already have over MCP:
 * move the standing completion callback (routing) and change the branch-local
 * parent (genealogy). Candidates come from the sessions this viewer already
 * has loaded; the server re-checks authority, tenant, branch and cycles.
 */
export function SessionRoutingControls({ client, session }: SessionRoutingControlsProps) {
  const { retargetCallback, reparentSession } = useSessionActions(client);
  const { showError, showSuccess } = useThemedMessage();
  const sessionById = useAgorStore(selectSessionById);
  const branchSessions =
    useAgorStore(
      useMemo(() => makeSessionsForBranchSelector(session.branch_id), [session.branch_id])
    ) ?? [];
  const [editing, setEditing] = useState<'callback' | 'parent' | null>(null);
  const [choice, setChoice] = useState<string>();
  const [saving, setSaving] = useState(false);

  const hasStandingCallback =
    !!session.callback_config?.callback_session_id ||
    !!session.remote_relationships?.as_target?.some(
      (relationship) => relationship.relationship_type === 'remote_create'
    );

  const callbackOptions = useMemo(
    () =>
      editing === 'callback'
        ? [...sessionById.values()]
            .filter((s) => !s.archived && s.session_id !== session.session_id)
            .map(sessionOption)
        : [],
    [editing, sessionById, session.session_id]
  );

  const parentOptions = useMemo(() => {
    if (editing !== 'parent') return [];
    const excluded = descendantIds(session.session_id, branchSessions);
    return [
      { value: ROOT_VALUE, label: 'No parent (make this a root session)' },
      ...branchSessions
        .filter(
          (s) => !s.archived && s.session_id !== session.session_id && !excluded.has(s.session_id)
        )
        .map(sessionOption),
    ];
  }, [editing, branchSessions, session.session_id]);

  const start = (mode: 'callback' | 'parent') => {
    setEditing(mode);
    setChoice(undefined);
  };

  const apply = async () => {
    if (!editing || !choice) return;
    setSaving(true);
    try {
      if (editing === 'callback') {
        await retargetCallback(session.session_id, choice as SessionID);
        showSuccess('Callback target changed');
      } else {
        await reparentSession(
          session.session_id,
          choice === ROOT_VALUE ? null : (choice as SessionID)
        );
        showSuccess(choice === ROOT_VALUE ? 'Session is now a root session' : 'Parent changed');
      }
      setEditing(null);
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Change failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <Flex gap={8} wrap>
        {hasStandingCallback && (
          <Button size="small" onClick={() => start('callback')} disabled={saving}>
            Change callback target…
          </Button>
        )}
        <Button size="small" onClick={() => start('parent')} disabled={saving}>
          Change parent…
        </Button>
      </Flex>
      {editing && (
        <Flex vertical gap={8} style={{ marginTop: 8 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {editing === 'callback'
              ? 'Moves where this session reports on completion. Its parent is unchanged, and callbacks already requested for a specific task keep their original destination.'
              : 'Changes only the parent in this branch’s session tree. The callback target is unchanged. The new parent must be in the same branch.'}
          </Typography.Text>
          <Select
            showSearch
            aria-label={editing === 'callback' ? 'New callback target' : 'New parent session'}
            placeholder={editing === 'callback' ? 'Choose a session' : 'Choose a parent'}
            optionFilterProp="label"
            options={editing === 'callback' ? callbackOptions : parentOptions}
            value={choice}
            onChange={setChoice}
            disabled={saving}
          />
          <Flex gap={8}>
            <Button type="primary" size="small" onClick={apply} loading={saving} disabled={!choice}>
              {editing === 'callback' ? 'Move callback' : 'Change parent'}
            </Button>
            <Button size="small" onClick={() => setEditing(null)} disabled={saving}>
              Cancel
            </Button>
          </Flex>
        </Flex>
      )}
    </div>
  );
}
