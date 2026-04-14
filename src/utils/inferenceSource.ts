import type { InferenceRunRecord } from '../../shared/domain';

const fallbackSourcePattern = /(fallback|template|mock|base_empty)/i;

const parseBooleanLike = (value: unknown): boolean => {
  if (value === true) {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0;
  }
  if (typeof value !== 'string') {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
};

const getRawOutput = (run: Pick<InferenceRunRecord, 'raw_output'>): Record<string, unknown> =>
  run.raw_output && typeof run.raw_output === 'object' && !Array.isArray(run.raw_output)
    ? (run.raw_output as Record<string, unknown>)
    : {};

const getNormalizedSource = (
  run: Pick<InferenceRunRecord, 'normalized_output'>
): string => {
  const source = run.normalized_output?.normalized_output?.source;
  return typeof source === 'string' && source.trim() ? source.trim() : '';
};

const getRawMeta = (rawOutput: Record<string, unknown>): Record<string, unknown> | null =>
  rawOutput.meta && typeof rawOutput.meta === 'object' && !Array.isArray(rawOutput.meta)
    ? (rawOutput.meta as Record<string, unknown>)
    : null;

export const isFallbackExecutionSource = (source: string | undefined | null): boolean =>
  typeof source === 'string' && fallbackSourcePattern.test(source.trim());

export const resolveInferenceRunFallbackReason = (
  run: Pick<InferenceRunRecord, 'raw_output'>
): string | null => {
  const rawOutput = getRawOutput(run);
  const directCandidates = [
    rawOutput.runtime_fallback_reason,
    rawOutput.local_command_fallback_reason
  ];
  for (const candidate of directCandidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  const rawMeta = getRawMeta(rawOutput);
  const metaReason = rawMeta?.fallback_reason;
  if (typeof metaReason === 'string' && metaReason.trim()) {
    return metaReason.trim();
  }
  return null;
};

export const hasInferenceRunFallbackEvidence = (
  run: Pick<InferenceRunRecord, 'raw_output'>
): boolean => {
  const rawOutput = getRawOutput(run);
  if (resolveInferenceRunFallbackReason(run)) {
    return true;
  }
  const rawMeta = getRawMeta(rawOutput);
  if (typeof rawMeta?.mode === 'string' && rawMeta.mode.trim().toLowerCase() === 'template') {
    return true;
  }
  return parseBooleanLike(rawOutput.local_command_template_mode);
};

export const resolveInferenceRunSource = (
  run: Pick<InferenceRunRecord, 'execution_source' | 'normalized_output' | 'raw_output'>
): string => {
  const executionSource =
    typeof run.execution_source === 'string' && run.execution_source.trim()
      ? run.execution_source.trim()
      : '';
  const normalizedSource = getNormalizedSource(run);
  const baseSource = executionSource || normalizedSource || 'unknown';
  if (isFallbackExecutionSource(baseSource)) {
    return baseSource;
  }
  if (!hasInferenceRunFallbackEvidence(run)) {
    return baseSource;
  }
  return baseSource === 'unknown' ? 'explicit_fallback_detected' : `${baseSource}_fallback`;
};

export const detectInferenceRunReality = (
  run: Pick<InferenceRunRecord, 'execution_source' | 'normalized_output' | 'raw_output'>
): { fallback: boolean; reason: string | null; source: string } => {
  const source = resolveInferenceRunSource(run);
  const reason = resolveInferenceRunFallbackReason(run);
  return {
    source,
    fallback: isFallbackExecutionSource(source) || Boolean(reason) || hasInferenceRunFallbackEvidence(run),
    reason
  };
};

