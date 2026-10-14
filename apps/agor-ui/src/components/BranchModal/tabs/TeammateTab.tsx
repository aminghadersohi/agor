import type { AgorClient, Branch, Session } from '@agor-live/client';
import { getTeammateConfig } from '@agor-live/client';
import {
  Button,
  Descriptions,
  Drawer,
  Form,
  Grid,
  Input,
  Popconfirm,
  Space,
  Typography,
  theme,
} from 'antd';
import { useRef, useState } from 'react';
import { useConnectionDisabled } from '../../../contexts/ConnectionContext';
import {
  errorMessage,
  formatActionError,
  isInFlightConnectionLossError,
} from '../../../utils/connectionErrors';
import { useThemedMessage } from '../../../utils/message';
import { EmojiPickerInput } from '../../EmojiPickerInput/EmojiPickerInput';
import { ProfileImageGalleryEditor } from '../../ProfileImage';
import { Tag } from '../../Tag';
import { TeammateIdentityAvatar } from '../../TeammateIdentityAvatar';
import { TeammateSkillsPanel } from '../../TeammateSkillsPanel';
import type { TeammateFormState } from '../useBranchModalForm';
import { TeammateFrontDeskSection } from './TeammateFrontDeskSection';

const RETIRED_SUCCESS = 'Teammate retired; files preserved';
const NOT_ACTIVE_TEAMMATE = 'Retirement requires an active teammate';

interface TeammateTabProps {
  branch: Branch;
  client?: AgorClient | null;
  /** The teammate branch's sessions, offered as front-desk candidates. */
  sessions?: Session[];
  onRetired?: () => void;
  canEdit: boolean;
  state: TeammateFormState;
  setField: <K extends keyof TeammateFormState>(key: K, value: TeammateFormState[K]) => void;
}

export const TeammateTab: React.FC<TeammateTabProps> = ({
  branch,
  canEdit,
  state,
  setField,
  client,
  sessions = [],
  onRetired,
}) => {
  const { token } = theme.useToken();
  const [retiring, setRetiring] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const screens = Grid.useBreakpoint();
  // Stack labels above fields on narrow screens instead of squeezing a 6/18 grid.
  const compact = !screens.md;
  const labelCol = compact ? undefined : { span: 6 };
  const wrapperCol = compact ? undefined : { span: 18 };
  const disabled = useConnectionDisabled();
  const { showSuccess, showInfo, showError } = useThemedMessage();
  // The branch whose last retire lost its reply; a retry it then refuses means that one went through.
  const lostRetireFor = useRef<string | null>(null);
  const retire = async () => {
    if (!client) return;
    setRetiring(true);
    const branchId = branch.branch_id;
    try {
      await client.service(`branches/${branchId}/retire-teammate`).create({});
      lostRetireFor.current = null;
      showSuccess(RETIRED_SUCCESS);
      onRetired?.();
    } catch (error) {
      const ownReplay = lostRetireFor.current === branchId;
      lostRetireFor.current = isInFlightConnectionLossError(error) ? branchId : null;
      if (ownReplay && errorMessage(error) === NOT_ACTIVE_TEAMMATE) {
        showInfo(RETIRED_SUCCESS);
        onRetired?.();
        return;
      }
      showError(formatActionError('retire the teammate', error, { idempotent: true }));
    } finally {
      setRetiring(false);
    }
  };
  const config = getTeammateConfig(branch);
  if (!config) return null;

  return (
    <div style={{ width: '100%', maxHeight: '70vh', overflowY: 'auto' }}>
      <Space orientation="vertical" size="large" style={{ width: '100%' }}>
        <Space>
          <TeammateIdentityAvatar branch={branch} size={32} />
          <Typography.Text strong style={{ fontSize: token.fontSizeLG }}>
            Teammate configuration
          </Typography.Text>
        </Space>

        <ProfileImageGalleryEditor
          subject={{ type: 'teammate', id: branch.branch_id }}
          canEdit={canEdit}
          label="Teammate photos"
          activeTheme={config.activePhotoTheme}
        />

        {/* Editable fields */}
        <Form layout={compact ? 'vertical' : 'horizontal'} colon={false}>
          <Form.Item label="Display Name" labelCol={labelCol} wrapperCol={wrapperCol}>
            <Input
              value={state.displayName}
              onChange={(e) => setField('displayName', e.target.value)}
              placeholder="Teammate display name"
              disabled={!canEdit}
            />
          </Form.Item>
          <Form.Item label="Icon" labelCol={labelCol} wrapperCol={wrapperCol}>
            <EmojiPickerInput
              value={state.emoji}
              onChange={(val) => setField('emoji', val)}
              defaultEmoji="🤖"
              disabled={!canEdit}
            />
          </Form.Item>
          <Form.Item
            label="Description"
            labelCol={labelCol}
            wrapperCol={wrapperCol}
            tooltip="What does this AI teammate do? Visible to other agents via MCP."
          >
            <Input.TextArea
              value={state.description}
              onChange={(e) => setField('description', e.target.value)}
              placeholder="What does this AI teammate do?"
              rows={2}
              disabled={!canEdit}
            />
          </Form.Item>
        </Form>

        <TeammateFrontDeskSection branch={branch} client={client} sessions={sessions} />

        {/* Fork: read-only skills summary; the full view opens in a drawer. */}
        <TeammateSkillsPanel
          branch={branch}
          client={client ?? null}
          variant="compact"
          onOpenFull={() => setSkillsOpen(true)}
        />
        <Drawer
          open={skillsOpen}
          onClose={() => setSkillsOpen(false)}
          title={null}
          aria-label="Skills"
          closable={false}
          placement="right"
          size="min(736px, 100vw)"
          destroyOnHidden
          styles={{ body: { padding: 0 } }}
        >
          <TeammateSkillsPanel
            branch={branch}
            client={client ?? null}
            onClose={() => setSkillsOpen(false)}
          />
        </Drawer>

        {!branch.archived && (
          <Popconfirm
            title="Retire teammate?"
            description="Archives this teammate and clears personal primary preferences. Files are preserved. Reassign any board primary first."
            onConfirm={retire}
          >
            <Button danger disabled={!canEdit || !client || disabled} loading={retiring}>
              Retire teammate
            </Button>
          </Popconfirm>
        )}

        {/* Read-only metadata */}
        <Descriptions column={1} bordered size="small">
          {config.frameworkRepo && (
            <Descriptions.Item label="Framework Repo">
              <Typography.Text code>{config.frameworkRepo}</Typography.Text>
            </Descriptions.Item>
          )}
          {config.frameworkVersion && (
            <Descriptions.Item label="Framework Version">
              <Typography.Text code>{config.frameworkVersion}</Typography.Text>
            </Descriptions.Item>
          )}
          <Descriptions.Item label="Created via">
            {config.createdViaOnboarding ? (
              <Tag color="blue">Onboarding Wizard</Tag>
            ) : (
              <Tag>Manual</Tag>
            )}
          </Descriptions.Item>
        </Descriptions>
      </Space>
    </div>
  );
};
