import type { LlmConfig } from '../../shared/domain';

export const LLM_CONFIG_UPDATED_EVENT = 'vistral:llm-config-updated';

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  enabled: false,
  provider: 'chatanywhere',
  base_url: import.meta.env.VITE_DEFAULT_LLM_BASE_URL ?? 'https://api.chatanywhere.tech',
  api_key: '',
  model: import.meta.env.VITE_DEFAULT_LLM_MODEL ?? 'gpt-3.5-turbo',
  temperature: 0.2
};

export const normalizeLlmConfig = (input: Partial<LlmConfig>): LlmConfig => {
  const tempRaw =
    typeof input.temperature === 'number' && Number.isFinite(input.temperature)
      ? input.temperature
      : DEFAULT_LLM_CONFIG.temperature;

  return {
    enabled: Boolean(input.enabled),
    provider: 'chatanywhere',
    base_url: (input.base_url ?? DEFAULT_LLM_CONFIG.base_url).trim(),
    api_key: (input.api_key ?? '').trim(),
    model: (input.model ?? DEFAULT_LLM_CONFIG.model).trim(),
    temperature: Math.max(0, Math.min(2, tempRaw))
  };
};

export const emitLlmConfigUpdated = () => {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(new CustomEvent(LLM_CONFIG_UPDATED_EVENT));
};

export const maskApiKey = (key: string): string => {
  if (!key) {
    return 'Not set';
  }

  if (key.length <= 8) {
    return '*'.repeat(key.length);
  }

  return `${key.slice(0, 4)}...${key.slice(-4)}`;
};
