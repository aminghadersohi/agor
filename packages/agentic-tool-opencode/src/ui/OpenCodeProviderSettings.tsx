import type { AgorClient } from '@agor/core/client';
import type {
  OpenCodeOAuthAttempt,
  OpenCodeOllamaDiscovery,
  OpenCodeProviderSettings as Settings,
} from '@agor/core/types';
import {
  Alert,
  AutoComplete,
  Button,
  Divider,
  Input,
  List,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  isActiveOAuthAttempt,
  OpenCodeProviderListItem,
  preferredOAuthMethodIndex,
  visibleAuthPrompts,
} from './OpenCodeProviderListItem';
import { publishOpenCodeConfiguration, useOpenCodeConfiguration } from './useOpenCodeConfiguration';
import { invalidateOpenCodeModelCatalog } from './useOpenCodeModelCatalog';

interface ProviderAction {
  generation: number;
  actionId: number;
}

const OLLAMA_STATUS_TONE: Record<
  OpenCodeOllamaDiscovery['status'],
  'default' | 'processing' | 'warning' | 'error' | 'success'
> = {
  unavailable: 'error',
  'service-reachable': 'processing',
  'model-missing': 'warning',
  'no-tools': 'error',
  'unsafe-context': 'error',
  ready: 'success',
};

const formatBytes = (bytes: number | undefined) =>
  bytes === undefined ? undefined : `${(bytes / 1024 ** 3).toFixed(1)} GB`;

function OllamaLocalProviderSettings({ client }: { client: AgorClient }) {
  const [discovery, setDiscovery] = useState<OpenCodeOllamaDiscovery>();
  const [enabled, setEnabled] = useState(false);
  const [endpoint, setEndpoint] = useState('http://127.0.0.1:11435');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void client
      .service('opencode-ollama')
      .find()
      .then((next) => {
        if (!mounted.current) return;
        // Older/test clients may not expose the new service yet. Keep native
        // provider management usable rather than interpreting another DTO.
        if (next?.providerId !== 'ollama' || !Array.isArray(next.models)) return;
        setDiscovery(next);
        setEnabled(next.configuration.enabled);
        setEndpoint(next.configuration.endpoint);
        setModel(next.configuration.model);
      })
      .catch(() => mounted.current && setError('Local Ollama settings could not be loaded.'));
    return () => {
      mounted.current = false;
    };
  }, [client]);

  const run = async (operation: () => Promise<OpenCodeOllamaDiscovery>) => {
    setBusy(true);
    setError(undefined);
    try {
      const next = await operation();
      if (!mounted.current) return;
      setDiscovery(next);
      setEndpoint(next.configuration.endpoint);
      setModel(next.configuration.model);
      invalidateOpenCodeModelCatalog(client);
    } catch (failure) {
      if (mounted.current) {
        setError(failure instanceof Error ? failure.message : 'The Ollama operation failed.');
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const selected = discovery?.models.find((candidate) => candidate.id === model);
  const modelDetails = selected
    ? [
        formatBytes(selected.sizeBytes),
        selected.contextTokens
          ? `${selected.contextTokens.toLocaleString()} max context`
          : undefined,
        selected.runningContextTokens
          ? `${selected.runningContextTokens.toLocaleString()} running context`
          : undefined,
        selected.tools ? 'tools' : 'no tools',
        selected.thinking ? 'thinking' : undefined,
        selected.vision ? 'vision' : undefined,
      ]
        .filter(Boolean)
        .join(' · ')
    : undefined;

  return (
    <Space orientation="vertical" size="small" style={{ width: '100%' }}>
      <Space wrap>
        <Typography.Text strong>Ollama (local via OpenCode)</Typography.Text>
        <Tag color="gold">Experimental</Tag>
        {discovery && <Tag color={OLLAMA_STATUS_TONE[discovery.status]}>{discovery.status}</Tag>}
      </Space>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 4 }}>
        Uses the existing OpenCode executor and a loopback-only Ollama service on the executor host.
        No API key is sent or required.
      </Typography.Paragraph>
      <Space>
        <Switch checked={enabled} onChange={setEnabled} />
        <Typography.Text>{enabled ? 'Enabled' : 'Disabled'}</Typography.Text>
      </Space>
      <Input
        aria-label="Ollama loopback endpoint"
        value={endpoint}
        onChange={(event) => setEndpoint(event.target.value)}
        placeholder="http://127.0.0.1:11435"
      />
      <AutoComplete
        aria-label="Exact Ollama model"
        value={model}
        options={(discovery?.models ?? []).map((candidate) => ({
          value: candidate.id,
          label: `${candidate.name}${candidate.tools ? '' : ' · no tools'}`,
        }))}
        onChange={setModel}
        placeholder="Exact model ID, e.g. qwen3-coder:30b"
        style={{ width: '100%' }}
        filterOption={(input, option) =>
          String(option?.value ?? '')
            .toLowerCase()
            .includes(input.toLowerCase())
        }
      />
      {modelDetails && <Typography.Text type="secondary">{modelDetails}</Typography.Text>}
      {discovery && (
        <Alert
          type={discovery.status === 'ready' ? 'success' : 'info'}
          showIcon
          title={discovery.message}
        />
      )}
      {error && <Alert type="error" showIcon title={error} />}
      <Space wrap>
        <Button
          loading={busy}
          onClick={() =>
            void run(() => client.service('opencode-ollama').create({ endpoint, model }))
          }
        >
          Test connection
        </Button>
        <Button
          type="primary"
          loading={busy}
          disabled={enabled && !model.trim()}
          onClick={() =>
            void run(async () => {
              const next = await client
                .service('opencode-ollama')
                .patch(null, { enabled, endpoint, model });
              setEnabled(next.configuration.enabled);
              return next;
            })
          }
        >
          Save local provider
        </Button>
      </Space>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        Provider ID is always <code>ollama</code>. Agor admits tools-capable models only, fixes the
        context budget at 32,768 tokens, and permits one local runner at a time.
      </Typography.Text>
    </Space>
  );
}

