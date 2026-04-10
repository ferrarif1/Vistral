import { randomBytes, scryptSync } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const now = () => new Date().toISOString();

const appStatePath = path.resolve(
  process.cwd(),
  (process.env.APP_STATE_STORE_PATH ?? '.data/app-state.json').trim()
);
const uploadRoot = path.resolve(
  process.cwd(),
  (process.env.UPLOAD_STORAGE_ROOT ?? '.data/uploads').trim()
);
const trainingWorkdirRoot = path.resolve(
  process.cwd(),
  (process.env.TRAINING_WORKDIR_ROOT ?? '.data/training-jobs').trim()
);
const modelExportRoot = path.resolve(
  process.cwd(),
  (process.env.MODEL_EXPORT_ROOT ?? '.data/model-exports').trim()
);
const runtimeLocalPredictRoot = path.resolve(
  process.cwd(),
  '.data/runtime-local-predict'
);
const resetFoundationPurgeStorage = (process.env.RESET_FOUNDATION_PURGE_STORAGE ?? '1').trim() !== '0';

const foundationModelNames = new Set(['Road Damage Detector', 'Invoice OCR Assistant']);

const hashPassword = (password) => {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
};

const readExistingState = async () => {
  try {
    const raw = await fs.readFile(appStatePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : '';
    if (code === 'ENOENT') {
      return {};
    }
    throw error;
  }
};

const purgeDirectoryContents = async (targetDir) => {
  try {
    const entries = await fs.readdir(targetDir, { withFileTypes: true });
    let removedEntries = 0;
    for (const entry of entries) {
      await fs.rm(path.join(targetDir, entry.name), { recursive: true, force: true });
      removedEntries += 1;
    }
    return removedEntries;
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : '';
    if (code === 'ENOENT') {
      return 0;
    }
    throw error;
  }
};

const toString = (value) => (typeof value === 'string' ? value.trim() : '');

const ensureUsersAndHashes = (state) => {
  const sourceUsers = Array.isArray(state.users) ? state.users : [];
  const sourceHashes =
    state.userPasswordHashes && typeof state.userPasswordHashes === 'object' && !Array.isArray(state.userPasswordHashes)
      ? { ...state.userPasswordHashes }
      : {};

  const normalizedUsers = sourceUsers
    .filter((user) => user && typeof user === 'object')
    .map((user) => {
      const username = toString(user.username);
      const role = user.role === 'admin' ? 'admin' : 'user';
      const status = user.status === 'disabled' ? 'disabled' : 'active';
      const userId = toString(user.id);
      if (!username || !userId) {
        return null;
      }
      return {
        id: userId,
        username,
        role,
        status,
        status_reason: status === 'disabled' ? toString(user.status_reason) || null : null,
        capabilities:
          role === 'admin' ? ['manage_models', 'global_governance'] : ['manage_models'],
        last_login_at: toString(user.last_login_at) || null,
        created_at: toString(user.created_at) || now(),
        updated_at: now()
      };
    })
    .filter(Boolean);

  const byUsername = new Map(normalizedUsers.map((user) => [user.username.toLowerCase(), user]));
  const timestamp = now();
  const defaults = [
    {
      id: 'u-1',
      username: 'alice',
      role: 'user',
      status: 'active',
      status_reason: null,
      capabilities: ['manage_models'],
      last_login_at: null,
      created_at: timestamp,
      updated_at: timestamp
    },
    {
      id: 'u-2',
      username: 'admin',
      role: 'admin',
      status: 'active',
      status_reason: null,
      capabilities: ['manage_models', 'global_governance'],
      last_login_at: null,
      created_at: timestamp,
      updated_at: timestamp
    }
  ];

  for (const candidate of defaults) {
    if (!byUsername.has(candidate.username.toLowerCase())) {
      normalizedUsers.push(candidate);
      byUsername.set(candidate.username.toLowerCase(), candidate);
    }
  }

  const passwordsByUsername = {
    alice: (process.env.DEFAULT_USER_PASSWORD ?? 'mock-pass').trim() || 'mock-pass',
    admin: (process.env.DEFAULT_ADMIN_PASSWORD ?? 'mock-pass-admin').trim() || 'mock-pass-admin'
  };

  const passwordHashes = {};
  for (const user of normalizedUsers) {
    const existing = toString(sourceHashes[user.id]);
    if (existing) {
      passwordHashes[user.id] = existing;
      continue;
    }
    const fallbackPassword = passwordsByUsername[user.username.toLowerCase()] ?? 'mock-pass';
    passwordHashes[user.id] = hashPassword(fallbackPassword);
  }

  return {
    users: normalizedUsers,
    userPasswordHashes: passwordHashes
  };
};

const ensureFoundationModels = (state, users) => {
  const sourceModels = Array.isArray(state.models) ? state.models : [];
  const ownerId =
    users.find((user) => user.username.toLowerCase() === 'alice')?.id ??
    users[0]?.id ??
    'u-1';
  const timestamp = now();

  const foundationFromState = sourceModels
    .filter((model) => model && typeof model === 'object')
    .filter((model) => foundationModelNames.has(toString(model.name)))
    .map((model) => ({
      id: toString(model.id) || `m-foundation-${Math.random().toString(36).slice(2, 8)}`,
      name: toString(model.name),
      description:
        toString(model.description) ||
        (toString(model.name) === 'Invoice OCR Assistant'
          ? 'Curated foundation model baseline for OCR workflows.'
          : 'Curated foundation model baseline for detection workflows.'),
      model_type: toString(model.model_type) || (toString(model.name) === 'Invoice OCR Assistant' ? 'ocr' : 'detection'),
      owner_user_id: toString(model.owner_user_id) || ownerId,
      visibility: toString(model.visibility) || 'workspace',
      status: toString(model.status) || 'published',
      metadata: {
        ...(model.metadata && typeof model.metadata === 'object' && !Array.isArray(model.metadata)
          ? model.metadata
          : {}),
        foundation: true
      },
      created_at: toString(model.created_at) || timestamp,
      updated_at: timestamp
    }));

  const modelByName = new Map(foundationFromState.map((model) => [model.name, model]));
  if (!modelByName.has('Road Damage Detector')) {
    foundationFromState.push({
      id: 'm-foundation-yolo',
      name: 'Road Damage Detector',
      description: 'Curated foundation model baseline for detection workflows.',
      model_type: 'detection',
      owner_user_id: ownerId,
      visibility: 'workspace',
      status: 'published',
      metadata: { framework: 'yolo', foundation: true },
      created_at: timestamp,
      updated_at: timestamp
    });
  }
  if (!modelByName.has('Invoice OCR Assistant')) {
    foundationFromState.push({
      id: 'm-foundation-ocr',
      name: 'Invoice OCR Assistant',
      description: 'Curated foundation model baseline for OCR workflows.',
      model_type: 'ocr',
      owner_user_id: ownerId,
      visibility: 'workspace',
      status: 'published',
      metadata: { framework: 'paddleocr', foundation: true },
      created_at: timestamp,
      updated_at: timestamp
    });
  }

  return foundationFromState;
};

const main = async () => {
  const existingState = await readExistingState();
  const { users, userPasswordHashes } = ensureUsersAndHashes(existingState);
  const models = ensureFoundationModels(existingState, users);

  const nextState = {
    users,
    userPasswordHashes,
    models,
    conversations: [],
    messages: [],
    attachments: [],
    datasets: [],
    datasetItems: [],
    annotations: [],
    annotationReviews: [],
    datasetVersions: [],
    trainingJobs: [],
    trainingWorkerNodes: [],
    trainingWorkerBootstrapSessions: [],
    trainingWorkerAuthTokensByWorkerId: {},
    trainingMetrics: [],
    modelVersions: [],
    inferenceRuns: [],
    approvalRequests: [],
    auditLogs: []
  };

  await fs.mkdir(path.dirname(appStatePath), { recursive: true });
  await fs.writeFile(appStatePath, JSON.stringify(nextState, null, 2), 'utf8');

  const storageCleanup = {
    enabled: resetFoundationPurgeStorage,
    upload_removed_entries: 0,
    training_workdir_removed_entries: 0,
    model_export_removed_entries: 0,
    runtime_local_predict_removed_entries: 0
  };
  if (resetFoundationPurgeStorage) {
    storageCleanup.upload_removed_entries = await purgeDirectoryContents(uploadRoot);
    storageCleanup.training_workdir_removed_entries = await purgeDirectoryContents(trainingWorkdirRoot);
    storageCleanup.model_export_removed_entries = await purgeDirectoryContents(modelExportRoot);
    storageCleanup.runtime_local_predict_removed_entries = await purgeDirectoryContents(
      runtimeLocalPredictRoot
    );
  }

  const summary = {
    app_state_path: appStatePath,
    users_kept: nextState.users.length,
    models_kept: nextState.models.length,
    models: nextState.models.map((model) => model.name),
    datasets_removed: true,
    training_removed: true,
    inference_removed: true,
    storage_cleanup: storageCleanup
  };
  globalThis.console.log(JSON.stringify(summary, null, 2));
};

main().catch((error) => {
  globalThis.console.error(
    '[reset-app-state-foundation] failed:',
    error instanceof Error ? error.message : String(error)
  );
  process.exitCode = 1;
});
