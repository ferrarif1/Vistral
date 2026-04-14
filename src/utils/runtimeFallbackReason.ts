export type RuntimeFallbackReasonBucket =
  | 'runtime_unreachable'
  | 'runner_command_unavailable'
  | 'dependency_missing'
  | 'model_artifact_unavailable'
  | 'template_mode'
  | 'unspecified'
  | 'needs_runtime_troubleshooting';

export const bucketRuntimeFallbackReason = (
  reason: string | null | undefined
): RuntimeFallbackReasonBucket => {
  const normalized = typeof reason === 'string' ? reason.trim().toLowerCase() : '';
  if (!normalized || normalized === 'unspecified_non_real_evidence' || normalized === 'unspecified_runtime_fallback') {
    return 'unspecified';
  }
  if (
    normalized.includes('fetch failed') ||
    normalized.includes('endpoint unavailable') ||
    normalized.includes('endpoint unreachable') ||
    normalized.includes('connection refused') ||
    normalized.includes('timed out')
  ) {
    return 'runtime_unreachable';
  }
  if (
    normalized.includes('spawn') ||
    normalized.includes('enoent') ||
    normalized.includes('attempted_command') ||
    normalized.includes('local command')
  ) {
    return 'runner_command_unavailable';
  }
  if (
    normalized.includes('import_') ||
    normalized.includes('no module named') ||
    normalized.includes('module not found') ||
    normalized.includes('dependency')
  ) {
    return 'dependency_missing';
  }
  if (
    normalized.includes('model_path_not_found') ||
    normalized.includes('artifact') ||
    normalized.includes('weights') ||
    normalized.includes('model path')
  ) {
    return 'model_artifact_unavailable';
  }
  if (normalized.includes('template')) {
    return 'template_mode';
  }
  return 'needs_runtime_troubleshooting';
};

export const runtimeFallbackReasonLabelKey = (bucket: RuntimeFallbackReasonBucket): string => {
  if (bucket === 'runtime_unreachable') {
    return 'Runtime endpoint unavailable';
  }
  if (bucket === 'runner_command_unavailable') {
    return 'Local runner command unavailable';
  }
  if (bucket === 'dependency_missing') {
    return 'Runtime dependency missing';
  }
  if (bucket === 'model_artifact_unavailable') {
    return 'Model artifact unavailable';
  }
  if (bucket === 'template_mode') {
    return 'Template-mode fallback';
  }
  if (bucket === 'unspecified') {
    return 'No explicit fallback reason';
  }
  return 'Needs runtime troubleshooting';
};
