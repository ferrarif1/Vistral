import { useEffect, useState } from 'react';
import type { ModelRecord } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import { api } from '../services/api';

export default function MyModelsPage() {
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    api
      .listMyModels()
      .then((result) => {
        setModels(result);
        setError('');
      })
      .catch((loadError) => setError((loadError as Error).message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="stack">
      <h2>My Models</h2>

      {loading ? <StateBlock variant="loading" title="Loading Models" description="Checking ownership-scoped models." /> : null}
      {error ? <StateBlock variant="error" title="Load Failed" description={error} /> : null}
      {!loading && !error && models.length === 0 ? (
        <StateBlock variant="empty" title="No Owned Models" description="Create your first model from the Create Model page." />
      ) : null}

      {!loading && !error && models.length > 0 ? (
        <ul className="list">
          {models.map((model) => (
            <li key={model.id} className="card stack">
              <div className="row between">
                <strong>{model.name}</strong>
                <span className="chip">{model.status}</span>
              </div>
              <p>{model.description}</p>
              <small className="muted">owner_user_id: {model.owner_user_id}</small>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
