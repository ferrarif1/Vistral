import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DatasetRecord } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import { api } from '../services/api';

export default function DatasetsPage() {
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
      setError('Dataset name and description are required.');
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

      setSuccess(`Dataset ${created.id} created.`);
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
      <h2>Datasets</h2>
      <p className="muted">Create and manage dataset assets for OCR and detection workflows.</p>

      <section className="card stack">
        <h3>Create Dataset</h3>
        <label>
          Name
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          Description
          <textarea
            value={description}
            rows={3}
            onChange={(event) => setDescription(event.target.value)}
          />
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
          Label Classes (comma separated)
          <input
            value={classesText}
            onChange={(event) => setClassesText(event.target.value)}
            placeholder="defect,scratch"
          />
        </label>
        <button onClick={createDataset} disabled={submitting}>
          {submitting ? 'Creating...' : 'Create Dataset'}
        </button>
      </section>

      {loading ? <StateBlock variant="loading" title="Loading Datasets" description="Fetching dataset list." /> : null}
      {error ? <StateBlock variant="error" title="Dataset Action Failed" description={error} /> : null}
      {success ? <StateBlock variant="success" title="Completed" description={success} /> : null}

      {!loading && !error && datasets.length === 0 ? (
        <StateBlock variant="empty" title="No Datasets" description="Create your first dataset to begin." />
      ) : null}

      {!loading && !error && datasets.length > 0 ? (
        <ul className="list">
          {datasets.map((dataset) => (
            <li key={dataset.id} className="card stack">
              <div className="row between gap">
                <div className="stack tight">
                  <strong>{dataset.name}</strong>
                  <small className="muted">
                    {dataset.task_type} · {dataset.status}
                  </small>
                </div>
                <Link className="quick-link" to={`/datasets/${dataset.id}`}>
                  Open Detail
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
