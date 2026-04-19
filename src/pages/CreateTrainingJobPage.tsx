import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type {
  DatasetRecord,
  DatasetVersionRecord,
  RequirementTaskDraft,
  TrainingWorkerNodeView
} from '../../shared/domain';
import AdvancedSection from '../components/AdvancedSection';
import StateBlock from '../components/StateBlock';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { InlineAlert, PageHeader } from '../components/ui/ConsolePage';
import { Input, Select, Textarea } from '../components/ui/Field';
import ProgressStepper from '../components/ui/ProgressStepper';
import { Card, Panel } from '../components/ui/Surface';
import {
  WorkspacePage,
  WorkspaceSectionHeader,
  WorkspaceWorkbench
} from '../components/ui/WorkspacePage';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

const curatedBaseModelCatalog = {
  paddleocr: ['paddleocr-PP-OCRv4'],
  doctr: ['doctr-crnn-vitstr-base'],
  yolo: ['yolo11n']
} as const;
const taskTypeOptions = ['ocr', 'detection', 'classification', 'segmentation', 'obb'] as const;
const adminAccessMessagePattern = /(forbidden|permission|unauthorized|not allowed|admin|管理员|权限)/i;

type TrainingFramework = keyof typeof curatedBaseModelCatalog;
const formatCoveragePercent = (value: number) => `${Math.round(value * 100)}%`;
const parsePositiveInteger = (value: string): number | null => {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    return null;
  }
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const parseNonNegativeNumber = (value: string): number | null => {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const parsePositiveNumber = (value: string): number | null => {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

export default function CreateTrainingJobPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const preferredTaskType = (searchParams.get('task_type') ?? searchParams.get('model_type') ?? '').trim();
  const preferredExecutionTargetRaw = (searchParams.get('execution_target') ?? '').trim().toLowerCase();
  const preferredExecutionTarget =
    preferredExecutionTargetRaw === 'control_plane' || preferredExecutionTargetRaw === 'worker'
      ? preferredExecutionTargetRaw
      : 'auto';
  const preferredWorkerId = (searchParams.get('worker') ?? '').trim();

  const [datasets, setDatasets] = useState<DatasetRecord[]>([]);
  const [datasetVersions, setDatasetVersions] = useState<DatasetVersionRecord[]>([]);
  const [name, setName] = useState('');
  const [taskType, setTaskType] = useState<'ocr' | 'detection' | 'classification' | 'segmentation' | 'obb'>(() =>
    taskTypeOptions.includes(preferredTaskType as (typeof taskTypeOptions)[number])
      ? (preferredTaskType as (typeof taskTypeOptions)[number])
      : 'ocr'
  );
  const [framework, setFramework] = useState<TrainingFramework>('paddleocr');
  const [datasetId, setDatasetId] = useState('');
  const [datasetVersionId, setDatasetVersionId] = useState('');
  const [baseModel, setBaseModel] = useState('');
  const [epochs, setEpochs] = useState('20');
  const [batchSize, setBatchSize] = useState('16');
  const [learningRate, setLearningRate] = useState('0.001');
  const [warmupRatio, setWarmupRatio] = useState('0.1');
  const [weightDecay, setWeightDecay] = useState('0.0001');
  const [requirementDescription, setRequirementDescription] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [taskDraft, setTaskDraft] = useState<RequirementTaskDraft | null>(null);
  const [runtimeSettingsLoading, setRuntimeSettingsLoading] = useState(true);
  const [runtimeSettingsError, setRuntimeSettingsError] = useState('');
  const [runtimeDisableSimulatedTrainFallback, setRuntimeDisableSimulatedTrainFallback] = useState(false);
  const [dispatchPreference, setDispatchPreference] = useState<'auto' | 'control_plane' | 'worker'>(() =>
    preferredWorkerId ? 'worker' : preferredExecutionTarget
  );
  const [selectedWorkerId, setSelectedWorkerId] = useState(preferredWorkerId);
  const [workersLoading, setWorkersLoading] = useState(false);
  const [workers, setWorkers] = useState<TrainingWorkerNodeView[]>([]);
  const [workersAccessDenied, setWorkersAccessDenied] = useState(false);
  const [workersError, setWorkersError] = useState('');
  const [nonStrictLaunchConfirmed, setNonStrictLaunchConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ variant: 'success' | 'error'; text: string } | null>(null);
  const preferredDatasetId = (searchParams.get('dataset') ?? '').trim();
  const preferredVersionId = (searchParams.get('version') ?? '').trim();
  const preferredDatasetAppliedRef = useRef(false);
  const preferredVersionAppliedRef = useRef(false);
  const jobNameInputRef = useRef<HTMLInputElement | null>(null);
  const datasetSelectRef = useRef<HTMLSelectElement | null>(null);
  const datasetVersionSelectRef = useRef<HTMLSelectElement | null>(null);
  const paramsEpochsInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setLoading(true);
    api
      .listDatasets()
      .then((result) => {
        setDatasets(result);
        const preferredDataset =
          preferredDatasetId && !preferredDatasetAppliedRef.current
            ? result.find((dataset) => dataset.id === preferredDatasetId) ?? null
            : null;

        if (preferredDataset) {
          preferredDatasetAppliedRef.current = true;
          if (preferredDataset.task_type !== taskType) {
            setTaskType(preferredDataset.task_type);
          }
          setDatasetId(preferredDataset.id);
          return;
        }

        const first = result.find((dataset) => dataset.task_type === taskType);
        setDatasetId((current) =>
          current && result.some((dataset) => dataset.id === current && dataset.task_type === taskType)
            ? current
            : (first?.id ?? '')
        );
      })
      .catch((error) => setFeedback({ variant: 'error', text: (error as Error).message }))
      .finally(() => setLoading(false));
  }, [preferredDatasetId, taskType]);

  useEffect(() => {
    if (!datasetId) {
      setDatasetVersions([]);
      setDatasetVersionId('');
      return;
    }

    let active = true;
    setVersionsLoading(true);

    api
      .listDatasetVersions(datasetId)
      .then((result) => {
        if (!active) {
          return;
        }

        setDatasetVersions(result);
        const preferredVersion =
          preferredVersionId &&
          !preferredVersionAppliedRef.current &&
          result.find((version) => version.id === preferredVersionId)
            ? preferredVersionId
            : '';

        if (preferredVersion) {
          preferredVersionAppliedRef.current = true;
        }

        setDatasetVersionId((current) =>
          preferredVersion ||
          (current && result.some((version) => version.id === current) ? current : (result[0]?.id ?? ''))
        );
      })
      .catch((error) => {
        if (!active) {
          return;
        }
        setFeedback({ variant: 'error', text: (error as Error).message });
      })
      .finally(() => {
        if (active) {
          setVersionsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [datasetId, preferredVersionId]);

  useEffect(() => {
    if (taskType === 'ocr' && framework === 'yolo') {
      setFramework('paddleocr');
    }

    if (taskType !== 'ocr' && (framework === 'paddleocr' || framework === 'doctr')) {
      setFramework('yolo');
    }
  }, [framework, taskType]);

  useEffect(() => {
    let active = true;
    setRuntimeSettingsLoading(true);
    setRuntimeSettingsError('');
    api
      .getRuntimeSettings()
      .then((view) => {
        if (!active) {
          return;
        }
        setRuntimeDisableSimulatedTrainFallback(view.controls.disable_simulated_train_fallback);
      })
      .catch((error) => {
        if (!active) {
          return;
        }
        setRuntimeSettingsError((error as Error).message);
      })
      .finally(() => {
        if (active) {
          setRuntimeSettingsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setWorkersLoading(true);
    setWorkersError('');
    setWorkersAccessDenied(false);
    api
      .listTrainingWorkers()
      .then((inventory) => {
        if (!active) {
          return;
        }
        setWorkers(inventory);
      })
      .catch((error) => {
        if (!active) {
          return;
        }
        const message = (error as Error).message;
        setWorkers([]);
        if (adminAccessMessagePattern.test(message)) {
          setWorkersAccessDenied(true);
          setWorkersError('');
          return;
        }
        setWorkersError(message);
      })
      .finally(() => {
        if (active) {
          setWorkersLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (runtimeDisableSimulatedTrainFallback || runtimeSettingsError) {
      setNonStrictLaunchConfirmed(false);
    }
  }, [runtimeDisableSimulatedTrainFallback, runtimeSettingsError]);

  useEffect(() => {
    if (dispatchPreference !== 'worker' && selectedWorkerId) {
      setSelectedWorkerId('');
    }
  }, [dispatchPreference, selectedWorkerId]);

  const baseModelOptions = useMemo<string[]>(
    () => [...curatedBaseModelCatalog[framework]],
    [framework]
  );

  useEffect(() => {
    setBaseModel((current) => {
      if (current && baseModelOptions.includes(current)) {
        return current;
      }

      return baseModelOptions[0] ?? '';
    });
  }, [baseModelOptions]);

  const filteredDatasets = useMemo(() => datasets.filter((dataset) => dataset.task_type === taskType), [datasets, taskType]);
  const selectedDataset = useMemo(
    () => filteredDatasets.find((dataset) => dataset.id === datasetId) ?? null,
    [datasetId, filteredDatasets]
  );
  const onlineWorkers = useMemo(
    () =>
      workers.filter(
        (worker) => worker.enabled && worker.effective_status === 'online' && Boolean(worker.endpoint)
      ),
    [workers]
  );
  const selectedWorker = useMemo(
    () => workers.find((worker) => worker.id === selectedWorkerId) ?? null,
    [selectedWorkerId, workers]
  );
  const selectedWorkerAvailable =
    !selectedWorkerId || workersLoading || workersAccessDenied || Boolean(selectedWorker);
  const dispatchSummary = useMemo(() => {
    if (dispatchPreference === 'auto') {
      return t('Scheduler chooses between worker and control-plane automatically.');
    }
    if (dispatchPreference === 'control_plane') {
      return t('Run will stay on control-plane local execution path.');
    }
    if (selectedWorkerId) {
      if (workersLoading || workersAccessDenied) {
        return t('Worker inventory is unavailable. Worker ID will be validated at submit time.');
      }
      return selectedWorker
        ? t('Worker dispatch is pinned to {worker}.', { worker: selectedWorker.name })
        : t('Pinned worker is not in current inventory.');
    }
    return t('Worker dispatch is required. Scheduler will pick one online eligible worker.');
  }, [dispatchPreference, selectedWorker, selectedWorkerId, t, workersAccessDenied, workersLoading]);
  const selectedDatasetVersion = useMemo(
    () => datasetVersions.find((version) => version.id === datasetVersionId) ?? null,
    [datasetVersionId, datasetVersions]
  );
  const snapshotPrefilledFromLink =
    Boolean(preferredDatasetId) &&
    datasetId === preferredDatasetId &&
    (!preferredVersionId || datasetVersionId === preferredVersionId);
  const datasetStatusReady = selectedDataset?.status === 'ready';
  const datasetVersionHasTrainSplit = (selectedDatasetVersion?.split_summary.train ?? 0) > 0;
  const datasetVersionHasAnnotationCoverage = (selectedDatasetVersion?.annotation_coverage ?? 0) > 0;
  const launchReady =
    Boolean(selectedDataset) &&
    datasetStatusReady &&
    Boolean(selectedDatasetVersion) &&
    datasetVersionHasTrainSplit &&
    datasetVersionHasAnnotationCoverage;
  const strictLaunchGateReady = runtimeDisableSimulatedTrainFallback || nonStrictLaunchConfirmed;
  const paramValidationIssues = useMemo(() => {
    const issues: string[] = [];
    if (parsePositiveInteger(epochs) === null) {
      issues.push(t('Epochs must be a positive integer.'));
    }
    if (parsePositiveInteger(batchSize) === null) {
      issues.push(t('Batch size must be a positive integer.'));
    }
    if (parsePositiveNumber(learningRate) === null) {
      issues.push(t('Learning rate must be greater than 0.'));
    }
    const parsedWarmupRatio = parseNonNegativeNumber(warmupRatio);
    if (parsedWarmupRatio === null || parsedWarmupRatio > 1) {
      issues.push(t('Warmup ratio must be between 0 and 1.'));
    }
    if (parseNonNegativeNumber(weightDecay) === null) {
      issues.push(t('Weight decay must be 0 or greater.'));
    }
    return issues;
  }, [batchSize, epochs, learningRate, t, warmupRatio, weightDecay]);
  const paramsReady = paramValidationIssues.length === 0;
  const dispatchReady = dispatchPreference !== 'worker' || selectedWorkerAvailable;
  const submitReady =
    launchReady &&
    !runtimeSettingsLoading &&
    !runtimeSettingsError &&
    strictLaunchGateReady &&
    paramsReady &&
    dispatchReady;
  const launchCheckpoints = useMemo(() => {
    const runtimeState = runtimeSettingsLoading
      ? ('pending' as const)
      : runtimeSettingsError
        ? ('blocked' as const)
        : runtimeDisableSimulatedTrainFallback || nonStrictLaunchConfirmed
          ? ('ready' as const)
          : ('blocked' as const);

    return [
      {
        key: 'name',
        label: t('Run name'),
        state: name.trim() ? ('ready' as const) : ('blocked' as const),
        detail: name.trim() || t('Add a short run name.'),
        action: () => jobNameInputRef.current?.focus()
      },
      {
        key: 'snapshot',
        label: t('Data snapshot'),
        state: launchReady ? ('ready' as const) : ('blocked' as const),
        detail: selectedDatasetVersion
          ? [selectedDataset?.name, selectedDatasetVersion.version_name].filter(Boolean).join(' · ')
          : t('Choose a dataset and version first.'),
        action: () => {
          if (!datasetId) {
            datasetSelectRef.current?.focus();
            return;
          }
          datasetVersionSelectRef.current?.focus();
        }
      },
      {
        key: 'params',
        label: t('Core params'),
        state: paramsReady ? ('ready' as const) : ('blocked' as const),
        detail: paramsReady ? t('Core values look valid.') : paramValidationIssues[0] ?? t('Fix the numeric values.'),
        action: () => paramsEpochsInputRef.current?.focus()
      },
      {
        key: 'dispatch',
        label: t('Dispatch strategy'),
        state: dispatchReady ? ('ready' as const) : ('blocked' as const),
        detail: dispatchReady ? dispatchSummary : t('Selected worker is not in current inventory.'),
        action: null
      },
      {
        key: 'runtime',
        label: t('Runtime guard'),
        state: runtimeState,
        detail: runtimeSettingsLoading
          ? t('Checking Runtime...')
          : runtimeSettingsError
            ? t('Go fix it in Runtime settings.')
            : runtimeDisableSimulatedTrainFallback
              ? t('Strict fallback is enabled.')
              : t('Confirm the risk to continue.'),
        action: runtimeSettingsError
          ? () => navigate('/settings/runtime')
          : !runtimeDisableSimulatedTrainFallback && !nonStrictLaunchConfirmed
            ? () => setNonStrictLaunchConfirmed(true)
            : null
      }
    ];
  }, [
    datasetId,
    launchReady,
    name,
    navigate,
    nonStrictLaunchConfirmed,
    dispatchReady,
    dispatchSummary,
    paramsReady,
    paramValidationIssues,
    runtimeDisableSimulatedTrainFallback,
    runtimeSettingsError,
    runtimeSettingsLoading,
    selectedDataset,
    selectedDatasetVersion,
    t
  ]);
  const blockedLaunchCheckpoints = launchCheckpoints.filter((item) => item.state !== 'ready');
  const nextLaunchCheckpoint = blockedLaunchCheckpoints[0] ?? null;
  const launchStatusDescription =
    runtimeSettingsLoading && blockedLaunchCheckpoints.length > 0
      ? t('Runtime is still loading.')
      : blockedLaunchCheckpoints.length === 0
        ? t('Snapshot, params, and Runtime are ready.')
        : t('{count} check(s) still need attention.', { count: blockedLaunchCheckpoints.length });
  const launchStatusAction =
    nextLaunchCheckpoint?.action && nextLaunchCheckpoint.state !== 'pending'
      ? {
          label:
            nextLaunchCheckpoint.key === 'name'
              ? t('Focus run name')
              : nextLaunchCheckpoint.key === 'snapshot'
                ? t('Focus snapshot')
                : nextLaunchCheckpoint.key === 'params'
                  ? t('Focus params')
                  : nextLaunchCheckpoint.key === 'runtime' && runtimeSettingsError
                    ? t('Open Runtime Settings')
                    : t('Confirm risk'),
          onClick: nextLaunchCheckpoint.action
        }
      : null;

  const taskFrameworkOptions = useMemo(() => {
    if (taskType === 'ocr') {
      return ['paddleocr', 'doctr'] as const;
    }
    return ['yolo'] as const;
  }, [taskType]);

  const submit = async () => {
    if (!name.trim()) {
      setFeedback({ variant: 'error', text: t('Training job name is required.') });
      return;
    }

    if (!datasetId) {
      setFeedback({ variant: 'error', text: t('Please select a dataset.') });
      return;
    }

    if (!datasetVersionId.trim()) {
      setFeedback({ variant: 'error', text: t('Please select a dataset version.') });
      return;
    }

    if (!selectedDatasetVersion) {
      setFeedback({ variant: 'error', text: t('Selected dataset version is unavailable.') });
      return;
    }

    if (!datasetStatusReady) {
      setFeedback({ variant: 'error', text: t('Selected dataset must be ready before creating a run.') });
      return;
    }

    if (!datasetVersionHasTrainSplit) {
      setFeedback({ variant: 'error', text: t('Selected dataset version must include train split items before launch.') });
      return;
    }

    if (!datasetVersionHasAnnotationCoverage) {
      setFeedback({ variant: 'error', text: t('Selected dataset version must include annotation coverage before launch.') });
      return;
    }

    if (runtimeSettingsError) {
      setFeedback({
        variant: 'error',
        text: t('Runtime safety status is unavailable. Resolve runtime settings before creating this run.')
      });
      return;
    }

    if (!runtimeSettingsLoading && !runtimeDisableSimulatedTrainFallback && !nonStrictLaunchConfirmed) {
      setFeedback({
        variant: 'error',
        text: t('Runtime safety guard is off. Confirm risk acknowledgment before creating this run.')
      });
      return;
    }

    if (!paramsReady) {
      setFeedback({
        variant: 'error',
        text: paramValidationIssues[0] ?? t('Fix the training params before launch.')
      });
      return;
    }

    if (!dispatchReady) {
      setFeedback({
        variant: 'error',
        text: t('Selected worker is not in current inventory.')
      });
      return;
    }

    setSubmitting(true);
    setFeedback(null);

    try {
      const executionTarget =
        dispatchPreference === 'auto' ? undefined : dispatchPreference;
      const workerId =
        dispatchPreference === 'worker' && selectedWorkerId.trim()
          ? selectedWorkerId.trim()
          : undefined;
      const created = await api.createTrainingJob({
        name: name.trim(),
        task_type: taskType,
        framework,
        dataset_id: datasetId,
        dataset_version_id: datasetVersionId.trim(),
        base_model: baseModel.trim() || baseModelOptions[0] || `${framework}-base`,
        config: {
          epochs,
          batch_size: batchSize,
          learning_rate: learningRate,
          warmup_ratio: warmupRatio,
          weight_decay: weightDecay
        },
        ...(executionTarget ? { execution_target: executionTarget } : {}),
        ...(workerId ? { worker_id: workerId } : {})
      });

      navigate(
        `/training/jobs/${created.id}?dataset=${encodeURIComponent(datasetId)}&version=${encodeURIComponent(
          datasetVersionId
        )}&created=1`
      );
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setSubmitting(false);
    }
  };

  const createTaskDraft = async () => {
    if (!requirementDescription.trim()) {
      setFeedback({ variant: 'error', text: t('Please describe your requirement first.') });
      return;
    }

    setDrafting(true);
    setFeedback(null);

    try {
      const draft = await api.draftTaskFromRequirement(requirementDescription.trim());
      setTaskDraft(draft);
      setTaskType(draft.task_type);
      setFramework(draft.recommended_framework);
      if (!name.trim()) {
        setName(`${draft.task_type}-job-${Date.now().toString().slice(-6)}`);
      }
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setDrafting(false);
    }
  };

  const wizardStep = !name.trim()
    ? 0
    : !selectedDataset || !selectedDatasetVersion
      ? 1
      : !paramsReady
        ? 2
        : !dispatchReady
          ? 3
          : 4;

  return (
    <WorkspacePage>
      <PageHeader
        eyebrow={t('Training Run')}
        title={t('Create Training Run')}
        description={t('Create a run from one fixed snapshot.')}
        primaryAction={{
          label: submitting ? t('Submitting...') : t('Create Training Run'),
          onClick: () => {
            void submit();
          },
          disabled: submitting || loading || versionsLoading || !submitReady
        }}
        secondaryActions={
          <ButtonLink to="/datasets" variant="ghost" size="sm">
            {t('Open datasets')}
          </ButtonLink>
        }
        meta={
          <div className="row gap wrap align-center">
            <Badge tone="info">{t('Task')}: {t(taskType)}</Badge>
            <Badge tone={snapshotPrefilledFromLink ? 'success' : 'neutral'}>
              {t('Snapshot prefill')}: {snapshotPrefilledFromLink ? t('Ready') : t('N/A')}
            </Badge>
            <Badge tone={dispatchPreference === 'auto' ? 'neutral' : dispatchPreference === 'control_plane' ? 'warning' : 'info'}>
              {t('Dispatch')}: {dispatchPreference === 'auto' ? t('Auto') : dispatchPreference === 'control_plane' ? t('Control-plane') : t('Worker')}
            </Badge>
            <Badge
              tone={
                runtimeSettingsError
                  ? 'danger'
                  : runtimeSettingsLoading
                    ? 'info'
                    : runtimeDisableSimulatedTrainFallback
                      ? 'success'
                      : 'warning'
              }
            >
              {t('Runtime')}: {
                runtimeSettingsError
                  ? t('Unavailable')
                  : runtimeSettingsLoading
                    ? t('Checking...')
                    : runtimeDisableSimulatedTrainFallback
                      ? t('Guarded')
                      : t('Review')
              }
            </Badge>
          </div>
        }
      />

      <ProgressStepper
        steps={[t('Run identity'), t('Dataset snapshot'), t('Core params'), t('Dispatch strategy'), t('Review and launch')]}
        current={wizardStep}
        title={t('Launch steps')}
        caption={t('Fill them in order.')}
      />

      {loading ? (
        <StateBlock variant="loading" title={t('Preparing')} description={t('Loading data.')} />
      ) : null}

      {snapshotPrefilledFromLink ? (
        <InlineAlert
          tone="success"
          title={t('Snapshot prefilled')}
          description={
            preferredVersionId
              ? t('Dataset and version are prefilled. Confirm to launch.')
              : t('Dataset is prefilled. Pick a version next.')
          }
        />
      ) : null}

      {feedback ? (
        <StateBlock
          variant={feedback.variant}
          title={feedback.variant === 'success' ? t('Action Completed') : t('Action Failed')}
          description={feedback.text}
        />
      ) : null}
      <WorkspaceWorkbench
        main={
          <div className="workspace-main-stack training-launch-stack">
            <Card as="article" className="stack">
              <WorkspaceSectionHeader
                title={t('1. Run identity')}
                description={t('Name it first, then choose task and framework.')}
                actions={<Badge tone="neutral">{taskType.toUpperCase()}</Badge>}
              />
              <div className="workspace-form-grid">
                <label className="workspace-form-span-2">
                  {t('Run Name')}
                  <Input ref={jobNameInputRef} value={name} onChange={(event) => setName(event.target.value)} />
                </label>
                <label>
                  {t('Task Type')}
                  <Select
                    value={taskType}
                    onChange={(event) =>
                      setTaskType(
                        event.target.value as 'ocr' | 'detection' | 'classification' | 'segmentation' | 'obb'
                      )
                    }
                  >
                    {taskTypeOptions.map((option) => (
                      <option key={option} value={option}>
                        {t(option)}
                      </option>
                    ))}
                  </Select>
                </label>
                <label>
                  {t('Framework')}
                  <Select
                    value={framework}
                    onChange={(event) => setFramework(event.target.value as 'paddleocr' | 'doctr' | 'yolo')}
                  >
                    {taskFrameworkOptions.map((option) => (
                      <option key={option} value={option}>
                        {t(option)}
                      </option>
                    ))}
                  </Select>
                </label>
              </div>
            </Card>

            <Card as="article" className="stack">
              <WorkspaceSectionHeader
                title={t('2. Dataset snapshot')}
                description={t('Choose the dataset, then lock the snapshot.')}
                actions={
                  selectedDatasetVersion ? (
                    <StatusTag status={launchReady ? 'ready' : 'draft'}>
                      {launchReady ? t('Ready') : t('Review')}
                    </StatusTag>
                  ) : null
                }
              />
              {filteredDatasets.length === 0 ? (
                  <StateBlock
                    variant="empty"
                    title={t('No matching dataset')}
                    description={t('Create a dataset for this task type first.')}
                  extra={
                    <div className="row gap wrap">
                      <ButtonLink to="/datasets" variant="secondary" size="sm">
                        {t('Open Datasets')}
                      </ButtonLink>
                    </div>
                  }
                />
              ) : null}
              <div className="workspace-form-grid">
                <label className="workspace-form-span-2">
                  {t('Dataset')}
                  <Select ref={datasetSelectRef} value={datasetId} onChange={(event) => setDatasetId(event.target.value)}>
                    {filteredDatasets.map((dataset) => (
                      <option key={dataset.id} value={dataset.id}>
                        {dataset.name} ({t(dataset.status)})
                      </option>
                    ))}
                  </Select>
                </label>
                <label>
                  {t('Dataset Version')}
                  <Select
                    ref={datasetVersionSelectRef}
                    value={datasetVersionId}
                    onChange={(event) => setDatasetVersionId(event.target.value)}
                    disabled={!selectedDataset || versionsLoading || datasetVersions.length === 0}
                  >
                    <option value="">
                      {versionsLoading ? t('Loading versions...') : t('Pick a version')}
                    </option>
                    {datasetVersions.map((version) => (
                      <option key={version.id} value={version.id}>
                        {version.version_name} · {t('train')} {version.split_summary.train} ·{' '}
                        {formatCoveragePercent(version.annotation_coverage)}
                      </option>
                    ))}
                  </Select>
                </label>
                <label>
                  {t('Base Model')}
                  <Select value={baseModel} onChange={(event) => setBaseModel(event.target.value)}>
                    {baseModelOptions.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </Select>
                </label>
              </div>
              {selectedDatasetVersion ? (
                <Panel className="stack tight" tone="soft">
                  <div className="row gap wrap align-center">
                    <Badge tone="neutral">{selectedDataset?.name ?? t('Dataset')}</Badge>
                    <Badge tone="info">{selectedDatasetVersion.version_name}</Badge>
                    <Badge tone={datasetVersionHasTrainSplit ? 'success' : 'warning'}>
                      {t('Train')}: {selectedDatasetVersion.split_summary.train}
                    </Badge>
                    <Badge tone={datasetVersionHasAnnotationCoverage ? 'success' : 'warning'}>
                      {t('Coverage')}: {formatCoveragePercent(selectedDatasetVersion.annotation_coverage)}
                    </Badge>
                  </div>
                  <small className="muted">{t('Launch uses only this snapshot.')}</small>
                </Panel>
              ) : (
                <StateBlock
                  variant="empty"
                  title={t('No dataset version')}
                  description={t('Create or pick a snapshot before launch.')}
                />
              )}
              {selectedDataset && datasetVersions.length === 0 && !versionsLoading ? (
                <StateBlock
                  variant="empty"
                  title={t('No dataset version')}
                  description={t('Create a dataset version snapshot first.')}
                  extra={
                    <ButtonLink to={`/datasets/${selectedDataset.id}`} variant="secondary" size="sm">
                      {t('Open Detail')}
                    </ButtonLink>
                  }
                />
              ) : null}
            </Card>

            <Card as="article" className="stack">
              <WorkspaceSectionHeader
                title={t('3. Core params')}
                description={t('Keep the core params visible.')}
                actions={
                  paramsReady ? (
                    <Badge tone="success">{t('Ready')}</Badge>
                  ) : (
                    <Badge tone="warning">{t('Needs review')}</Badge>
                  )
                }
              />
              <div className="three-col">
                <label>
                  {t('Epochs')}
                  <Input
                    ref={paramsEpochsInputRef}
                    value={epochs}
                    inputMode="numeric"
                    onChange={(event) => setEpochs(event.target.value)}
                  />
                </label>
                <label>
                  {t('Batch Size')}
                  <Input value={batchSize} inputMode="numeric" onChange={(event) => setBatchSize(event.target.value)} />
                </label>
                <label>
                  {t('Learning Rate')}
                  <Input
                    value={learningRate}
                    inputMode="decimal"
                    onChange={(event) => setLearningRate(event.target.value)}
                  />
                </label>
              </div>
              {!paramsReady ? (
                <InlineAlert
                  tone="warning"
                  title={t('Params need attention')}
                  description={paramValidationIssues.join(' ')}
                />
              ) : (
                <small className="muted">{t('Core params checked.')}</small>
              )}
              <AdvancedSection
                title={t('Advanced helper')}
                description={t('Use only when you need draft suggestions.')}
              >
                <div className="three-col">
                  <label>
                    {t('Warmup Ratio')}
                    <Input
                      value={warmupRatio}
                      inputMode="decimal"
                      onChange={(event) => setWarmupRatio(event.target.value)}
                    />
                  </label>
                  <label>
                    {t('Weight Decay')}
                    <Input
                      value={weightDecay}
                      inputMode="decimal"
                      onChange={(event) => setWeightDecay(event.target.value)}
                    />
                  </label>
                </div>
                <details className="workspace-details">
                  <summary>{t('Requirement to Task Draft')}</summary>
                  <div className="workspace-disclosure-content stack">
                    <label>
                      {t('Requirement')}
                      <Textarea
                        value={requirementDescription}
                        onChange={(event) => setRequirementDescription(event.target.value)}
                        rows={3}
                        placeholder={t('For example: detect vehicle defects or read a vehicle number')}
                      />
                    </label>
                    <Button type="button" onClick={createTaskDraft} disabled={drafting || loading} block>
                      {drafting ? t('Generating...') : t('Draft from requirement')}
                    </Button>
                    {taskDraft ? (
                      <div className="stack tight">
                        <div className="workspace-keyline-list">
                          <div className="workspace-keyline-item">
                            <span>{t('Task Type')}</span>
                            <strong>{t(taskDraft.task_type)}</strong>
                          </div>
                          <div className="workspace-keyline-item">
                            <span>{t('Framework')}</span>
                            <strong>{t(taskDraft.recommended_framework)}</strong>
                          </div>
                          <div className="workspace-keyline-item">
                            <span>{t('Labels')}</span>
                            <strong>{taskDraft.label_hints.length}</strong>
                          </div>
                        </div>
                        <small className="muted">{taskDraft.rationale}</small>
                      </div>
                    ) : (
                      <small className="muted">
                        {t('This is only a helper. Launch still depends on the snapshot and checks.')}
                      </small>
                    )}
                  </div>
                </details>
              </AdvancedSection>
            </Card>

            <Card as="article" className="stack">
              <WorkspaceSectionHeader
                title={t('4. Dispatch strategy')}
                description={t('Choose whether this run is auto-scheduled, control-plane only, or worker-oriented.')}
                actions={
                  <Badge tone={dispatchPreference === 'auto' ? 'neutral' : dispatchPreference === 'control_plane' ? 'warning' : 'info'}>
                    {dispatchPreference === 'auto' ? t('Auto') : dispatchPreference === 'control_plane' ? t('Control-plane') : t('Worker')}
                  </Badge>
                }
              />
              <div className="workspace-form-grid">
                <label className="workspace-form-span-2">
                  {t('Dispatch target')}
                  <Select
                    value={dispatchPreference}
                    onChange={(event) =>
                      setDispatchPreference(event.target.value as 'auto' | 'control_plane' | 'worker')
                    }
                  >
                    <option value="auto">{t('Auto (scheduler decides)')}</option>
                    <option value="control_plane">{t('Force control-plane')}</option>
                    <option value="worker">{t('Prefer worker dispatch')}</option>
                  </Select>
                </label>
                {dispatchPreference === 'worker' ? (
                  <label className="workspace-form-span-2">
                    {t('Worker preference (optional)')}
                    <Select
                      value={selectedWorkerId}
                      onChange={(event) => setSelectedWorkerId(event.target.value)}
                      disabled={workersLoading || workersAccessDenied || workers.length === 0}
                    >
                      <option value="">{t('Auto-select from online workers')}</option>
                      {onlineWorkers.map((worker) => (
                        <option key={worker.id} value={worker.id}>
                          {worker.name} · {worker.id}
                        </option>
                      ))}
                    </Select>
                  </label>
                ) : null}
              </div>
              <small className="muted">{dispatchSummary}</small>
              {dispatchPreference === 'worker' ? (
                <div className="row gap wrap">
                  <Badge tone={onlineWorkers.length > 0 ? 'success' : 'warning'}>
                    {t('Online workers')}: {onlineWorkers.length}
                  </Badge>
                  {selectedWorkerId ? (
                    <Badge tone={selectedWorkerAvailable ? 'success' : 'danger'}>
                      {selectedWorkerAvailable ? t('Selected worker ready') : t('Selected worker missing')}
                    </Badge>
                  ) : null}
                </div>
              ) : null}
              {workersLoading ? <small className="muted">{t('Loading worker inventory...')}</small> : null}
              {workersAccessDenied ? (
                <small className="muted">{t('Worker inventory is restricted to admins.')}</small>
              ) : null}
              {!workersAccessDenied && workersError ? <small className="muted">{workersError}</small> : null}
              {dispatchPreference === 'worker' && !workersLoading && !workersAccessDenied && onlineWorkers.length === 0 ? (
                <InlineAlert
                  tone="warning"
                  title={t('No online worker')}
                  description={t('Worker dispatch may fail if no eligible online worker is available.')}
                />
              ) : null}
            </Card>

          </div>
        }
        side={
          <div className="workspace-inspector-rail">
            <Card as="article" className="workspace-inspector-card">
              <div className="row between gap wrap align-center">
                <h3>{t('Next step')}</h3>
                <StatusTag status={blockedLaunchCheckpoints.length === 0 ? 'ready' : 'draft'}>
                  {blockedLaunchCheckpoints.length === 0 ? t('Ready') : t('Needs review')}
                </StatusTag>
              </div>
              <small className="muted">
                {launchStatusDescription}
              </small>
              {launchStatusAction ? (
                <div className="row gap wrap align-center">
                  <Button type="button" variant="secondary" size="sm" onClick={launchStatusAction.onClick}>
                    {launchStatusAction.label}
                  </Button>
                  {nextLaunchCheckpoint?.key === 'runtime' &&
                  !runtimeSettingsLoading &&
                  !runtimeSettingsError &&
                  !runtimeDisableSimulatedTrainFallback ? (
                    <label className="row gap wrap align-center">
                      <input
                        type="checkbox"
                        className="ui-checkbox"
                        checked={nonStrictLaunchConfirmed}
                        onChange={(event) => setNonStrictLaunchConfirmed(event.target.checked)}
                      />
                      <span>{t('Confirm risk')}</span>
                    </label>
                  ) : null}
                </div>
              ) : null}
              {nextLaunchCheckpoint ? (
                <small className="muted">
                  {nextLaunchCheckpoint.label}: {nextLaunchCheckpoint.state === 'ready' ? t('Ready') : nextLaunchCheckpoint.detail}
                </small>
              ) : null}
              <details className="workspace-details">
                <summary>{t('All checks')}</summary>
                <div className="workspace-keyline-list">
                  {launchCheckpoints.map((item) => (
                    <div key={item.key} className="workspace-keyline-item">
                      <span>{item.label}</span>
                      <small>{item.state === 'ready' ? t('Ready') : item.detail}</small>
                    </div>
                  ))}
                </div>
              </details>
            </Card>
          </div>
        }
      />
    </WorkspacePage>
  );
}
