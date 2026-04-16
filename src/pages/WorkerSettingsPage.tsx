import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  CreateTrainingWorkerInput,
  TrainingWorkerBootstrapSessionRecord,
  TrainingWorkerDeploymentMode,
  TrainingWorkerNodeView,
  TrainingWorkerProfile,
  TrainingWorkerStatus
} from '../../shared/domain';
import SettingsTabs from '../components/settings/SettingsTabs';
import StateBlock from '../components/StateBlock';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import {
  ActionBar,
  ConfirmDangerDialog,
  DetailDrawer,
  DetailList,
  InlineAlert,
  PageHeader,
  SectionCard,
  StatusTable,
  type StatusTableColumn
} from '../components/ui/ConsolePage';
import { Input, Select, Textarea } from '../components/ui/Field';
import { Drawer } from '../components/ui/Overlay';
import ProgressStepper from '../components/ui/ProgressStepper';
import { Card, Panel } from '../components/ui/Surface';
import { WorkspacePage, WorkspaceSectionHeader, WorkspaceWorkbench } from '../components/ui/WorkspacePage';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';
import { formatCompactTimestamp } from '../utils/formatting';

type WorkerOnboardingDraft = {
  deployment_mode: TrainingWorkerDeploymentMode;
  worker_profile: TrainingWorkerProfile;
  control_plane_base_url: string;
  worker_name: string;
  worker_public_host: string;
  worker_bind_port: string;
  max_concurrency: string;
};

type WorkerRegistryDraft = {
  name: string;
  endpoint: string;
  status: TrainingWorkerStatus;
  enabled: boolean;
  max_concurrency: string;
  capabilities_text: string;
  metadata_text: string;
};

const buildDefaultWorkerOnboardingDraft = (): WorkerOnboardingDraft => ({
  deployment_mode: 'docker',
  worker_profile: 'yolo',
  control_plane_base_url:
    typeof window !== 'undefined' && window.location?.origin ? window.location.origin : '',
  worker_name: '',
  worker_public_host: '',
  worker_bind_port: '9090',
  max_concurrency: '1'
});

const buildDefaultWorkerRegistryDraft = (): WorkerRegistryDraft => ({
  name: '',
  endpoint: '',
  status: 'online',
  enabled: true,
  max_concurrency: '1',
  capabilities_text: 'framework:yolo, task:detection',
  metadata_text: ''
});

const normalizeCapabilityTokens = (raw: string): string[] =>
  raw
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);

const normalizeMetadataInput = (raw: string): Record<string, string> =>
  raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((result, line) => {
      const separatorIndex = line.indexOf('=');
      if (separatorIndex < 0) {
        result[line] = '';
        return result;
      }
      const key = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1).trim();
      if (key) {
        result[key] = value;
      }
      return result;
    }, {});

const serializeCapabilities = (capabilities: string[]) => capabilities.join(', ');

const serializeMetadata = (metadata: Record<string, string>) =>
  Object.entries(metadata)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

const buildWorkerRegistryDraftFromWorker = (worker: TrainingWorkerNodeView): WorkerRegistryDraft => ({
  name: worker.name,
  endpoint: worker.endpoint ?? '',
  status: worker.status,
  enabled: worker.enabled,
  max_concurrency: String(worker.max_concurrency),
  capabilities_text: serializeCapabilities(worker.capabilities),
  metadata_text: serializeMetadata(worker.metadata)
});

const formatWorkerUrlHost = (value: string): string =>
  value.includes(':') && !value.startsWith('[') ? `[${value}]` : value;

const buildWorkerEndpointHint = (
  workerPublicHost: string | null,
  workerBindPort: number
): string | null =>
  workerPublicHost ? `http://${formatWorkerUrlHost(workerPublicHost)}:${workerBindPort}` : null;

const buildWorkerSetupUrlHint = (workerPublicHost: string | null, workerBindPort: number): string => {
  const endpoint = buildWorkerEndpointHint(workerPublicHost, workerBindPort);
  return endpoint ? `${endpoint}/setup` : `http://<worker-host>:${workerBindPort}/setup`;
};

const resolveWorkerRuntimeProfile = (worker: TrainingWorkerNodeView): string | null =>
  worker.metadata.runtime_profile ??
  worker.metadata.worker_runtime_profile ??
  worker.metadata.profile ??
  null;

const resolveWorkerVersion = (worker: TrainingWorkerNodeView): string | null =>
  worker.metadata.worker_version ?? null;

const resolveWorkerContractVersion = (worker: TrainingWorkerNodeView): string | null =>
  worker.metadata.contract_version ?? null;

const isConcreteWorkerUrl = (value: string | null | undefined): value is string =>
  Boolean(value && value.trim() && !value.includes('<worker-host>'));

const workerBootstrapStatusTone = (
  status: TrainingWorkerBootstrapSessionRecord['status']
): 'ready' | 'running' | 'failed' | 'draft' => {
  if (status === 'online') {
    return 'ready';
  }
  if (status === 'pairing' || status === 'awaiting_confirmation') {
    return 'running';
  }
  if (status === 'validation_failed' || status === 'expired') {
    return 'failed';
  }
  return 'draft';
};

const resolveSessionCompatibility = (
  session: TrainingWorkerBootstrapSessionRecord
): NonNullable<TrainingWorkerBootstrapSessionRecord['compatibility']> =>
  session.compatibility ?? {
    status: 'unknown',
    message: 'Compatibility check has not run yet.',
    expected_runtime_profile: session.worker_runtime_profile,
    reported_runtime_profile: null,
    reported_worker_version: null,
    reported_contract_version: null,
    missing_capabilities: []
  };

const workerCompatibilityBadgeTone = (
  status: NonNullable<TrainingWorkerBootstrapSessionRecord['compatibility']>['status']
): 'success' | 'warning' | 'danger' | 'neutral' => {
  if (status === 'compatible') {
    return 'success';
  }
  if (status === 'warning') {
    return 'warning';
  }
  if (status === 'incompatible') {
    return 'danger';
  }
  return 'neutral';
};

