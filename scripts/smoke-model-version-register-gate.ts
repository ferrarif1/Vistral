import { strict as assert } from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { registerModelVersion, runAsUser } from '../backend/src/handlers';
import { attachments, modelVersions, trainingJobs } from '../backend/src/store';
import type { FileAttachment, TrainingJobRecord } from '../shared/domain';

const removeById = <T extends { id: string }>(items: T[], id: string): void => {
  const index = items.findIndex((item) => item.id === id);
  if (index >= 0) {
    items.splice(index, 1);
  }
};

const run = async () => {
  const baselineVersionCount = modelVersions.length;
  let simulatedBlocked = false;
  let simulatedBlockedMessage = '';
  let templateBlocked = false;
  let templateBlockedMessage = '';
  const nowTs = Date.now();
  const templateJobId = `tj-smoke-template-${nowTs}`;
  const templateAttachmentId = `f-smoke-template-artifact-${nowTs}`;
  const templateArtifactRoot = path.join(os.tmpdir(), `vistral-smoke-register-gate-${nowTs}`);
  const templateArtifactPath = path.join(
    templateArtifactRoot,
    templateJobId,
    'artifacts',
    `${templateJobId}.artifact.json`
  );

  try {
    await runAsUser('u-1', async () =>
      registerModelVersion({
        model_id: 'm-1',
        training_job_id: 'tj-ocr-1',
        version_name: `smoke-simulated-block-${Date.now()}`
      })
    );
  } catch (error) {
    simulatedBlocked = true;
    simulatedBlockedMessage = error instanceof Error ? error.message : String(error);
  }

  assert.equal(
    simulatedBlocked,
    true,
    'simulated execution_mode training job should be blocked from registration'
  );
  assert.match(
    simulatedBlockedMessage,
    /execution_mode=local_command/i,
    'blocked error should explain local_command requirement'
  );

  const seedTemplateSource = trainingJobs.find((item) => item.id === 'tj-ocr-1');
  assert.ok(seedTemplateSource, 'seed training job tj-ocr-1 should exist');

  const timestamp = new Date().toISOString();
  const templateJob: TrainingJobRecord = {
    ...seedTemplateSource,
    id: templateJobId,
    status: 'completed',
    execution_mode: 'local_command',
    log_excerpt: 'smoke-template-artifact',
    created_at: timestamp,
    updated_at: timestamp,
    scheduler_decision_history: [...seedTemplateSource.scheduler_decision_history]
  };
  const templateAttachment: FileAttachment = {
    id: templateAttachmentId,
    filename: `${templateJobId}.artifact.json`,
    status: 'ready',
    owner_user_id: 'u-1',
    attached_to_type: 'Model',
    attached_to_id: null,
    mime_type: 'application/json',
    byte_size: null,
    storage_backend: 'local',
    storage_path: templateArtifactPath,
    upload_error: null,
    created_at: timestamp,
    updated_at: timestamp
  };

  trainingJobs.unshift(templateJob);
  attachments.unshift(templateAttachment);
  await fs.mkdir(path.dirname(templateArtifactPath), { recursive: true });
  await fs.writeFile(
    templateArtifactPath,
    JSON.stringify(
      {
        runner: 'paddleocr_train_runner',
        mode: 'template',
        fallback_reason: 'smoke_template_mode',
        training_performed: false,
        generated_at: timestamp,
        metrics: { accuracy: 0.8123 }
      },
      null,
      2
    ),
    'utf8'
  );

  try {
    await runAsUser('u-1', async () =>
      registerModelVersion({
        model_id: 'm-1',
        training_job_id: templateJobId,
        version_name: `smoke-template-block-${Date.now()}`
      })
    );
  } catch (error) {
    templateBlocked = true;
    templateBlockedMessage = error instanceof Error ? error.message : String(error);
  } finally {
    modelVersions
      .filter((item) => item.training_job_id === templateJobId)
      .forEach((item) => removeById(modelVersions, item.id));
    removeById(trainingJobs, templateJobId);
    removeById(attachments, templateAttachmentId);
    await fs.rm(templateArtifactRoot, { recursive: true, force: true });
  }

  assert.equal(
    templateBlocked,
    true,
    'local_command training job with template artifact evidence should be blocked from registration'
  );
  assert.match(
    templateBlockedMessage,
    /non-real local execution evidence/i,
    'blocked error should explain non-real local-command evidence'
  );
  assert.match(
    templateBlockedMessage,
    /mode=template/i,
    'blocked error should include template mode detail'
  );
  assert.equal(modelVersions.length, baselineVersionCount, 'blocked registration must not append model versions');

  console.log('[smoke-model-version-register-gate] PASS');
  console.log(
    JSON.stringify(
      {
        simulated_blocked_message: simulatedBlockedMessage,
        template_blocked_message: templateBlockedMessage,
        version_count_before: baselineVersionCount,
        version_count_after: modelVersions.length
      },
      null,
      2
    )
  );
};

run().catch((error) => {
  console.error(
    '[smoke-model-version-register-gate] failed:',
    error instanceof Error ? error.message : String(error)
  );
  process.exitCode = 1;
});
