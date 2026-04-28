import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import type {
  DatasetRecord,
  InferenceRunRecord,
  ModelRecord,
  ModelVersionRecord,
  TrainingJobRecord,
  VisionModelingTaskRecord
} from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import { Badge } from '../components/ui/Badge';
import { ButtonLink } from '../components/ui/Button';
import { Select } from '../components/ui/Field';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

type PixelPhase = 'data' | 'design' | 'training' | 'exam' | 'delivery';

interface PixelLabState {
  datasets: DatasetRecord[];
  models: ModelRecord[];
  modelVersions: ModelVersionRecord[];
  trainingJobs: TrainingJobRecord[];
  inferenceRuns: InferenceRunRecord[];
  visionTasks: VisionModelingTaskRecord[];
}

const initialState: PixelLabState = {
  datasets: [],
  models: [],
  modelVersions: [],
  trainingJobs: [],
  inferenceRuns: [],
  visionTasks: []
};

const activeTrainingStatuses = new Set(['queued', 'preparing', 'running', 'evaluating']);

const formatDateTime = (value: string) => {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(parsed));
};

const sortByUpdatedDesc = <T extends { updated_at?: string; created_at: string }>(items: T[]) =>
  [...items].sort((left, right) => {
    const leftTime = Date.parse(left.updated_at ?? left.created_at);
    const rightTime = Date.parse(right.updated_at ?? right.created_at);
    return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
  });

const getModelCharacterClass = (index: number) =>
  ['pixel-character--rose', 'pixel-character--mint', 'pixel-character--violet', 'pixel-character--amber'][
    index % 4
  ];

const pixelScopedNavKeys = [
  'dataset',
  'version',
  'task_type',
  'framework',
  'execution_target',
  'worker',
  'return_to'
] as const;

const buildScopedPixelPath = (basePath: string, currentSearch: string): string => {
  const sourceParams = new URLSearchParams(currentSearch);
  const [pathname, query = ''] = basePath.split('?');
  const targetParams = new URLSearchParams(query);
  pixelScopedNavKeys.forEach((key) => {
    const value = sourceParams.get(key)?.trim();
    if (value && !targetParams.has(key)) {
      targetParams.set(key, value);
    }
  });
  const nextQuery = targetParams.toString();
  return nextQuery ? `${pathname}?${nextQuery}` : pathname;
};

