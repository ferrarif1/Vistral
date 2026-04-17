import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LlmConfig, LlmConfigView } from '../../shared/domain';
import SettingsTabs from '../components/settings/SettingsTabs';
import StateBlock from '../components/StateBlock';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { DetailList, InlineAlert, PageHeader, SectionCard } from '../components/ui/ConsolePage';
import { Checkbox, Input } from '../components/ui/Field';
import { WorkspacePage } from '../components/ui/WorkspacePage';
import AdvancedSection from '../components/AdvancedSection';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';
import {
  DEFAULT_LLM_CONFIG,
  emitLlmConfigUpdated,
  normalizeLlmConfig
} from '../services/llmConfig';

const CHATANYWHERE_MODEL_PRESETS = ['gpt-4o-mini', 'gpt-4.1-mini'] as const;

const resolveConnectionAdvice = (
  message: string,
  t: (source: string, vars?: Record<string, string | number>) => string
): string => {
  const lower = message.toLowerCase();
  if (lower.includes('(401') || lower.includes('unauthorized') || lower.includes('invalid api key')) {
    return t('API key may be invalid. Re-copy it before retrying.');
  }
  if (lower.includes('(403') || lower.includes('forbidden')) {
    return t('Current key may not access this model.');
  }
  if (lower.includes('(429') || lower.includes('rate limit') || lower.includes('quota')) {
    return t('Rate limit hit. Retry later or switch to a cheaper model.');
  }
  if (lower.includes('(404') || lower.includes('not found')) {
    return t('Endpoint or model not found. Check the base URL and model name.');
  }
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('etimedout')) {
    return t('Connection timed out. Try again later.');
  }
  return t('Apply a preset before testing.');
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
  const [apiKeyMasked, setApiKeyMasked] = useState('Not set');
  const [hasApiKey, setHasApiKey] = useState(false);
  const [connectionVerified, setConnectionVerified] = useState(false);

  const refresh = useCallback(async () => {
    const current = await api.getLlmConfig();
    setSavedConfig(current);
    setForm(buildEditableForm(current));
    setApiKeyMasked(current.api_key_masked);
    setHasApiKey(current.has_api_key);
  }, []);

  useEffect(() => {
    setLoading(true);
    refresh()
      .catch((error) => {
        setStatus({ variant: 'error', text: (error as Error).message });
      })
      .finally(() => setLoading(false));
  }, [refresh]);

  const update = <K extends keyof LlmConfig>(key: K, value: LlmConfig[K]) => {
    setConnectionVerified(false);
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const normalizedForm = useMemo(() => normalizeLlmConfig(form), [form]);
  const hasTypedApiKey = normalizedForm.api_key.trim().length > 0;
  const busy = loading || testing;

  const hasUnsavedChanges = useMemo(() => {
    if (!savedConfig) {
      return true;
    }
    return (
      savedConfig.enabled !== normalizedForm.enabled ||
      savedConfig.base_url !== normalizedForm.base_url ||
      savedConfig.model !== normalizedForm.model ||
      savedConfig.temperature !== normalizedForm.temperature ||
      hasTypedApiKey
    );
  }, [hasTypedApiKey, normalizedForm, savedConfig]);

  const requiresKeyWhenEnabled = normalizedForm.enabled && !hasTypedApiKey && !hasApiKey;
  const hasBaseUrl = normalizedForm.base_url.trim().length > 0;
  const hasModel = normalizedForm.model.trim().length > 0;
  const canTest = (hasTypedApiKey || hasApiKey) && hasBaseUrl && hasModel && !busy;
  const canSave = hasBaseUrl && hasModel && !busy && (!normalizedForm.enabled || hasTypedApiKey || hasApiKey);

  const applyChatAnywherePreset = () => {
    setConnectionVerified(false);
    setForm((prev) => ({
      ...prev,
      provider: 'chatanywhere',
      base_url: 'https://api.chatanywhere.tech/v1',
      model: prev.model.trim() || 'gpt-4o-mini'
    }));
    setStatus({ variant: 'success', text: t('ChatAnywhere preset applied.') });
    setConnectionAdvice('');
  };

  const applyRecommendedModel = (model: string) => {
    update('model', model);
    setStatus({ variant: 'success', text: t('Model preset applied: {model}', { model }) });
    setConnectionAdvice('');
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

  const saveConfig = async (forceEnable: boolean) => {
    const next = normalizeLlmConfig({
      ...normalizedForm,
      enabled: forceEnable ? true : normalizedForm.enabled
    });

    if (!next.base_url || !next.model) {
      setStatus({ variant: 'error', text: t('Base URL and model are required.') });
      setConnectionAdvice(t('Apply a preset before testing.'));
      return;
    }

    if (next.enabled && !next.api_key && !hasApiKey) {
      setStatus({
        variant: 'error',
        text: t('Enable mode requires an API key. Please input key at least once.')
      });
      setConnectionAdvice(t('API key may be invalid. Re-copy it before retrying.'));
      return;
    }

    try {
      const saved = await api.saveLlmConfig(next, !next.api_key && hasApiKey);
      setSavedConfig(saved);
      setApiKeyMasked(saved.api_key_masked);
      setHasApiKey(saved.has_api_key);
      setForm(buildEditableForm(saved));
      setConnectionVerified(false);
      setConnectionAdvice('');
      setStatus({
        variant: 'success',
        text: saved.enabled
          ? t('LLM configuration saved and enabled.')
          : t('LLM configuration saved.')
      });
      emitLlmConfigUpdated();
    } catch (error) {
      const message = (error as Error).message;
      setStatus({ variant: 'error', text: message });
      setConnectionAdvice(resolveConnectionAdvice(message, t));
    }
  };

  const clear = async () => {
    try {
      const cleared = await api.clearLlmConfig();
      setSavedConfig(cleared);
      setForm(buildEditableForm(cleared));
      setApiKeyMasked(cleared.api_key_masked);
      setHasApiKey(cleared.has_api_key);
      setConnectionVerified(false);
      setConnectionAdvice('');
      setStatus({ variant: 'success', text: t('Saved settings cleared.') });
      emitLlmConfigUpdated();
    } catch (error) {
      const message = (error as Error).message;
      setStatus({ variant: 'error', text: message });
      setConnectionAdvice(resolveConnectionAdvice(message, t));
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
        text: t('Testing requires an input key or a saved key.')
      });
      setConnectionAdvice(t('API key may be invalid. Re-copy it before retrying.'));
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

  if (loading) {
    return (
      <WorkspacePage>
        <SettingsTabs />
        <PageHeader
          eyebrow={t('Settings')}
          title={t('LLM Settings')}
          description={t('Pick a preset first, then fill the fields.')}
        />
        <StateBlock
          variant="loading"
          title={t('Loading Settings')}
          description={t('Load the current configuration.')}
        />
      </WorkspacePage>
    );
  }

  return (
    <WorkspacePage>
      <SettingsTabs />
      <PageHeader
        eyebrow={t('Settings')}
        title={t('LLM Settings')}
        description={t('Configure, test, then enable.')}
        primaryAction={{
          label: t('Save and enable'),
          onClick: () => {
            void saveConfig(true);
          },
          disabled: !canSave
        }}
      />

      {status ? (
        <InlineAlert
          tone={status.variant === 'success' ? 'success' : 'danger'}
          title={status.variant === 'success' ? t('Action Completed') : t('Action Failed')}
          description={status.text}
        />
      ) : null}

      <div className="workspace-main-stack">
        <SectionCard
          title={t('Preset and settings')}
          description={t('Apply a preset, then fill base URL, key, model, and temperature.')}
          actions={
            <div className="row gap wrap align-center">
              <Badge tone="info">{t('OpenAI-compatible')}</Badge>
              <small className="muted">{t('ChatAnywhere preset')}</small>
            </div>
          }
        >
          <div className="row gap wrap align-center">
            <Button type="button" onClick={applyChatAnywherePreset} disabled={busy}>
              {t('Apply preset')}
            </Button>
            <div className="row gap wrap">
              {CHATANYWHERE_MODEL_PRESETS.map((model) => (
                <Button
                  key={model}
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => applyRecommendedModel(model)}
                  disabled={busy}
                >
                  {t('Use {model}', { model })}
                </Button>
              ))}
            </div>
          </div>
          <div className="workspace-form-grid">
            <label className="workspace-form-span-2">
              {t('Base URL')}
              <Input
                value={form.base_url}
                onChange={(event) => update('base_url', event.target.value)}
                placeholder="https://api.chatanywhere.tech/v1"
              />
              {!hasBaseUrl ? <small className="muted">{t('Base URL is required.')}</small> : null}
            </label>

            <label className="workspace-form-span-2">
              {t('API Key')}
              <Input
                type="password"
                value={form.api_key}
                onChange={(event) => update('api_key', event.target.value)}
                placeholder="sk-..."
              />
              <small className="muted">
                {hasTypedApiKey
                  ? t('Typed key will be used for test/save.')
                  : hasApiKey
                    ? t('Leave blank to reuse the saved key.')
                    : t('Enter one key to finish setup.')}
              </small>
            </label>

            <label>
              {t('Model')}
              <Input
                value={form.model}
                onChange={(event) => update('model', event.target.value)}
                placeholder="gpt-4o-mini"
              />
              {!hasModel ? <small className="muted">{t('Model is required.')}</small> : null}
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
          </div>

          <div className="row gap wrap align-center">
            <label className="workspace-checkbox-row">
              <Checkbox
                checked={form.enabled}
                onChange={(event) => update('enabled', event.target.checked)}
              />
              <span>{t('Enable custom LLM')}</span>
            </label>
            {hasTypedApiKey ? (
              <Button type="button" variant="ghost" size="sm" onClick={discardTypedApiKey} disabled={busy}>
                {t('Discard typed key')}
              </Button>
            ) : null}
          </div>
          {requiresKeyWhenEnabled ? <InlineAlert tone="warning" description={t('Enable mode requires an API key or a saved key.')} /> : null}
        </SectionCard>

        <SectionCard title={t('Test connection')} description={t('Save before testing endpoint, key, and model.')}>
          <div className="row gap wrap align-center">
            <Button type="button" onClick={testConnection} disabled={!canTest}>
              {testing ? t('Testing...') : t('Test connection')}
            </Button>
            <Badge tone={connectionVerified ? 'success' : 'neutral'}>
              {connectionVerified ? t('Connection verified') : t('Not verified')}
            </Badge>
          </div>
          {connectionAdvice ? <small className="muted">{connectionAdvice}</small> : null}
        </SectionCard>

        <AdvancedSection
          title={t('Saved settings and danger zone')}
          description={t('Only compare or clear when needed.')}
        >
          <SectionCard
            title={t('Saved settings snapshot')}
            description={t('Open only when you need to compare.')}
            actions={
              <Badge tone={hasUnsavedChanges ? 'warning' : 'neutral'}>
                {hasUnsavedChanges ? t('Unsaved') : t('Saved')}
              </Badge>
            }
          >
            <DetailList
              items={[
                { label: t('Mode'), value: savedEnabled ? t('enabled') : t('disabled') },
                { label: t('Base URL'), value: savedBaseUrl },
                { label: t('Model'), value: savedModel },
                { label: t('Temperature'), value: savedTemperature },
                { label: t('Stored key'), value: hasApiKey ? apiKeyMasked : t('not set') },
                { label: t('Pending changes'), value: hasUnsavedChanges ? t('Yes') : t('No') }
              ]}
            />
          </SectionCard>

          <SectionCard
            title={t('Danger zone')}
            description={t('Use only when you need to clear the saved configuration.')}
          >
            <Button type="button" variant="danger" onClick={clear} disabled={busy}>
              {t('Clear saved settings')}
            </Button>
          </SectionCard>
        </AdvancedSection>
      </div>
    </WorkspacePage>
  );
}
