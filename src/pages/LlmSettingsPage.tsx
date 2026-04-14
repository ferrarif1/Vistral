import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LlmConfig, LlmConfigView } from '../../shared/domain';
import AdvancedSection from '../components/AdvancedSection';
import WorkspaceOnboardingCard from '../components/onboarding/WorkspaceOnboardingCard';
import WorkspaceNextStepCard from '../components/onboarding/WorkspaceNextStepCard';
import StateBlock from '../components/StateBlock';
import SettingsTabs from '../components/settings/SettingsTabs';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { FilterToolbar, InlineAlert, KPIStatRow, PageHeader } from '../components/ui/ConsolePage';
import WorkspaceActionPanel from '../components/ui/WorkspaceActionPanel';
import WorkspaceActionStack from '../components/ui/WorkspaceActionStack';
import { Checkbox, Input } from '../components/ui/Field';
import { Card, Panel } from '../components/ui/Surface';
import {
  WorkspacePage,
  WorkspaceSectionHeader,
  WorkspaceWorkbench
} from '../components/ui/WorkspacePage';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';
import {
  DEFAULT_LLM_CONFIG,
  emitLlmConfigUpdated,
  normalizeLlmConfig
} from '../services/llmConfig';

const CHATANYWHERE_MODEL_PRESETS = ['gpt-4o-mini', 'gpt-4.1-mini'] as const;
const llmOnboardingDismissedStorageKey = 'vistral-llm-onboarding-dismissed';

const resolveConnectionAdvice = (
  message: string,
  t: (source: string, vars?: Record<string, string | number>) => string
): string => {
  const lower = message.toLowerCase();

  if (lower.includes('(401') || lower.includes('unauthorized') || lower.includes('invalid api key')) {
    return t('API key appears invalid or expired. Re-copy key and retry.');
  }

  if (lower.includes('(403') || lower.includes('forbidden')) {
    return t('Current key may not access this model. Try gpt-4o-mini first.');
  }

  if (lower.includes('(429') || lower.includes('rate limit') || lower.includes('quota')) {
    return t('Rate limit reached. Wait and retry, or switch to a lower-cost model.');
  }

  if (lower.includes('(404') || lower.includes('not found')) {
    return t('Endpoint or model not found. Check Base URL and model name.');
  }

  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('etimedout')) {
    return t('Connection timed out. Retry later or use a more stable network.');
  }

  return t('Apply ChatAnywhere preset and test with gpt-4o-mini.');
};

const buildEditableForm = (current: LlmConfigView): LlmConfig => ({
  enabled: current.enabled,
  provider: 'chatanywhere',
  base_url: current.base_url,
  api_key: '',
  model: current.model,
  temperature: current.temperature
});

