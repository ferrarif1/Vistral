import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DatasetRecord } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

const formatTimestamp = (iso: string): string => {
  const value = Date.parse(iso);
  if (Number.isNaN(value)) {
    return iso;
  }

  return new Date(value).toLocaleString();
};

export default function DatasetsPage() {
  const { t } = useI18n();
  const [datasets, setDatasets] = useState<DatasetRecord[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [taskType, setTaskType] = useState<'ocr' | 'detection' | 'classification' | 'segmentation' | 'obb'>('ocr');
  const [classesText, setClassesText] = useState('text_line,table,stamp');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const result = await api.listDatasets();
      setDatasets(result);
      setError('');
    } catch (loadError) {
      setError((loadError as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load().catch(() => {
      // no-op
    });
  }, []);

  const createDataset = async () => {
    if (!name.trim() || !description.trim()) {
      setError(t('Dataset name and description are required.'));
      return;
    }

    setSubmitting(true);
    setError('');
    setSuccess('');

    try {
      const classes = classesText
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);

      const created = await api.createDataset({
        name: name.trim(),
        description: description.trim(),
        task_type: taskType,
        label_schema: {
          classes
        }
      });

      setSuccess(t('Dataset {datasetId} created.', { datasetId: created.id }));
      setName('');
      setDescription('');
      await load();
    } catch (createError) {
      setError((createError as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const sortedDatasets = useMemo(
    () =>
      [...datasets].sort((left, right) => {
        const leftTime = Date.parse(left.updated_at);
        const rightTime = Date.parse(right.updated_at);
        return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
      }),
    [datasets]
  );

  const summary = useMemo(
    () => ({
      total: datasets.length,
      ready: datasets.filter((dataset) => dataset.status === 'ready').length,
      draft: datasets.filter((dataset) => dataset.status === 'draft').length,
      ocr: datasets.filter((dataset) => dataset.task_type === 'ocr').length,
      detection: datasets.filter((dataset) => dataset.task_type === 'detection').length
    }),
    [datasets]
  );

  return (
    <div className="workspace-overview-page stack">
      <section className="card workspace-overview-hero">
        <div className="workspace-overview-hero-grid">
          <div className="workspace-overview-copy stack">
            <small className="workspace-eyebrow">{t('Dataset Hub')}</small>
            <h1>{t('Datasets')}</h1>
            <p className="muted">{t('Create and manage dataset assets for OCR and detection workflows.')}</p>
          </div>
          <div className="workspace-overview-badges">
            <div className="workspace-overview-badge">
              <span>{t('Total')}</span>
              <strong>{summary.total}</strong>
            </div>
            <div className="workspace-overview-badge">
              <span>{t('Ready Datasets')}</span>
              <strong>{summary.ready}</strong>
            </div>
            <div className="workspace-overview-badge">
              <span>{t('Datasets by task')}</span>
              <strong>
                {summary.ocr} {t('ocr')} / {summary.detection} {t('detection')}
              </strong>
            </div>
          </div>
        </div>
      </section>

      {error ? <StateBlock variant="error" title={t('Dataset Action Failed')} description={error} /> : null}
      {success ? <StateBlock variant="success" title={t('Completed')} description={success} /> : null}

      <section className="workspace-overview-signal-grid">
        <article className="card stack workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Total')}</h3>
            <small className="muted">{t('All dataset shells currently visible to this account.')}</small>
          </div>
          <strong className="metric">{summary.total}</strong>
        </article>
        <article className="card stack workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Ready')}</h3>
            <small className="muted">{t('Datasets already prepared for downstream steps.')}</small>
          </div>
          <strong className="metric">{summary.ready}</strong>
        </article>
        <article className="card stack workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('draft')}</h3>
            <small className="muted">{t('Draft dataset containers still waiting for more structure.')}</small>
          </div>
          <strong className="metric">{summary.draft}</strong>
        </article>
        <article className="card stack workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Task Type')}</h3>
            <small className="muted">{t('OCR and detection remain the main operational paths here.')}</small>
          </div>
          <strong className="metric">
            {summary.ocr + summary.detection}
          </strong>
        </article>
      </section>

      <section className="workspace-overview-panel-grid">
        <article className="card stack workspace-overview-main">
          <div className="workspace-section-header">
            <div className="stack tight">
              <h3>{t('Dataset Inventory')}</h3>
              <small className="muted">
                {t('Open the dataset detail page to upload files, create splits, and version the asset.')}
              </small>
            </div>
            <button
              type="button"
              className="workspace-inline-button"
              onClick={() => {
                load().catch(() => {
                  // no-op
                });
              }}
              disabled={loading}
            >
              {loading ? t('Loading') : t('Refresh')}
            </button>
          </div>

          {loading ? (
            <StateBlock variant="loading" title={t('Loading Datasets')} description={t('Fetching dataset list.')} />
          ) : sortedDatasets.length === 0 ? (
            <StateBlock variant="empty" title={t('No Datasets')} description={t('Create your first dataset to begin.')} />
          ) : (
            <ul className="workspace-record-list">
              {sortedDatasets.map((dataset) => (
                <li key={dataset.id} className="workspace-record-item">
                  <div className="workspace-record-item-top">
                    <div className="workspace-record-summary stack tight">
                      <strong>{dataset.name}</strong>
                      <small className="muted">
                        {t(dataset.task_type)} · {t(dataset.status)} · {t('Last updated')}: {formatTimestamp(dataset.updated_at)}
                      </small>
                    </div>
                    <div className="workspace-record-actions">
                      <span className={`workspace-status-pill ${dataset.status}`}>{t(dataset.status)}</span>
                      <Link className="workspace-inline-link" to={`/datasets/${dataset.id}`}>
                        {t('Open Detail')}
                      </Link>
                    </div>
                  </div>
                  <p>{dataset.description}</p>
                  <div className="row gap wrap">
                    <span className="chip">{t(dataset.task_type)}</span>
                    <span className="chip">
                      {t('Classes')}: {dataset.label_schema.classes.length}
                    </span>
                    {dataset.label_schema.classes.slice(0, 3).map((label) => (
                      <span key={`${dataset.id}-${label}`} className="chip">
                        {label}
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </article>

        <div className="workspace-overview-side">
          <article className="card stack">
            <div className="stack tight">
              <h3>{t('Create Dataset')}</h3>
              <small className="muted">
                {t('Set the dataset intent first, then continue deeper in the detail workspace.')}
              </small>
            </div>

            <div className="workspace-form-grid">
              <label>
                {t('Name')}
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
              <label className="workspace-form-span-2">
                {t('Description')}
                <textarea
                  value={description}
                  rows={4}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
              <label className="workspace-form-span-2">
                {t('Label Classes (comma separated)')}
                <input
                  value={classesText}
                  onChange={(event) => setClassesText(event.target.value)}
                  placeholder="defect,scratch"
                />
              </label>
            </div>

            <button onClick={createDataset} disabled={submitting}>
              {submitting ? t('Creating...') : t('Create Dataset')}
            </button>
          </article>
        </div>
      </section>
    </div>
  );
}
