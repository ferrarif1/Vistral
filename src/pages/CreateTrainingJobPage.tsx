import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { DatasetRecord } from '../../shared/domain';
import AdvancedSection from '../components/AdvancedSection';
import StateBlock from '../components/StateBlock';
import StepIndicator from '../components/StepIndicator';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

export default function CreateTrainingJobPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const steps = useMemo(() => [t('Task'), t('Dataset'), t('Params'), t('Review')], [t]);
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
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ variant: 'success' | 'error'; text: string } | null>(null);

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

  const filteredDatasets = useMemo(
    () => datasets.filter((dataset) => dataset.task_type === taskType),
    [datasets, taskType]
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

  return (
    <div className="stack page-width">
      <h2>{t('Create Training Job')}</h2>
      <StepIndicator steps={steps} current={step} />

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

      {step === 0 ? (
        <section className="card stack">
          <h3>{t('Step 1. Task and Framework')}</h3>
          <label>
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
        </section>
      ) : null}

      {step === 1 ? (
        <section className="card stack">
          <h3>{t('Step 2. Dataset and Base Model')}</h3>
          {filteredDatasets.length === 0 ? (
            <StateBlock
              variant="empty"
              title={t('No Matching Dataset')}
              description={t('Create dataset for selected task type first.')}
            />
          ) : null}
          <label>
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
              placeholder="dv-1"
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
        </section>
      ) : null}

      {step === 2 ? (
        <section className="stack">
          <section className="card stack">
            <h3>{t('Step 3. Core Params')}</h3>
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
      ) : null}

      {step === 3 ? (
        <section className="card stack">
          <h3>{t('Step 4. Review')}</h3>
          <p>
            <strong>{name || t('Unnamed job')}</strong>
          </p>
          <p className="muted">
            {t('Task')}: {t(taskType)} · {t('Framework')}: {t(framework)}
          </p>
          <p className="muted">
            {t('Dataset')}: {datasetId || t('N/A')} · {t('Dataset Version')}: {datasetVersionId || t('latest')}
          </p>
          <p className="muted">
            {t('Epochs')}: {epochs}, {t('Batch Size')}: {batchSize}, {t('Learning Rate')}: {learningRate}
          </p>
        </section>
      ) : null}

      <div className="row gap">
        <button onClick={previousStep} disabled={step === 0 || submitting}>
          {t('Back')}
        </button>
        <button onClick={nextStep} disabled={step === steps.length - 1 || submitting || loading}>
          {t('Next')}
        </button>
        <button onClick={submit} disabled={step !== steps.length - 1 || submitting || loading}>
          {submitting ? t('Submitting...') : t('Create Training Job')}
        </button>
      </div>
    </div>
  );
}
