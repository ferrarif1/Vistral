import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from './ui/Button';
import useBackgroundPolling from '../hooks/useBackgroundPolling';
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

const normalizeHealthDetailForUi = (
  detail: string,
  t: (source: string) => string
): string => {
  const lowered = detail.toLowerCase();
  if (lowered.includes('empty response body')) {
    return t(
      'API returned empty response body. This usually means API restart or proxy upstream interruption.'
    );
  }

  if (lowered.includes('failed to fetch')) {
    return t('Network request failed. Check API process, Docker status, or proxy reachability.');
  }

  return detail;
};

export default function ApiHealthBanner() {
  const { t } = useI18n();
  const [state, setState] = useState<ApiHealthState>('checking');
  const [detail, setDetail] = useState('');
  const [checking, setChecking] = useState(false);

  const applyHealthState = useCallback((nextState: ApiHealthState, nextDetail: string) => {
    setState((previous) => (previous === nextState ? previous : nextState));
    setDetail((previous) => (previous === nextDetail ? previous : nextDetail));
  }, []);

  const checkHealth = useCallback(async (showChecking = false) => {
    if (showChecking) {
      setChecking(true);
    }

    try {
      const response = await api.health();
      if (response.status === 'ok') {
        applyHealthState('healthy', '');
      } else {
        applyHealthState('degraded', t('Unexpected API health payload.'));
      }
    } catch (error) {
      applyHealthState('degraded', parseHealthErrorDetail(error));
    } finally {
      if (showChecking) {
        setChecking(false);
      }
    }
  }, [applyHealthState, t]);

  useEffect(() => {
    checkHealth(false).catch(() => {
      // surfaced via local status
    });

    const onOnline = () => {
      checkHealth(false).catch(() => {
        // surfaced via local status
      });
    };
    const onOffline = () => {
      applyHealthState('degraded', t('Browser is offline.'));
    };

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [applyHealthState, checkHealth, t]);

  useBackgroundPolling(
    () => {
      checkHealth(false).catch(() => {
        // surfaced via local status
      });
    },
    {
      intervalMs: 15000
    }
  );

  const visible = state === 'degraded';
  const showEmptyBodyHint = detail.toLowerCase().includes('empty response body');
  const localizedDetail = useMemo(() => normalizeHealthDetailForUi(detail, t), [detail, t]);
  const statusDetail = useMemo(
    () => (localizedDetail ? `${t('Current status')}: ${localizedDetail}` : ''),
    [localizedDetail, t]
  );

  if (!visible) {
    return null;
  }

  return (
    <div className="api-health-banner" role="status" aria-live="polite">
      <div className="api-health-banner-inner">
        <div className="stack tight">
          <strong>{t('Backend service unreachable. Some actions may fail until API recovers.')}</strong>
          <small>
            {t(
              'Check that the Docker stack is running, then access the product via http://127.0.0.1:8080.'
            )}
          </small>
          <small>
            {t(
              'API requests should go through http://127.0.0.1:8080/api/* (host port 8787 may be intentionally closed).'
            )}
          </small>
          {showEmptyBodyHint ? (
            <small>
              {t(
                'Empty response body usually means upstream API restarted or proxy upstream temporarily failed. Retry in a few seconds.'
              )}
            </small>
          ) : null}
          {statusDetail ? <small className="muted">{statusDetail}</small> : null}
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="api-health-banner-retry"
          onClick={() => {
            checkHealth(true).catch(() => {
              // surfaced via local status
            });
          }}
          disabled={checking}
        >
          {checking ? t('Checking...') : t('Retry')}
        </Button>
      </div>
    </div>
  );
}
