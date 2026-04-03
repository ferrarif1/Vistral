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

const CHATANYWHERE_MODEL_PRESETS = ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-3.5-turbo'] as const;

const resolveConnectionAdvice = (message: string, t: (source: string) => string): string => {
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

export default function LlmSettingsPage() {
  const { t } = useI18n();
  const [form, setForm] = useState<LlmConfig>({ ...DEFAULT_LLM_CONFIG });
  const [status, setStatus] = useState<{ variant: 'success' | 'error'; text: string } | null>(null);
  const [connectionAdvice, setConnectionAdvice] = useState('');
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

  const applyChatAnywherePreset = () => {
    setForm((prev) => ({
      ...prev,
      provider: 'chatanywhere',
      base_url: 'https://api.chatanywhere.tech/v1',
      model: prev.model.trim() || 'gpt-3.5-turbo'
    }));
    setStatus({ variant: 'success', text: t('ChatAnywhere preset applied.') });
  };

  const save = async () => {
    const normalized = normalizeLlmConfig(form);

    if (!normalized.base_url || !normalized.model) {
      setStatus({ variant: 'error', text: t('Base URL and model are required.') });
      setConnectionAdvice(t('Apply ChatAnywhere preset and test with gpt-4o-mini.'));
      return;
    }

    if (normalized.enabled && !normalized.api_key && !hasApiKey) {
      setStatus({
        variant: 'error',
        text: t('Enable mode requires an API key. Please input key at least once.')
      });
      setConnectionAdvice(t('API key appears invalid or expired. Re-copy key and retry.'));
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
      setConnectionAdvice('');
      emitLlmConfigUpdated();
    } catch (error) {
      setStatus({ variant: 'error', text: (error as Error).message });
      setConnectionAdvice(resolveConnectionAdvice((error as Error).message, t));
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
      setConnectionAdvice(t('API key appears invalid or expired. Re-copy key and retry.'));
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

  return (
    <div className="stack page-width">
      <h2>{t('LLM Settings (Bring Your Own Key)')}</h2>
      <p className="muted">
        {t(
          'Configure your own OpenAI-compatible endpoint. Key is managed server-side and encrypted in local prototype storage; it is never committed into repository files.'
        )}
      </p>
      <small className="muted">
        {t('Supports base URL like {baseUrl} and full endpoint {endpoint}.', {
          baseUrl: 'https://api.chatanywhere.tech/v1',
          endpoint: 'https://api.chatanywhere.tech/v1/chat/completions'
        })}
      </small>

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

        <div className="row gap wrap">
          <button type="button" className="small-btn" onClick={applyChatAnywherePreset}>
            {t('Apply ChatAnywhere Preset')}
          </button>
        </div>

        <label>
          {t('Base URL')}
          <input
            value={form.base_url}
            onChange={(event) => update('base_url', event.target.value)}
            placeholder="https://api.chatanywhere.tech/v1"
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
          {t('Recommended Models')}
          <select
            value=""
            onChange={(event) => {
              if (event.target.value) {
                update('model', event.target.value);
              }
            }}
          >
            <option value="">{t('Select recommended model')}</option>
            {CHATANYWHERE_MODEL_PRESETS.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
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
        {connectionAdvice ? <small className="muted">{t('Troubleshooting')}: {connectionAdvice}</small> : null}
        <small className="muted">{t('Free key may have per-day quota and per-IP limits.')}</small>
        <small className="muted">
          {t(
            'Security note: rotate your key if it was ever exposed in public channels and keep `LLM_CONFIG_SECRET` private.'
          )}
        </small>
      </section>
    </div>
  );
}