function providerListEmptyText(settings: Settings | null, error: string | undefined): string {
  if (error) return 'No provider status available';
  return settings ? 'Choose a provider to connect' : 'Loading providers';
}

function pollOAuthAttempt(input: {
  client: AgorClient;
  attemptId: string;
  ownsSelection: () => boolean;
  currentAttempt: () => OpenCodeOAuthAttempt | undefined;
  isCancelling: () => boolean;
  onResult: (attempt: OpenCodeOAuthAttempt) => void;
  onError: () => void;
}): () => void {
  let disposed = false;
  let timer: number | undefined;
  const remainsActive = () => {
    const attempt = input.currentAttempt();
    return attempt?.attemptId === input.attemptId && isActiveOAuthAttempt(attempt);
  };
  const schedule = () => {
    timer = window.setTimeout(async () => {
      timer = undefined;
      if (disposed || !input.ownsSelection() || !remainsActive()) return;
      if (input.isCancelling()) {
        schedule();
        return;
      }
      try {
        const next = await input.client.service('opencode-auth').get(input.attemptId);
        if (
          !disposed &&
          input.ownsSelection() &&
          !input.isCancelling() &&
          remainsActive() &&
          next.attemptId === input.attemptId
        ) {
          input.onResult(next);
        }
      } catch {
        if (!disposed && input.ownsSelection() && !input.isCancelling() && remainsActive()) {
          input.onError();
        }
      } finally {
        if (!disposed && input.ownsSelection() && remainsActive()) schedule();
      }
    }, 1000);
  };
  schedule();
  return () => {
    disposed = true;
    if (timer !== undefined) window.clearTimeout(timer);
  };
}