export default function WorkerSettingsPage() {
  const { t } = useI18n();
  const [workerView, setWorkerView] = useState<'inventory' | 'pairing'>('inventory');
  const [workersLoading, setWorkersLoading] = useState(true);
  const [workers, setWorkers] = useState<TrainingWorkerNodeView[]>([]);
  const [workersAccessDenied, setWorkersAccessDenied] = useState(false);
  const [workersError, setWorkersError] = useState('');
  const [bootstrapSessionsLoading, setBootstrapSessionsLoading] = useState(true);
  const [bootstrapSessions, setBootstrapSessions] = useState<TrainingWorkerBootstrapSessionRecord[]>([]);
  const [bootstrapSessionsAccessDenied, setBootstrapSessionsAccessDenied] = useState(false);
  const [bootstrapSessionsError, setBootstrapSessionsError] = useState('');
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null);
  const [workerMutationTargetId, setWorkerMutationTargetId] = useState<string | null>(null);
  const [workerMutationAction, setWorkerMutationAction] = useState('');

  const [workerRegistryOpen, setWorkerRegistryOpen] = useState(false);
  const [workerRegistrySaving, setWorkerRegistrySaving] = useState(false);
  const [workerRegistryError, setWorkerRegistryError] = useState('');
  const [editingWorkerId, setEditingWorkerId] = useState<string | null>(null);
  const [workerRegistryDraft, setWorkerRegistryDraft] = useState<WorkerRegistryDraft>(
    () => buildDefaultWorkerRegistryDraft()
  );

  const [workerOnboardingOpen, setWorkerOnboardingOpen] = useState(false);
  const [workerOnboardingDraft, setWorkerOnboardingDraft] = useState<WorkerOnboardingDraft>(
    () => buildDefaultWorkerOnboardingDraft()
  );
  const [creatingBootstrapSession, setCreatingBootstrapSession] = useState(false);
  const [activeBootstrapSessionId, setActiveBootstrapSessionId] = useState<string | null>(null);
  const [downloadingBootstrapSessionId, setDownloadingBootstrapSessionId] = useState<string | null>(
    null
  );
  const [validatingBootstrapSessionId, setValidatingBootstrapSessionId] = useState<string | null>(
    null
  );
  const [activatingBootstrapWorkerId, setActivatingBootstrapWorkerId] = useState<string | null>(null);
  const [reconfiguringWorkerId, setReconfiguringWorkerId] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState('');
  const [removingWorker, setRemovingWorker] = useState<TrainingWorkerNodeView | null>(null);

  const refreshTrainingWorkers = useCallback(async () => {
    setWorkersLoading(true);
    setWorkersError('');
    setWorkersAccessDenied(false);
    try {
      const list = await api.listTrainingWorkers();
      setWorkers(list);
    } catch (workerError) {
      const message = (workerError as Error).message;
      if (/admin/i.test(message) || /permission/i.test(message)) {
        setWorkersAccessDenied(true);
        setWorkers([]);
      } else {
        setWorkersError(message);
      }
    } finally {
      setWorkersLoading(false);
    }
  }, []);

  const refreshBootstrapSessions = useCallback(async () => {
    setBootstrapSessionsLoading(true);
    setBootstrapSessionsError('');
    setBootstrapSessionsAccessDenied(false);
    try {
      const list = await api.listTrainingWorkerBootstrapSessions();
      setBootstrapSessions(list);
    } catch (bootstrapError) {
      const message = (bootstrapError as Error).message;
      if (/admin/i.test(message) || /permission/i.test(message)) {
        setBootstrapSessionsAccessDenied(true);
        setBootstrapSessions([]);
      } else {
        setBootstrapSessionsError(message);
      }
    } finally {
      setBootstrapSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshTrainingWorkers();
    void refreshBootstrapSessions();
  }, [refreshBootstrapSessions, refreshTrainingWorkers]);

  const refreshAll = async () => {
    await Promise.all([refreshTrainingWorkers(), refreshBootstrapSessions()]);
  };

  const copyText = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyMessage(t('{label} copied.', { label }));
    } catch (copyError) {
      setCopyMessage(t('Copy failed: {message}', { message: (copyError as Error).message }));
    }
  };

  const openExternalUrl = (url: string) => {
    if (!isConcreteWorkerUrl(url)) {
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const openCreateWorkerRegistry = () => {
    setEditingWorkerId(null);
    setWorkerRegistryDraft(buildDefaultWorkerRegistryDraft());
    setWorkerRegistryError('');
    setWorkerRegistryOpen(true);
  };

  const openEditWorkerRegistry = useCallback((worker: TrainingWorkerNodeView) => {
    setEditingWorkerId(worker.id);
    setWorkerRegistryDraft(buildWorkerRegistryDraftFromWorker(worker));
    setWorkerRegistryError('');
    setWorkerRegistryOpen(true);
  }, []);

  const buildWorkerRegistryPayload = (): CreateTrainingWorkerInput => ({
    name: workerRegistryDraft.name.trim(),
    endpoint: workerRegistryDraft.endpoint.trim() || null,
    status: workerRegistryDraft.status,
    enabled: workerRegistryDraft.enabled,
    max_concurrency: Number.parseInt(workerRegistryDraft.max_concurrency, 10) || 1,
    capabilities: normalizeCapabilityTokens(workerRegistryDraft.capabilities_text),
    metadata: normalizeMetadataInput(workerRegistryDraft.metadata_text)
  });

  const saveWorkerRegistry = async () => {
    setWorkerRegistrySaving(true);
    setWorkerRegistryError('');
    try {
      const payload = buildWorkerRegistryPayload();
      const updatedWorker = editingWorkerId
        ? await api.updateTrainingWorker(editingWorkerId, payload)
        : await api.createTrainingWorker(payload);
      setWorkers((prev) => {
        const next = editingWorkerId
          ? prev.map((item) => (item.id === updatedWorker.id ? updatedWorker : item))
          : [updatedWorker, ...prev];
        return [...next].sort((left, right) => left.name.localeCompare(right.name));
      });
      setWorkerRegistryOpen(false);
      setEditingWorkerId(null);
      setWorkerRegistryDraft(buildDefaultWorkerRegistryDraft());
    } catch (workerError) {
      setWorkerRegistryError((workerError as Error).message);
    } finally {
      setWorkerRegistrySaving(false);
    }
  };

  const patchWorker = async (
    workerId: string,
    patch: Partial<CreateTrainingWorkerInput>,
    actionLabel: string
  ) => {
    setWorkerMutationTargetId(workerId);
    setWorkerMutationAction(actionLabel);
    setWorkersError('');
    try {
      const updated = await api.updateTrainingWorker(workerId, patch);
      setWorkers((prev) =>
        [...prev.map((item) => (item.id === workerId ? updated : item))].sort((left, right) =>
          left.name.localeCompare(right.name)
        )
      );
    } catch (workerError) {
      setWorkersError((workerError as Error).message);
    } finally {
      setWorkerMutationTargetId(null);
      setWorkerMutationAction('');
    }
  };

  const removeWorker = async (worker: TrainingWorkerNodeView) => {
    setWorkerMutationTargetId(worker.id);
    setWorkerMutationAction('remove');
    setWorkersError('');
    try {
      await api.removeTrainingWorker(worker.id);
      setWorkers((prev) => prev.filter((item) => item.id !== worker.id));
      setRemovingWorker(null);
    } catch (workerError) {
      setWorkersError((workerError as Error).message);
    } finally {
      setWorkerMutationTargetId(null);
      setWorkerMutationAction('');
    }
  };

  const createBootstrapSession = async () => {
    setCreatingBootstrapSession(true);
    setBootstrapSessionsError('');
    try {
      const created = await api.createTrainingWorkerBootstrapSession({
        deployment_mode: workerOnboardingDraft.deployment_mode,
        worker_profile: workerOnboardingDraft.worker_profile,
        control_plane_base_url: workerOnboardingDraft.control_plane_base_url,
        worker_name: workerOnboardingDraft.worker_name || undefined,
        worker_public_host: workerOnboardingDraft.worker_public_host || undefined,
        worker_bind_port: Number.parseInt(workerOnboardingDraft.worker_bind_port, 10) || 9090,
        max_concurrency: Number.parseInt(workerOnboardingDraft.max_concurrency, 10) || 1
      });
      setBootstrapSessions((prev) => [created, ...prev.filter((item) => item.id !== created.id)]);
      setActiveBootstrapSessionId(created.id);
      setCopyMessage('');
    } catch (bootstrapError) {
      setBootstrapSessionsError((bootstrapError as Error).message);
    } finally {
      setCreatingBootstrapSession(false);
    }
  };

  const validateBootstrapSession = async (sessionId: string) => {
    setValidatingBootstrapSessionId(sessionId);
    setBootstrapSessionsError('');
    try {
      const updated = await api.validateTrainingWorkerBootstrapCallback(sessionId);
      setBootstrapSessions((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      await refreshTrainingWorkers();
    } catch (bootstrapError) {
      setBootstrapSessionsError((bootstrapError as Error).message);
    } finally {
      setValidatingBootstrapSessionId(null);
    }
  };

  const downloadBootstrapBundle = async (sessionId: string) => {
    setDownloadingBootstrapSessionId(sessionId);
    setBootstrapSessionsError('');
    try {
      const { blob, filename } = await api.downloadTrainingWorkerBootstrapBundle(sessionId);
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (bootstrapError) {
      setBootstrapSessionsError((bootstrapError as Error).message);
    } finally {
      setDownloadingBootstrapSessionId(null);
    }
  };

  const activateBootstrapWorker = async (workerId: string) => {
    setActivatingBootstrapWorkerId(workerId);
    setBootstrapSessionsError('');
    try {
      const result = await api.activateTrainingWorker(workerId);
      setWorkers((prev) =>
        [...prev.map((item) => (item.id === result.worker.id ? result.worker : item))].sort(
          (left, right) => left.name.localeCompare(right.name)
        )
      );
      if (result.bootstrap_session) {
        setBootstrapSessions((prev) =>
          prev.map((item) =>
            item.id === result.bootstrap_session?.id ? result.bootstrap_session : item
          )
        );
      }
      setCopyMessage(t('Worker activation succeeded.'));
      await refreshTrainingWorkers();
      await refreshBootstrapSessions();
    } catch (bootstrapError) {
      setBootstrapSessionsError((bootstrapError as Error).message);
    } finally {
      setActivatingBootstrapWorkerId(null);
    }
  };

  const createWorkerReconfigureSession = async (worker: TrainingWorkerNodeView) => {
    setReconfiguringWorkerId(worker.id);
    setBootstrapSessionsError('');
    try {
      const session = await api.createTrainingWorkerReconfigureSession(worker.id);
      setBootstrapSessions((prev) => [session, ...prev.filter((item) => item.id !== session.id)]);
      setActiveBootstrapSessionId(session.id);
      setWorkerOnboardingOpen(true);
      setCopyMessage(t('Worker reconfiguration session created for {name}.', { name: worker.name }));
      await refreshBootstrapSessions();
    } catch (workerError) {
      setBootstrapSessionsError((workerError as Error).message);
    } finally {
      setReconfiguringWorkerId(null);
    }
  };

  const formatPercent = useCallback(
    (value: number | null | undefined) => {
      if (value === null || value === undefined || !Number.isFinite(value)) {
        return t('n/a');
      }
      return `${Math.round(value * 100)}%`;
    },
    [t]
  );

  const formatTimestamp = useCallback((value: string | null) => formatCompactTimestamp(value, t('n/a')), [t]);

  const selectedWorker =
    selectedWorkerId ? workers.find((worker) => worker.id === selectedWorkerId) ?? null : null;
  const editingWorker =
    editingWorkerId ? workers.find((worker) => worker.id === editingWorkerId) ?? null : null;
  const workerRegistryTitle = editingWorker ? t('Edit Worker') : t('Register Worker');
  const pendingBootstrapCount = bootstrapSessions.filter(
    (session) => session.status !== 'online' && session.status !== 'expired'
  ).length;

  const workerTableColumns = useMemo<StatusTableColumn<TrainingWorkerNodeView>[]>(
    () => [
      {
        key: 'status',
        header: t('Status'),
        width: '10%',
        cell: (worker) => (
          <StatusTag
            status={
              worker.effective_status === 'online'
                ? 'ready'
                : worker.effective_status === 'draining'
                  ? 'running'
                  : 'failed'
            }
          >
            {t(worker.effective_status)}
          </StatusTag>
        )
      },
      {
        key: 'name',
        header: t('Name'),
        width: '16%',
        cell: (worker) => (
          <div className="stack tight">
            <strong>{worker.name}</strong>
            <small className="muted">
              {t(worker.registration_source)} · {t(worker.auth_mode)}
            </small>
          </div>
        )
      },
      {
        key: 'framework',
        header: t('Framework'),
        width: '12%',
        cell: (worker) => (
          <div className="stack tight">
            <Badge tone="neutral">{resolveWorkerRuntimeProfile(worker) || t('n/a')}</Badge>
            <small className="muted">{worker.capabilities.join(', ') || t('No capabilities')}</small>
          </div>
        )
      },
      {
        key: 'endpoint',
        header: t('Endpoint'),
        width: '20%',
        cell: (worker) => <small className="muted">{worker.endpoint ?? t('not set')}</small>
      },
      {
        key: 'heartbeat',
        header: t('Last heartbeat'),
        width: '12%',
        cell: (worker) => <small className="muted">{formatTimestamp(worker.last_heartbeat_at)}</small>
      },
      {
        key: 'load',
        header: t('Load'),
        width: '10%',
        cell: (worker) => (
          <div className="stack tight">
            <Badge tone="neutral">{formatPercent(worker.last_reported_load)}</Badge>
            <small className="muted">
              {t('In-flight')}: {worker.in_flight_jobs}/{worker.max_concurrency}
            </small>
          </div>
        )
      },
      {
        key: 'version',
        header: t('Version'),
        width: '10%',
        cell: (worker) => (
          <div className="stack tight">
            <small className="muted">{resolveWorkerVersion(worker) ?? t('n/a')}</small>
            <small className="muted">
              {t('Contract')}: {resolveWorkerContractVersion(worker) ?? t('n/a')}
            </small>
          </div>
        )
      },
      {
        key: 'actions',
        header: t('Actions'),
        width: '10%',
        cell: (worker) => (
          <div className="workspace-record-actions">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={(event) => {
                event.stopPropagation();
                setSelectedWorkerId(worker.id);
              }}
            >
              {t('View')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={(event) => {
                event.stopPropagation();
                openEditWorkerRegistry(worker);
              }}
            >
              {t('Edit')}
            </Button>
          </div>
        )
      }
    ],
    [formatPercent, formatTimestamp, openEditWorkerRegistry, t]
  );

  const bootstrapTableColumns = useMemo<StatusTableColumn<TrainingWorkerBootstrapSessionRecord>[]>(
    () => [
      {
        key: 'status',
        header: t('Status'),
        width: '12%',
        cell: (session) => (
          <StatusTag status={workerBootstrapStatusTone(session.status)}>{t(session.status)}</StatusTag>
        )
      },
      {
        key: 'worker',
        header: t('Worker'),
        width: '16%',
        cell: (session) => (
          <div className="stack tight">
            <strong>{session.worker_name}</strong>
            <small className="muted">
              {t(session.worker_profile)} · {t(session.deployment_mode)}
            </small>
          </div>
        )
      },
      {
        key: 'setup',
        header: t('Setup URL'),
        width: '28%',
        cell: (session) => <small className="muted">{session.setup_url_hint}</small>
      },
      {
        key: 'callback',
        header: t('Callback'),
        width: '22%',
        cell: (session) => (
          <div className="stack tight">
            <small className="muted">{session.worker_endpoint_hint ?? t('to be confirmed in /setup')}</small>
            <small className="muted">{session.callback_validation_message ?? t('n/a')}</small>
          </div>
        )
      },
      {
        key: 'expires',
        header: t('Expires'),
        width: '12%',
        cell: (session) => <small className="muted">{formatTimestamp(session.expires_at)}</small>
      },
      {
        key: 'actions',
        header: t('Actions'),
        width: '10%',
        cell: (session) => (
          <div className="workspace-record-actions">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={(event) => {
                event.stopPropagation();
                setActiveBootstrapSessionId(session.id);
                setWorkerOnboardingOpen(true);
              }}
            >
              {t('Open')}
            </Button>
          </div>
        )
      }
    ],
    [formatTimestamp, t]
  );

  const activeBootstrapSession = useMemo(() => {
    if (!activeBootstrapSessionId) {
      return bootstrapSessions[0] ?? null;
    }
    return bootstrapSessions.find((session) => session.id === activeBootstrapSessionId) ?? null;
  }, [activeBootstrapSessionId, bootstrapSessions]);

  const activeBootstrapCompatibility = activeBootstrapSession
    ? resolveSessionCompatibility(activeBootstrapSession)
    : null;
  const onboardingBindPort = Number.parseInt(workerOnboardingDraft.worker_bind_port, 10) || 9090;
  const onboardingPreviewPublicHost = workerOnboardingDraft.worker_public_host.trim() || null;
  const onboardingPreviewEndpoint = buildWorkerEndpointHint(onboardingPreviewPublicHost, onboardingBindPort);
  const onboardingPreviewSetupUrl = buildWorkerSetupUrlHint(onboardingPreviewPublicHost, onboardingBindPort);
  const onboardingStep = activeBootstrapSession
    ? activeBootstrapSession.status === 'online'
      ? 2
      : 1
    : 0;
  const workerOnlineCount = useMemo(
    () => workers.filter((worker) => worker.effective_status === 'online').length,
    [workers]
  );
  const workerPageDescription =
    workerView === 'inventory'
      ? t('Inventory-first worker operations: review capacity, heartbeat, and maintenance in one place.')
      : t('Pairing-first worker operations: generate onboarding sessions and complete callback validation.');
  const workerHeaderMeta = useMemo(
    () => (
      <div className="row gap wrap align-center">
        {workerView === 'inventory' ? (
          <>
            <Badge tone={workers.length > 0 ? 'info' : 'warning'}>
              {t('Workers')}: {workers.length}
            </Badge>
            <Badge tone={workerOnlineCount > 0 ? 'success' : 'warning'}>
              {t('Online')}: {workerOnlineCount}
            </Badge>
            <Badge tone="neutral">
              {t('Draining')}: {workers.filter((worker) => worker.effective_status === 'draining').length}
            </Badge>
          </>
        ) : (
          <>
            <Badge tone={bootstrapSessions.length > 0 ? 'info' : 'warning'}>
              {t('Sessions')}: {bootstrapSessions.length}
            </Badge>
            <Badge tone={pendingBootstrapCount > 0 ? 'warning' : 'success'}>
              {t('Pending')}: {pendingBootstrapCount}
            </Badge>
          </>
        )}
      </div>
    ),
    [bootstrapSessions.length, pendingBootstrapCount, t, workerOnlineCount, workerView, workers]
  );

  return (
    <WorkspacePage>
      <SettingsTabs />
      <PageHeader
        eyebrow={t('Worker operations')}
        title={t('Worker Settings')}
        description={workerPageDescription}
        meta={workerHeaderMeta}
        primaryAction={{
          label: t('Add Worker'),
          onClick: () => setWorkerOnboardingOpen(true)
        }}
        secondaryActions={
          <div className="row gap wrap">
            <Button
              type="button"
              variant={workerView === 'inventory' ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setWorkerView('inventory')}
            >
              {t('Inventory')}
            </Button>
            <Button
              type="button"
              variant={workerView === 'pairing' ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setWorkerView('pairing')}
            >
              {t('Pairing')}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => void refreshAll()} disabled={workersLoading || bootstrapSessionsLoading}>
              {workersLoading || bootstrapSessionsLoading ? t('Refreshing...') : t('Refresh All')}
            </Button>
          </div>
        }
      />

      {workersError ? <InlineAlert tone="danger" title={t('Worker list unavailable')} description={workersError} /> : null}
      {bootstrapSessionsError ? (
        <InlineAlert tone="warning" title={t('Pairing status warning')} description={bootstrapSessionsError} />
      ) : null}

      <WorkspaceWorkbench
        main={
          <div className="workspace-main-stack">
            {workerView === 'inventory' ? (
              <SectionCard
                title={t('Worker inventory')}
                description={t('Table-first worker operations: capacity, heartbeat, and scheduling controls.')}
                actions={<Badge tone="neutral">{t('Total')}: {workers.length}</Badge>}
              >
                {workersLoading ? (
                  <StateBlock
                    variant="loading"
                    title={t('Loading Workers')}
                    description={t('Collecting worker status and recent activity.')}
                  />
                ) : workersAccessDenied ? (
                  <StateBlock
                    variant="empty"
                    title={t('Admin only')}
                    description={t('Worker management is visible to administrators only.')}
                  />
                ) : (
                  <StatusTable
                    columns={workerTableColumns}
                    rows={workers}
                    getRowKey={(worker) => worker.id}
                    emptyTitle={t('No workers')}
                    emptyDescription={t('No training workers are currently registered in the control plane.')}
                    onRowClick={(worker) => setSelectedWorkerId(worker.id)}
                  />
                )}
              </SectionCard>
            ) : (
              <SectionCard
                title={t('Worker pairing sessions')}
                description={t('Generate and verify worker onboarding sessions from one table-first view.')}
                actions={<Badge tone={pendingBootstrapCount > 0 ? 'warning' : 'neutral'}>{t('Sessions')}: {bootstrapSessions.length}</Badge>}
              >
                {bootstrapSessionsLoading ? (
                  <StateBlock
                    variant="loading"
                    title={t('Loading pairing sessions')}
                    description={t('Collecting recent worker bootstrap commands and states.')}
                  />
                ) : bootstrapSessionsAccessDenied ? (
                  <StateBlock
                    variant="empty"
                    title={t('Admin only')}
                    description={t('Worker onboarding sessions are visible to administrators only.')}
                  />
                ) : (
                  <StatusTable
                    columns={bootstrapTableColumns}
                    rows={bootstrapSessions}
                    getRowKey={(session) => session.id}
                    emptyTitle={t('No pairing sessions')}
                    emptyDescription={t('Create an Add Worker session to generate a startup command and pairing token.')}
                  />
                )}
              </SectionCard>
            )}
          </div>
        }
        side={
          <div className="workspace-inspector-rail">
            <Card as="article" className="workspace-inspector-card">
              <WorkspaceSectionHeader
                title={t('Next step')}
                description={t('Keep the rail short. Pairing and registry actions live in drawers.')}
              />
              <div className="row gap wrap">
                <Button type="button" onClick={() => setWorkerOnboardingOpen(true)}>
                  {t('Open Add Worker')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={workerView === 'inventory' ? () => setWorkerView('pairing') : () => setWorkerView('inventory')}
                >
                  {workerView === 'inventory' ? t('Go to Pairing') : t('Go to Inventory')}
                </Button>
              </div>
              {workerView === 'inventory' ? (
                <Button type="button" variant="ghost" size="sm" onClick={openCreateWorkerRegistry}>
                  {t('Register Existing Worker')}
                </Button>
              ) : null}
              <small className="muted">
                {workerView === 'inventory'
                  ? t('Use the drawer for pairing or registry work so the inventory lane stays table-first.')
                  : t('Pairing stays in the drawer so the inventory lane remains table-first.')}
              </small>
            </Card>
          </div>
        }
      />

      <DetailDrawer
        open={Boolean(selectedWorker)}
        onClose={() => setSelectedWorkerId(null)}
        title={selectedWorker ? selectedWorker.name : t('Worker detail')}
        description={t('Inspect worker status and apply targeted updates without leaving the list.')}
        actions={
          selectedWorker ? (
            <>
              <Button type="button" variant="ghost" size="sm" onClick={() => openEditWorkerRegistry(selectedWorker)}>
                {t('Edit')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={reconfiguringWorkerId === selectedWorker.id}
                onClick={() => void createWorkerReconfigureSession(selectedWorker)}
              >
                {reconfiguringWorkerId === selectedWorker.id ? t('Creating...') : t('Reconfigure')}
              </Button>
            </>
          ) : null
        }
      >
        {selectedWorker ? (
          <>
            <div className="row gap wrap">
              <StatusTag
                status={
                  selectedWorker.effective_status === 'online'
                    ? 'ready'
                    : selectedWorker.effective_status === 'draining'
                      ? 'running'
                      : 'failed'
                }
              >
                {t(selectedWorker.effective_status)}
              </StatusTag>
              <Badge tone="neutral">{t(selectedWorker.registration_source)}</Badge>
              <Badge tone="neutral">{t(selectedWorker.auth_mode)}</Badge>
            </div>
            <DetailList
              items={[
                { label: t('Endpoint'), value: selectedWorker.endpoint ?? t('not set') },
                { label: t('Runtime profile'), value: resolveWorkerRuntimeProfile(selectedWorker) ?? t('n/a') },
                { label: t('Last heartbeat'), value: formatTimestamp(selectedWorker.last_heartbeat_at) },
                { label: t('Last success'), value: formatTimestamp(selectedWorker.dispatch_last_success_at) },
                { label: t('Last failure'), value: formatTimestamp(selectedWorker.dispatch_last_failure_at) },
                { label: t('Load'), value: formatPercent(selectedWorker.last_reported_load) },
                { label: t('In-flight'), value: `${selectedWorker.in_flight_jobs}/${selectedWorker.max_concurrency}` },
                { label: t('Version'), value: resolveWorkerVersion(selectedWorker) ?? t('n/a') },
                { label: t('Capabilities'), value: selectedWorker.capabilities.join(', ') || t('No capabilities') }
              ]}
            />
            <SectionCard
              title={t('Worker operations')}
              description={t('Use this order: edit identity, reconfigure callback, then adjust scheduling state.')}
            >
              <ActionBar
                primary={
                  <Button type="button" variant="secondary" size="sm" onClick={() => openEditWorkerRegistry(selectedWorker)}>
                    {t('Edit')}
                  </Button>
                }
                secondary={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={reconfiguringWorkerId === selectedWorker.id}
                    onClick={() => void createWorkerReconfigureSession(selectedWorker)}
                  >
                    {reconfiguringWorkerId === selectedWorker.id ? t('Creating...') : t('Reconfigure')}
                  </Button>
                }
              />
              <details className="workspace-details">
                <summary>{t('Maintenance actions')}</summary>
                <div className="stack tight">
                  <small className="muted">
                    {t('Scheduling state changes are available here when the worker needs a temporary pause or re-enable.')}
                  </small>
                  <ActionBar
                    primary={
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={workerMutationTargetId === selectedWorker.id}
                        onClick={() =>
                          void patchWorker(
                            selectedWorker.id,
                            { status: selectedWorker.status === 'draining' ? 'online' : 'draining' },
                            'status'
                          )
                        }
                      >
                        {workerMutationTargetId === selectedWorker.id && workerMutationAction === 'status'
                          ? t('Saving...')
                          : selectedWorker.status === 'draining'
                            ? t('Resume Scheduling')
                            : t('Mark Draining')}
                      </Button>
                    }
                    secondary={
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={workerMutationTargetId === selectedWorker.id}
                        onClick={() =>
                          void patchWorker(selectedWorker.id, { enabled: !selectedWorker.enabled }, 'enabled')
                        }
                      >
                        {workerMutationTargetId === selectedWorker.id && workerMutationAction === 'enabled'
                          ? t('Saving...')
                          : selectedWorker.enabled
                            ? t('Disable')
                            : t('Enable')}
                      </Button>
                    }
                  />
                </div>
              </details>
            </SectionCard>

            <SectionCard
              title={t('Danger zone')}
              description={t('Remove worker only when it has no in-flight jobs. This operation requires confirmation.')}
            >
              <ActionBar
                primary={
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    disabled={selectedWorker.in_flight_jobs > 0 || workerMutationTargetId === selectedWorker.id}
                    onClick={() => setRemovingWorker(selectedWorker)}
                  >
                    {workerMutationTargetId === selectedWorker.id && workerMutationAction === 'remove'
                      ? t('Removing...')
                      : t('Remove Worker')}
                  </Button>
                }
              />
            </SectionCard>
          </>
        ) : null}
      </DetailDrawer>

      <Drawer
        open={workerOnboardingOpen}
        onClose={() => setWorkerOnboardingOpen(false)}
        side="right"
        className="runtime-worker-drawer"
        title={t('Add Worker')}
      >
        <div className="stack">
          <WorkspaceSectionHeader
            title={t('Add Worker')}
            description={t('Generate startup commands, then complete pairing from worker-local setup page.')}
            actions={
              <Button type="button" variant="ghost" size="sm" onClick={() => setWorkerOnboardingOpen(false)}>
                {t('Close')}
              </Button>
            }
          />

          <ProgressStepper
            steps={[t('Configure'), t('Start Worker'), t('Finish Pairing')]}
            current={onboardingStep}
            title={t('Worker onboarding')}
            caption={t('Worker settings flow')}
          />

          {copyMessage ? <StateBlock variant="success" title={t('Clipboard')} description={copyMessage} /> : null}
          {bootstrapSessionsError && !activeBootstrapSession ? (
            <StateBlock variant="error" title={t('Pairing unavailable')} description={bootstrapSessionsError} />
          ) : null}

          <Card as="section">
            <WorkspaceSectionHeader
              title={t('Bootstrap draft')}
              description={t('Docker-first by default. These fields define generated startup templates.')}
            />

            <label>
              {t('Deployment mode')}
              <Select
                value={workerOnboardingDraft.deployment_mode}
                onChange={(event) =>
                  setWorkerOnboardingDraft((prev) => ({
                    ...prev,
                    deployment_mode: event.target.value as TrainingWorkerDeploymentMode
                  }))
                }
              >
                <option value="docker">{t('Docker')}</option>
                <option value="script">{t('Linux Script')}</option>
              </Select>
            </label>

            <label>
              {t('Worker profile')}
              <Select
                value={workerOnboardingDraft.worker_profile}
                onChange={(event) =>
                  setWorkerOnboardingDraft((prev) => ({
                    ...prev,
                    worker_profile: event.target.value as TrainingWorkerProfile
                  }))
                }
              >
                <option value="yolo">{t('YOLO / detection')}</option>
                <option value="paddleocr">{t('PaddleOCR / OCR')}</option>
                <option value="doctr">{t('docTR / OCR')}</option>
                <option value="mixed">{t('Mixed')}</option>
              </Select>
            </label>

            <label>
              {t('Control plane URL')}
              <Input
                value={workerOnboardingDraft.control_plane_base_url}
                onChange={(event) =>
                  setWorkerOnboardingDraft((prev) => ({
                    ...prev,
                    control_plane_base_url: event.target.value
                  }))
                }
                placeholder="http://10.0.0.10:8080"
              />
            </label>

            <label>
              {t('Worker name')}
              <Input
                value={workerOnboardingDraft.worker_name}
                onChange={(event) =>
                  setWorkerOnboardingDraft((prev) => ({
                    ...prev,
                    worker_name: event.target.value
                  }))
                }
                placeholder="gpu-worker-b"
              />
            </label>

            <label>
              {t('Worker public host / IP')}
              <Input
                value={workerOnboardingDraft.worker_public_host}
                onChange={(event) =>
                  setWorkerOnboardingDraft((prev) => ({
                    ...prev,
                    worker_public_host: event.target.value
                  }))
                }
                placeholder="10.0.0.22 or gpu-b.internal"
              />
            </label>

            <div className="workspace-form-grid">
              <label>
                {t('Worker bind port')}
                <Input
                  type="number"
                  min={1}
                  max={65535}
                  step={1}
                  value={workerOnboardingDraft.worker_bind_port}
                  onChange={(event) =>
                    setWorkerOnboardingDraft((prev) => ({
                      ...prev,
                      worker_bind_port: event.target.value
                    }))
                  }
                />
              </label>

              <label>
                {t('Max concurrency')}
                <Input
                  type="number"
                  min={1}
                  step={1}
                  value={workerOnboardingDraft.max_concurrency}
                  onChange={(event) =>
                    setWorkerOnboardingDraft((prev) => ({
                      ...prev,
                      max_concurrency: event.target.value
                    }))
                  }
                />
              </label>
            </div>

            <Panel tone="soft" className="stack tight">
              <strong>{t('Worker access preview')}</strong>
              <small className="muted">
                {t('endpoint hint')}: {onboardingPreviewEndpoint ?? t('to be confirmed in /setup')}
              </small>
              <small className="muted">
                {t('Setup URL')}: {onboardingPreviewSetupUrl}
              </small>
            </Panel>

            <ActionBar
              primary={
                <Button type="button" onClick={() => void createBootstrapSession()} disabled={creatingBootstrapSession}>
                  {creatingBootstrapSession ? t('Generating...') : t('Generate Pairing Command')}
                </Button>
              }
              secondary={
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setWorkerOnboardingDraft(buildDefaultWorkerOnboardingDraft());
                    setActiveBootstrapSessionId(null);
                  }}
                >
                  {t('Reset Draft')}
                </Button>
              }
            />
          </Card>

          {activeBootstrapSession ? (
            <>
              <Card as="section" className="stack tight">
                <WorkspaceSectionHeader
                  title={t('Current pairing session')}
                  description={t('Use this session token/URL to finish worker pairing.')}
                  actions={
                    <StatusTag status={workerBootstrapStatusTone(activeBootstrapSession.status)}>
                      {t(activeBootstrapSession.status)}
                    </StatusTag>
                  }
                />
                <div className="row gap wrap">
                  <Badge tone="neutral">{t(activeBootstrapSession.worker_profile)}</Badge>
                  <Badge tone="neutral">{t(activeBootstrapSession.deployment_mode)}</Badge>
                  <Badge tone="info">{t('token')}: {activeBootstrapSession.token_preview}</Badge>
                  {activeBootstrapCompatibility ? (
                    <Badge tone={workerCompatibilityBadgeTone(activeBootstrapCompatibility.status)}>
                      {t('Compatibility')}: {t(activeBootstrapCompatibility.status)}
                    </Badge>
                  ) : null}
                </div>
                <small className="muted">
                  {t('setup url')}: {activeBootstrapSession.setup_url_hint}
                </small>
                <small className="muted">
                  {t('endpoint hint')}: {activeBootstrapSession.worker_endpoint_hint ?? t('to be confirmed in /setup')}
                </small>
                {activeBootstrapSession.callback_validation_message ? (
                  <small className="muted">{activeBootstrapSession.callback_validation_message}</small>
                ) : null}
                <small className="muted">
                  {t('expires')}: {formatTimestamp(activeBootstrapSession.expires_at)}
                </small>
                <div className="row gap wrap">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void copyText(t('pairing token'), activeBootstrapSession.pairing_token)}
                  >
                    {t('Copy Token')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void copyText(t('Setup URL'), activeBootstrapSession.setup_url_hint)}
                  >
                    {t('Copy Setup URL')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => openExternalUrl(activeBootstrapSession.setup_url_hint)}
                    disabled={!isConcreteWorkerUrl(activeBootstrapSession.setup_url_hint)}
                  >
                    {t('Open Setup')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void downloadBootstrapBundle(activeBootstrapSession.id)}
                    disabled={downloadingBootstrapSessionId === activeBootstrapSession.id}
                  >
                    {downloadingBootstrapSessionId === activeBootstrapSession.id ? t('Downloading...') : t('Download Bundle')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void validateBootstrapSession(activeBootstrapSession.id)}
                    disabled={validatingBootstrapSessionId === activeBootstrapSession.id}
                  >
                    {validatingBootstrapSessionId === activeBootstrapSession.id ? t('Validating...') : t('Retry callback')}
                  </Button>
                  {activeBootstrapSession.status !== 'online' ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        void activateBootstrapWorker(
                          activeBootstrapSession.linked_worker_id ?? activeBootstrapSession.worker_id
                        )
                      }
                      disabled={
                        activatingBootstrapWorkerId ===
                        (activeBootstrapSession.linked_worker_id ?? activeBootstrapSession.worker_id)
                      }
                    >
                      {activatingBootstrapWorkerId ===
                      (activeBootstrapSession.linked_worker_id ?? activeBootstrapSession.worker_id)
                        ? t('Activating...')
                        : t('Activate Worker')}
                    </Button>
                  ) : null}
                </div>
              </Card>

              <Card as="section" className="stack tight">
              <WorkspaceSectionHeader
                title={t('Docker startup command')}
                description={t('Recommended path for remote workers.')}
                  actions={
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void copyText(t('Docker command'), activeBootstrapSession.docker_command)}
                    >
                      {t('Copy')}
                    </Button>
                  }
                />
                <pre className="code-block">{activeBootstrapSession.docker_command}</pre>
              </Card>

              <Card as="section" className="stack tight">
              <WorkspaceSectionHeader
                title={t('Script startup alternative')}
                description={t('Use this if the host already has repository scripts.')}
                  actions={
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void copyText(t('Script command'), activeBootstrapSession.script_command)}
                    >
                      {t('Copy')}
                    </Button>
                  }
                />
                <pre className="code-block">{activeBootstrapSession.script_command}</pre>
              </Card>
            </>
          ) : (
            <StateBlock
              variant="empty"
              title={t('Create a pairing session')}
              description={t('Generate one session first. Then the drawer shows the command and token.')}
            />
          )}
        </div>
      </Drawer>

      <Drawer
        open={workerRegistryOpen}
        onClose={() => setWorkerRegistryOpen(false)}
        side="right"
        className="runtime-worker-drawer"
        title={workerRegistryTitle}
      >
        <div className="stack">
          <div className="workspace-section-header">
            <div className="stack tight">
              <h3>{workerRegistryTitle}</h3>
              <small className="muted">
                {editingWorker
                  ? t('Adjust endpoint, scheduler status, or capacity without leaving worker settings.')
                  : t('Manually register an existing worker endpoint when guided pairing is not required.')}
              </small>
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={() => setWorkerRegistryOpen(false)}>
              {t('Close')}
            </Button>
          </div>

          {workerRegistryError ? (
            <StateBlock variant="error" title={t('Worker update failed')} description={workerRegistryError} />
          ) : null}

          {editingWorker ? (
            <Card as="section">
              <div className="row gap wrap align-center">
                <Badge tone="neutral">{t(editingWorker.registration_source)}</Badge>
                <Badge tone="neutral">{t(editingWorker.auth_mode)}</Badge>
              </div>
              <small className="muted">
                {t('Last heartbeat')}: {formatTimestamp(editingWorker.last_heartbeat_at)} · {t('Last success')}:{' '}
                {formatTimestamp(editingWorker.dispatch_last_success_at)}
              </small>
            </Card>
          ) : null}

          <Card as="section">
            <label>
              {t('Worker name')}
              <Input
                value={workerRegistryDraft.name}
                onChange={(event) =>
                  setWorkerRegistryDraft((prev) => ({
                    ...prev,
                    name: event.target.value
                  }))
                }
                placeholder="gpu-worker-b"
              />
            </label>

            <label>
              {t('Worker endpoint')}
              <Input
                value={workerRegistryDraft.endpoint}
                onChange={(event) =>
                  setWorkerRegistryDraft((prev) => ({
                    ...prev,
                    endpoint: event.target.value
                  }))
                }
                placeholder="http://10.10.0.22:9090"
              />
            </label>

            <div className="workspace-form-grid">
              <label>
                {t('Status')}
                <Select
                  value={workerRegistryDraft.status}
                  onChange={(event) =>
                    setWorkerRegistryDraft((prev) => ({
                      ...prev,
                      status: event.target.value as TrainingWorkerStatus
                    }))
                  }
                >
                  <option value="online">{t('online')}</option>
                  <option value="offline">{t('offline')}</option>
                  <option value="draining">{t('draining')}</option>
                </Select>
              </label>

              <label>
                {t('Max concurrency')}
                <Input
                  type="number"
                  min={1}
                  step={1}
                  value={workerRegistryDraft.max_concurrency}
                  onChange={(event) =>
                    setWorkerRegistryDraft((prev) => ({
                      ...prev,
                      max_concurrency: event.target.value
                    }))
                  }
                />
              </label>
            </div>

            <label className="workspace-checkbox-row">
              <input
                type="checkbox"
                checked={workerRegistryDraft.enabled}
                onChange={(event) =>
                  setWorkerRegistryDraft((prev) => ({
                    ...prev,
                    enabled: event.target.checked
                  }))
                }
              />
              <span>{t('Enabled for scheduling')}</span>
            </label>

            <label>
              {t('Capabilities')}
              <Textarea
                value={workerRegistryDraft.capabilities_text}
                onChange={(event) =>
                  setWorkerRegistryDraft((prev) => ({
                    ...prev,
                    capabilities_text: event.target.value
                  }))
                }
                rows={3}
                placeholder="framework:yolo, task:detection"
              />
              <small className="muted">
                {t('Use comma or line breaks, for example framework:yolo and task:detection.')}
              </small>
            </label>

            <label>
              {t('Metadata')}
              <Textarea
                value={workerRegistryDraft.metadata_text}
                onChange={(event) =>
                  setWorkerRegistryDraft((prev) => ({
                    ...prev,
                    metadata_text: event.target.value
                  }))
                }
                rows={4}
                placeholder={'ip=10.10.0.22\nzone=rack-b'}
              />
              <small className="muted">{t('One key=value pair per line.')}</small>
            </label>

            <ActionBar
              primary={
                <Button type="button" onClick={() => void saveWorkerRegistry()} disabled={workerRegistrySaving}>
                  {workerRegistrySaving ? t('Saving...') : editingWorker ? t('Save Worker') : t('Create Worker')}
                </Button>
              }
              secondary={
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setWorkerRegistryDraft(
                      editingWorker
                        ? buildWorkerRegistryDraftFromWorker(editingWorker)
                        : buildDefaultWorkerRegistryDraft()
                    );
                    setWorkerRegistryError('');
                  }}
                >
                  {t('Reset Draft')}
                </Button>
              }
            />
          </Card>
        </div>
      </Drawer>

      <ConfirmDangerDialog
        open={Boolean(removingWorker)}
        onClose={() => setRemovingWorker(null)}
        title={t('Remove worker')}
        description={
          removingWorker
            ? t('This will remove worker {name} from inventory. Continue?', {
                name: removingWorker.name
              })
            : t('Confirm remove action')
        }
        confirmLabel={t('Confirm remove')}
        cancelLabel={t('Cancel')}
        confirmationPhrase={removingWorker?.name}
        busy={Boolean(removingWorker && workerMutationTargetId === removingWorker.id)}
        onConfirm={() => {
          if (!removingWorker) {
            return;
          }
          void removeWorker(removingWorker);
        }}
      />
    </WorkspacePage>
  );
}
