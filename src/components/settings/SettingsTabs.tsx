import { useEffect, useMemo, useState } from 'react';
import { NavLink } from 'react-router-dom';
import type { RuntimeReadinessReport, RuntimeSettingsView } from '../../../shared/domain';
import { Card } from '../ui/Surface';
import { Badge } from '../ui/Badge';
import { useI18n } from '../../i18n/I18nProvider';
import { api } from '../../services/api';

const RUNTIME_FRAMEWORKS = ['paddleocr', 'doctr', 'yolo'] as const;

type RuntimeQuickSetupSnapshot = {
  completed: number;
  total: number;
  nextAction: string;
  localOnlyBaseline: boolean;
  endpointConfiguredCount: number;
  readinessReady: boolean;
};

const buildRuntimeQuickSetupSnapshot = (
  settings: RuntimeSettingsView,
  readiness: RuntimeReadinessReport,
  t: (source: string, vars?: Record<string, string | number>) => string
): RuntimeQuickSetupSnapshot => {
  const endpointConfiguredCount = RUNTIME_FRAMEWORKS.reduce((count, framework) => {
    return settings.frameworks[framework].endpoint.trim() ? count + 1 : count;
  }, 0);
  const localOnlyBaseline = endpointConfiguredCount === 0 && Boolean(settings.updated_at);
  const configured = endpointConfiguredCount > 0 || localOnlyBaseline;
  const profileActivated = Boolean(settings.active_profile_id);
  const readinessReady = readiness.status === 'ready';
  const completed = [configured, profileActivated, readinessReady].filter(Boolean).length;

  let nextAction = t('Configure at least one framework');
  if (configured && !profileActivated) {
    nextAction = t('Activate profile');
  } else if (configured && profileActivated && !readinessReady) {
    nextAction = t('Run readiness checks');
  } else if (configured && profileActivated && readinessReady) {
    nextAction = t('Validate Inference');
  } else if (!configured && endpointConfiguredCount === 0) {
    nextAction = t('Apply local quick setup');
  }

  return {
    completed,
    total: 3,
    nextAction,
    localOnlyBaseline,
    endpointConfiguredCount,
    readinessReady
  };
};

export default function SettingsTabs() {
  const { t } = useI18n();
  const [runtimeSnapshot, setRuntimeSnapshot] = useState<RuntimeQuickSetupSnapshot | null>(null);
  const [runtimeSnapshotLoading, setRuntimeSnapshotLoading] = useState(true);
  const [runtimeSnapshotError, setRuntimeSnapshotError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setRuntimeSnapshotLoading(true);
    setRuntimeSnapshotError('');

    void Promise.all([api.getRuntimeSettings(), api.getRuntimeReadiness()])
      .then(([settings, readiness]) => {
        if (cancelled) {
          return;
        }
        setRuntimeSnapshot(buildRuntimeQuickSetupSnapshot(settings, readiness, t));
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setRuntimeSnapshot(null);
        setRuntimeSnapshotError((error as Error).message);
      })
      .finally(() => {
        if (!cancelled) {
          setRuntimeSnapshotLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [t]);

  const runtimeSnapshotTone = useMemo(() => {
    if (runtimeSnapshotLoading) {
      return 'neutral' as const;
    }
    if (!runtimeSnapshot) {
      return 'warning' as const;
    }
    if (runtimeSnapshot.readinessReady) {
      return 'success' as const;
    }
    if (runtimeSnapshot.completed >= 2) {
      return 'info' as const;
    }
    return 'warning' as const;
  }, [runtimeSnapshot, runtimeSnapshotLoading]);

  return (
    <Card className="settings-surface-nav">
      <div className="stack tight">
        <strong>{t('Settings')}</strong>
        <small className="muted">
          {t('Use one settings entry, then switch between Account, LLM, Runtime, Runtime Templates, and Workers here.')}
        </small>
      </div>

      <nav className="settings-surface-tabs" aria-label={t('Settings')}>
        <NavLink
          to="/settings/account"
          className={({ isActive }) =>
            isActive ? 'settings-surface-tab active' : 'settings-surface-tab'
          }
        >
          {t('Account Settings')}
        </NavLink>
        <NavLink
          to="/settings/llm"
          className={({ isActive }) =>
            isActive ? 'settings-surface-tab active' : 'settings-surface-tab'
          }
        >
          {t('LLM Settings')}
        </NavLink>
        <NavLink
          to="/settings/runtime"
          end
          className={({ isActive }) =>
            isActive ? 'settings-surface-tab active' : 'settings-surface-tab'
          }
        >
          {t('Runtime Settings')}
        </NavLink>
        <NavLink
          to="/settings/runtime/templates"
          className={({ isActive }) =>
            isActive ? 'settings-surface-tab active' : 'settings-surface-tab'
          }
        >
          {t('Runtime Templates')}
        </NavLink>
        <NavLink
          to="/settings/workers"
          className={({ isActive }) =>
            isActive ? 'settings-surface-tab active' : 'settings-surface-tab'
          }
        >
          {t('Worker Settings')}
        </NavLink>
      </nav>

      <div className="stack tight" style={{ marginTop: 8 }}>
        <div className="row gap wrap align-center">
          <Badge tone={runtimeSnapshotTone}>
            {t('Runtime quick-start snapshot')}:{' '}
            {runtimeSnapshotLoading
              ? t('Checking...')
              : runtimeSnapshot
                ? `${runtimeSnapshot.completed}/${runtimeSnapshot.total}`
                : t('unavailable')}
          </Badge>
          {runtimeSnapshot ? (
            <>
              <Badge tone={runtimeSnapshot.localOnlyBaseline ? 'info' : 'neutral'}>
                {runtimeSnapshot.localOnlyBaseline
                  ? t('Local-only path active')
                  : t('Endpoints') + `: ${runtimeSnapshot.endpointConfiguredCount}`}
              </Badge>
              <Badge tone={runtimeSnapshot.readinessReady ? 'success' : 'warning'}>
                {t('Next runtime action')}: {runtimeSnapshot.nextAction}
              </Badge>
            </>
          ) : null}
        </div>
        {!runtimeSnapshotLoading && runtimeSnapshotError ? (
          <small className="muted">
            {t('Runtime setup snapshot unavailable')}: {runtimeSnapshotError}
          </small>
        ) : null}
      </div>
    </Card>
  );
}
