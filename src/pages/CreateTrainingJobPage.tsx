import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { DatasetRecord, DatasetVersionRecord, RequirementTaskDraft } from '../../shared/domain';
import AdvancedSection from '../components/AdvancedSection';
import StateBlock from '../components/StateBlock';
import StepIndicator from '../components/StepIndicator';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { InlineAlert, PageHeader } from '../components/ui/ConsolePage';
import { Input, Select, Textarea } from '../components/ui/Field';
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

type TrainingFramework = keyof typeof curatedBaseModelCatalog;
const formatCoveragePercent = (value: number) => `${Math.round(value * 100)}%`;

export default function CreateTrainingJobPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const steps = useMemo(() => [t('Task'), t('Dataset'), t('Params'), t('Review')], [t]);
  const stepTitles = useMemo(
    () => [t('Step 1. Task and Framework'), t('Step 2. Dataset and Base Model'), t('Step 3. Core Params'), t('Step 4. Review')],
    [t]
  );
  const stepDescriptions = useMemo(
    () => [
      t('Define the run identity, task type, and framework family.'),
      t('Choose the dataset, version hint, and base model source.'),
      t('Set the core hyperparameters and only open advanced values when needed.'),
      t('Review the final training configuration before launch.')
    ],
    [t]
  );

  const [datasets, setDatasets] = useState<DatasetRecord[]>([]);
  const [datasetVersions, setDatasetVersions] = useState<DatasetVersionRecord[]>([]);
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [taskType, setTaskType] = useState<'ocr' | 'detection' | 'classification' | 'segmentation' | 'obb'>('ocr');
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
  const datasetVersionSelectRef = useRef<HTMLSelectElement | null>(null);

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
          setStep((current) => (current < 1 ? 1 : current));
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
    if (runtimeDisableSimulatedTrainFallback || runtimeSettingsError) {
      setNonStrictLaunchConfirmed(false);
    }
  }, [runtimeDisableSimulatedTrainFallback, runtimeSettingsError]);

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
  const submitReady = launchReady && !runtimeSettingsLoading && !runtimeSettingsError && strictLaunchGateReady;
  const launchReadinessBanner = useMemo(() => {
    if (loading || versionsLoading) {
      return null;
    }

    if (!selectedDataset) {
      return {
        tone: 'info' as const,
        title: t('Pick a dataset first'),
        description: t('Training starts from a fixed dataset snapshot. Choose one dataset, then bind a version and launch.')
      };
    }

    if (!selectedDatasetVersion) {
      return {
        tone: 'warning' as const,
        title: t('Choose a dataset version snapshot'),
        description: t('Launch is blocked until you bind an explicit dataset version with train split and annotation coverage.')
      };
    }

    if (!datasetStatusReady || !datasetVersionHasTrainSplit || !datasetVersionHasAnnotationCoverage) {
      return {
        tone: 'warning' as const,
        title: t('Dataset snapshot is not ready yet'),
        description: t('Fix dataset status, train split, or annotation coverage before you create the run.')
      };
    }

    if (runtimeSettingsError) {
      return {
        tone: 'danger' as const,
        title: t('Runtime safety status is unavailable'),
        description: t('Open Runtime Settings and resolve the runtime guard before launching training.')
      };
    }

    if (!runtimeDisableSimulatedTrainFallback && !nonStrictLaunchConfirmed) {
      return {
        tone: 'warning' as const,
        title: t('Confirm risk before launch'),
        description: t('This run can still fall back to degraded output. Confirm the risk acknowledgement on the right.')
      };
    }

    return {
      tone: 'success' as const,
      title: t('Ready to create training job'),
      description: t('The dataset snapshot, launch gate, and core params are ready. Review once, then create the job.')
    };
  }, [
    datasetStatusReady,
    datasetVersionHasAnnotationCoverage,
    datasetVersionHasTrainSplit,
    loading,
    nonStrictLaunchConfirmed,
    runtimeDisableSimulatedTrainFallback,
    runtimeSettingsError,
    selectedDataset,
    selectedDatasetVersion,
    t,
    versionsLoading
  ]);

  const taskFrameworkOptions = useMemo(() => {
    if (taskType === 'ocr') {
      return ['paddleocr', 'doctr'] as const;
    }
    return ['yolo'] as const;
  }, [taskType]);

  const nextStep = () => {
    if (step < steps.length - 1) {
      setStep((value) => value + 1);
      setFeedback(null);
    }
  };

  const previousStep = () => {
    if (step > 0) {
      setStep((value) => value - 1);
      setFeedback(null);
    }
  };

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
      setFeedback({ variant: 'error', text: t('Selected dataset must be ready before creating a training job.') });
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
        text: t('Runtime safety status is unavailable. Resolve runtime settings before creating this training job.')
      });
      return;
    }

    if (!runtimeSettingsLoading && !runtimeDisableSimulatedTrainFallback && !nonStrictLaunchConfirmed) {
      setFeedback({
        variant: 'error',
        text: t('Runtime safety guard is off. Confirm risk acknowledgment before creating this training job.')
      });
      return;
    }

    setSubmitting(true);
    setFeedback(null);

    try {
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
        }
      });

      setFeedback({
        variant: 'success',
        text: t('Training job created. Opening the detail page.')
      });
      navigate(`/training/jobs/${created.id}?dataset=${encodeURIComponent(datasetId)}&version=${encodeURIComponent(datasetVersionId)}`);
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
      setFeedback({
        variant: 'success',
        text: t('Task draft generated from requirement ({source}).', { source: draft.source })
      });
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setDrafting(false);
    }
  };

  const runChecklist = [
    {
      label: t('Job name'),
      done: Boolean(name.trim()),
      hint: name.trim() || t('Name this run.')
    },
    {
      label: t('Dataset'),
      done: Boolean(selectedDataset),
      hint: selectedDataset
        ? `${selectedDataset.name} · ${t(selectedDataset.status)}`
        : t('Match the task type first.')
    },
    {
      label: t('Dataset Version'),
      done: Boolean(selectedDatasetVersion),
      hint: selectedDatasetVersion
        ? `${selectedDatasetVersion.version_name} · ${t('train')} ${selectedDatasetVersion.split_summary.train} · ${formatCoveragePercent(selectedDatasetVersion.annotation_coverage)}`
        : t('Choose one fixed snapshot.')
    },
    {
      label: t('Launch readiness'),
      done: launchReady,
      hint: selectedDatasetVersion
        ? t('Dataset, split, and coverage are checked.')
        : t('Launch readiness appears after a snapshot is selected.')
    },
    {
      label: t('Runtime safety guard'),
      done: strictLaunchGateReady && !runtimeSettingsLoading && !runtimeSettingsError,
      hint: runtimeSettingsLoading
        ? t('Checking runtime guard...')
        : runtimeSettingsError
          ? t('Fix Runtime settings first.')
          : runtimeDisableSimulatedTrainFallback
            ? t('Guard is active.')
            : nonStrictLaunchConfirmed
              ? t('Risk confirmed.')
              : t('Confirm risk to continue.')
    }
  ];
  const blockingChecklist = runChecklist.filter((item) => !item.done);
  const checklistPreview = blockingChecklist.length > 0 ? blockingChecklist : runChecklist;
  const renderStage = () => {
    if (step === 0) {
      return (
        <Card className="stack">
          <div className="stack tight">
            <h3>{stepTitles[step]}</h3>
            <small className="muted">{stepDescriptions[step]}</small>
          </div>
          <div className="workspace-form-grid">
            <label className="workspace-form-span-2">
              {t('Training Job Name')}
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
      );
    }

    if (step === 1) {
      return (
        <Card className="stack">
          <div className="stack tight">
            <h3>{stepTitles[step]}</h3>
            <small className="muted">{stepDescriptions[step]}</small>
          </div>
          {filteredDatasets.length === 0 ? (
            <StateBlock
              variant="empty"
              title={t('No Matching Dataset')}
              description={t('Create dataset for selected task type first.')}
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
              <Select value={datasetId} onChange={(event) => setDatasetId(event.target.value)}>
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
                  {versionsLoading ? t('Loading dataset versions...') : t('Select a dataset version')}
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
              <Select
                value={baseModel}
                onChange={(event) => setBaseModel(event.target.value)}
              >
                {baseModelOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
            </label>
          </div>
          <small className="muted">
            {t('Base model options are curated for future fine-tuning and keep only essential foundation choices.')}
          </small>
          {selectedDataset && datasetVersions.length === 0 && !versionsLoading ? (
            <StateBlock
              variant="empty"
              title={t('No Dataset Version')}
              description={t('Create a dataset version snapshot before launching training.')}
              extra={
                <ButtonLink to={`/datasets/${selectedDataset.id}`} variant="secondary" size="sm">
                  {t('Open Detail')}
                </ButtonLink>
              }
            />
          ) : null}
          {selectedDatasetVersion ? (
            <ul className="workspace-record-list compact">
              <li className="workspace-record-item compact">
                <div className="row between gap wrap">
                  <strong>{t('Dataset version snapshot')}</strong>
                  <StatusTag status={launchReady ? 'ready' : 'draft'}>
                    {launchReady ? t('Ready') : t('draft')}
                  </StatusTag>
                </div>
                <small className="muted">{selectedDatasetVersion.version_name}</small>
              </li>
              <li className="workspace-record-item compact">
                <div className="row between gap wrap">
                  <strong>{t('Split summary')}</strong>
                  <Badge tone="info">
                    {t('train')}: {selectedDatasetVersion.split_summary.train}
                  </Badge>
                </div>
                <small className="muted">
                  {t('train')} {selectedDatasetVersion.split_summary.train} · {t('val')} {selectedDatasetVersion.split_summary.val} ·
                  {t('test')} {selectedDatasetVersion.split_summary.test} · {t('unassigned')} {selectedDatasetVersion.split_summary.unassigned}
                </small>
              </li>
              <li className="workspace-record-item compact">
                <div className="row between gap wrap">
                  <strong>{t('Annotation coverage')}</strong>
                  <Badge tone={datasetVersionHasAnnotationCoverage ? 'success' : 'warning'}>
                    {Math.round(selectedDatasetVersion.annotation_coverage * 100)}%
                  </Badge>
                </div>
                <small className="muted">
                  {t('Training uses an explicit dataset version snapshot so this run stays reproducible.')}
                </small>
              </li>
              <li className="workspace-record-item compact">
                <div className="row between gap wrap">
                  <strong>{t('Launch readiness checks')}</strong>
                  <StatusTag status={launchReady ? 'ready' : 'draft'}>
                    {launchReady ? t('Ready') : t('draft')}
                  </StatusTag>
                </div>
                <small className="muted">
                  {t('Dataset ready {datasetReady} · train split {trainReady} · coverage {coverageReady}', {
                    datasetReady: t(datasetStatusReady ? 'ready' : 'draft'),
                    trainReady: t(datasetVersionHasTrainSplit ? 'ready' : 'draft'),
                    coverageReady: t(datasetVersionHasAnnotationCoverage ? 'ready' : 'draft')
                  })}
                </small>
              </li>
            </ul>
          ) : null}
        </Card>
      );
    }

    if (step === 2) {
      return (
        <section className="stack">
          <Card className="stack">
            <div className="stack tight">
              <h3>{stepTitles[step]}</h3>
              <small className="muted">{stepDescriptions[step]}</small>
            </div>
            <div className="three-col">
              <label>
                {t('Epochs')}
                <Input value={epochs} onChange={(event) => setEpochs(event.target.value)} />
              </label>
              <label>
                {t('Batch Size')}
                <Input value={batchSize} onChange={(event) => setBatchSize(event.target.value)} />
              </label>
              <label>
                {t('Learning Rate')}
                <Input value={learningRate} onChange={(event) => setLearningRate(event.target.value)} />
              </label>
            </div>
          </Card>

          <AdvancedSection>
            <label>
              {t('Warmup Ratio')}
              <Input value={warmupRatio} onChange={(event) => setWarmupRatio(event.target.value)} />
            </label>
            <label>
              {t('Weight Decay')}
              <Input value={weightDecay} onChange={(event) => setWeightDecay(event.target.value)} />
            </label>
          </AdvancedSection>
        </section>
      );
    }

    return (
      <Card className="stack">
        <div className="stack tight">
          <h3>{stepTitles[step]}</h3>
          <small className="muted">{stepDescriptions[step]}</small>
        </div>
        <ul className="workspace-record-list compact">
          <li className="workspace-record-item compact">
            <div className="row between gap wrap">
              <strong>{name || t('Unnamed job')}</strong>
              <StatusTag status="info">{t(framework)}</StatusTag>
            </div>
            <small className="muted">
              {t('Task')}: {t(taskType)}
            </small>
          </li>
          <li className="workspace-record-item compact">
            <div className="row between gap wrap">
              <strong>{t('Dataset')}</strong>
              <StatusTag status={selectedDataset?.status ?? 'draft'}>
                {selectedDataset ? t(selectedDataset.status) : t('N/A')}
              </StatusTag>
            </div>
            <small className="muted">
              {selectedDataset?.name ?? t('N/A')} · {t('Dataset Version')}: {selectedDatasetVersion?.version_name ?? t('N/A')}
            </small>
          </li>
          <li className="workspace-record-item compact">
            <div className="row between gap wrap">
              <strong>{t('Params')}</strong>
              <StatusTag status="info">{epochs}</StatusTag>
            </div>
            <small className="muted">
              {t('Epochs')}: {epochs} · {t('Batch Size')}: {batchSize} · {t('Learning Rate')}: {learningRate}
            </small>
          </li>
        </ul>
        {!runtimeSettingsLoading && !runtimeSettingsError && !runtimeDisableSimulatedTrainFallback ? (
          <Panel as="section" className="workspace-record-item compact" tone="soft">
            <div className="stack tight">
              <strong>{t('Runtime guard needs confirmation')}</strong>
              <small className="muted">
                {t('Confirm the risk if this launch may fall back to degraded output.')}
              </small>
            </div>
            <label className="row gap wrap align-center">
              <input
                type="checkbox"
                className="ui-checkbox"
                checked={nonStrictLaunchConfirmed}
                onChange={(event) => setNonStrictLaunchConfirmed(event.target.checked)}
              />
              <span>{t('I understand the risk')}</span>
            </label>
          </Panel>
        ) : null}
      </Card>
    );
  };

  return (
    <WorkspacePage>
      <PageHeader
        eyebrow={t('Training Job Builder')}
        title={t('Create Training Job')}
        description={t('Create one training run from a fixed dataset snapshot.')}
        meta={
          <div className="row gap wrap align-center">
            <Badge tone="neutral">{t('Step')}: {step + 1}/{steps.length}</Badge>
            <Badge tone="info">{t('Matching datasets')}: {filteredDatasets.length}</Badge>
            <Badge tone={snapshotPrefilledFromLink ? 'success' : 'neutral'}>
              {t('Snapshot prefill')}: {snapshotPrefilledFromLink ? t('Ready') : t('N/A')}
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

      {loading ? (
        <StateBlock variant="loading" title={t('Preparing')} description={t('Loading dataset options.')} />
      ) : null}

      {snapshotPrefilledFromLink ? (
        <StateBlock
          variant="success"
          title={t('Snapshot preselected from dataset detail')}
          description={preferredVersionId
            ? t('Dataset and version snapshot were prefilled. You can launch directly after readiness review.')
            : t('Dataset was prefilled. Choose a version snapshot, then continue launch review.')}
        />
      ) : null}

      {feedback ? (
        <StateBlock
          variant={feedback.variant}
          title={feedback.variant === 'success' ? t('Action Completed') : t('Action Failed')}
          description={feedback.text}
        />
      ) : null}
      {launchReadinessBanner ? (
        <InlineAlert
          tone={launchReadinessBanner.tone}
          title={launchReadinessBanner.title}
          description={launchReadinessBanner.description}
          actions={
            !selectedDataset ? (
              <Button type="button" variant="secondary" size="sm" onClick={() => setStep(1)}>
                {t('Go to dataset step')}
              </Button>
            ) : !selectedDatasetVersion ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  setStep(1);
                  window.setTimeout(() => datasetVersionSelectRef.current?.focus(), 50);
                }}
              >
                {t('Select version')}
              </Button>
            ) : runtimeSettingsError ? (
              <ButtonLink to="/settings/runtime" variant="secondary" size="sm">
                {t('Open Runtime Settings')}
              </ButtonLink>
            ) : !runtimeDisableSimulatedTrainFallback && !nonStrictLaunchConfirmed ? (
              <Button type="button" variant="secondary" size="sm" onClick={() => setStep(3)}>
                {t('Review risk')}
              </Button>
            ) : null
          }
        />
      ) : null}
      <WorkspaceWorkbench
        toolbar={
          <Card as="section" className="workspace-toolbar-card">
            <div className="workspace-toolbar-head">
              <div className="workspace-toolbar-copy">
                <h3>{t('Flow controls')}</h3>
                <small className="muted">{stepDescriptions[step]}</small>
              </div>
              <div className="workspace-toolbar-actions">
                <Button type="button" variant="secondary" onClick={previousStep} disabled={step === 0 || submitting} size="sm">
                  {t('Back')}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={nextStep}
                  disabled={step === steps.length - 1 || submitting || loading}
                  size="sm"
                >
                  {t('Next')}
                </Button>
                <Button
                  type="button"
                  onClick={submit}
                  disabled={step !== steps.length - 1 || submitting || loading || versionsLoading || !submitReady}
                  size="sm"
                >
                  {submitting ? t('Submitting...') : t('Create Training Job')}
                </Button>
              </div>
            </div>
          </Card>
        }
        main={
          <div className="workspace-main-stack">
            <Card as="article">
              <WorkspaceSectionHeader
                title={t('Launch step')}
                description={stepTitles[step]}
                actions={<StatusTag status="info">{`${step + 1}/${steps.length}`}</StatusTag>}
              />
              <small className="muted">{stepDescriptions[step]}</small>
              <StepIndicator steps={steps} current={step} />
            </Card>
            {renderStage()}
            <AdvancedSection
              title={t('Optional task sketch')}
              description={t('Use this only when you want the system to suggest a training shape from prose. It is not required to launch training.')}
            >
              <label>
                {t('Requirement Description')}
                <Textarea
                  value={requirementDescription}
                  onChange={(event) => setRequirementDescription(event.target.value)}
                  rows={4}
                  placeholder={t('Example: detect train body defects or read train serial number')}
                />
              </label>
              <Button type="button" onClick={createTaskDraft} disabled={drafting || loading} block>
                {drafting ? t('Generating...') : t('Generate Task Draft')}
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
                  {t('Optional helper only. A real training launch still depends on dataset, snapshot, and readiness checks.')}
                </small>
              )}
            </AdvancedSection>
          </div>
        }
        side={
          <div className="workspace-inspector-rail">
            <Card as="article" className="workspace-inspector-card">
              <div className="row between gap wrap align-center">
                <h3>{t('Next checkpoint')}</h3>
                <Badge tone={blockingChecklist.length > 0 ? 'warning' : 'success'}>
                  {runChecklist.length - blockingChecklist.length}/{runChecklist.length}
                </Badge>
              </div>
              <small className="muted">
                {blockingChecklist.length > 0 ? t('Only unresolved blockers are shown.') : t('Launch is ready.')}
              </small>
              <div className="workspace-keyline-list">
                {checklistPreview.slice(0, 2).map((item) => (
                  <div key={item.label} className="workspace-keyline-item">
                    <span>{item.label}</span>
                    <small>{item.done ? t('Ready') : t('Pending')}</small>
                  </div>
                ))}
                {blockingChecklist.length > 2 ? (
                  <div className="workspace-keyline-item">
                    <span>{t('More blockers')}</span>
                    <small>{t('{count} remaining', { count: blockingChecklist.length - 2 })}</small>
                  </div>
                ) : null}
              </div>
            </Card>
          </div>
        }
      />
    </WorkspacePage>
  );
}
