import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { DatasetRecord, DatasetVersionRecord, RequirementTaskDraft } from '../../shared/domain';
import AdvancedSection from '../components/AdvancedSection';
import WorkspaceFollowUpHint from '../components/onboarding/WorkspaceFollowUpHint';
import WorkspaceOnboardingCard from '../components/onboarding/WorkspaceOnboardingCard';
import WorkspaceNextStepCard from '../components/onboarding/WorkspaceNextStepCard';
import StateBlock from '../components/StateBlock';
import StepIndicator from '../components/StepIndicator';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import WorkspaceActionPanel from '../components/ui/WorkspaceActionPanel';
import { Input, Select, Textarea } from '../components/ui/Field';
import { Card, Panel } from '../components/ui/Surface';
import {
  WorkspaceHero,
  WorkspaceMetricGrid,
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
const createTrainingOnboardingDismissedStorageKey = 'vistral-create-training-onboarding-dismissed';

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
  const [runtimeDisableInferenceFallback, setRuntimeDisableInferenceFallback] = useState(false);
  const [runtimePythonBin, setRuntimePythonBin] = useState('');
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
  const currentStepCardRef = useRef<HTMLDivElement | null>(null);
  const draftAnnotationType = taskDraft?.recommended_annotation_type ?? taskDraft?.annotation_type ?? '';

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
        setRuntimeDisableInferenceFallback(view.controls.disable_inference_fallback);
        setRuntimePythonBin(view.controls.python_bin.trim());
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
  const scopedJobsPath = useMemo(() => {
    const next = new URLSearchParams();
    if (datasetId) {
      next.set('dataset', datasetId);
    }
    if (datasetVersionId) {
      next.set('version', datasetVersionId);
    }
    const query = next.toString();
    return query ? `/training/jobs?${query}` : '/training/jobs';
  }, [datasetId, datasetVersionId]);
  const scopedDatasetDetailPath = useMemo(() => {
    if (!selectedDataset) {
      return '/datasets';
    }
    if (!datasetVersionId) {
      return `/datasets/${selectedDataset.id}`;
    }
    const next = new URLSearchParams();
    next.set('version', datasetVersionId);
    return `/datasets/${selectedDataset.id}?${next.toString()}`;
  }, [datasetVersionId, selectedDataset]);
  const snapshotPrefilledFromLink =
    Boolean(preferredDatasetId) &&
    datasetId === preferredDatasetId &&
    (!preferredVersionId || datasetVersionId === preferredVersionId);
  const readyMatchingDatasets = useMemo(
    () => filteredDatasets.filter((dataset) => dataset.status === 'ready').length,
    [filteredDatasets]
  );
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
      hint: name.trim() || t('This run still needs a name.')
    },
    {
      label: t('Dataset'),
      done: Boolean(selectedDataset),
      hint: selectedDataset
        ? `${selectedDataset.name} (${t(selectedDataset.status)})`
        : t('Pick a dataset that matches the selected task type.')
    },
    {
      label: t('Dataset Version'),
      done: Boolean(selectedDatasetVersion),
      hint: selectedDatasetVersion
        ? `${selectedDatasetVersion.version_name} · ${t('train')} ${selectedDatasetVersion.split_summary.train} · ${t('Annotation coverage')}: ${formatCoveragePercent(selectedDatasetVersion.annotation_coverage)}`
        : t('Choose an immutable dataset version snapshot for this run.')
    },
    {
      label: t('Launch readiness'),
      done: launchReady,
      hint: selectedDatasetVersion
        ? t('Dataset {datasetStatus} · train {trainCount} · coverage {coverage}% · train split ready {trainReady} · coverage ready {coverageReady}', {
            datasetStatus: selectedDataset ? t(selectedDataset.status) : t('N/A'),
            trainCount: selectedDatasetVersion.split_summary.train,
            coverage: Math.round(selectedDatasetVersion.annotation_coverage * 100),
            trainReady: t(datasetVersionHasTrainSplit ? 'ready' : 'draft'),
            coverageReady: t(datasetVersionHasAnnotationCoverage ? 'ready' : 'draft')
          })
        : t('Launch readiness becomes available after a dataset version is selected.')
    },
    {
      label: t('Runtime safety guard'),
      done: strictLaunchGateReady && !runtimeSettingsLoading && !runtimeSettingsError,
      hint: runtimeSettingsLoading
        ? t('Loading runtime safety status...')
        : runtimeSettingsError
          ? t('Runtime settings unavailable. Resolve Runtime settings before launch.')
          : runtimeDisableSimulatedTrainFallback
            ? t('Safety guard is active: degraded training output is blocked.')
            : nonStrictLaunchConfirmed
              ? t('Risk confirmed: this launch may return degraded output when local execution fails.')
              : t('Safety guard is off. Confirm risk acknowledgment before launch.')
    },
    {
      label: t('Params'),
      done: Boolean(epochs && batchSize && learningRate),
      hint:
        step >= 2
          ? `${t('Epochs')}: ${epochs} · ${t('Batch Size')}: ${batchSize} · ${t('Learning Rate')}: ${learningRate}`
          : t('Core params stay editable until launch.')
    },
    {
      label: t('Review'),
      done: step === steps.length - 1 && Boolean(name.trim()) && submitReady,
      hint:
        step === steps.length - 1
          ? t('This run is ready for final review.')
          : t('This run will be ready for final review after earlier steps are completed.')
    }
  ];
  const onboardingSteps = useMemo(
    () => [
      {
        key: 'scope',
        label: t('Confirm task and run scope'),
        detail: t('Set job name, task type, and framework so this run has a clear target.'),
        done: Boolean(name.trim()) && Boolean(framework),
        to: '/training/jobs/new',
        cta: t('Jump to task scope')
      },
      {
        key: 'snapshot',
        label: t('Bind dataset version snapshot'),
        detail: t('Training launch must bind an explicit dataset version, not an implicit latest dataset state.'),
        done: Boolean(selectedDatasetVersion),
        to: selectedDataset ? `/datasets/${selectedDataset.id}` : '/datasets',
        cta:
          selectedDataset && datasetVersions.length > 0
            ? t('Jump to snapshot step')
            : selectedDataset
              ? t('Open Dataset Detail')
              : t('Manage Datasets')
      },
      {
        key: 'readiness',
        label: t('Pass launch readiness gates'),
        detail: t('Dataset ready, train split available, and annotation coverage > 0 are required before launch.'),
        done: launchReady,
        to: scopedDatasetDetailPath,
        cta: t('Check readiness source')
      },
      {
        key: 'strict',
        label: t('Confirm runtime safety guard'),
        detail: t('If the safety guard is off, explicit risk confirmation is required before launch.'),
        done: !runtimeSettingsLoading && !runtimeSettingsError && strictLaunchGateReady,
        to: '/settings/runtime',
        cta: t('Open Runtime Settings')
      }
    ],
    [
      framework,
      launchReady,
      name,
      runtimeSettingsError,
      runtimeSettingsLoading,
      scopedDatasetDetailPath,
      datasetVersions.length,
      selectedDataset,
      selectedDatasetVersion,
      strictLaunchGateReady,
      t
    ]
  );
  const nextOnboardingStep = useMemo(
    () => onboardingSteps.find((item) => !item.done) ?? null,
    [onboardingSteps]
  );
  const nextOnboardingStepIndex = useMemo(
    () => (nextOnboardingStep ? onboardingSteps.findIndex((item) => item.key === nextOnboardingStep.key) + 1 : 0),
    [nextOnboardingStep, onboardingSteps]
  );

  const focusTaskScopeStep = () => {
    setStep(0);
    currentStepCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.setTimeout(() => {
      jobNameInputRef.current?.focus();
    }, 180);
  };

  const focusSnapshotStep = () => {
    setStep(1);
    currentStepCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.setTimeout(() => {
      datasetVersionSelectRef.current?.focus();
    }, 180);
  };
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
        {runtimeSettingsError ? (
          <Panel as="section" className="workspace-record-item compact" tone="soft">
            <div className="stack tight">
              <strong>{t('Runtime safety status unavailable')}</strong>
              <small className="muted">
                {t('Resolve runtime settings first. Training launch stays blocked until safety status can be verified.')}
              </small>
            </div>
            <ButtonLink to="/settings/runtime" variant="secondary" size="sm">
              {t('Open Runtime Settings')}
            </ButtonLink>
          </Panel>
        ) : null}
        {!runtimeSettingsLoading && !runtimeSettingsError && !runtimeDisableSimulatedTrainFallback ? (
          <Panel as="section" className="workspace-record-item compact" tone="soft">
            <div className="stack tight">
              <strong>{t('Runtime safety guard is off')}</strong>
              <small className="muted">
                {t(
                  'This launch may return degraded output when local execution command is unavailable. Enable the safety guard for production runs.'
                )}
              </small>
            </div>
            <label className="row gap wrap align-center">
              <input
                type="checkbox"
                className="ui-checkbox"
                checked={nonStrictLaunchConfirmed}
                onChange={(event) => setNonStrictLaunchConfirmed(event.target.checked)}
              />
              <span>{t('I understand the risk and still want to launch this training job')}</span>
            </label>
            <ButtonLink to="/settings/runtime" variant="secondary" size="sm">
              {t('Open Runtime Settings')}
            </ButtonLink>
          </Panel>
        ) : null}
      </Card>
    );
  };

  return (
    <WorkspacePage>
      <WorkspaceHero
        eyebrow={t('Training Job Builder')}
        title={t('Create Training Job')}
        description={t('Build a training run from requirement draft to launch-ready configuration.')}
        stats={[
          {
            label: t('Current step'),
            value: `${step + 1}/${steps.length}`
          },
          {
            label: t('Matching datasets'),
            value: filteredDatasets.length
          },
          {
            label: t('Draft assist'),
            value: taskDraft ? 1 : 0
          },
          {
            label: t('Snapshot prefill'),
            value: snapshotPrefilledFromLink ? t('Ready') : t('N/A')
          }
        ]}
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

      {!runtimeSettingsLoading ? (
        runtimeSettingsError ? (
          <StateBlock
            variant="empty"
            title={t('Runtime safety status unavailable')}
            description={t('Unable to load runtime settings: {reason}', { reason: runtimeSettingsError })}
            extra={
              <ButtonLink to="/settings/runtime" variant="secondary" size="sm">
                {t('Open Runtime Settings')}
              </ButtonLink>
            }
          />
        ) : runtimeDisableSimulatedTrainFallback ? (
          <StateBlock
            variant="success"
            title={t('Training safety guard is active')}
            description={t(
              'Degraded training output is blocked. Built-in runner Python: {pythonBin}.',
              { pythonBin: runtimePythonBin || t('platform default (python3 / python)') }
            )}
            extra={
              <Badge tone={runtimeDisableInferenceFallback ? 'success' : 'warning'}>
                {t('Inference safety guard')}: {runtimeDisableInferenceFallback ? t('yes') : t('no')}
              </Badge>
            }
          />
        ) : (
          <StateBlock
            variant="error"
            title={t('Training safety guard is off')}
            description={t(
              'Training may return degraded output when local execution command is unavailable. Enable the safety guard in Runtime settings before production runs.'
            )}
            extra={
              <ButtonLink to="/settings/runtime" variant="secondary" size="sm">
                {t('Open Runtime Settings')}
              </ButtonLink>
            }
          />
        )
      ) : null}

      {feedback ? (
        <StateBlock
          variant={feedback.variant}
          title={feedback.variant === 'success' ? t('Action Completed') : t('Action Failed')}
          description={feedback.text}
        />
      ) : null}

      <WorkspaceMetricGrid
        items={[
          {
            title: t('Matching datasets'),
            description: t('Datasets currently compatible with the selected task type.'),
            value: filteredDatasets.length
          },
          {
            title: t('Ready Datasets'),
            description: t('Ready datasets available for immediate training launch.'),
            value: readyMatchingDatasets
          },
          {
            title: t('Framework'),
            description: t('Current framework family selected for the run.'),
            value: t(framework)
          },
          {
            title: t('Draft assist'),
            description: t('Optional requirement parsing that can pre-fill task choices.'),
            value: taskDraft ? t('Ready') : t('N/A'),
            tone: taskDraft ? 'default' : 'attention'
          }
        ]}
      />

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
            <div className="workspace-toolbar-meta">
              <div className="workspace-segmented-actions">
                <StatusTag status={launchReady ? 'ready' : 'draft'}>
                  {t('Launch readiness')}: {launchReady ? t('Ready') : t('draft')}
                </StatusTag>
                <StatusTag status="info">
                  {t('Current step')}: {step + 1}/{steps.length}
                </StatusTag>
                <StatusTag status="info">
                  {t('Framework')}: {t(framework)}
                </StatusTag>
                {selectedDataset ? (
                  <StatusTag status={selectedDataset.status}>{selectedDataset.name}</StatusTag>
                ) : null}
                {selectedDatasetVersion ? (
                  <StatusTag status={datasetVersionHasAnnotationCoverage ? 'ready' : 'draft'}>
                    {selectedDatasetVersion.version_name}
                  </StatusTag>
                ) : null}
              </div>
            </div>
          </Card>
        }
        main={
          <div className="workspace-main-stack">
            <WorkspaceOnboardingCard
              title={t('Training first-run guide')}
              description={t('Use this page to launch reproducible training from dataset snapshots, not ad-hoc state.')}
              summary={t('Guide status is computed from your current form and selected dataset version context.')}
              storageKey={createTrainingOnboardingDismissedStorageKey}
              steps={onboardingSteps.map((item) => ({
                key: item.key,
                label: item.label,
                detail: item.detail,
                done: item.done,
                primaryAction: {
                  to: item.to,
                  label: item.cta,
                  onClick:
                    item.key === 'scope'
                      ? focusTaskScopeStep
                      : item.key === 'snapshot' && selectedDataset && datasetVersions.length > 0
                        ? focusSnapshotStep
                        : undefined
                }
              }))}
	            />

	            {nextOnboardingStep ? (
	              <WorkspaceNextStepCard
	                title={t('Next training setup step')}
	                description={t('Finish one clear setup action here before launching the run.')}
	                stepLabel={nextOnboardingStep.label}
	                stepDetail={nextOnboardingStep.detail}
	                current={nextOnboardingStepIndex}
	                total={onboardingSteps.length}
	                actions={
	                  <div className="row gap wrap">
	                    {nextOnboardingStep.key === 'scope' ? (
	                      <Button type="button" variant="secondary" size="sm" onClick={focusTaskScopeStep}>
	                        {t('Jump to task scope')}
	                      </Button>
	                    ) : nextOnboardingStep.key === 'snapshot' && selectedDataset && datasetVersions.length > 0 ? (
	                      <Button type="button" variant="secondary" size="sm" onClick={focusSnapshotStep}>
	                        {t('Jump to snapshot step')}
	                      </Button>
	                    ) : (
	                      <ButtonLink to={nextOnboardingStep.to} variant="secondary" size="sm">
	                        {nextOnboardingStep.cta}
	                      </ButtonLink>
	                    )}
	                    <ButtonLink to="/workspace/console" variant="ghost" size="sm">
	                      {t('Back to Console')}
	                    </ButtonLink>
	                  </div>
	                }
	              />
	            ) : null}

            <div ref={currentStepCardRef}>
              <Card as="article">
              <WorkspaceSectionHeader
                title={t('Current step')}
                description={stepTitles[step]}
                actions={<StatusTag status="info">{`${step + 1}/${steps.length}`}</StatusTag>}
              />
              <small className="muted">{stepDescriptions[step]}</small>
              <StepIndicator steps={steps} current={step} />
              </Card>
            </div>
            {renderStage()}
          </div>
        }
        side={
          <div className="workspace-inspector-rail">
            <Card as="article" className="workspace-inspector-card">
              <div className="stack tight">
                <h3>{t('Requirement to Task Draft')}</h3>
                <small className="muted">
                  {t('Turn a natural-language requirement into a suggested task, framework, labels, and metrics.')}
                </small>
              </div>
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
                <ul className="workspace-record-list compact">
                  <li className="workspace-record-item compact">
                    <div className="row between gap wrap">
                      <strong>{t('Task Type')}</strong>
                      <StatusTag status="info">{t(taskDraft.task_type)}</StatusTag>
                    </div>
                    <small className="muted">
                      {t('Framework')}: {t(taskDraft.recommended_framework)} · {t('annotation')}:{' '}
                      {draftAnnotationType || t('N/A')}
                    </small>
                  </li>
                  <li className="workspace-record-item compact">
                    <div className="row between gap wrap">
                      <strong>{t('labels')}</strong>
                      <StatusTag status="info">{taskDraft.label_hints.length}</StatusTag>
                    </div>
                    <small className="muted">{taskDraft.label_hints.join(', ') || t('N/A')}</small>
                  </li>
                  <li className="workspace-record-item compact">
                    <div className="row between gap wrap">
                      <strong>{t('dataset suggestions')}</strong>
                      <StatusTag status="info">{taskDraft.dataset_suggestions.length}</StatusTag>
                    </div>
                    <small className="muted">{taskDraft.dataset_suggestions.join('；') || t('N/A')}</small>
                  </li>
                  <li className="workspace-record-item compact">
                    <div className="row between gap wrap">
                      <strong>{t('rationale')}</strong>
                      <StatusTag status="info">{taskDraft.source}</StatusTag>
                    </div>
                    <small className="muted">{taskDraft.rationale}</small>
                  </li>
                </ul>
              ) : (
                <StateBlock
                  variant="empty"
                  title={t('No requirement draft yet.')}
                  description={t('Use the assist card to convert a free-form requirement into a structured training starting point.')}
                  extra={
                    <WorkspaceFollowUpHint
                      layout="inline"
                      actions={
                        <>
                          <ButtonLink to="/workspace/chat" variant="secondary" size="sm">
                            {t('Open Chat Workspace')}
                          </ButtonLink>
                          <ButtonLink to="/datasets" variant="ghost" size="sm">
                            {t('Open Datasets')}
                          </ButtonLink>
                        </>
                      }
                    />
                  }
                />
              )}
            </Card>

            <Card as="article" className="workspace-inspector-card">
              <div className="stack tight">
                <h3>{t('Current run plan')}</h3>
                <small className="muted">{stepDescriptions[step]}</small>
              </div>
              <ul className="workspace-record-list compact">
                {runChecklist.map((item) => (
                  <li key={item.label} className="workspace-record-item compact">
                    <div className="row between gap wrap">
                      <strong>{item.label}</strong>
                      <StatusTag status={item.done ? 'ready' : 'draft'}>
                        {item.done ? t('Ready') : t('draft')}
                      </StatusTag>
                    </div>
                    <small className="muted">{item.hint}</small>
                  </li>
                ))}
              </ul>
            </Card>

            <WorkspaceActionPanel
              title={t('Launch lane')}
              description={t('Keep the main training actions and supporting routes close together.')}
              surface="panel"
              actions={
                <>
                  <ButtonLink to={scopedDatasetDetailPath} variant="secondary" block>
                    {selectedDataset ? t('Open scoped dataset') : t('Manage Datasets')}
                  </ButtonLink>
                  <ButtonLink to={scopedJobsPath} variant="secondary" block>
                    {t('Open Training Jobs')}
                  </ButtonLink>
                </>
              }
            />
          </div>
        }
      />
    </WorkspacePage>
  );
}
