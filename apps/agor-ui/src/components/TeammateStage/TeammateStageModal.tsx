import type { Branch } from '@agor-live/client';
import { getTeammateConfig } from '@agor-live/client';
import { useTeammateProfileImageUrl } from '../ProfileImage';
import { AdaptiveSettingsModal } from '../SettingsModal/AdaptiveSettingsModal';
import { TeammateStage } from './TeammateStage';

interface TeammateStageModalProps {
  branch: Branch;
  open: boolean;
  onClose: () => void;
}

export function TeammateStageModal({ branch, open, onClose }: TeammateStageModalProps) {
  const config = getTeammateConfig(branch);
  const imageUrl = useTeammateProfileImageUrl(branch, 'large');
  const name = config?.displayName || branch.name;

  return (
    <AdaptiveSettingsModal
      open={open}
      title={`${name} · 3D stage`}
      onCancel={onClose}
      footer={null}
      width={920}
      destroyOnHidden
    >
      <TeammateStage name={name} imageUrl={imageUrl} emoji={config?.emoji} active={open} />
    </AdaptiveSettingsModal>
  );
}