export default function PixelLabPage() {
  const { t } = useI18n();
  const location = useLocation();
  const [state, setState] = useState<PixelLabState>(initialState);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedDatasetId, setSelectedDatasetId] = useState('');
  const [selectedModelVersionId, setSelectedModelVersionId] = useState('');
  const loginPath = useMemo(() => buildScopedPixelPath('/auth/login', location.search), [location.search]);
  const datasetsPath = useMemo(() => buildScopedPixelPath('/datasets', location.search), [location.search]);
  const smartLaunchPath = useMemo(
    () => buildScopedPixelPath('/training/jobs/new', location.search),
    [location.search]
  );
  const trainingJobsPath = useMemo(
    () => buildScopedPixelPath('/training/jobs', location.search),
    [location.search]
  );
  const modelVersionsPath = useMemo(
    () => buildScopedPixelPath('/models/versions', location.search),
    [location.search]
  );

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const [datasets, models, modelVersions, trainingJobs, inferenceRuns, visionTasks] = await Promise.all([
          api.listDatasets(),
          api.listModels(),
          api.listModelVersions(),
          api.listTrainingJobs(),
          api.listInferenceRuns(),
          api.listVisionTasks()
        ]);

        if (!cancelled) {
          setState({
            datasets,
            models,
            modelVersions,
            trainingJobs,
            inferenceRuns,
            visionTasks
          });
        }
      } catch (requestError) {
        if (!cancelled) {
          setError((requestError as Error).message);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const readyDatasets = useMemo(
    () => state.datasets.filter((dataset) => dataset.status === 'ready'),
    [state.datasets]
  );
  const activeTrainingJobs = useMemo(
    () => state.trainingJobs.filter((job) => activeTrainingStatuses.has(job.status)),
    [state.trainingJobs]
  );
  const latestTrainingJob = useMemo(
    () => sortByUpdatedDesc(state.trainingJobs)[0] ?? null,
    [state.trainingJobs]
  );
  const latestInferenceRun = useMemo(
    () => sortByUpdatedDesc(state.inferenceRuns)[0] ?? null,
    [state.inferenceRuns]
  );
  const latestVisionTask = useMemo(
    () => sortByUpdatedDesc(state.visionTasks)[0] ?? null,
    [state.visionTasks]
  );
  const registeredVersions = useMemo(
    () => state.modelVersions.filter((version) => version.status === 'registered'),
    [state.modelVersions]
  );

  const phase = useMemo<PixelPhase>(() => {
    if (activeTrainingJobs.length > 0) {
      return 'training';
    }
    if (state.modelVersions.length > 0 && latestInferenceRun) {
      return 'exam';
    }
    if (registeredVersions.length > 0) {
      return 'delivery';
    }
    if (readyDatasets.length > 0 || state.modelVersions.length > 0) {
      return 'design';
    }
    return 'data';
  }, [activeTrainingJobs.length, latestInferenceRun, readyDatasets.length, registeredVersions.length, state.modelVersions.length]);

  const autoDatasetId = readyDatasets[0]?.id ?? state.datasets[0]?.id ?? '';
  const autoModelVersionId = registeredVersions[0]?.id ?? state.modelVersions[0]?.id ?? '';

  useEffect(() => {
    if (!selectedDatasetId && autoDatasetId) {
      setSelectedDatasetId(autoDatasetId);
    }
  }, [autoDatasetId, selectedDatasetId]);

  useEffect(() => {
    if (!selectedModelVersionId && autoModelVersionId) {
      setSelectedModelVersionId(autoModelVersionId);
    }
  }, [autoModelVersionId, selectedModelVersionId]);

  const examSearch = useMemo(() => {
    const params = new URLSearchParams();
    if (selectedDatasetId) {
      params.set('dataset', selectedDatasetId);
    }
    if (selectedModelVersionId) {
      params.set('selectedVersion', selectedModelVersionId);
    }
    const query = params.toString();
    return query ? `/inference/validate?${query}` : '/inference/validate';
  }, [selectedDatasetId, selectedModelVersionId]);

  const phaseCopy: Record<PixelPhase, { title: string; summary: string; badge: string }> = {
    data: {
      title: 'Dataset warehouse is sorting albums',
      summary: 'Prepare or version a dataset before the model characters can study.',
      badge: 'Data sorting'
    },
    design: {
      title: 'Model characters are choosing study material',
      summary: 'A ready dataset or version exists. Pick the next recipe-backed training run.',
      badge: 'Design'
    },
    training: {
      title: 'Training workshop is active',
      summary: 'A model character is learning from the selected dataset. Watch the training lane for logs and evidence.',
      badge: 'Learning'
    },
    exam: {
      title: 'Exam room is ready for inference validation',
      summary: 'Choose a dataset and model version, then send the character into an explicit validation exam.',
      badge: 'Exam'
    },
    delivery: {
      title: 'Delivery room has registered model versions',
      summary: 'Promotion evidence exists. Continue into model versions or run an exam before shipping.',
      badge: 'Delivery'
    }
  };

  const baseCharacters = useMemo(() => {
    if (state.models.length > 0) {
      return state.models.slice(0, 4).map((model) => ({
        id: model.id,
        name: model.name,
        label: model.model_type,
        status: model.status
      }));
    }
    return [
      { id: 'yolo-guide', name: 'YOLO Scout', label: 'detection', status: 'foundation' },
      { id: 'paddle-scribe', name: 'Paddle Scribe', label: 'ocr', status: 'foundation' },
      { id: 'doctr-reader', name: 'docTR Reader', label: 'ocr', status: 'foundation' }
    ];
  }, [state.models]);

  if (loading) {
    return (
      <main className="pixel-lab-page pixel-lab-page--state">
        <StateBlock
          variant="loading"
          title={t('Loading Pixel Lab')}
          description={t('Preparing the pixel house from datasets, models, training jobs, and inference runs.')}
        />
      </main>
    );
  }

  if (error) {
    return (
      <main className="pixel-lab-page pixel-lab-page--state">
        <StateBlock
          variant="error"
          title={t('Pixel Lab unavailable')}
          description={error}
          extra={<ButtonLink to={loginPath} variant="secondary">{t('Login')}</ButtonLink>}
        />
      </main>
    );
  }

  return (
    <main className={`pixel-lab-page pixel-lab-phase-${phase}`}>
      <section className="pixel-lab-hud" aria-label={t('Pixel Lab status')}>
        <div>
          <small>{t('Pixel Lab')}</small>
          <h1>{t('Vistral Model House')}</h1>
          <p>{t(phaseCopy[phase].summary)}</p>
        </div>
        <div className="pixel-lab-hud__badges">
          <Badge tone={phase === 'training' ? 'info' : phase === 'exam' ? 'warning' : 'success'}>
            {t(phaseCopy[phase].badge)}
          </Badge>
          <Badge tone="neutral">{t('Datasets')}: {state.datasets.length}</Badge>
          <Badge tone="neutral">{t('Training Jobs')}: {state.trainingJobs.length}</Badge>
          <Badge tone="neutral">{t('Model Versions')}: {state.modelVersions.length}</Badge>
        </div>
      </section>

      <section className="pixel-lab-stage" aria-label={t('Pixel house')}>
        <div className="pixel-sky" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="pixel-house">
          <section className={`pixel-room pixel-room--warehouse${phase === 'data' ? ' active' : ''}`}>
            <div className="pixel-room__header">
              <strong>{t('Dataset Warehouse')}</strong>
              <Badge tone={readyDatasets.length > 0 ? 'success' : 'warning'}>
                {readyDatasets.length}/{state.datasets.length || 0}
              </Badge>
            </div>
            <div className="pixel-shelves" aria-hidden="true">
              {state.datasets.slice(0, 8).map((dataset, index) => (
                <span key={dataset.id} className={dataset.task_type} style={{ animationDelay: `${index * 120}ms` }} />
              ))}
            </div>
            <p>{t('Albums and tapes become trainable snapshots here.')}</p>
            <ButtonLink to={datasetsPath} variant="secondary" size="sm">
              {t('Open Datasets')}
            </ButtonLink>
          </section>

          <section className={`pixel-room pixel-room--studio${phase === 'design' ? ' active' : ''}`}>
            <div className="pixel-room__header">
              <strong>{t('Model Character Studio')}</strong>
              <Badge tone="info">{baseCharacters.length}</Badge>
            </div>
            <div className="pixel-character-row">
              {baseCharacters.map((character, index) => (
                <div key={character.id} className={`pixel-character ${getModelCharacterClass(index)}`}>
                  <span className="pixel-character__head" />
                  <span className="pixel-character__body" />
                  <small>{character.name}</small>
                  <em>{t(character.label)}</em>
                </div>
              ))}
            </div>
            <p>{t('Base model characters wait here for a recipe and a dataset.')}</p>
            <ButtonLink to={smartLaunchPath} variant="secondary" size="sm">
              {t('Smart Launch')}
            </ButtonLink>
          </section>

          <section className={`pixel-room pixel-room--training${phase === 'training' ? ' active' : ''}`}>
            <div className="pixel-room__header">
              <strong>{t('Training Workshop')}</strong>
              <Badge tone={activeTrainingJobs.length > 0 ? 'info' : 'neutral'}>{activeTrainingJobs.length}</Badge>
            </div>
            <div className="pixel-machine" aria-hidden="true">
              <span className="pixel-machine__screen" />
              <span className="pixel-machine__belt" />
              <span className="pixel-machine__spark" />
            </div>
            <p>
              {latestTrainingJob
                ? t('Latest job {{job}} is {{status}}.', {
                    job: latestTrainingJob.id,
                    status: t(latestTrainingJob.status)
                  })
                : t('No training run is active yet.')}
            </p>
            <ButtonLink to={trainingJobsPath} variant="secondary" size="sm">
              {t('Open Training Jobs')}
            </ButtonLink>
          </section>

          <section className={`pixel-room pixel-room--exam${phase === 'exam' ? ' active' : ''}`}>
            <div className="pixel-room__header">
              <strong>{t('Inference Exam Room')}</strong>
              <Badge tone={latestInferenceRun ? 'success' : 'warning'}>
                {latestInferenceRun ? t(latestInferenceRun.status) : t('Ready')}
              </Badge>
            </div>
            <div className="pixel-exam" aria-hidden="true">
              <span className="pixel-exam__desk" />
              <span className="pixel-exam__paper" />
              <span className="pixel-exam__timer" />
            </div>
            <div className="pixel-exam-controls">
              <label>
                <span>{t('Dataset')}</span>
                <Select value={selectedDatasetId} onChange={(event) => setSelectedDatasetId(event.target.value)}>
                  <option value="">{t('Auto select')}</option>
                  {state.datasets.map((dataset) => (
                    <option key={dataset.id} value={dataset.id}>
                      {dataset.name} · {dataset.task_type}
                    </option>
                  ))}
                </Select>
              </label>
              <label>
                <span>{t('Model Version')}</span>
                <Select value={selectedModelVersionId} onChange={(event) => setSelectedModelVersionId(event.target.value)}>
                  <option value="">{t('Auto select')}</option>
                  {state.modelVersions.map((version) => (
                    <option key={version.id} value={version.id}>
                      {version.version_name} · {version.task_type}
                    </option>
                  ))}
                </Select>
              </label>
            </div>
            <ButtonLink to={examSearch} variant="primary" size="sm">
              {t('Start exam')}
            </ButtonLink>
          </section>

          <section className={`pixel-room pixel-room--delivery${phase === 'delivery' ? ' active' : ''}`}>
            <div className="pixel-room__header">
              <strong>{t('Version Delivery Room')}</strong>
              <Badge tone={registeredVersions.length > 0 ? 'success' : 'neutral'}>{registeredVersions.length}</Badge>
            </div>
            <div className="pixel-delivery" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <p>
              {registeredVersions[0]
                ? t('Latest registered version: {{version}}.', {
                    version: registeredVersions[0].version_name
                  })
                : t('Registered versions will be packed here after promotion.')}
            </p>
            <ButtonLink to={modelVersionsPath} variant="secondary" size="sm">
              {t('Open Model Versions')}
            </ButtonLink>
          </section>
        </div>

        <aside className="pixel-lab-director" aria-label={t('Current process')}>
          <div className="pixel-dialog">
            <span className="pixel-dialog__avatar" aria-hidden="true" />
            <div>
              <strong>{t(phaseCopy[phase].title)}</strong>
              <p>{t('The house is synced from real Vistral records. Canonical actions still happen in the standard workflow pages.')}</p>
            </div>
          </div>
          <ol className="pixel-process">
            <li className={phase === 'data' ? 'active' : readyDatasets.length > 0 ? 'done' : ''}>
              <span>{t('Sort data')}</span>
              <strong>{readyDatasets.length} {t('ready')}</strong>
            </li>
            <li className={phase === 'design' ? 'active' : state.trainingJobs.length > 0 ? 'done' : ''}>
              <span>{t('Choose character')}</span>
              <strong>{baseCharacters[0]?.name ?? '-'}</strong>
            </li>
            <li className={phase === 'training' ? 'active' : state.modelVersions.length > 0 ? 'done' : ''}>
              <span>{t('Learn dataset')}</span>
              <strong>{activeTrainingJobs[0]?.status ? t(activeTrainingJobs[0].status) : t('Pending')}</strong>
            </li>
            <li className={phase === 'exam' ? 'active' : latestInferenceRun ? 'done' : ''}>
              <span>{t('Take exam')}</span>
              <strong>{latestInferenceRun ? formatDateTime(latestInferenceRun.updated_at) : t('Ready')}</strong>
            </li>
            <li className={phase === 'delivery' ? 'active' : registeredVersions.length > 0 ? 'done' : ''}>
              <span>{t('Deliver version')}</span>
              <strong>{registeredVersions.length}</strong>
            </li>
          </ol>
          {latestVisionTask ? (
            <ButtonLink
              to={`/vision/tasks/${encodeURIComponent(latestVisionTask.id)}`}
              variant="ghost"
              size="sm"
            >
              {t('Open latest vision task')}
            </ButtonLink>
          ) : null}
        </aside>
      </section>
    </main>
  );
}
