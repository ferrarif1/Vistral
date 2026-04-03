import { useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

type ApiHealthState = 'checking' | 'healthy' | 'degraded';

const parseHealthErrorDetail = (error: unknown): string => {
  const message = (error as Error).message?.trim();
  if (!message) {
    return 'unknown';
  }

  if (message.length > 120) {
    return `${message.slice(0, 120)}...`;
  }

  return message;
};

export default function ApiHealthBanner() {
  const { t } = useI18n();
  const [state, setState] = useState<ApiHealthState>('checking');
  const [detail, setDetail] = useState('');
  const [checking, setChecking] = useState(false);

  const checkHealth = useCallback(async () => {
    setChecking(true);
    try {
      const response = await api.health();
      if (response.status === 'ok') {
        setState('healthy');
        setDetail('');
      } else {
        setState('degraded');
        setDetail(t('Unexpected API health payload.'));
      }
    } catch (error) {
      setState('degraded');
      setDetail(parseHealthErrorDetail(error));
    } finally {
      setChecking(false);
    }
  }, [t]);

  useEffect(() => {
    checkHealth().catch(() => {
      // surfaced via local status
    });

    const timer = window.setInterval(() => {
      checkHealth().catch(() => {
        // surfaced via local status
      });
    }, 15000);

    const onOnline = () => {
      checkHealth().catch(() => {
        // surfaced via local status
      });
    };
    const onOffline = () => {
      setState('degraded');
      setDetail(t('Browser is offline.'));
    };

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [checkHealth, t]);

  const visible = state === 'degraded';
  const statusDetail = useMemo(
    () => (detail ? `${t('Current status')}: ${detail}` : ''),
    [detail, t]
  );

  if (!visible) {
    return null;
  }

  return (
    <div className="api-health-banner" role="status" aria-live="polite">
      <div className="api-health-banner-inner">
        <div className="stack tight">
          <strong>{t('Backend service unreachable. Some actions may fail until API recovers.')}</strong>
          <small>{t('Check API process (`npm run dev:api`) or Docker service status.')}</small>
          {statusDetail ? <small className="muted">{statusDetail}</small> : null}
        </div>
        <button
          type="button"
          className="small-btn api-health-banner-retry"
          onClick={() => {
            checkHealth().catch(() => {
              // surfaced via local status
            });
          }}
          disabled={checking}
        >
          {checking ? t('Checking...') : t('Retry')}
        </button>
      </div>
    </div>
  );
}
