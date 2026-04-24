import { strict as assert } from 'node:assert';
import type { ConversationActionMetadata } from '../shared/domain';
import {
  buildConversationActionNextStepInput,
  deriveConversationActionNextSteps,
  type ConversationActionNextStep
} from '../src/features/conversationActionNextSteps';

const t = (source: string) => source;

const action = (overrides: Partial<ConversationActionMetadata>): ConversationActionMetadata => ({
  action: 'console_api_call',
  status: 'failed',
  summary: '',
  missing_fields: [],
  collected_fields: {},
  ...overrides,
  collected_fields: {
    ...(overrides.collected_fields ?? {})
  }
});

const stepById = (steps: ConversationActionNextStep[], id: string): ConversationActionNextStep | undefined =>
  steps.find((step) => step.id === id);

const requireStep = (steps: ConversationActionNextStep[], id: string): ConversationActionNextStep => {
  const step = stepById(steps, id);
  assert.ok(step, `expected step ${id}`);
  return step;
};

const parseOpsInput = (input: string): { api: string; params: Record<string, string> } => {
  assert.ok(input.startsWith('/ops '), 'expected /ops input');
  return JSON.parse(input.slice('/ops '.length)) as { api: string; params: Record<string, string> };
};

const failedWorkerSteps = deriveConversationActionNextSteps(
  action({
    summary: 'Worker heartbeat timeout while retrying training job tj-guard-1.',
    collected_fields: {
      api: 'retry_training_job',
      training_job_id: 'tj-guard-1',
      status: 'failed'
    }
  }),
  t
);
const retryStep = requireStep(failedWorkerSteps, 'retry-control-plane');
assert.equal(retryStep.kind, 'ops');
assert.equal(retryStep.api, 'retry_training_job');
assert.deepEqual(retryStep.params, {
  job_id: 'tj-guard-1',
  execution_target: 'control_plane'
});
assert.deepEqual(parseOpsInput(buildConversationActionNextStepInput(retryStep)), {
  api: 'retry_training_job',
  params: {
    job_id: 'tj-guard-1',
    execution_target: 'control_plane'
  }
});
assert.equal(requireStep(failedWorkerSteps, 'open-worker-settings').href, '/settings/workers');
assert.ok(
  requireStep(failedWorkerSteps, 'open-training-logs').href?.startsWith('/training/jobs/tj-guard-1?evidence=logs'),
  'expected training log deep link for worker failure'
);

const runtimeSteps = deriveConversationActionNextSteps(
  action({
    summary: 'ImportError: No module named paddleocr; template fallback blocked local command execution.',
    collected_fields: {
      job_id: 'tj-runtime-1',
      status: 'failed'
    }
  }),
  t
);
assert.equal(requireStep(runtimeSteps, 'open-runtime-settings').href, '/settings/runtime');
assert.equal(requireStep(runtimeSteps, 'retry-control-plane').params?.execution_target, 'control_plane');

const completedSteps = deriveConversationActionNextSteps(
  action({
    action: 'create_training_job',
    status: 'completed',
    summary: 'Training job created successfully.',
    collected_fields: {
      status: 'completed'
    },
    created_entity_type: 'TrainingJob',
    created_entity_id: 'tj-complete-1',
    created_entity_label: 'Completed OCR run'
  }),
  t
);
assert.equal(stepById(completedSteps, 'retry-control-plane'), undefined);
assert.equal(requireStep(completedSteps, 'open-training-logs').href, '/training/jobs/tj-complete-1?evidence=logs');

const genericFailedSteps = deriveConversationActionNextSteps(
  action({
    action: 'create_training_job',
    summary: 'Training failed before a job id could be resolved.'
  }),
  t
);
const reviewStep = requireStep(genericFailedSteps, 'review-card-summary');
assert.equal(reviewStep.kind, 'none');
assert.equal(buildConversationActionNextStepInput(reviewStep), '');

const datasetSteps = deriveConversationActionNextSteps(
  action({
    action: 'create_dataset',
    summary: 'Dataset creation failed.',
    collected_fields: {
      status: 'failed'
    }
  }),
  t
);
assert.equal(datasetSteps.length, 0);

console.log('[smoke-conversation-next-steps] PASS');
