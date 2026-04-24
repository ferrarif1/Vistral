import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import type { User, VerificationReportRecord, VerificationReportStatus } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import TrainingLaunchContextPills from '../components/onboarding/TrainingLaunchContextPills';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import {
  ActionBar,
  DetailDrawer,
  DetailList,
  PageHeader,
  SectionCard,
  StatusTable,
  type StatusTableColumn
} from '../components/ui/ConsolePage';
import { Checkbox, Input, Select } from '../components/ui/Field';
import { Card, Panel } from '../components/ui/Surface';
import {
  WorkspacePage,
  WorkspaceWorkbench
} from '../components/ui/WorkspacePage';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';
import { formatCompactTimestamp } from '../utils/formatting';

const PAGE_SIZE_OPTIONS = [10, 25, 50] as const;
type ReportSortMode = 'latest' | 'oldest' | 'failed_first';
type DateQuickRange = 'all' | '7d' | '30d';

const getReportTimestamp = (item: VerificationReportRecord): number => {
  const raw = item.finished_at_utc || item.started_at_utc;
  if (!raw) {
    return 0;
  }

  const value = Date.parse(raw);
  return Number.isNaN(value) ? 0 : value;
};

const toInputDate = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

type LaunchContext = {
  datasetId?: string | null;
  versionId?: string | null;
  taskType?: string | null;
  framework?: string | null;
  executionTarget?: string | null;
  workerId?: string | null;
  returnTo?: string | null;
};

const appendTrainingLaunchContext = (
  searchParams: URLSearchParams,
  context?: LaunchContext
) => {
  if (!context) {
    return;
  }
  if (context.datasetId?.trim() && !searchParams.has('dataset')) {
    searchParams.set('dataset', context.datasetId.trim());
  }
  if (context.versionId?.trim() && !searchParams.has('version')) {
    searchParams.set('version', context.versionId.trim());
  }
  if (context.taskType?.trim() && !searchParams.has('task_type')) {
    searchParams.set('task_type', context.taskType.trim());
  }
  if (context.framework?.trim() && !searchParams.has('framework')) {
    searchParams.set('framework', context.framework.trim());
  }
  if (
    context.executionTarget?.trim() &&
    context.executionTarget.trim() !== 'auto' &&
    !searchParams.has('execution_target')
  ) {
    searchParams.set('execution_target', context.executionTarget.trim());
  }
  if (context.workerId?.trim() && !searchParams.has('worker')) {
    searchParams.set('worker', context.workerId.trim());
  }
  const returnTo = context.returnTo?.trim() ?? '';
  if (
    returnTo &&
    returnTo.startsWith('/') &&
    !returnTo.startsWith('//') &&
    !returnTo.includes('://') &&
    !searchParams.has('return_to')
  ) {
    searchParams.set('return_to', returnTo);
  }
};

const sanitizeReturnToPath = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || !trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('://')) {
    return null;
  }
  return trimmed;
};

const buildAdminAuditPath = (launchContext?: LaunchContext): string => {
  const searchParams = new URLSearchParams();
  appendTrainingLaunchContext(searchParams, launchContext);
  const query = searchParams.toString();
  return query ? `/admin/audit?${query}` : '/admin/audit';
};

const buildAdminPendingApprovalsPath = (launchContext?: LaunchContext): string => {
  const searchParams = new URLSearchParams();
  appendTrainingLaunchContext(searchParams, launchContext);
  const query = searchParams.toString();
  return query ? `/admin/models/pending?${query}` : '/admin/models/pending';
};