export function OpenCodeProviderSettings({
  client,
  copyText,
}: {
  client: AgorClient;
  copyText: (text: string) => Promise<boolean>;
}) {
  const {
    configuration: settings,
    loading,
    loadFailed,
    retry,
  } = useOpenCodeConfiguration({ client, enabled: true });
  const [selectedProviderId, setSelectedProviderId] = useState<string>();
  const [apiKey, setApiKey] = useState('');
  const [selectedMethodIndex, setSelectedMethodIndex] = useState<number>();
  const [promptValues, setPromptValues] = useState<Record<string, string>>({});
  const [oauthAttempts, setOAuthAttempts] = useState<Record<string, OpenCodeOAuthAttempt>>({});
  const oauthAttemptsRef = useRef<Record<string, OpenCodeOAuthAttempt>>({});
  const cancellingAttemptsRef = useRef(new Set<string>());
  const [oauthCode, setOAuthCode] = useState('');
  const [busyProvider, setBusyProvider] = useState<string>();
  const [error, setError] = useState<string>();
  const actionIdRef = useRef(0);
  const mountedRef = useRef(false);
  const selectedProviderRef = useRef<string | undefined>(undefined);
  const selectionGenerationRef = useRef(0);
  const scopeRef = useRef({ client, generation: 0 });
  if (scopeRef.current.client !== client) {
    scopeRef.current = {
      client,
      generation: scopeRef.current.generation + 1,
    };
  }
  const scopeGeneration = scopeRef.current.generation;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      actionIdRef.current += 1;
    };
  }, []);
  const isCurrentScope = useCallback(
    (generation: number) => mountedRef.current && scopeRef.current.generation === generation,
    []
  );
  const beginAction = useCallback((providerId: string, generation: number): ProviderAction => {
    const action = { generation, actionId: ++actionIdRef.current };
    setBusyProvider(providerId);
    setError(undefined);
    return action;
  }, []);
  const isCurrentAction = useCallback(
    (action: ProviderAction) =>
      isCurrentScope(action.generation) && actionIdRef.current === action.actionId,
    [isCurrentScope]
  );
  const publishSettings = useCallback(
    (next: Settings) => {
      publishOpenCodeConfiguration(client, next);
      invalidateOpenCodeModelCatalog(client);
    },
    [client]
  );
  const updateSelectedProvider = useCallback((providerId: string | undefined) => {
    if (selectedProviderRef.current === providerId) return false;
    selectedProviderRef.current = providerId;
    selectionGenerationRef.current += 1;
    actionIdRef.current += 1;
    setSelectedProviderId(providerId);
    setBusyProvider(undefined);
    return true;
  }, []);
  const isCurrentSelection = useCallback(
    (generation: number, selectionGeneration: number, providerId: string) =>
      isCurrentScope(generation) &&
      selectionGenerationRef.current === selectionGeneration &&
      selectedProviderRef.current === providerId,
    [isCurrentScope]
  );

  const clearFormState = useCallback(() => {
    setApiKey('');
    setSelectedMethodIndex(undefined);
    setPromptValues({});
    setOAuthCode('');
  }, []);

  const storeAttempt = useCallback(
    (providerId: string, attempt: OpenCodeOAuthAttempt, generation: number) => {
      if (!isCurrentScope(generation)) return false;
      oauthAttemptsRef.current = { ...oauthAttemptsRef.current, [providerId]: attempt };
      setOAuthAttempts(oauthAttemptsRef.current);
      return true;
    },
    [isCurrentScope]
  );

  useEffect(() => {
    if (!isCurrentScope(scopeGeneration)) return;
    updateSelectedProvider(undefined);
    clearFormState();
    oauthAttemptsRef.current = {};
    setOAuthAttempts({});
    cancellingAttemptsRef.current.clear();
    setBusyProvider(undefined);
    setError(undefined);
  }, [clearFormState, isCurrentScope, scopeGeneration, updateSelectedProvider]);

  useEffect(() => {
    const generation = scopeGeneration;
    const selectionGeneration = selectionGenerationRef.current;
    const actionId = actionIdRef.current;
    if (!selectedProviderId || busyProvider) return;
    const attempt = oauthAttempts[selectedProviderId];
    if (!attempt || !isActiveOAuthAttempt(attempt)) return;

    const ownsSelection = () =>
      actionIdRef.current === actionId &&
      isCurrentSelection(generation, selectionGeneration, selectedProviderId);
    return pollOAuthAttempt({
      client,
      attemptId: attempt.attemptId,
      ownsSelection,
      currentAttempt: () => oauthAttemptsRef.current[selectedProviderId],
      isCancelling: () => cancellingAttemptsRef.current.has(attempt.attemptId),
      onResult: (next) => {
        storeAttempt(selectedProviderId, next, generation);
        if (next.phase === 'configured' && next.settings) {
          publishSettings(next.settings);
        }
      },
      onError: () => setError('OpenCode authorization status could not be refreshed.'),
    });
  }, [
    busyProvider,
    client,
    isCurrentSelection,
    oauthAttempts,
    scopeGeneration,
    selectedProviderId,
    storeAttempt,
    publishSettings,
  ]);

  const connectableProviders = useMemo(
    () => settings?.providers.filter((provider) => provider.credentialPresence !== 'present') ?? [],
    [settings]
  );
  const selectedProvider = connectableProviders.find(
    (provider) => provider.id === selectedProviderId
  );
  const visibleProviders =
    settings?.providers.filter(
      (provider) =>
        provider.credentialPresence === 'present' ||
        provider.runtimeAvailable ||
        provider.id === selectedProvider?.id
    ) ?? [];

  useEffect(() => {
    if (!settings) return;
    if (
      selectedProviderId &&
      !settings.providers.some(
        (provider) =>
          provider.id === selectedProviderId && provider.credentialPresence !== 'present'
      )
    ) {
      updateSelectedProvider(undefined);
      clearFormState();
      return;
    }
    if (!selectedProviderId && connectableProviders.length === 1) {
      updateSelectedProvider(connectableProviders[0].id);
    }
  }, [clearFormState, connectableProviders, selectedProviderId, settings, updateSelectedProvider]);

  const selectProvider = (providerId: string | undefined) => {
    if (!updateSelectedProvider(providerId)) return;
    clearFormState();
    setError(undefined);
  };

  const runProviderAction = async <T,>(
    providerId: string,
    failureMessage: string,
    operation: () => Promise<T>,
    onSuccess: (result: T, generation: number) => void
  ) => {
    const action = beginAction(providerId, scopeGeneration);
    try {
      const result = await operation();
      if (isCurrentAction(action)) onSuccess(result, action.generation);
    } catch {
      if (isCurrentAction(action)) setError(failureMessage);
    } finally {
      if (isCurrentAction(action)) setBusyProvider(undefined);
    }
  };

  const connect = async (providerId: string) => {
    const trimmedApiKey = apiKey.trim();
    if (!trimmedApiKey) return;
    const provider = settings?.providers.find((candidate) => candidate.id === providerId);
    if (!provider) return;
    const methodPosition = selectedMethodIndex ?? preferredOAuthMethodIndex(provider.authMethods);
    const method = provider.authMethods[methodPosition];
    if (method && method.type !== 'api') return;
    const visiblePrompts = visibleAuthPrompts(method?.prompts, promptValues);
    if (visiblePrompts.some((prompt) => !promptValues[prompt.key]?.trim())) return;
    const metadata = Object.fromEntries(
      visiblePrompts.map((prompt) => [prompt.key, promptValues[prompt.key].trim()])
    );
    await runProviderAction(
      providerId,
      'OpenCode could not configure that provider.',
      () =>
        client.service('opencode-auth').create({
          providerId,
          apiKey: trimmedApiKey,
          ...(Object.keys(metadata).length ? { metadata } : {}),
        }) as Promise<Settings>,
      (next) => {
        publishSettings(next);
        setApiKey('');
        setPromptValues({});
      }
    );
  };

  const connectOAuth = async (providerId: string) => {
    const provider = settings?.providers.find((candidate) => candidate.id === providerId);
    if (!provider) return;
    const methodPosition = selectedMethodIndex ?? preferredOAuthMethodIndex(provider.authMethods);
    const method = provider.authMethods[methodPosition];
    if (method?.type !== 'oauth') return;
    const visiblePrompts = visibleAuthPrompts(method.prompts, promptValues);
    if (visiblePrompts.some((prompt) => !promptValues[prompt.key]?.trim())) return;
    const inputs = Object.fromEntries(
      visiblePrompts.map((prompt) => [prompt.key, promptValues[prompt.key].trim()])
    );
    await runProviderAction(
      providerId,
      'OpenCode could not start native authorization.',
      () =>
        client.service('opencode-auth').create({
          operation: 'connect-oauth',
          providerId,
          method: method.index,
          ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
        }) as Promise<OpenCodeOAuthAttempt>,
      (attempt, generation) => {
        if (!storeAttempt(providerId, attempt, generation)) return;
        if (attempt.phase === 'configured' && attempt.settings) {
          publishSettings(attempt.settings);
        }
      }
    );
  };

  const cancelOAuth = async (providerId: string) => {
    const attempt = oauthAttempts[providerId];
    if (!attempt) return;
    cancellingAttemptsRef.current.add(attempt.attemptId);
    try {
      await runProviderAction(
        providerId,
        'OpenCode authorization could not be cancelled.',
        () => client.service('opencode-auth').patch(attempt.attemptId, { cancel: true }),
        (cancelled, generation) => {
          if (oauthAttemptsRef.current[providerId]?.attemptId === attempt.attemptId) {
            storeAttempt(providerId, cancelled, generation);
          }
        }
      );
    } finally {
      cancellingAttemptsRef.current.delete(attempt.attemptId);
    }
  };

  const submitOAuthCode = async (providerId: string) => {
    const attempt = oauthAttemptsRef.current[providerId];
    const code = oauthCode.trim();
    if (!attempt || !code) return;
    setOAuthCode('');
    await runProviderAction(
      providerId,
      'OpenCode authorization code could not be submitted.',
      () => client.service('opencode-auth').patch(attempt.attemptId, { code }),
      (next, generation) => {
        if (oauthAttemptsRef.current[providerId]?.attemptId === attempt.attemptId) {
          storeAttempt(providerId, next, generation);
        }
      }
    );
  };

  const disconnect = async (providerId: string) => {
    await runProviderAction(
      providerId,
      'OpenCode could not disconnect that provider.',
      () => client.service('opencode-auth').remove(providerId),
      publishSettings
    );
  };

  return (
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
      <OllamaLocalProviderSettings client={client} />
      <Divider style={{ margin: '8px 0' }} />
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        Connect providers through native API-key or subscription authorization in the managed
        OpenCode runtime.
      </Typography.Paragraph>
      {settings && (
        <Alert
          type="warning"
          showIcon
          title="Credentials use logical namespaces in the daemon credential home."
          description="This is not a host-account boundary. Use sandbox filesystem policy or a reviewed external substrate for untrusted users."
        />
      )}
      {(error || loadFailed) && (
        <Alert
          type="error"
          showIcon
          title={error ?? 'OpenCode provider settings could not be loaded.'}
          {...(!error && loadFailed
            ? {
                action: (
                  <Button size="small" onClick={() => void retry()}>
                    Retry
                  </Button>
                ),
              }
            : {})}
        />
      )}
      <Select
        allowClear
        showSearch
        aria-label="Provider to connect"
        placeholder="Search for a provider to connect"
        value={selectedProviderId}
        optionFilterProp="searchText"
        options={connectableProviders.map((provider) => ({
          value: provider.id,
          label: provider.name,
          searchText: `${provider.name} ${provider.id}`,
        }))}
        onChange={selectProvider}
        style={{ width: '100%' }}
      />
      <List
        loading={loading && !settings}
        dataSource={visibleProviders}
        locale={{
          emptyText: providerListEmptyText(settings, error ?? (loadFailed ? 'failed' : undefined)),
        }}
        renderItem={(provider) => (
          <OpenCodeProviderListItem
            provider={provider}
            copyText={copyText}
            selected={provider.id === selectedProviderId}
            selectedMethodIndex={selectedMethodIndex}
            promptValues={promptValues}
            apiKey={apiKey}
            oauthCode={oauthCode}
            oauthAttempt={oauthAttempts[provider.id]}
            busy={busyProvider === provider.id}
            onConnect={() => connect(provider.id)}
            onConnectOAuth={() => connectOAuth(provider.id)}
            onCancelOAuth={() => cancelOAuth(provider.id)}
            onDisconnect={() => disconnect(provider.id)}
            onSubmitOAuthCode={() => void submitOAuthCode(provider.id)}
            onMethodChange={(index) => {
              setSelectedMethodIndex(index);
              setApiKey('');
              setPromptValues({});
              setOAuthCode('');
            }}
            onPromptChange={(key, value) =>
              setPromptValues((current) => ({ ...current, [key]: value }))
            }
            onApiKeyChange={setApiKey}
            onOAuthCodeChange={setOAuthCode}
          />
        )}
      />
      {settings && (
        <Typography.Text type="secondary">
          Managed OpenCode runtime {settings.runtimeVersion}
        </Typography.Text>
      )}
    </Space>
  );
}
