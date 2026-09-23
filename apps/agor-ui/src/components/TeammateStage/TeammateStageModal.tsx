import type { Branch } from '@agor-live/client';
import { getTeammateConfig } from '@agor-live/client';
import {
  useProfileIdentityModel,
  useProfileImageGallery,
  useProfileImageUrl,
} from '../ProfileImage';
import { AdaptiveSettingsModal } from '../SettingsModal/AdaptiveSettingsModal';
import { TeammateStage } from './TeammateStage';

interface TeammateStageModalProps {
  branch: Branch;
  open: boolean;
  onClose: () => void;
}

export function TeammateStageModal({ branch, open, onClose }: TeammateStageModalProps) {
  const config = getTeammateConfig(branch);
  const gallery = useProfileImageGallery({ type: 'teammate', id: branch.branch_id }, open);
  const sourceImage =
    gallery.find((image) => image.image_id === config?.profileImageId) ??
    gallery.find((image) => image.is_primary) ??
    gallery[0];
  const imageUrl = useProfileImageUrl(sourceImage?.image_id, 'large');
  const identity = useProfileIdentityModel(sourceImage, open);
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
      <TeammateStage
        name={name}
        imageUrl={imageUrl}
        modelUrl={identity.modelUrl}
        identityModel={identity.identityModel}
        emoji={config?.emoji}
        active={open}
        generating={identity.generating}
        generationError={identity.error}
        onGenerate={sourceImage ? identity.generate : undefined}
      />
    </AdaptiveSettingsModal>
  );
}