export default function AdminVerificationReportsPage() {
  const { t } = useI18n();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const requestedReturnTo = sanitizeReturnToPath(searchParams.get('return_to'));
  const currentTaskPath = useMemo(
    () => `${location.pathname}${location.search || ''}`,
    [location.pathname, location.search]
  );
  const outboundReturnTo = requestedReturnTo ?? currentTaskPath;
  const launchContext = useMemo<LaunchContext>(
    () => ({
      datasetId: (searchParams.get('dataset') ?? '').trim() || null,
      versionId: (searchParams.get('version') ?? '').trim() || null,
      taskType: (searchParams.get('task_type') ?? '').trim() || null,
      framework: (searchParams.get('framework') ?? searchParams.get('profile') ?? '').trim().toLowerCase() || null,
      executionTarget: (searchParams.get('execution_target') ?? '').trim().toLowerCase() || null,
      workerId: (searchParams.get('worker') ?? '').trim() || null,
      returnTo: outboundReturnTo
    }),
    [outboundReturnTo, searchParams]
  );
  const adminAuditPath = useMemo(
    () => buildAdminAuditPath(launchContext),
    [launchContext]
  );
  const pendingApprovalsPath = useMemo(
    () => buildAdminPendingApprovalsPath(launchContext),
    [launchContext]
  );
  const headerMeta = (
    <TrainingLaunchContextPills
      taskType={launchContext.taskType}
      framework={launchContext.framework}
      executionTarget={launchContext.executionTarget}
      workerId={launchContext.workerId}
      t={t}
    />
  );
  const headerSecondaryActions = (
    <div className="row gap wrap">
      {requestedReturnTo ? (
        <ButtonLink to={requestedReturnTo} variant="ghost" size="sm">
          {t('Return to current task')}
        </ButtonLink>
      ) : null}
      <ButtonLink to={pendingApprovalsPath} variant="ghost" size="sm">
        {t('Open pending requests')}
      </ButtonLink>
      <ButtonLink to={adminAuditPath} variant="ghost" size="sm">
        {t('Open audit logs')}
      </ButtonLink>
    </div>
  );
  const notAvailable = t('n/a');
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [items, setItems] = useState<VerificationReportRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const deferredSearchTerm = useDeferredValue(searchTerm);
  const [statusFilter, setStatusFilter] = useState<'all' | VerificationReportStatus>('all');
  const [baseUrlFilter, setBaseUrlFilter] = useState('all');
  const [failedOnly, setFailedOnly] = useState(false);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [sortMode, setSortMode] = useState<ReportSortMode>('failed_first');
  const [quickRange, setQuickRange] = useState<DateQuickRange>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZE_OPTIONS)[number]>(10);
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const activePageTitle = t('Admin Verification Reports');

  const loadReports = useCallback(async (mode: 'initial' | 'manual' = 'initial') => {
    if (mode === 'initial') {
      setLoading(true);
    } else {
      setRefreshing(true);
    }
    setError('');

    try {
      const [user, reports] = await Promise.all([api.me(), api.listVerificationReports()]);
      setCurrentUser(user);
      setItems(reports);
    } catch (loadError) {
      setError((loadError as Error).message);
    } finally {
      if (mode === 'initial') {
        setLoading(false);
      } else {
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    loadReports('initial').catch(() => {
      // handled by local state
    });
  }, [loadReports]);

  const baseUrlOptions = useMemo(
    () =>
      Array.from(new Set(items.map((item) => item.target_base_url).filter(Boolean))).sort((a, b) =>
        a.localeCompare(b)
      ),
    [items]
  );

  const filteredItems = useMemo(() => {
    const keyword = deferredSearchTerm.trim().toLowerCase();
    const fromBoundary = fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : null;
    const toBoundary = toDate ? new Date(`${toDate}T23:59:59.999`).getTime() : null;

    const filtered = items.filter((item) => {
      if (statusFilter !== 'all' && item.status !== statusFilter) {
        return false;
      }

      if (baseUrlFilter !== 'all' && item.target_base_url !== baseUrlFilter) {
        return false;
      }

      if (failedOnly && item.checks_failed === 0) {
        return false;
      }

      if (fromBoundary !== null || toBoundary !== null) {
        const timestamp = getReportTimestamp(item);
        if (timestamp <= 0) {
          return false;
        }

        if (fromBoundary !== null && timestamp < fromBoundary) {
          return false;
        }

        if (toBoundary !== null && timestamp > toBoundary) {
          return false;
        }
      }

      if (!keyword) {
        return true;
      }

      const haystack = [
        item.filename,
        item.summary,
        item.status,
        item.target_base_url,
        item.business_username,
        item.probe_username
      ]
        .join(' ')
        .toLowerCase();

      return haystack.includes(keyword);
    });

    filtered.sort((a, b) => {
      const aTime = getReportTimestamp(a);
      const bTime = getReportTimestamp(b);

      if (sortMode === 'oldest') {
        return aTime - bTime;
      }

      if (sortMode === 'failed_first') {
        const aFailed = a.checks_failed > 0 ? 1 : 0;
        const bFailed = b.checks_failed > 0 ? 1 : 0;
        if (aFailed !== bFailed) {
          return bFailed - aFailed;
        }
      }

      return bTime - aTime;
    });

    return filtered;
  }, [baseUrlFilter, deferredSearchTerm, failedOnly, fromDate, items, sortMode, statusFilter, toDate]);

  const hasActivePrimaryFilters =
    searchTerm.trim().length > 0 ||
    statusFilter !== 'all' ||
    baseUrlFilter !== 'all' ||
    failedOnly ||
    fromDate.length > 0 ||
    toDate.length > 0 ||
    sortMode !== 'failed_first' ||
    quickRange !== 'all';

  useEffect(() => {
    setCurrentPage(1);
  }, [deferredSearchTerm, statusFilter, baseUrlFilter, failedOnly, fromDate, toDate, sortMode, pageSize]);

  const totalPages = Math.max(1, Math.ceil(filteredItems.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const pageStart = (safePage - 1) * pageSize;
  const paginatedItems = filteredItems.slice(pageStart, pageStart + pageSize);
  const selectedReport = useMemo(
    () => (selectedReportId ? items.find((item) => item.id === selectedReportId) ?? null : null),
    [items, selectedReportId]
  );

  const reportTableColumns = useMemo<StatusTableColumn<VerificationReportRecord>[]>(
    () => [
      {
        key: 'filename',
        header: t('Report'),
        width: '28%',
        cell: (item) => (
          <div className="stack tight">
            <strong>{item.filename}</strong>
            <small className="muted">{item.summary || t('No summary provided.')}</small>
          </div>
        )
      },
      {
        key: 'status',
        header: t('Status'),
        width: '12%',
        cell: (item) => <StatusTag status={item.status}>{t(item.status)}</StatusTag>
      },
      {
        key: 'target',
        header: t('Target'),
        width: '24%',
        cell: (item) => (
          <div className="stack tight">
            <small className="muted">{item.target_base_url || notAvailable}</small>
            <small className="muted">
              {t('business')}: {item.business_username || notAvailable} · {t('probe')}: {item.probe_username || notAvailable}
            </small>
          </div>
        )
      },
      {
        key: 'checks',
        header: t('Checks'),
        width: '16%',
        cell: (item) => (
          <div className="stack tight">
            <Badge tone={item.checks_failed > 0 ? 'danger' : 'success'}>
              {item.checks_failed} {t('failed')} / {item.checks_total} {t('total')}
            </Badge>
            {item.runtime_metrics_retention ? (
              <small className="muted">
                {t('metrics rows')}: {item.runtime_metrics_retention.current_total_rows} / {item.runtime_metrics_retention.max_total_rows}
              </small>
            ) : (
              <small className="muted">{t('No metrics retention summary')}</small>
            )}
          </div>
        )
      },
      {
        key: 'finished',
        header: t('Finished'),
        width: '20%',
        cell: (item) => formatCompactTimestamp(item.finished_at_utc, notAvailable)
      }
    ],
    [notAvailable, t]
  );

  const exportFilteredReports = useCallback(() => {
    const payload = {
      generated_at: new Date().toISOString(),
      filters: {
        search: searchTerm,
        status: statusFilter,
        base_url: baseUrlFilter,
        failed_only: failedOnly,
        from_date: fromDate || null,
        to_date: toDate || null,
        sort: sortMode
      },
      page: {
        page_size: pageSize,
        current_page: safePage,
        total_pages: totalPages
      },
      total_records: filteredItems.length,
      records: filteredItems
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json;charset=utf-8'
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `verification-reports-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [
    baseUrlFilter,
    failedOnly,
    filteredItems,
    fromDate,
    pageSize,
    safePage,
    searchTerm,
    sortMode,
    statusFilter,
    toDate,
    totalPages
  ]);

  const applyQuickRange = useCallback((range: DateQuickRange) => {
    setQuickRange(range);
    if (range === 'all') {
      setFromDate('');
      setToDate('');
      return;
    }

    const today = new Date();
    const startDate = new Date(today);
    const days = range === '7d' ? 6 : 29;
    startDate.setDate(today.getDate() - days);
    setFromDate(toInputDate(startDate));
    setToDate(toInputDate(today));
  }, []);

  const resetFilters = useCallback(() => {
    setSearchTerm('');
    setStatusFilter('all');
    setBaseUrlFilter('all');
    setFailedOnly(false);
    setFromDate('');
    setToDate('');
    setSortMode('failed_first');
    setQuickRange('all');
    setCurrentPage(1);
  }, []);

  if (loading) {
    return (
      <WorkspacePage>
        <PageHeader
          eyebrow={t('Operations Audit')}
          title={activePageTitle}
          description={t('Review deployment verification evidence and inspect one report at a time.')}
          meta={headerMeta}
          secondaryActions={headerSecondaryActions}
        />
        <StateBlock
          variant="loading"
          title={t('Loading')}
          description={t('Scanning deployment verification reports.')}
        />
      </WorkspacePage>
    );
  }

  if (error) {
    return (
      <WorkspacePage>
        <PageHeader
          eyebrow={t('Operations Audit')}
          title={activePageTitle}
          description={t('Review deployment verification evidence and inspect one report at a time.')}
          meta={headerMeta}
          secondaryActions={headerSecondaryActions}
        />
        <StateBlock variant="error" title={t('Load Failed')} description={error} />
      </WorkspacePage>
    );
  }

  if (currentUser && currentUser.role !== 'admin') {
    return (
      <WorkspacePage>
        <PageHeader
          eyebrow={t('Operations Audit')}
          title={activePageTitle}
          description={t('Review deployment verification evidence and inspect one report at a time.')}
          meta={headerMeta}
          secondaryActions={headerSecondaryActions}
        />
        <StateBlock
          variant="error"
          title={t('Permission Denied')}
          description={t('Only admin can view deployment verification reports.')}
        />
      </WorkspacePage>
    );
  }

  if (items.length === 0) {
    return (
      <WorkspacePage>
        <PageHeader
          eyebrow={t('Operations Audit')}
          title={activePageTitle}
          description={t('Review deployment verification evidence and inspect one report at a time.')}
          meta={headerMeta}
          secondaryActions={headerSecondaryActions}
        />
        <div className="workspace-main-stack">
          <StateBlock
            variant="empty"
            title={t('No Reports Yet')}
            description={t('Run docker verification scripts to generate reports.')}
            extra={
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  loadReports('manual').catch(() => {
                    // handled by local state
                  });
                }}
                disabled={refreshing || loading}
              >
                {refreshing ? t('Refreshing...') : t('Refresh')}
              </Button>
            }
          />
        </div>
      </WorkspacePage>
    );
  }

  return (
    <WorkspacePage>
      <PageHeader
        eyebrow={t('Operations Audit')}
        title={activePageTitle}
        description={t('Review deployment verification evidence and inspect one report at a time.')}
        meta={headerMeta}
        primaryAction={{
          label: refreshing ? t('Refreshing...') : t('Refresh'),
          onClick: () => {
            loadReports('manual').catch(() => {
              // handled by local state
            });
          },
          disabled: refreshing || loading
        }}
        secondaryActions={headerSecondaryActions}
      />

      <WorkspaceWorkbench
        toolbar={
          <Card as="section" className="workspace-toolbar-card">
            <div className="workspace-toolbar-head">
              <div className="workspace-toolbar-copy">
                <h3>{t('Verification Controls')}</h3>
                <small className="muted">
                  {t('Keep release triage filters and refresh actions in one stable strip.')}
                </small>
              </div>
              <div className="workspace-toolbar-actions">
                {hasActivePrimaryFilters ? (
                  <Button type="button" variant="ghost" size="sm" onClick={resetFilters}>
                    {t('Clear filters')}
                  </Button>
                ) : null}
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    loadReports('manual').catch(() => {
                      // handled by local state
                    });
                  }}
                  disabled={refreshing || loading}
                >
                  {refreshing ? t('Refreshing...') : t('Refresh')}
                </Button>
                <Button variant="ghost" size="sm" onClick={exportFilteredReports}>
                  {t('Export JSON')}
                </Button>
              </div>
            </div>

            <div className="workspace-filter-grid">
              <label className="stack tight">
                <small className="muted">{t('Search')}</small>
                <Input
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                  placeholder={t('filename, summary, username, base_url')}
                />
              </label>
              <label className="stack tight">
                <small className="muted">{t('Status')}</small>
                <Select
                  value={statusFilter}
                  onChange={(event) =>
                    setStatusFilter(event.target.value as 'all' | VerificationReportStatus)
                  }
                >
                  <option value="all">{t('all')}</option>
                  <option value="passed">{t('passed')}</option>
                  <option value="failed">{t('failed')}</option>
                  <option value="unknown">{t('unknown')}</option>
                </Select>
              </label>
              <label className="stack tight">
                <small className="muted">{t('Target Base URL')}</small>
                <Select value={baseUrlFilter} onChange={(event) => setBaseUrlFilter(event.target.value)}>
                  <option value="all">{t('all')}</option>
                  {baseUrlOptions.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="stack tight">
                <small className="muted">{t('Triage mode')}</small>
                <span className="row align-center gap workspace-checkbox-row">
                  <Checkbox
                    className="inline-checkbox"
                    checked={failedOnly}
                    onChange={(event) => setFailedOnly(event.target.checked)}
                  />
                  <span>{t('Only failed checks')}</span>
                </span>
              </label>
            </div>

          </Card>
        }
        main={
          <div className="workspace-main-stack">
            <details className="workspace-details">
              <summary>{t('Advanced report filters')}</summary>
              <SectionCard
                title={t('Date window and density')}
                description={t('Keep the narrower filter set collapsed until you need a specific evidence slice.')}
              >
                <div className="filters-grid">
                  <label>
                    {t('From Date')}
                    <Input
                      type="date"
                      value={fromDate}
                      onChange={(event) => {
                        setQuickRange('all');
                        setFromDate(event.target.value);
                      }}
                    />
                  </label>
                  <label>
                    {t('To Date')}
                    <Input
                      type="date"
                      value={toDate}
                      onChange={(event) => {
                        setQuickRange('all');
                        setToDate(event.target.value);
                      }}
                    />
                  </label>
                  <label>
                    {t('Sort')}
                    <Select
                      value={sortMode}
                      onChange={(event) => setSortMode(event.target.value as ReportSortMode)}
                    >
                      <option value="latest">{t('latest first')}</option>
                      <option value="oldest">{t('oldest first')}</option>
                      <option value="failed_first">{t('failed first')}</option>
                    </Select>
                  </label>
                  <label>
                    {t('Page Size')}
                    <Select
                      value={pageSize}
                      onChange={(event) =>
                        setPageSize(Number(event.target.value) as (typeof PAGE_SIZE_OPTIONS)[number])
                      }
                    >
                      {PAGE_SIZE_OPTIONS.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </Select>
                  </label>
                </div>
                <div className="row gap wrap">
                  <Button
                    variant={quickRange === '7d' ? 'secondary' : 'ghost'}
                    size="sm"
                    className={`workspace-chip-toggle${quickRange === '7d' ? ' active' : ''}`}
                    onClick={() => applyQuickRange('7d')}
                  >
                    {t('Last 7 Days')}
                  </Button>
                  <Button
                    variant={quickRange === '30d' ? 'secondary' : 'ghost'}
                    size="sm"
                    className={`workspace-chip-toggle${quickRange === '30d' ? ' active' : ''}`}
                    onClick={() => applyQuickRange('30d')}
                  >
                    {t('Last 30 Days')}
                  </Button>
                  <Button
                    variant={quickRange === 'all' ? 'secondary' : 'ghost'}
                    size="sm"
                    className={`workspace-chip-toggle${quickRange === 'all' ? ' active' : ''}`}
                    onClick={() => applyQuickRange('all')}
                  >
                    {t('Clear Range')}
                  </Button>
                </div>
              </SectionCard>
            </details>
            <SectionCard
              title={t('Verification reports')}
              description={t('Review the filtered evidence set and expand individual reports only when you need deeper check context.')}
              actions={
                <Badge tone="neutral">
                  {t('Showing {count} items', { count: paginatedItems.length })}
                </Badge>
              }
            >
              <small className="muted">
                {t('Use filters to narrow release evidence and export the exact subset required for governance review.')}
              </small>

              {filteredItems.length === 0 ? (
                <StateBlock
                  variant="empty"
                  title={t('No Matching Reports')}
                  description={t('Adjust filters or run docker verification scripts to create new reports.')}
                />
              ) : (
                <StatusTable
                  columns={reportTableColumns}
                  rows={paginatedItems}
                  getRowKey={(item) => item.id}
                  emptyTitle={t('No Matching Reports')}
                  emptyDescription={t('Adjust filters or run docker verification scripts to create new reports.')}
                  onRowClick={(item) => setSelectedReportId(item.id)}
                />
              )}

              <ActionBar
                className="workspace-table-pagination"
                primary={
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                    disabled={safePage <= 1}
                  >
                    {t('Prev Page')}
                  </Button>
                }
                secondary={
                  <div className="row gap wrap">
                    <Badge tone="neutral">{t('total')}: {items.length}</Badge>
                    <Badge tone="info">{t('matched')}: {filteredItems.length}</Badge>
                    <Badge tone="neutral">
                      {t('page')}: {safePage}/{totalPages}
                    </Badge>
                  </div>
                }
                tertiary={
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
                    disabled={safePage >= totalPages}
                  >
                    {t('Next Page')}
                  </Button>
                }
              />
            </SectionCard>
          </div>
        }
      />

      <DetailDrawer
        open={Boolean(selectedReport)}
        onClose={() => setSelectedReportId(null)}
        title={selectedReport ? selectedReport.filename : t('Verification report')}
        description={t('Inspect one report at a time. Raw checks and retention details stay behind the drawer.')}
      >
        {selectedReport ? (
          <>
            <div className="row gap wrap">
              <StatusTag status={selectedReport.status}>{t(selectedReport.status)}</StatusTag>
              <Badge tone="neutral">
                {t('finished')}: {formatCompactTimestamp(selectedReport.finished_at_utc, notAvailable)}
              </Badge>
              <Badge tone="info">{t('base_url')}: {selectedReport.target_base_url || notAvailable}</Badge>
            </div>

            <DetailList
              items={[
                { label: t('Summary'), value: selectedReport.summary || t('No summary provided.') },
                { label: t('Business user'), value: selectedReport.business_username || notAvailable },
                { label: t('Probe user'), value: selectedReport.probe_username || notAvailable },
                { label: t('Checks total'), value: String(selectedReport.checks_total) },
                { label: t('Checks failed'), value: String(selectedReport.checks_failed) }
              ]}
            />

            {selectedReport.runtime_metrics_retention ? (
              <details className="workspace-details">
                <summary>{t('Metrics retention')}</summary>
                <SectionCard
                  title={t('Metrics retention')}
                  description={t('Keep this technical summary collapsed unless you need a quota or retention check.')}
                >
                  <DetailList
                    items={[
                      {
                        label: t('Current rows'),
                        value: String(selectedReport.runtime_metrics_retention.current_total_rows)
                      },
                      {
                        label: t('Max rows'),
                        value: String(selectedReport.runtime_metrics_retention.max_total_rows)
                      },
                      {
                        label: t('Per-job cap'),
                        value: String(selectedReport.runtime_metrics_retention.max_points_per_job)
                      }
                    ]}
                  />
                </SectionCard>
              </details>
            ) : null}

            <SectionCard
              title={t('Checks detail')}
              description={t('Only failed checks are shown when the failed-only filter is active.')}
            >
              <div className="stack tight">
                {(failedOnly
                  ? selectedReport.checks.filter((check) => check.status !== 'passed')
                  : selectedReport.checks
                ).length > 0 ? (
                  (failedOnly
                    ? selectedReport.checks.filter((check) => check.status !== 'passed')
                    : selectedReport.checks
                  ).map((check) => (
                    <Panel key={`${selectedReport.id}-${check.name}`} tone="soft">
                      <div className="row gap wrap align-center">
                        <StatusTag status={check.status}>{t(check.status)}</StatusTag>
                        <strong>{check.name}</strong>
                      </div>
                      <small className="muted">{check.detail}</small>
                    </Panel>
                  ))
                ) : (
                  <small className="muted">{t('No checks to show for current filter.')}</small>
                )}
              </div>
            </SectionCard>

            <details className="workspace-details">
              <summary>{t('Entities')}</summary>
              <SectionCard
                title={t('Entities')}
                description={t('Raw entity keys stay available for governance follow-up without crowding the main page.')}
              >
                <div className="stack tight">
                  {Object.entries(selectedReport.entities).length > 0 ? (
                    Object.entries(selectedReport.entities).map(([key, value]) => (
                      <div key={key} className="workspace-keyline-item">
                        <span>{key}</span>
                        <small>{value}</small>
                      </div>
                    ))
                  ) : (
                    <small className="muted">{t('No entity metadata recorded.')}</small>
                  )}
                </div>
              </SectionCard>
            </details>
          </>
        ) : null}
      </DetailDrawer>
    </WorkspacePage>
  );
}
