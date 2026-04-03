import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DatasetRecord } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

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

  return (
    <div className="stack">
      <h2>{t('Datasets')}</h2>
      <p className="muted">{t('Create and manage dataset assets for OCR and detection workflows.')}</p>

      <section className="card stack">
        <h3>{t('Create Dataset')}</h3>
        <label>
          {t('Name')}
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          {t('Description')}
          <textarea
            value={description}
            rows={3}
            onChange={(event) => setDescription(event.target.value)}
          />
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
          {t('Label Classes (comma separated)')}
          <input
            value={classesText}
            onChange={(event) => setClassesText(event.target.value)}
            placeholder="defect,scratch"
          />
        </label>
        <button onClick={createDataset} disabled={submitting}>
          {submitting ? t('Creating...') : t('Create Dataset')}
        </button>
      </section>

      {loading ? <StateBlock variant="loading" title={t('Loading Datasets')} description={t('Fetching dataset list.')} /> : null}
      {error ? <StateBlock variant="error" title={t('Dataset Action Failed')} description={error} /> : null}
      {success ? <StateBlock variant="success" title={t('Completed')} description={success} /> : null}

      {!loading && !error && datasets.length === 0 ? (
        <StateBlock variant="empty" title={t('No Datasets')} description={t('Create your first dataset to begin.')} />
      ) : null}

      {!loading && !error && datasets.length > 0 ? (
        <ul className="list">
          {datasets.map((dataset) => (
            <li key={dataset.id} className="card stack">
              <div className="row between gap">
                <div className="stack tight">
                  <strong>{dataset.name}</strong>
                  <small className="muted">
                    {t(dataset.task_type)} · {t(dataset.status)}
                  </small>
                </div>
                <Link className="quick-link" to={`/datasets/${dataset.id}`}>
                  {t('Open Detail')}
                </Link>
              </div>
              <p>{dataset.description}</p>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
