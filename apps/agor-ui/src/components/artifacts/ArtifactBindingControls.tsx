import type {
  ArtifactActionBinding,
  ArtifactActionEffect,
  ArtifactDataResult,
  ArtifactInteractionConfig,
} from '@agor-live/client';
import { MessageOutlined } from '@ant-design/icons';
import { App, Button, Flex, Tag, Tooltip, theme } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchArtifactDataBinding, runArtifactActionBinding } from '@/utils/artifactActions';
import { useThemedMessage } from '@/utils/message';

type ModalApi = ReturnType<typeof App.useApp>['modal'];

/**
 * Fired after any declared action succeeds, from the controls or from the
 * artifact's own `window.agor.runAction`, so every surface showing the
 * artifact's data bindings can refresh.
 */
export const ARTIFACT_BINDING_ACTION_EVENT = 'agor:artifact-binding-action';

export function notifyArtifactBindingAction(artifactId: string): void {
  window.dispatchEvent(new CustomEvent(ARTIFACT_BINDING_ACTION_EVENT, { detail: { artifactId } }));
}

function describeEffect(effect: ArtifactActionEffect): string {
  if (effect.kind === 'schedule_run') {
    return 'This starts a new agent session using the configured schedule.';
  }
  return effect.enabled
    ? 'This enables the configured schedule so it runs on its cron.'
    : 'This disables the configured schedule; it will stop running on its cron.';
}

function describeSuccess(action: ArtifactActionBinding): string {
  if (action.effect.kind === 'schedule_run') return `“${action.label}” started a session`;
  return `“${action.label}” ${action.effect.enabled ? 'enabled' : 'disabled'} the schedule`;
}

/**
 * Parent-page confirmation for an action declared with `confirm: true`.
 * Rendered outside the iframe, so artifact code can neither draw nor dismiss it.
 */
export function confirmArtifactAction(
  modal: ModalApi,
  action: ArtifactActionBinding
): Promise<boolean> {
  return new Promise((resolve) => {
    modal.confirm({
      title: `Run “${action.label}”?`,
      content: action.description || describeEffect(action.effect),
      okText: 'Run action',
      cancelText: 'Cancel',
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

function formatTime(ms: number | null | undefined): string {
  return ms ? new Date(ms).toLocaleString() : 'never';
}

function summarizeData(result: ArtifactDataResult): { text: string; detail: string; on?: boolean } {
  if (result.kind === 'schedule_status') {
    return {
      text: result.enabled ? 'Armed' : 'Disarmed',
      detail: `${result.name} · ${result.cron_expression} · next ${formatTime(result.next_run_at)} · last ${formatTime(result.last_run_at)}`,
      on: result.enabled,
    };
  }
  return {
    text: result.archived ? 'Archived' : result.status,
    detail: result.title ?? result.session_id,
  };
}

type DataState = { result: ArtifactDataResult } | { error: string };

/**
 * An artifact's declared bindings, rendered by Agor rather than by the
 * artifact: status for each data binding, a button per action, a button per
 * chat. Every control goes through the same artifact-scoped routes as
 * `window.agor`, with the viewer's own credentials, so it can do nothing the
 * viewer could not do by hand.
 */
export function ArtifactBindingControls({
  artifactId,
  config,
  onOpenSession,
  className,
}: {
  artifactId: string;
  config?: ArtifactInteractionConfig;
  onOpenSession?: (sessionId: string) => void;
  className?: string;
}) {
  const { token } = theme.useToken();
  const { modal } = App.useApp();
  const { showSuccess, showError } = useThemedMessage();
  const [data, setData] = useState<Record<string, DataState>>({});
  const [running, setRunning] = useState<string | null>(null);
  const refreshSeq = useRef(0);
  const dataBindings = config?.data;

  const refresh = useCallback(async () => {
    const seq = ++refreshSeq.current;
    if (!dataBindings?.length) return;
    const entries = await Promise.all(
      dataBindings.map(async (binding): Promise<[string, DataState]> => {
        try {
          return [binding.id, { result: await fetchArtifactDataBinding(artifactId, binding.id) }];
        } catch (error) {
          return [binding.id, { error: error instanceof Error ? error.message : 'Unavailable' }];
        }
      })
    );
    // A newer refresh (or unmount) supersedes this one.
    if (seq === refreshSeq.current) setData(Object.fromEntries(entries));
  }, [artifactId, dataBindings]);

  useEffect(() => {
    void refresh();
    return () => {
      refreshSeq.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    const handler = (event: Event) => {
      if ((event as CustomEvent<{ artifactId?: string }>).detail?.artifactId === artifactId) {
        void refresh();
      }
    };
    window.addEventListener(ARTIFACT_BINDING_ACTION_EVENT, handler);
    return () => window.removeEventListener(ARTIFACT_BINDING_ACTION_EVENT, handler);
  }, [artifactId, refresh]);

  const runAction = async (action: ArtifactActionBinding) => {
    if (action.confirm && !(await confirmArtifactAction(modal, action))) return;
    setRunning(action.id);
    try {
      await runArtifactActionBinding(artifactId, action.id);
      showSuccess(describeSuccess(action));
      notifyArtifactBindingAction(artifactId);
    } catch (error) {
      showError(
        `“${action.label}” failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setRunning(null);
    }
  };

  const actions = config?.actions ?? [];
  const chats = onOpenSession ? (config?.chats ?? []) : [];
  if (!dataBindings?.length && actions.length === 0 && chats.length === 0) return null;

  return (
    <Flex
      role="toolbar"
      aria-label="Artifact controls"
      className={className}
      wrap
      align="center"
      gap={token.marginXS}
      style={{
        padding: `${token.paddingXXS}px ${token.paddingXS}px`,
        borderTop: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      {dataBindings?.map((binding) => {
        const state = data[binding.id];
        const summary = state && 'result' in state ? summarizeData(state.result) : null;
        const text = summary?.text ?? (state ? 'Unavailable' : 'Loading…');
        const detail =
          summary?.detail ?? (state && 'error' in state ? state.error : binding.description);
        return (
          <Tooltip key={`data-${binding.id}`} title={detail}>
            <Tag color={summary?.on ? 'success' : undefined} style={{ marginInlineEnd: 0 }}>
              {binding.label}: {text}
            </Tag>
          </Tooltip>
        );
      })}
      {actions.map((action) => (
        <Tooltip key={`action-${action.id}`} title={action.description}>
          <Button
            size="small"
            loading={running === action.id}
            disabled={running !== null && running !== action.id}
            onClick={(event) => {
              event.stopPropagation();
              void runAction(action);
            }}
          >
            {action.label}
          </Button>
        </Tooltip>
      ))}
      {chats.map((chat) => (
        <Tooltip key={`chat-${chat.id}`} title={chat.description}>
          <Button
            size="small"
            icon={<MessageOutlined />}
            onClick={(event) => {
              event.stopPropagation();
              onOpenSession?.(chat.session_id);
            }}
          >
            {chat.label}
          </Button>
        </Tooltip>
      ))}
    </Flex>
  );
}
