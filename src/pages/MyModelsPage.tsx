import { useEffect, useState } from 'react';
import type { ModelRecord } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

export default function MyModelsPage() {
  const { t } = useI18n();
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
      <h2>{t('My Models')}</h2>

      {loading ? <StateBlock variant="loading" title={t('Loading Models')} description={t('Checking ownership-scoped models.')} /> : null}
      {error ? <StateBlock variant="error" title={t('Load Failed')} description={error} /> : null}
      {!loading && !error && models.length === 0 ? (
        <StateBlock variant="empty" title={t('No Owned Models')} description={t('Create your first model from the Create Model page.')} />
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
              <small className="muted">{t('owner_user_id')}: {model.owner_user_id}</small>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
