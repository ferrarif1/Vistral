import { useEffect, useMemo, useState } from 'react';
import type { LlmConfig, LlmConfigView } from '../../shared/domain';
import AdvancedSection from '../components/AdvancedSection';
import StateBlock from '../components/StateBlock';
import SettingsTabs from '../components/settings/SettingsTabs';
import { StatusTag } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Checkbox, Input } from '../components/ui/Field';
import { Card, Panel } from '../components/ui/Surface';
import {
  WorkspaceHero,
  WorkspaceMetricGrid,
  WorkspacePage,
  WorkspaceSectionHeader,
  WorkspaceSplit
} from '../components/ui/WorkspacePage';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';
import {
  DEFAULT_LLM_CONFIG,
  emitLlmConfigUpdated,
  normalizeLlmConfig
} from '../services/llmConfig';

const CHATANYWHERE_MODEL_PRESETS = ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-3.5-turbo'] as const;

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
    ? t('Typed API Key will replace the saved key on save and be used for connection test.')
    : hasApiKey
      ? t('Blank API Key means save/test will keep using the saved key.')
      : t('No saved key yet. Input API key once to start managed editing.');

  const applyChatAnywherePreset = () => {
    setForm((prev) => ({
      ...prev,
      provider: 'chatanywhere',
      base_url: 'https://api.chatanywhere.tech/v1',
      model: prev.model.trim() || 'gpt-3.5-turbo'
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

    update('api_key', '');
    setStatus({ variant: 'success', text: t('Typed API key discarded. Saved key handling restored.') });
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
        text: t('Configuration saved to encrypted local storage. Current key: {key}.', {
          key: saved.api_key_masked
        })
      });
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
      setStatus({ variant: 'success', text: t('Configuration cleared from encrypted local storage.') });
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
      setStatus({ variant: 'success', text: t('Reloaded saved LLM settings.') });
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
      setConnectionAdvice('');
    } catch (error) {
      const message = (error as Error).message;
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

  return (
    <WorkspacePage>
      <SettingsTabs />

      <WorkspaceHero
        eyebrow={t('LLM Control Plane')}
        title={t('LLM Settings (Bring Your Own Key)')}
        description={t('Manage provider credentials, saved key reuse, and live connection checks from one page.')}
        stats={[
          { label: t('Saved mode'), value: savedEnabled ? t('enabled') : t('disabled') },
          { label: t('Stored key'), value: hasApiKey ? apiKeyMasked : t('not set') },
          { label: t('Unsaved edits'), value: hasUnsavedChanges ? t('Yes') : t('No') }
        ]}
      />

      {loading ? (
        <StateBlock variant="loading" title={t('Loading Settings')} description={t('Fetching current LLM settings.')} />
      ) : null}

      {status ? (
        <StateBlock
          variant={status.variant}
          title={status.variant === 'success' ? t('Settings Updated') : t('Settings Error')}
          description={status.text}
        />
      ) : null}

      <WorkspaceMetricGrid
        items={[
          {
            title: t('Saved mode'),
            description: t('Saved conversation mode toggle from the encrypted local config.'),
            value: savedEnabled ? t('enabled') : t('disabled')
          },
          {
            title: t('Stored key'),
            description: t('Whether an encrypted key is already stored for reuse.'),
            value: hasApiKey ? t('Ready') : t('N/A')
          },
          {
            title: t('Unsaved edits'),
            description: t('Form changes that still need save or discard.'),
            value: hasUnsavedChanges ? t('Yes') : t('No'),
            tone: hasUnsavedChanges ? 'attention' : 'default'
          },
          {
            title: t('Preset shortcuts'),
            description: t('Preset models available for one-click selection.'),
            value: CHATANYWHERE_MODEL_PRESETS.length
          }
        ]}
      />

      <WorkspaceSplit
        main={
          <Card className="stack">
            <WorkspaceSectionHeader
              title={t('Editing Lane')}
              description={t('Update endpoint, key, model, and temperature in one focused form.')}
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
                placeholder="gpt-3.5-turbo"
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
            <div className="stack tight">
              <small className="muted">{t('Provider is fixed to OpenAI-compatible mode in this prototype.')}</small>
              <small className="muted">{t('Leave API Key blank to keep the saved key when editing or testing.')}</small>
              <small className="muted">{keyHandlingText}</small>
            </div>
          </Panel>

          <div className="stack tight">
            <strong>{t('Preset shortcuts')}</strong>
            <small className="muted">
              {t('Use a preset button to move faster while keeping the underlying form editable.')}
            </small>
          </div>

          <div className="workspace-action-grid">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={applyChatAnywherePreset}
              disabled={busy}
              block
            >
              {t('Apply ChatAnywhere Preset')}
            </Button>
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

            <div className="workspace-button-stack">
              <Button type="button" onClick={save} disabled={busy} block>
                {t('Save')}
              </Button>
              <Button type="button" variant="secondary" onClick={testConnection} disabled={busy} block>
                {testing ? t('Testing...') : t('Test Connection')}
              </Button>
              <Button type="button" variant="danger" onClick={clear} disabled={busy} block>
                {t('Clear')}
              </Button>
            </div>
          </Card>
        }
        side={
          <>
            <Card className="stack">
              <WorkspaceSectionHeader
                title={t('Saved snapshot')}
                description={t('Masked saved values remain visible so you can tell what will be reused.')}
              />

            <div className="workspace-button-stack">
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
                <Button type="button" variant="secondary" size="sm" onClick={discardTypedApiKey} disabled={busy}>
                  {t('Discard typed key')}
                </Button>
              ) : null}
            </div>

            <ul className="workspace-record-list compact">
              <li className="workspace-record-item compact">
                <div className="row between gap wrap">
                  <strong>{t('Saved mode')}</strong>
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
                <small className="muted">{t('Stored key: {key}', { key: apiKeyMasked })}</small>
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
                  <strong>{t('Unsaved edits')}</strong>
                  <StatusTag status={unsavedVariant}>
                    {hasUnsavedChanges ? t('Yes') : t('No')}
                  </StatusTag>
                </div>
                <small className="muted">
                  {hasUnsavedChanges ? t('Unsaved edits are pending.') : t('No unsaved edits.')}
                </small>
              </li>
            </ul>
          </Card>

            <AdvancedSection
              title={t('Connection guidance')}
              description={t('Open troubleshooting and security guidance only when needed.')}
            >
              {connectionAdvice ? (
                <StateBlock variant="success" title={t('Troubleshooting')} description={connectionAdvice} />
              ) : (
                <StateBlock
                  variant="empty"
                  title={t('No live troubleshooting advice right now.')}
                  description={t('Try a connection test after changing base URL, key, or model.')}
                />
              )}

              <ul className="workspace-record-list compact">
                <li className="workspace-record-item compact">
                  <div className="row between gap wrap">
                    <strong>{t('Stored key reuse')}</strong>
                    <StatusTag status="info">{hasTypedApiKey ? t('No') : t('Yes')}</StatusTag>
                  </div>
                  <small className="muted">{keyHandlingText}</small>
                </li>
              </ul>

              <small className="muted">{t('Free key may have per-day quota and per-IP limits.')}</small>
              <small className="muted">
                {t(
                  'Security note: rotate your key if it was ever exposed in public channels and keep `LLM_CONFIG_SECRET` private.'
                )}
              </small>
            </AdvancedSection>
          </>
        }
      />
    </WorkspacePage>
  );
}
