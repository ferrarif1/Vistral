import type {
  VisionTaskAgentDecisionLogEntry,
  VisionTaskAgentRecommendation,
  TrainingJobRecord,
  VisionModelingTaskRecord
} from '../../shared/domain';

const now = () => new Date().toISOString();

export const sameVisionTaskRecommendationMeaning = (
  left: VisionTaskAgentRecommendation | null,
  right: VisionTaskAgentRecommendation
): boolean => {
  if (!left) {
    return false;
  }
  return (
    left.action === right.action &&
    left.title === right.title &&
    left.summary === right.summary &&
    left.reason === right.reason &&
    left.requires_confirmation === right.requires_confirmation &&
    JSON.stringify(left.blocking_items) === JSON.stringify(right.blocking_items) &&
    JSON.stringify(left.evidence) === JSON.stringify(right.evidence)
  );
};

export const appendVisionTaskDecisionLog = (
  task: VisionModelingTaskRecord,
  entry: VisionTaskAgentDecisionLogEntry
): boolean => {
  const head = task.agent_decision_log[0] ?? null;
  if (
    head &&
    head.action === entry.action &&
    head.outcome === entry.outcome &&
    head.summary === entry.summary &&
    head.reason === entry.reason
  ) {
    return false;
  }
  task.agent_decision_log = [entry, ...task.agent_decision_log].slice(0, 24);
  return true;
};

export const buildVisionTaskDecisionEvidenceRefs = (
  task: VisionModelingTaskRecord,
  extraRefs: string[] = []
): string[] => {
  const refs = [
    task.dataset_id ? `dataset:${task.dataset_id}` : '',
    task.dataset_version_id ? `dataset_version:${task.dataset_version_id}` : '',
    task.training_job_id ? `training_job:${task.training_job_id}` : '',
    task.model_id ? `model:${task.model_id}` : '',
    task.model_version_id ? `model_version:${task.model_version_id}` : '',
    (task.metadata.feedback_dataset_id ?? '').trim()
      ? `dataset:${(task.metadata.feedback_dataset_id ?? '').trim()}`
      : '',
    ...extraRefs
  ]
    .map((ref) => ref.trim())
    .filter((ref) => ref.length > 0);
  return [...new Set(refs)];
};

export const buildVisionTaskAgentRecommendation = (input: {
  task: VisionModelingTaskRecord;
  currentJob: TrainingJobRecord | null;
  evidence: string[];
  createdAt?: string;
}): VisionTaskAgentRecommendation => {
  const { task, currentJob, evidence } = input;
  const feedbackDatasetId = (task.metadata.feedback_dataset_id ?? '').trim();
  const gate = task.promotion_gate;
  const comparison = task.run_comparison;
  const passStatus = gate?.status ?? task.validation_report?.summary.pass_status ?? 'needs_review';
  const base = {
    blocking_items: [] as string[],
    evidence,
    created_at: input.createdAt ?? now()
  };

  if (task.missing_requirements.length > 0) {
    return {
      action: 'requires_input',
      title: 'Missing requirements',
      summary: 'Provide the missing requirements before the agent can continue.',
      reason: 'The task is still blocked by missing inputs or unresolved dataset readiness requirements.',
      blocking_items: [...task.missing_requirements],
      requires_confirmation: false,
      evidence: evidence.length > 0 ? evidence : ['task understanding is still incomplete'],
      created_at: base.created_at
    };
  }

  if (
    currentJob &&
    currentJob.status !== 'completed' &&
    currentJob.status !== 'failed' &&
    currentJob.status !== 'cancelled'
  ) {
    return {
      action: 'wait_training',
      title: 'Training is in progress',
      summary: 'Wait for the active training run to finish before choosing the next mutation.',
      reason: 'A linked training run is still active, so the next safe step is to observe rather than mutate.',
      ...base,
      requires_confirmation: false
    };
  }

  if (!task.training_job_id) {
    return {
      action: 'start_training',
      title: 'Ready to launch training',
      summary: 'The task has enough structure to start the first training round.',
      reason: 'Dataset context and task understanding are present, so the next productive step is to launch training.',
      ...base,
      requires_confirmation: true
    };
  }

  if (!task.model_version_id && passStatus === 'pass') {
    return {
      action: 'register_model',
      title: 'Register the model version',
      summary:
        comparison?.summary ??
        'Metrics passed the current gate; the next step is to register the resulting model version.',
      reason:
        gate?.reason ??
        'The linked training job already meets the current validation threshold, so promotion is safer than launching another round.',
      ...base,
      requires_confirmation: true
    };
  }

  if (!task.model_version_id) {
    if (gate?.status === 'needs_review' && gate.reason.toLowerCase().includes('artifact')) {
      return {
        action: 'fix_runtime',
        title: 'Enable real training evidence',
        summary: gate.summary,
        reason: gate.reason,
        blocking_items: [
          'real_training_artifact_required',
          'enable VISTRAL_RUNNER_ENABLE_REAL=1',
          'configure local model path/dependencies or online worker'
        ],
        evidence,
        created_at: base.created_at,
        requires_confirmation: false
      };
    }
    if (comparison?.decision === 'collect_data') {
      return {
        action: 'collect_data',
        title: comparison.title,
        summary: comparison.summary,
        reason: comparison.reason,
        ...base,
        requires_confirmation: false
      };
    }
    const currentJobStatus = currentJob?.status ?? 'completed';
    return {
      action: 'start_training',
      title: 'Run the next training round',
      summary:
        comparison?.summary ??
        'The current metrics are still below the target gate, so the agent recommends another round.',
      reason:
        comparison?.reason ??
        `The latest linked run ended with ${currentJobStatus} and the validation result is ${passStatus}.`,
      ...base,
      requires_confirmation: true
    };
  }

  if (!feedbackDatasetId) {
    return {
      action: 'mine_feedback',
      title: 'Mine a feedback dataset',
      summary:
        task.active_learning_pool?.summary ??
        'The model version is registered. Next, collect low-confidence runs into a feedback dataset.',
      reason:
        task.active_learning_pool && task.active_learning_pool.total_candidates > 0
          ? 'A clustered active-learning pool is already available, so feedback mining is the highest-leverage next step.'
          : 'Closing the data loop is the highest-value next step once a model version already exists.',
      ...base,
      requires_confirmation: true
    };
  }

  return {
    action: 'completed',
    title: 'Closed loop is ready',
    summary: 'Training, registration, and feedback dataset creation are already linked on this task.',
    reason: 'The task has a linked model version and feedback dataset, so the workflow is ready for iterative reuse rather than a forced next mutation.',
    ...base,
    requires_confirmation: false
  };
};

export const recordVisionTaskAgentOutcome = (
  task: VisionModelingTaskRecord,
  action: VisionTaskAgentDecisionLogEntry['action'],
  outcome: VisionTaskAgentDecisionLogEntry['outcome'],
  summary: string,
  reason: string,
  options: {
    source_layer?: VisionTaskAgentDecisionLogEntry['source_layer'];
    evidence_refs?: string[];
  } = {}
): boolean =>
  appendVisionTaskDecisionLog(task, {
    action,
    outcome,
    summary,
    reason,
    created_at: now(),
    ...(options.source_layer ? { source_layer: options.source_layer } : {}),
    ...(options.evidence_refs
      ? { evidence_refs: buildVisionTaskDecisionEvidenceRefs(task, options.evidence_refs) }
      : {})
  });
