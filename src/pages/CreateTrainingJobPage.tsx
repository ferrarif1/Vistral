import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { DatasetRecord, RequirementTaskDraft } from '../../shared/domain';
import AdvancedSection from '../components/AdvancedSection';
import StateBlock from '../components/StateBlock';
import StepIndicator from '../components/StepIndicator';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

export default function CreateTrainingJobPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
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
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [taskType, setTaskType] = useState<'ocr' | 'detection' | 'classification' | 'segmentation' | 'obb'>('ocr');
  const [framework, setFramework] = useState<'paddleocr' | 'doctr' | 'yolo'>('paddleocr');
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
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ variant: 'success' | 'error'; text: string } | null>(null);
  const draftAnnotationType = taskDraft?.recommended_annotation_type ?? taskDraft?.annotation_type ?? '';

  useEffect(() => {
    setLoading(true);
    api
      .listDatasets()
      .then((result) => {
        setDatasets(result);
        const first = result.find((dataset) => dataset.task_type === taskType);
        if (first) {
          setDatasetId(first.id);
        }
      })
      .catch((error) => setFeedback({ variant: 'error', text: (error as Error).message }))
      .finally(() => setLoading(false));
  }, [taskType]);

  useEffect(() => {
    if (taskType === 'ocr' && framework === 'yolo') {
      setFramework('paddleocr');
    }

    if (taskType !== 'ocr' && (framework === 'paddleocr' || framework === 'doctr')) {
      setFramework('yolo');
    }
  }, [framework, taskType]);

  const filteredDatasets = useMemo(() => datasets.filter((dataset) => dataset.task_type === taskType), [datasets, taskType]);
  const selectedDataset = useMemo(
    () => filteredDatasets.find((dataset) => dataset.id === datasetId) ?? null,
    [datasetId, filteredDatasets]
  );
  const readyMatchingDatasets = useMemo(
    () => filteredDatasets.filter((dataset) => dataset.status === 'ready').length,
    [filteredDatasets]
  );

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

    setSubmitting(true);
    setFeedback(null);

    try {
      const created = await api.createTrainingJob({
        name: name.trim(),
        task_type: taskType,
        framework,
        dataset_id: datasetId,
        dataset_version_id: datasetVersionId.trim() || null,
        base_model: baseModel.trim() || `${framework}-base`,
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
        text: t('Training job {jobId} created.', { jobId: created.id })
      });
      navigate(`/training/jobs/${created.id}`);
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
      label: t('Params'),
      done: Boolean(epochs && batchSize && learningRate),
      hint:
        step >= 2
          ? `${t('Epochs')}: ${epochs} · ${t('Batch Size')}: ${batchSize} · ${t('Learning Rate')}: ${learningRate}`
          : t('Core params stay editable until launch.')
    },
    {
      label: t('Review'),
      done: step === steps.length - 1 && Boolean(name.trim()) && Boolean(selectedDataset),
      hint:
        step === steps.length - 1
          ? t('This run is ready for final review.')
          : t('This run will be ready for final review after earlier steps are completed.')
    }
  ];

  const renderStage = () => {
    if (step === 0) {
      return (
        <section className="card stack">
          <div className="stack tight">
            <h3>{stepTitles[step]}</h3>
            <small className="muted">{stepDescriptions[step]}</small>
          </div>
          <div className="workspace-form-grid">
            <label className="workspace-form-span-2">
              {t('Training Job Name')}
              <input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label>
              {t('Task Type')}
              <select
                value={taskType}
                onChange={(event) =>
                  setTaskType(
                    event.target.value as 'ocr' | 'detection' | 'classification' | 'segmentation' | 'obb'
                  )
                }
              >
                <option value="ocr">{t('ocr')}</option>
                <option value="detection">{t('detection')}</option>
                <option value="classification">{t('classification')}</option>
                <option value="segmentation">{t('segmentation')}</option>
                <option value="obb">{t('obb')}</option>
              </select>
            </label>
            <label>
              {t('Framework')}
              <select
                value={framework}
                onChange={(event) => setFramework(event.target.value as 'paddleocr' | 'doctr' | 'yolo')}
              >
                {taskFrameworkOptions.map((option) => (
                  <option key={option} value={option}>
                    {t(option)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>
      );
    }

    if (step === 1) {
      return (
        <section className="card stack">
          <div className="stack tight">
            <h3>{stepTitles[step]}</h3>
            <small className="muted">{stepDescriptions[step]}</small>
          </div>
          {filteredDatasets.length === 0 ? (
            <StateBlock
              variant="empty"
              title={t('No Matching Dataset')}
              description={t('Create dataset for selected task type first.')}
            />
          ) : null}
          <div className="workspace-form-grid">
            <label className="workspace-form-span-2">
              {t('Dataset')}
              <select value={datasetId} onChange={(event) => setDatasetId(event.target.value)}>
                {filteredDatasets.map((dataset) => (
                  <option key={dataset.id} value={dataset.id}>
                    {dataset.name} ({t(dataset.status)})
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('Dataset Version (optional)')}
              <input
                value={datasetVersionId}
                onChange={(event) => setDatasetVersionId(event.target.value)}
                placeholder={t('for example: dv-1')}
              />
            </label>
            <label>
              {t('Base Model')}
              <input
                value={baseModel}
                onChange={(event) => setBaseModel(event.target.value)}
                placeholder={`${framework}-base`}
              />
            </label>
          </div>
        </section>
      );
    }

    if (step === 2) {
      return (
        <section className="stack">
          <section className="card stack">
            <div className="stack tight">
              <h3>{stepTitles[step]}</h3>
              <small className="muted">{stepDescriptions[step]}</small>
            </div>
            <div className="three-col">
              <label>
                {t('Epochs')}
                <input value={epochs} onChange={(event) => setEpochs(event.target.value)} />
              </label>
              <label>
                {t('Batch Size')}
                <input value={batchSize} onChange={(event) => setBatchSize(event.target.value)} />
              </label>
              <label>
                {t('Learning Rate')}
                <input value={learningRate} onChange={(event) => setLearningRate(event.target.value)} />
              </label>
            </div>
          </section>

          <AdvancedSection>
            <label>
              {t('Warmup Ratio')}
              <input value={warmupRatio} onChange={(event) => setWarmupRatio(event.target.value)} />
            </label>
            <label>
              {t('Weight Decay')}
              <input value={weightDecay} onChange={(event) => setWeightDecay(event.target.value)} />
            </label>
          </AdvancedSection>
        </section>
      );
    }

    return (
      <section className="card stack">
        <div className="stack tight">
          <h3>{stepTitles[step]}</h3>
          <small className="muted">{stepDescriptions[step]}</small>
        </div>
        <ul className="workspace-record-list compact">
          <li className="workspace-record-item compact">
            <div className="row between gap wrap">
              <strong>{name || t('Unnamed job')}</strong>
              <span className="chip">{t(framework)}</span>
            </div>
            <small className="muted">
              {t('Task')}: {t(taskType)}
            </small>
          </li>
          <li className="workspace-record-item compact">
            <div className="row between gap wrap">
              <strong>{t('Dataset')}</strong>
              <span className="chip">{selectedDataset ? t(selectedDataset.status) : t('N/A')}</span>
            </div>
            <small className="muted">
              {(selectedDataset?.name ?? datasetId) || t('N/A')} · {t('Dataset Version')}: {datasetVersionId || t('latest')}
            </small>
          </li>
          <li className="workspace-record-item compact">
            <div className="row between gap wrap">
              <strong>{t('Params')}</strong>
              <span className="chip">{epochs}</span>
            </div>
            <small className="muted">
              {t('Epochs')}: {epochs} · {t('Batch Size')}: {batchSize} · {t('Learning Rate')}: {learningRate}
            </small>
          </li>
        </ul>
      </section>
    );
  };

  return (
    <div className="workspace-overview-page stack">
      <section className="card workspace-overview-hero">
        <div className="workspace-overview-hero-grid">
          <div className="workspace-overview-copy stack">
            <small className="workspace-eyebrow">{t('Training Job Builder')}</small>
            <h1>{t('Create Training Job')}</h1>
            <p className="muted">{t('Build a training run from requirement draft to launch-ready configuration.')}</p>
          </div>
          <div className="workspace-overview-badges">
            <div className="workspace-overview-badge">
              <span>{t('Current step')}</span>
              <strong>
                {step + 1}/{steps.length}
              </strong>
            </div>
            <div className="workspace-overview-badge">
              <span>{t('Matching datasets')}</span>
              <strong>{filteredDatasets.length}</strong>
            </div>
            <div className="workspace-overview-badge">
              <span>{t('Draft assist')}</span>
              <strong>{taskDraft ? 1 : 0}</strong>
            </div>
          </div>
        </div>
      </section>

      {loading ? (
        <StateBlock variant="loading" title={t('Preparing')} description={t('Loading dataset options.')} />
      ) : null}

      {feedback ? (
        <StateBlock
          variant={feedback.variant}
          title={feedback.variant === 'success' ? t('Action Completed') : t('Action Failed')}
          description={feedback.text}
        />
      ) : null}

      <section className="workspace-overview-signal-grid">
        <article className="card stack workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Matching datasets')}</h3>
            <small className="muted">{t('Datasets currently compatible with the selected task type.')}</small>
          </div>
          <strong className="metric">{filteredDatasets.length}</strong>
        </article>
        <article className="card stack workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Ready Datasets')}</h3>
            <small className="muted">{t('Ready datasets available for immediate training launch.')}</small>
          </div>
          <strong className="metric">{readyMatchingDatasets}</strong>
        </article>
        <article className="card stack workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Framework')}</h3>
            <small className="muted">{t('Current framework family selected for the run.')}</small>
          </div>
          <strong className="metric">{t(framework)}</strong>
        </article>
        <article className={`card stack workspace-signal-card${taskDraft ? '' : ' attention'}`}>
          <div className="workspace-signal-top">
            <h3>{t('Draft assist')}</h3>
            <small className="muted">{t('Optional requirement parsing that can pre-fill task choices.')}</small>
          </div>
          <strong className="metric">{taskDraft ? t('Ready') : t('N/A')}</strong>
        </article>
      </section>

      <section className="workspace-overview-panel-grid">
        <div className="workspace-overview-main">
          <StepIndicator steps={steps} current={step} />
          {renderStage()}
        </div>

        <div className="workspace-overview-side">
          <article className="card stack">
            <div className="stack tight">
              <h3>{t('Requirement to Task Draft')}</h3>
              <small className="muted">
                {t('Turn a natural-language requirement into a suggested task, framework, labels, and metrics.')}
              </small>
            </div>
            <label>
              {t('Requirement Description')}
              <textarea
                value={requirementDescription}
                onChange={(event) => setRequirementDescription(event.target.value)}
                rows={4}
                placeholder={t('Example: detect train body defects or read train serial number')}
              />
            </label>
            <button type="button" onClick={createTaskDraft} disabled={drafting || loading}>
              {drafting ? t('Generating...') : t('Generate Task Draft')}
            </button>
            {taskDraft ? (
              <ul className="workspace-record-list compact">
                <li className="workspace-record-item compact">
                  <div className="row between gap wrap">
                    <strong>{t('Task Type')}</strong>
                    <span className="chip">{t(taskDraft.task_type)}</span>
                  </div>
                  <small className="muted">
                    {t('Framework')}: {t(taskDraft.recommended_framework)} · {t('annotation')}: {draftAnnotationType || t('N/A')}
                  </small>
                </li>
                <li className="workspace-record-item compact">
                  <div className="row between gap wrap">
                    <strong>{t('labels')}</strong>
                    <span className="chip">{taskDraft.label_hints.length}</span>
                  </div>
                  <small className="muted">{taskDraft.label_hints.join(', ') || t('N/A')}</small>
                </li>
                <li className="workspace-record-item compact">
                  <div className="row between gap wrap">
                    <strong>{t('dataset suggestions')}</strong>
                    <span className="chip">{taskDraft.dataset_suggestions.length}</span>
                  </div>
                  <small className="muted">{taskDraft.dataset_suggestions.join('；') || t('N/A')}</small>
                </li>
                <li className="workspace-record-item compact">
                  <div className="row between gap wrap">
                    <strong>{t('rationale')}</strong>
                    <span className="chip">{taskDraft.source}</span>
                  </div>
                  <small className="muted">{taskDraft.rationale}</small>
                </li>
              </ul>
            ) : (
              <StateBlock
                variant="empty"
                title={t('No requirement draft yet.')}
                description={t('Use the assist card to convert a free-form requirement into a structured training starting point.')}
              />
            )}
          </article>

          <article className="card stack">
            <div className="stack tight">
              <h3>{t('Current run plan')}</h3>
              <small className="muted">{stepDescriptions[step]}</small>
            </div>
            <ul className="workspace-record-list compact">
              {runChecklist.map((item) => (
                <li key={item.label} className="workspace-record-item compact">
                  <div className="row between gap wrap">
                    <strong>{item.label}</strong>
                    <span className={`workspace-status-pill ${item.done ? 'ready' : 'draft'}`}>
                      {item.done ? t('Ready') : t('draft')}
                    </span>
                  </div>
                  <small className="muted">{item.hint}</small>
                </li>
              ))}
            </ul>
          </article>

          <article className="card stack">
            <div className="stack tight">
              <h3>{t('Launch lane')}</h3>
              <small className="muted">{t('Keep the main training actions and supporting routes close together.')}</small>
            </div>
            <div className="workspace-button-stack">
              <button type="button" className="workspace-inline-button" onClick={previousStep} disabled={step === 0 || submitting}>
                {t('Back')}
              </button>
              <button
                type="button"
                className="workspace-inline-button"
                onClick={nextStep}
                disabled={step === steps.length - 1 || submitting || loading}
              >
                {t('Next')}
              </button>
              <button type="button" onClick={submit} disabled={step !== steps.length - 1 || submitting || loading}>
                {submitting ? t('Submitting...') : t('Create Training Job')}
              </button>
              <Link to="/datasets" className="workspace-inline-link">
                {t('Manage Datasets')}
              </Link>
              <Link to="/training/jobs" className="workspace-inline-link">
                {t('Open Training Jobs')}
              </Link>
            </div>
          </article>
        </div>
      </section>
    </div>
  );
}
