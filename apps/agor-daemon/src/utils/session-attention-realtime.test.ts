import type { UserID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { tenantUserChannelName } from '../realtime/routing';
import { emitSessionAttentionAcknowledged } from './session-attention-realtime';

describe('session attention realtime', () => {
  it('targets only the acknowledging user room inside the current tenant', () => {
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const acknowledgement = {
      session_id: '018f0000-0000-7000-8000-000000000001' as never,
      attention_generation: 3,
      seen_attention_generation: 3,
    };

    emitSessionAttentionAcknowledged(
      { io: { to } } as never,
      'tenant-a',
      'user-a' as UserID,
      acknowledgement
    );

    expect(to).toHaveBeenCalledOnce();
    expect(to).toHaveBeenCalledWith(tenantUserChannelName('tenant-a', 'user-a'));
    expect(to).not.toHaveBeenCalledWith(tenantUserChannelName('tenant-a', 'user-b'));
    expect(to).not.toHaveBeenCalledWith(tenantUserChannelName('tenant-b', 'user-a'));
    expect(emit).toHaveBeenCalledWith('session-attention:acknowledged', acknowledgement);
  });
});
