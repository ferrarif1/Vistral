import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { DatasetRecord } from '../../shared/domain';
import AdvancedSection from '../components/AdvancedSection';
import StateBlock from '../components/StateBlock';
import StepIndicator from '../components/StepIndicator';
import { api } from '../services/api';

const STEPS = ['Task', 'Dataset', 'Params', 'Review'];

export default function CreateTrainingJobPage() {
  const navigate = useNavigate();
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
    if (step < STEPS.length - 1) {
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
      setFeedback({ variant: 'error', text: 'Training job name is required.' });
      return;
    }

    if (!datasetId) {
      setFeedback({ variant: 'error', text: 'Please select a dataset.' });
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

      setFeedback({ variant: 'success', text: `Training job ${created.id} created.` });
      navigate(`/training/jobs/${created.id}`);
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="stack page-width">
      <h2>Create Training Job</h2>
      <StepIndicator steps={STEPS} current={step} />

      {loading ? (
        <StateBlock variant="loading" title="Preparing" description="Loading dataset options." />
      ) : null}

      {feedback ? (
        <StateBlock
          variant={feedback.variant}
          title={feedback.variant === 'success' ? 'Action Completed' : 'Action Failed'}
          description={feedback.text}
        />
      ) : null}

      {step === 0 ? (
        <section className="card stack">
          <h3>Step 1. Task and Framework</h3>
          <label>
            Training Job Name
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            Task Type
            <select
              value={taskType}
              onChange={(event) =>
                setTaskType(
                  event.target.value as 'ocr' | 'detection' | 'classification' | 'segmentation' | 'obb'
                )
              }
            >
              <option value="ocr">ocr</option>
              <option value="detection">detection</option>
              <option value="classification">classification</option>
              <option value="segmentation">segmentation</option>
              <option value="obb">obb</option>
            </select>
          </label>
          <label>
            Framework
            <select
              value={framework}
              onChange={(event) => setFramework(event.target.value as 'paddleocr' | 'doctr' | 'yolo')}
            >
              {taskFrameworkOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        </section>
      ) : null}

      {step === 1 ? (
        <section className="card stack">
          <h3>Step 2. Dataset and Base Model</h3>
          {filteredDatasets.length === 0 ? (
            <StateBlock
              variant="empty"
              title="No Matching Dataset"
              description="Create dataset for selected task type first."
            />
          ) : null}
          <label>
            Dataset
            <select value={datasetId} onChange={(event) => setDatasetId(event.target.value)}>
              {filteredDatasets.map((dataset) => (
                <option key={dataset.id} value={dataset.id}>
                  {dataset.name} ({dataset.status})
                </option>
              ))}
            </select>
          </label>
          <label>
            Dataset Version (optional)
            <input
              value={datasetVersionId}
              onChange={(event) => setDatasetVersionId(event.target.value)}
              placeholder="dv-1"
            />
          </label>
          <label>
            Base Model
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
            <h3>Step 3. Core Params</h3>
            <div className="three-col">
              <label>
                Epochs
                <input value={epochs} onChange={(event) => setEpochs(event.target.value)} />
              </label>
              <label>
                Batch Size
                <input value={batchSize} onChange={(event) => setBatchSize(event.target.value)} />
              </label>
              <label>
                Learning Rate
                <input value={learningRate} onChange={(event) => setLearningRate(event.target.value)} />
              </label>
            </div>
          </section>

          <AdvancedSection>
            <label>
              Warmup Ratio
              <input value={warmupRatio} onChange={(event) => setWarmupRatio(event.target.value)} />
            </label>
            <label>
              Weight Decay
              <input value={weightDecay} onChange={(event) => setWeightDecay(event.target.value)} />
            </label>
          </AdvancedSection>
        </section>
      ) : null}

      {step === 3 ? (
        <section className="card stack">
          <h3>Step 4. Review</h3>
          <p>
            <strong>{name || 'Unnamed job'}</strong>
          </p>
          <p className="muted">
            task {taskType} · framework {framework}
          </p>
          <p className="muted">
            dataset {datasetId || 'N/A'} · dataset version {datasetVersionId || 'latest'}
          </p>
          <p className="muted">
            epochs {epochs}, batch size {batchSize}, learning rate {learningRate}
          </p>
        </section>
      ) : null}

      <div className="row gap">
        <button onClick={previousStep} disabled={step === 0 || submitting}>
          Back
        </button>
        <button onClick={nextStep} disabled={step === STEPS.length - 1 || submitting || loading}>
          Next
        </button>
        <button onClick={submit} disabled={step !== STEPS.length - 1 || submitting || loading}>
          {submitting ? 'Submitting...' : 'Create Training Job'}
        </button>
      </div>
    </div>
  );
}
