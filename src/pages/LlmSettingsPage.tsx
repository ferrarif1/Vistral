import { useEffect, useMemo, useState } from 'react';
import type { LlmConfig, LlmConfigView } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import SettingsTabs from '../components/settings/SettingsTabs';
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
    <div className="workspace-overview-page stack">
      <SettingsTabs />

      <section className="card workspace-overview-hero">
        <div className="workspace-overview-hero-grid">
          <div className="workspace-overview-copy stack">
            <small className="workspace-eyebrow">{t('LLM Control Plane')}</small>
            <h1>{t('LLM Settings (Bring Your Own Key)')}</h1>
            <p className="muted">
              {t('Manage provider credentials, saved key reuse, and live connection checks from one page.')}
            </p>
          </div>
          <div className="workspace-overview-badges">
            <div className="workspace-overview-badge">
              <span>{t('Saved mode')}</span>
              <strong>{savedEnabled ? t('enabled') : t('disabled')}</strong>
            </div>
            <div className="workspace-overview-badge">
              <span>{t('Stored key')}</span>
              <strong>{hasApiKey ? apiKeyMasked : t('not set')}</strong>
            </div>
            <div className="workspace-overview-badge">
              <span>{t('Unsaved edits')}</span>
              <strong>{hasUnsavedChanges ? t('Yes') : t('No')}</strong>
            </div>
          </div>
        </div>
      </section>

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

      <section className="workspace-overview-signal-grid">
        <article className="card stack workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Saved mode')}</h3>
            <small className="muted">{t('Saved conversation mode toggle from the encrypted local config.')}</small>
          </div>
          <strong className="metric">{savedEnabled ? t('enabled') : t('disabled')}</strong>
        </article>
        <article className="card stack workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Stored key')}</h3>
            <small className="muted">{t('Whether an encrypted key is already stored for reuse.')}</small>
          </div>
          <strong className="metric">{hasApiKey ? t('Ready') : t('N/A')}</strong>
        </article>
        <article className={`card stack workspace-signal-card${hasUnsavedChanges ? ' attention' : ''}`}>
          <div className="workspace-signal-top">
            <h3>{t('Unsaved edits')}</h3>
            <small className="muted">{t('Form changes that still need save or discard.')}</small>
          </div>
          <strong className="metric">{hasUnsavedChanges ? t('Yes') : t('No')}</strong>
        </article>
        <article className="card stack workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Preset shortcuts')}</h3>
            <small className="muted">{t('Preset models available for one-click selection.')}</small>
          </div>
          <strong className="metric">{CHATANYWHERE_MODEL_PRESETS.length}</strong>
        </article>
      </section>

      <section className="workspace-overview-panel-grid">
        <article className="card stack workspace-overview-main">
          <div className="workspace-section-header">
            <div className="stack tight">
              <h3>{t('Editing Lane')}</h3>
              <small className="muted">
                {t('Update endpoint, key, model, and temperature in one focused form.')}
              </small>
            </div>
          </div>

          <div className="workspace-form-grid">
            <label className="workspace-form-span-2">
              {t('Provider')}
              <input value="chatanywhere (OpenAI compatible)" disabled />
            </label>
            <label className="workspace-form-span-2">
              {t('Base URL')}
              <input
                value={form.base_url}
                onChange={(event) => update('base_url', event.target.value)}
                placeholder="https://api.chatanywhere.tech/v1"
              />
            </label>
            <label className="workspace-form-span-2">
              {t('API Key')}
              <input
                type="password"
                value={form.api_key}
                onChange={(event) => update('api_key', event.target.value)}
                placeholder="sk-..."
              />
            </label>
            <label>
              {t('Model')}
              <input
                value={form.model}
                onChange={(event) => update('model', event.target.value)}
                placeholder="gpt-3.5-turbo"
              />
            </label>
            <label>
              {t('Temperature (0-2)')}
              <input
                type="number"
                value={form.temperature}
                min={0}
                max={2}
                step={0.1}
                onChange={(event) => update('temperature', Number(event.target.value))}
              />
            </label>
            <label className="workspace-form-span-2 row gap align-center">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) => update('enabled', event.target.checked)}
              />
              {t('Enable custom LLM in conversation workspace')}
            </label>
          </div>

          <small className="muted">{t('Provider is fixed to OpenAI-compatible mode in this prototype.')}</small>
          <small className="muted">{t('Leave API Key blank to keep the saved key when editing or testing.')}</small>
          <small className="muted">{keyHandlingText}</small>

          <div className="stack tight">
            <strong>{t('Preset shortcuts')}</strong>
            <small className="muted">
              {t('Use a preset button to move faster while keeping the underlying form editable.')}
            </small>
          </div>

          <div className="row gap wrap">
            <button type="button" className="workspace-inline-button" onClick={applyChatAnywherePreset} disabled={busy}>
              {t('Apply ChatAnywhere Preset')}
            </button>
            {CHATANYWHERE_MODEL_PRESETS.map((item) => (
              <button
                key={item}
                type="button"
                className="workspace-inline-button"
                onClick={() => applyRecommendedModel(item)}
                disabled={busy}
              >
                {t('Use {model}', { model: item })}
              </button>
            ))}
          </div>

          <div className="workspace-button-stack">
            <button type="button" onClick={save} disabled={busy}>
              {t('Save')}
            </button>
            <button type="button" onClick={testConnection} disabled={busy}>
              {testing ? t('Testing...') : t('Test Connection')}
            </button>
            <button type="button" className="workspace-inline-button" onClick={clear} disabled={busy}>
              {t('Clear')}
            </button>
          </div>
        </article>

        <div className="workspace-overview-side">
          <article className="card stack">
            <div className="workspace-section-header">
              <div className="stack tight">
                <h3>{t('Saved snapshot')}</h3>
                <small className="muted">
                  {t('Masked saved values remain visible so you can tell what will be reused.')}
                </small>
              </div>
              <div className="row gap wrap">
                <button
                  type="button"
                  className="workspace-inline-button"
                  onClick={reloadSavedConfig}
                  disabled={refreshing || loading}
                >
                  {refreshing ? t('Loading') : t('Reload saved settings')}
                </button>
                {hasTypedApiKey ? (
                  <button type="button" className="workspace-inline-button" onClick={discardTypedApiKey} disabled={busy}>
                    {t('Discard typed key')}
                  </button>
                ) : null}
              </div>
            </div>

            <ul className="workspace-record-list compact">
              <li className="workspace-record-item compact">
                <div className="row between gap wrap">
                  <strong>{t('Saved mode')}</strong>
                  <span className={`workspace-status-pill ${statusVariant}`}>
                    {savedEnabled ? t('enabled') : t('disabled')}
                  </span>
                </div>
                <small className="muted">
                  {t('Base URL')}: {savedBaseUrl}
                </small>
              </li>
              <li className="workspace-record-item compact">
                <div className="row between gap wrap">
                  <strong>{t('Stored key')}</strong>
                  <span className={`workspace-status-pill ${keyVariant}`}>
                    {hasApiKey ? t('Ready') : t('not set')}
                  </span>
                </div>
                <small className="muted">{t('Stored key: {key}', { key: apiKeyMasked })}</small>
              </li>
              <li className="workspace-record-item compact">
                <div className="row between gap wrap">
                  <strong>{t('Model')}</strong>
                  <span className="chip">{savedModel}</span>
                </div>
                <small className="muted">
                  {t('Temperature')}: {savedTemperature}
                </small>
              </li>
              <li className="workspace-record-item compact">
                <div className="row between gap wrap">
                  <strong>{t('Unsaved edits')}</strong>
                  <span className={`workspace-status-pill ${unsavedVariant}`}>
                    {hasUnsavedChanges ? t('Yes') : t('No')}
                  </span>
                </div>
                <small className="muted">
                  {hasUnsavedChanges ? t('Unsaved edits are pending.') : t('No unsaved edits.')}
                </small>
              </li>
            </ul>
          </article>

          <article className="card stack">
            <div className="stack tight">
              <h3>{t('Connection guidance')}</h3>
              <small className="muted">
                {t('Use connection advice and safety reminders before switching providers or models.')}
              </small>
            </div>

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
                  <span className="chip">{hasTypedApiKey ? t('No') : t('Yes')}</span>
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
          </article>
        </div>
      </section>
    </div>
  );
}