export default function LlmSettingsPage() {
  const { t } = useI18n();
  const [form, setForm] = useState<LlmConfig>({ ...DEFAULT_LLM_CONFIG });
  const [savedConfig, setSavedConfig] = useState<LlmConfigView | null>(null);
  const [status, setStatus] = useState<{ variant: 'success' | 'error'; text: string } | null>(null);
  const [connectionAdvice, setConnectionAdvice] = useState('');
  const [testing, setTesting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [apiKeyMasked, setApiKeyMasked] = useState('Not set');
  const [hasApiKey, setHasApiKey] = useState(false);
  const [connectionVerified, setConnectionVerified] = useState(false);
  const configurationRef = useRef<HTMLDivElement | null>(null);

  const refresh = async () => {
    const current = await api.getLlmConfig();
    setSavedConfig(current);
    setForm(buildEditableForm(current));
    setApiKeyMasked(current.api_key_masked);
    setHasApiKey(current.has_api_key);
  };

  useEffect(() => {
    setLoading(true);
    refresh()
      .catch((error) => {
        setStatus({ variant: 'error', text: (error as Error).message });
      })
      .finally(() => setLoading(false));
  }, []);

  const update = <K extends keyof LlmConfig>(key: K, value: LlmConfig[K]) => {
    setConnectionVerified(false);
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const normalizedForm = useMemo(() => normalizeLlmConfig(form), [form]);
  const hasTypedApiKey = normalizedForm.api_key.trim().length > 0;
  const busy = loading || refreshing || testing;
  const hasUnsavedChanges =
    !savedConfig ||
    savedConfig.enabled !== normalizedForm.enabled ||
    savedConfig.base_url !== normalizedForm.base_url ||
    savedConfig.model !== normalizedForm.model ||
    savedConfig.temperature !== normalizedForm.temperature ||
    hasTypedApiKey;
  const keyHandlingText = hasTypedApiKey
    ? t('A newly entered key will be used for this test and saved if you click Save.')
    : hasApiKey
      ? t('Leave API Key blank to keep using the saved key.')
      : t('No key saved yet. Add one once to finish setup.');

  const applyChatAnywherePreset = () => {
    setConnectionVerified(false);
    setForm((prev) => ({
      ...prev,
      provider: 'chatanywhere',
      base_url: 'https://api.chatanywhere.tech/v1',
      model: prev.model.trim() || 'gpt-4o-mini'
    }));
    setStatus({ variant: 'success', text: t('ChatAnywhere preset applied.') });
  };

  const applyRecommendedModel = (model: string) => {
    update('model', model);
    setStatus({ variant: 'success', text: t('Model preset applied: {model}', { model }) });
  };

  const discardTypedApiKey = () => {
    if (!hasTypedApiKey) {
      return;
    }

    setConnectionVerified(false);
    update('api_key', '');
    setStatus({ variant: 'success', text: t('Typed key removed. Saved key will be reused again.') });
    setConnectionAdvice('');
  };

  const save = async () => {
    if (!normalizedForm.base_url || !normalizedForm.model) {
      setStatus({ variant: 'error', text: t('Base URL and model are required.') });
      setConnectionAdvice(t('Apply ChatAnywhere preset and test with gpt-4o-mini.'));
      return;
    }

    if (normalizedForm.enabled && !normalizedForm.api_key && !hasApiKey) {
      setStatus({
        variant: 'error',
        text: t('Enable mode requires an API key. Please input key at least once.')
      });
      setConnectionAdvice(t('API key appears invalid or expired. Re-copy key and retry.'));
      return;
    }

    try {
      const saved = await api.saveLlmConfig(normalizedForm, !normalizedForm.api_key && hasApiKey);
      setSavedConfig(saved);
      setApiKeyMasked(saved.api_key_masked);
      setHasApiKey(saved.has_api_key);
      setForm(buildEditableForm(saved));
      setStatus({
        variant: 'success',
        text: t('Settings saved. Stored key reminder: {key}.', {
          key: saved.api_key_masked
        })
      });
      setConnectionVerified(false);
      setConnectionAdvice('');
      emitLlmConfigUpdated();
    } catch (error) {
      setStatus({ variant: 'error', text: (error as Error).message });
      setConnectionAdvice(resolveConnectionAdvice((error as Error).message, t));
    }
  };

  const clear = async () => {
    try {
      const cleared = await api.clearLlmConfig();
      setSavedConfig(cleared);
      setForm(buildEditableForm(cleared));
      setApiKeyMasked(cleared.api_key_masked);
      setHasApiKey(cleared.has_api_key);
      setStatus({ variant: 'success', text: t('Saved settings cleared.') });
      setConnectionVerified(false);
      setConnectionAdvice('');
      emitLlmConfigUpdated();
    } catch (error) {
      setStatus({ variant: 'error', text: (error as Error).message });
      setConnectionAdvice(resolveConnectionAdvice((error as Error).message, t));
    }
  };

  const reloadSavedConfig = async () => {
    setRefreshing(true);
    try {
      await refresh();
      setStatus({ variant: 'success', text: t('Saved settings reloaded.') });
      setConnectionVerified(false);
      setConnectionAdvice('');
    } catch (error) {
      setStatus({ variant: 'error', text: (error as Error).message });
      setConnectionAdvice(resolveConnectionAdvice((error as Error).message, t));
    } finally {
      setRefreshing(false);
    }
  };

  const testConnection = async () => {
    const useStoredApiKey = !normalizedForm.api_key.trim() && hasApiKey;
    const configForTest = normalizeLlmConfig({
      ...normalizedForm,
      enabled: true,
      api_key: normalizedForm.api_key || ''
    });

    if (!configForTest.api_key && !useStoredApiKey) {
      setStatus({
        variant: 'error',
        text: t('Connection test requires API key input or a saved key.')
      });
      setConnectionAdvice(t('API key appears invalid or expired. Re-copy key and retry.'));
      return;
    }

    setTesting(true);
    setStatus(null);

    try {
      const result = await api.testLlmConnection(configForTest, useStoredApiKey);
      setStatus({
        variant: 'success',
        text: t('Connection succeeded. Preview: {preview}', {
          preview: result.preview.slice(0, 140)
        })
      });
      setConnectionVerified(true);
      setConnectionAdvice('');
    } catch (error) {
      const message = (error as Error).message;
      setConnectionVerified(false);
      setStatus({
        variant: 'error',
        text: t('Connection failed: {message}', { message })
      });
      setConnectionAdvice(resolveConnectionAdvice(message, t));
    } finally {
      setTesting(false);
    }
  };

  const savedBaseUrl = savedConfig?.base_url ?? DEFAULT_LLM_CONFIG.base_url;
  const savedModel = savedConfig?.model ?? DEFAULT_LLM_CONFIG.model;
  const savedEnabled = savedConfig?.enabled ?? DEFAULT_LLM_CONFIG.enabled;
  const savedTemperature = savedConfig?.temperature ?? DEFAULT_LLM_CONFIG.temperature;
  const statusVariant = savedEnabled ? 'ready' : 'draft';
  const keyVariant = hasApiKey ? 'ready' : 'draft';
  const unsavedVariant = hasUnsavedChanges ? 'error' : 'ready';
  const llmOnboardingSteps = useMemo(
    () => [
      {
        key: 'base',
        label: t('Set provider endpoint and model'),
        detail: t('Use preset or manual input to keep Base URL and model explicit.'),
        done: savedBaseUrl.trim().length > 0 && savedModel.trim().length > 0,
        to: '/settings/llm',
        cta: t('Open LLM configuration')
      },
      {
        key: 'key',
        label: t('Save one API key'),
        detail: t('Save key once so later edits can reuse masked key without retyping.'),
        done: hasApiKey,
        to: '/settings/llm',
        cta: t('Save')
      },
      {
        key: 'enable',
        label: t('Enable custom LLM mode'),
        detail: t('Turn on custom mode so chat workspace uses your saved provider settings.'),
        done: savedEnabled && hasApiKey,
        to: '/settings/llm',
        cta: t('Enable custom LLM in conversation workspace')
      },
      {
        key: 'test',
        label: t('Run connection test and continue to chat'),
        detail: t('Verify connection first, then return to conversation workspace for real usage.'),
        done: connectionVerified,
        to: connectionVerified ? '/workspace/chat' : '/settings/llm',
        cta: connectionVerified ? t('Open Conversation Workspace') : t('Test Connection')
      }
    ],
    [connectionVerified, hasApiKey, savedBaseUrl, savedEnabled, savedModel, t]
  );
  const nextOnboardingStep = useMemo(
    () => llmOnboardingSteps.find((stepItem) => !stepItem.done) ?? null,
    [llmOnboardingSteps]
  );
  const nextOnboardingStepIndex = useMemo(
    () => (nextOnboardingStep ? llmOnboardingSteps.findIndex((stepItem) => stepItem.key === nextOnboardingStep.key) + 1 : 0),
    [llmOnboardingSteps, nextOnboardingStep]
  );

  const focusConfiguration = useCallback(() => {
    configurationRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const renderLlmNextAction = useCallback(
    (
      stepItem: (typeof llmOnboardingSteps)[number],
      options?: {
        variant?: 'secondary' | 'ghost';
      }
    ) => {
      const variant = options?.variant ?? 'secondary';

      if (stepItem.key === 'test' && connectionVerified) {
        return (
          <ButtonLink to={stepItem.to} variant={variant} size="sm">
            {stepItem.cta}
          </ButtonLink>
        );
      }

      return (
        <Button type="button" variant={variant} size="sm" onClick={focusConfiguration}>
          {stepItem.key === 'test' ? t('Test Connection') : t('Open LLM configuration')}
        </Button>
      );
    },
    [connectionVerified, focusConfiguration, t]
  );

  return (
    <WorkspacePage>
      <SettingsTabs />

      <PageHeader
        eyebrow={t('Settings')}
        title={t('LLM Settings')}
        description={t('Connect one OpenAI-compatible provider for the chat workspace.')}
        primaryAction={{
          label: refreshing ? t('Loading') : t('Reload saved settings'),
          onClick: reloadSavedConfig,
          disabled: refreshing || loading
        }}
        secondaryActions={
          <ButtonLink to="/workspace/chat" variant="ghost" size="sm">
            {t('Open Chat')}
          </ButtonLink>
        }
      />

      <KPIStatRow
        items={[
          {
            label: t('Mode'),
            value: savedEnabled ? t('enabled') : t('disabled'),
            tone: savedEnabled ? 'success' : 'neutral',
            hint: t('Current saved enable state for conversation usage.')
          },
          {
            label: t('Stored key'),
            value: hasApiKey ? apiKeyMasked : t('not set'),
            tone: hasApiKey ? 'success' : 'warning',
            hint: t('Saved key state for provider authentication.')
          },
          {
            label: t('Pending changes'),
            value: hasUnsavedChanges ? t('Yes') : t('No'),
            tone: hasUnsavedChanges ? 'warning' : 'neutral',
            hint: t('Unsaved edits in current configuration form.')
          }
        ]}
      />

      {loading ? (
        <StateBlock variant="loading" title={t('Loading Settings')} description={t('Fetching current LLM settings.')} />
      ) : null}

      {status ? (
        <InlineAlert
          tone={status.variant === 'success' ? 'success' : 'danger'}
          title={status.variant === 'success' ? t('Settings Updated') : t('Settings Error')}
          description={status.text}
        />
      ) : null}

      <WorkspaceWorkbench
        toolbar={
          <FilterToolbar
            filters={
              <small className="muted">
                {t('Keep presets and key-handling actions compact so configuration remains the single primary task.')}
              </small>
            }
            actions={
              <>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={reloadSavedConfig}
                  disabled={refreshing || loading}
                >
                  {refreshing ? t('Loading') : t('Reload saved settings')}
                </Button>
                {hasTypedApiKey ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={discardTypedApiKey}
                    disabled={busy}
                  >
                    {t('Discard typed key')}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={applyChatAnywherePreset}
                  disabled={busy}
                >
                  {t('Apply ChatAnywhere Preset')}
                </Button>
              </>
            }
            summary={
              <div className="workspace-segmented-actions">
                <Badge tone={savedEnabled ? 'success' : 'neutral'}>
                  {t('Mode')}: {savedEnabled ? t('enabled') : t('disabled')}
                </Badge>
                <Badge tone={hasApiKey ? 'success' : 'warning'}>
                  {t('Stored key')}: {hasApiKey ? t('Ready') : t('not set')}
                </Badge>
                <Badge tone={hasUnsavedChanges ? 'warning' : 'neutral'}>
                  {t('Pending changes')}: {hasUnsavedChanges ? t('Yes') : t('No')}
                </Badge>
                {connectionAdvice ? (
                  <Badge tone="info">{t('Troubleshooting')}: {t('available')}</Badge>
                ) : null}
              </div>
            }
          />
        }
        main={
          <div className="workspace-main-stack">
            <WorkspaceOnboardingCard
              title={t('LLM first-run guide')}
              description={t('Use this page to finish provider setup before relying on chat responses.')}
              summary={t('Guide status is computed from saved endpoint/model/key state plus latest connection test result.')}
              storageKey={llmOnboardingDismissedStorageKey}
              steps={llmOnboardingSteps.map((stepItem) => ({
                key: stepItem.key,
                label: stepItem.label,
                detail: stepItem.detail,
                done: stepItem.done,
                primaryAction: {
                  to: stepItem.key === 'test' && connectionVerified ? stepItem.to : undefined,
                  label: stepItem.key === 'test' && connectionVerified ? stepItem.cta : stepItem.key === 'test' ? t('Test Connection') : t('Open LLM configuration'),
                  onClick: stepItem.key === 'test' && connectionVerified ? undefined : focusConfiguration
                }
              }))}
            />

            {nextOnboardingStep ? (
              <WorkspaceNextStepCard
                title={t('Next LLM step')}
                description={t('Finish one clear LLM setup action here before testing chat usage.')}
                stepLabel={nextOnboardingStep.label}
                stepDetail={nextOnboardingStep.detail}
                current={nextOnboardingStepIndex}
                total={llmOnboardingSteps.length}
                actions={
                  <div className="row gap wrap">
                    {renderLlmNextAction(nextOnboardingStep)}
                    <ButtonLink to="/settings/account" variant="ghost" size="sm">
                      {t('Account Settings')}
                    </ButtonLink>
                  </div>
                }
              />
            ) : null}

            <div ref={configurationRef}>
              <Card as="article" className="stack">
              <WorkspaceSectionHeader
                title={t('Configuration')}
                description={t('Update endpoint, key, model, and temperature in one place.')}
              />

              <div className="workspace-form-grid">
                <label className="workspace-form-span-2">
                  {t('Provider')}
                  <Input value="chatanywhere (OpenAI compatible)" disabled />
                </label>
                <label className="workspace-form-span-2">
                  {t('Base URL')}
                  <Input
                    value={form.base_url}
                    onChange={(event) => update('base_url', event.target.value)}
                    placeholder="https://api.chatanywhere.tech/v1"
                  />
                </label>
                <label className="workspace-form-span-2">
                  {t('API Key')}
                  <Input
                    type="password"
                    value={form.api_key}
                    onChange={(event) => update('api_key', event.target.value)}
                    placeholder="sk-..."
                  />
                </label>
                <label>
                  {t('Model')}
                  <Input
                    value={form.model}
                    onChange={(event) => update('model', event.target.value)}
                    placeholder="gpt-4o-mini"
                  />
                </label>
                <label>
                  {t('Temperature (0-2)')}
                  <Input
                    type="number"
                    value={form.temperature}
                    min={0}
                    max={2}
                    step={0.1}
                    onChange={(event) => update('temperature', Number(event.target.value))}
                  />
                </label>
                <label className="workspace-form-span-2 row gap align-center workspace-checkbox-row">
                  <Checkbox
                    checked={form.enabled}
                    onChange={(event) => update('enabled', event.target.checked)}
                  />
                  {t('Enable custom LLM in conversation workspace')}
                </label>
              </div>

              <Panel className="workspace-record-item compact" tone="soft">
                <small className="muted">
                  {t('OpenAI-compatible mode.')}{' '}
                  {keyHandlingText}
                </small>
              </Panel>

              <strong>{t('Quick presets')}</strong>

              <div className="workspace-action-grid">
                {CHATANYWHERE_MODEL_PRESETS.map((item) => (
                  <Button
                    key={item}
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => applyRecommendedModel(item)}
                    disabled={busy}
                    block
                  >
                    {t('Use {model}', { model: item })}
                  </Button>
                ))}
              </div>

              <WorkspaceActionStack>
                <Button type="button" onClick={save} disabled={busy} block>
                  {t('Save')}
                </Button>
                <Button type="button" variant="secondary" onClick={testConnection} disabled={busy} block>
                  {testing ? t('Testing...') : t('Test Connection')}
                </Button>
                <Button type="button" variant="danger" onClick={clear} disabled={busy} block>
                  {t('Clear')}
                </Button>
              </WorkspaceActionStack>
            </Card>
            </div>
          </div>
        }
        side={
          <div className="workspace-inspector-rail">
            <WorkspaceActionPanel
              title={t('Saved settings')}
              description={t('Saved values stay visible here so you know what will be reused.')}
            >
              <ul className="workspace-record-list compact">
                <li className="workspace-record-item compact">
                  <div className="row between gap wrap">
                    <strong>{t('Mode')}</strong>
                    <StatusTag status={statusVariant}>
                      {savedEnabled ? t('enabled') : t('disabled')}
                    </StatusTag>
                  </div>
                  <small className="muted">
                    {t('Base URL')}: {savedBaseUrl}
                  </small>
                </li>
                <li className="workspace-record-item compact">
                  <div className="row between gap wrap">
                    <strong>{t('Stored key')}</strong>
                    <StatusTag status={keyVariant}>
                      {hasApiKey ? t('Ready') : t('not set')}
                    </StatusTag>
                  </div>
                  <small className="muted">{t('Masked key reminder: {key}', { key: apiKeyMasked })}</small>
                </li>
                <li className="workspace-record-item compact">
                  <div className="row between gap wrap">
                    <strong>{t('Model')}</strong>
                    <StatusTag status="info">{savedModel}</StatusTag>
                  </div>
                  <small className="muted">
                    {t('Temperature')}: {savedTemperature}
                  </small>
                </li>
                <li className="workspace-record-item compact">
                  <div className="row between gap wrap">
                    <strong>{t('Pending changes')}</strong>
                    <StatusTag status={unsavedVariant}>
                      {hasUnsavedChanges ? t('Yes') : t('No')}
                    </StatusTag>
                  </div>
                  <small className="muted">
                    {hasUnsavedChanges ? t('Pending changes are waiting to be saved.') : t('No pending changes.')}
                  </small>
                </li>
              </ul>
            </WorkspaceActionPanel>

            <AdvancedSection
              title={t('Connection notes')}
              description={t('Open troubleshooting and security reminders only when needed.')}
            >
              {connectionAdvice ? (
                <StateBlock variant="success" title={t('Troubleshooting')} description={connectionAdvice} />
              ) : (
                <StateBlock
                  variant="empty"
                  title={t('No connection advice right now.')}
                  description={t('Run a test after changing the endpoint, key, or model.')}
                />
              )}

              <small className="muted">
                {t(
                  'Stored key reuse follows the current form state. Free keys may have per-day or per-IP limits, and exposed keys should be rotated while keeping `LLM_CONFIG_SECRET` private.'
                )}
              </small>
            </AdvancedSection>
          </div>
        }
      />
    </WorkspacePage>
  );
}
