import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = process.cwd();
const appStatePath = path.resolve(
  repoRoot,
  (process.env.APP_STATE_STORE_PATH ?? '.data/app-state.json').trim()
);
const uploadRoot = path.resolve(repoRoot, (process.env.UPLOAD_STORAGE_ROOT ?? '.data/uploads').trim());
const verificationReportsDir = path.resolve(
  repoRoot,
  (process.env.VERIFICATION_REPORTS_DIR ?? '.data/verify-reports').trim()
);
const trainingWorkdirRoot = path.resolve(
  repoRoot,
  (process.env.TRAINING_WORKDIR_ROOT ?? '.data/training-jobs').trim()
);
const keepVerificationReportGroups = Math.max(
  Number.parseInt(process.env.KEEP_VERIFY_REPORT_GROUPS ?? '2', 10) || 2,
  1
);

const readJsonFile = async (targetPath) => {
  const raw = await fs.readFile(targetPath, 'utf8');
  return JSON.parse(raw);
};

const pathExists = async (targetPath) => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const listFilesRecursively = async (targetDir) => {
  if (!(await pathExists(targetDir))) {
    return [];
  }

  const entries = await fs.readdir(targetDir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(targetDir, entry.name);
      if (entry.isDirectory()) {
        return listFilesRecursively(fullPath);
      }
      if (entry.isFile()) {
        return [fullPath];
      }
      return [];
    })
  );

  return nested.flat();
};

const removeEmptyDirectories = async (targetDir) => {
  if (!(await pathExists(targetDir))) {
    return 0;
  }

  let removed = 0;
  const entries = await fs.readdir(targetDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const fullPath = path.join(targetDir, entry.name);
    removed += await removeEmptyDirectories(fullPath);

    const remaining = await fs.readdir(fullPath);
    if (remaining.length === 0) {
      await fs.rmdir(fullPath);
      removed += 1;
    }
  }

  return removed;
};

const deleteFiles = async (files) => {
  let removed = 0;
  for (const filePath of files) {
    if (!(await pathExists(filePath))) {
      continue;
    }
    await fs.rm(filePath, { force: true });
    removed += 1;
  }
  return removed;
};

const main = async () => {
  const state = await readJsonFile(appStatePath);
  const attachments = Array.isArray(state.attachments) ? state.attachments : [];
  const trainingJobs = Array.isArray(state.trainingJobs) ? state.trainingJobs : [];

  const referencedUploadBasenames = new Set(
    attachments
      .map((attachment) =>
        typeof attachment.storage_path === 'string' && attachment.storage_path.trim()
          ? path.basename(attachment.storage_path)
          : null
      )
      .filter(Boolean)
  );

  const uploadFiles = await listFilesRecursively(uploadRoot);
  const orphanedUploadFiles = uploadFiles.filter(
    (filePath) => !referencedUploadBasenames.has(path.basename(filePath))
  );
  const removedUploadFiles = await deleteFiles(orphanedUploadFiles);
  const removedUploadDirs = await removeEmptyDirectories(uploadRoot);

  const activeTrainingJobIds = new Set(
    trainingJobs
      .map((job) => (typeof job.id === 'string' ? job.id.trim() : ''))
      .filter(Boolean)
  );

  let removedTrainingWorkdirs = 0;
  if (await pathExists(trainingWorkdirRoot)) {
    const trainingEntries = await fs.readdir(trainingWorkdirRoot, { withFileTypes: true });
    for (const entry of trainingEntries) {
      if (!entry.isDirectory()) {
        continue;
      }

      if (activeTrainingJobIds.has(entry.name)) {
        continue;
      }

      await fs.rm(path.join(trainingWorkdirRoot, entry.name), { recursive: true, force: true });
      removedTrainingWorkdirs += 1;
    }
  }

  let removedVerificationReportFiles = 0;
  let keptVerificationReportGroups = 0;
  if (await pathExists(verificationReportsDir)) {
    const reportEntries = await fs.readdir(verificationReportsDir, { withFileTypes: true });
    const reportFiles = reportEntries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left));

    const groupMap = new Map();
    for (const filename of reportFiles) {
      const extension = path.extname(filename);
      const groupKey = filename.slice(0, filename.length - extension.length);
      const files = groupMap.get(groupKey) ?? [];
      files.push(filename);
      groupMap.set(groupKey, files);
    }

    const orderedGroupKeys = Array.from(groupMap.keys()).sort((left, right) =>
      right.localeCompare(left)
    );
    const keptGroups = new Set(orderedGroupKeys.slice(0, keepVerificationReportGroups));
    keptVerificationReportGroups = keptGroups.size;

    for (const [groupKey, files] of groupMap.entries()) {
      if (keptGroups.has(groupKey)) {
        continue;
      }

      for (const filename of files) {
        await fs.rm(path.join(verificationReportsDir, filename), { force: true });
        removedVerificationReportFiles += 1;
      }
    }
  }

  const summary = {
    app_state_path: appStatePath,
    removed_upload_files: removedUploadFiles,
    removed_upload_dirs: removedUploadDirs,
    removed_training_workdirs: removedTrainingWorkdirs,
    removed_verification_report_files: removedVerificationReportFiles,
    kept_verification_report_groups: keptVerificationReportGroups,
    active_training_jobs: Array.from(activeTrainingJobIds),
    referenced_upload_files: referencedUploadBasenames.size
  };

  globalThis.console.log(JSON.stringify(summary, null, 2));
};

main().catch((error) => {
  globalThis.console.error(
    '[prune-prototype-data] failed:',
    error instanceof Error ? error.message : String(error)
  );
  process.exitCode = 1;
});
