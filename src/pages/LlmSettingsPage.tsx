import { useEffect, useState } from 'react';
import type { LlmConfig } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';
import {
  DEFAULT_LLM_CONFIG,
  emitLlmConfigUpdated,
  normalizeLlmConfig
} from '../services/llmConfig';

export default function LlmSettingsPage() {
  const { t } = useI18n();
  const [form, setForm] = useState<LlmConfig>({ ...DEFAULT_LLM_CONFIG });
  const [status, setStatus] = useState<{ variant: 'success' | 'error'; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [apiKeyMasked, setApiKeyMasked] = useState('Not set');
  const [hasApiKey, setHasApiKey] = useState(false);

  const refresh = async () => {
    const current = await api.getLlmConfig();
    setForm({
      enabled: current.enabled,
      provider: 'chatanywhere',
      base_url: current.base_url,
      api_key: '',
      model: current.model,
      temperature: current.temperature
    });
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

  const save = async () => {
    const normalized = normalizeLlmConfig(form);

    if (!normalized.base_url || !normalized.model) {
      setStatus({ variant: 'error', text: t('Base URL and model are required.') });
      return;
    }

    if (normalized.enabled && !normalized.api_key && !hasApiKey) {
      setStatus({
        variant: 'error',
        text: t('Enable mode requires an API key. Please input key at least once.')
      });
      return;
    }

    try {
      const saved = await api.saveLlmConfig(normalized, !normalized.api_key && hasApiKey);
      setApiKeyMasked(saved.api_key_masked);
      setHasApiKey(saved.has_api_key);
      setForm((prev) => ({ ...prev, api_key: '' }));
      setStatus({
        variant: 'success',
        text: t('Configuration saved on server memory. Current key: {key}.', {
          key: saved.api_key_masked
        })
      });
      emitLlmConfigUpdated();
    } catch (error) {
      setStatus({ variant: 'error', text: (error as Error).message });
    }
  };

  const clear = async () => {
    try {
      const cleared = await api.clearLlmConfig();
      setForm({
        enabled: cleared.enabled,
        provider: 'chatanywhere',
        base_url: cleared.base_url,
        api_key: '',
        model: cleared.model,
        temperature: cleared.temperature
      });
      setApiKeyMasked(cleared.api_key_masked);
      setHasApiKey(cleared.has_api_key);
      setStatus({ variant: 'success', text: t('Configuration cleared from server memory.') });
      emitLlmConfigUpdated();
    } catch (error) {
      setStatus({ variant: 'error', text: (error as Error).message });
    }
  };

  const testConnection = async () => {
    const configForTest = normalizeLlmConfig({
      ...form,
      enabled: true,
      api_key: form.api_key || ''
    });

    if (!configForTest.api_key) {
      setStatus({
        variant: 'error',
        text: t('Connection test requires API key input for this test run.')
      });
      return;
    }

    setTesting(true);
    setStatus(null);

    try {
      const result = await api.testLlmConnection(configForTest);
      setStatus({
        variant: 'success',
        text: t('Connection succeeded. Preview: {preview}', {
          preview: result.preview.slice(0, 140)
        })
      });
    } catch (error) {
      setStatus({
        variant: 'error',
        text: t('Connection failed: {message}', { message: (error as Error).message })
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="stack page-width">
      <h2>{t('LLM Settings (Bring Your Own Key)')}</h2>
      <p className="muted">
        {t(
          'Configure your own OpenAI-compatible endpoint. Key is managed server-side and encrypted in local prototype storage; it is never committed into repository files.'
        )}
      </p>

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

      <section className="card stack">
        <label>
          {t('Provider')}
          <input value="chatanywhere (OpenAI compatible)" disabled />
        </label>

        <label>
          {t('Base URL')}
          <input
            value={form.base_url}
            onChange={(event) => update('base_url', event.target.value)}
            placeholder="https://api.chatanywhere.tech"
          />
        </label>

        <label>
          {t('API Key')}
          <input
            type="password"
            value={form.api_key}
            onChange={(event) => update('api_key', event.target.value)}
            placeholder="sk-..."
          />
        </label>

        <small className="muted">{t('Stored key: {key}', { key: apiKeyMasked })}</small>

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

        <label className="row gap align-center">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(event) => update('enabled', event.target.checked)}
          />
          {t('Enable custom LLM in conversation workspace')}
        </label>
      </section>

      <section className="card stack">
        <div className="row gap">
          <button onClick={save}>{t('Save')}</button>
          <button onClick={testConnection} disabled={testing}>
            {testing ? t('Testing...') : t('Test Connection')}
          </button>
          <button onClick={clear}>{t('Clear')}</button>
        </div>
        <small className="muted">
          {t(
            'Security note: rotate your key if it was ever exposed in public channels and keep `LLM_CONFIG_SECRET` private.'
          )}
        </small>
      </section>
    </div>
  );
}
