import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import type { User, VerificationReportRecord, VerificationReportStatus } from '../../shared/domain';
import AdvancedSection from '../components/AdvancedSection';
import StateBlock from '../components/StateBlock';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Checkbox, Input, Select } from '../components/ui/Field';
import { Card, Panel } from '../components/ui/Surface';
import {
  WorkspaceHero,
  WorkspaceMetricGrid,
  WorkspacePage,
  WorkspaceSectionHeader,
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

export default function AdminVerificationReportsPage() {
  const { t } = useI18n();
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
  const summary = useMemo(
    () => ({
      total: items.length,
      failed: items.filter((item) => item.status === 'failed').length,
      passed: items.filter((item) => item.status === 'passed').length,
      failedChecks: items.reduce((sum, item) => sum + item.checks_failed, 0),
      targets: baseUrlOptions.length
    }),
    [baseUrlOptions.length, items]
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

  const heroSection = (
    <WorkspaceHero
      eyebrow={t('Operations Audit')}
      title={t('Admin Verification Reports')}
      description={t('Reports generated by `docker:verify:full` are collected from server runtime data.')}
      stats={[
        { label: t('Total'), value: summary.total },
        { label: t('Failed'), value: summary.failed },
        { label: t('Passed'), value: summary.passed },
        { label: t('Targets'), value: summary.targets }
      ]}
    />
  );

  if (loading) {
    return (
      <WorkspacePage>
        {heroSection}
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
        {heroSection}
        <StateBlock variant="error" title={t('Load Failed')} description={error} />
      </WorkspacePage>
    );
  }

  if (currentUser && currentUser.role !== 'admin') {
    return (
      <WorkspacePage>
        {heroSection}
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
        {heroSection}
        <StateBlock
          variant="empty"
          title={t('No Reports Yet')}
          description={t('Run docker verification scripts to generate reports.')}
        />
      </WorkspacePage>
    );
  }

  return (
    <WorkspacePage>
      {heroSection}

      <WorkspaceMetricGrid
        items={[
          {
            title: t('Filtered reports'),
            description: t('Reports matching the current filters and pagination scope.'),
            value: filteredItems.length
          },
          {
            title: t('Failed checks'),
            description: t('Aggregate failed checks across all reports in this workspace view.'),
            value: summary.failedChecks,
            tone: summary.failed > 0 ? 'attention' : 'default'
          },
          {
            title: t('Current page'),
            description: t('Pagination stays stable while filters update quietly in the background.'),
            value: `${safePage}/${totalPages}`
          },
          {
            title: t('Page size'),
            description: t('Visible report density per page.'),
            value: pageSize
          }
        ]}
      />

      <WorkspaceWorkbench
        toolbar={
          <Card as="section" className="workspace-toolbar-card">
            <div className="workspace-toolbar-head">
              <div className="workspace-toolbar-copy">
                <h3>{t('Verification Controls')}</h3>
                <small className="muted">
                  {t('Keep release triage filters, refresh, and export actions in one stable strip.')}
                </small>
              </div>
              <div className="workspace-toolbar-actions">
                <Button variant="secondary" size="sm" onClick={exportFilteredReports}>
                  {t('Export Filtered JSON')}
                </Button>
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

            <div className="workspace-toolbar-meta">
              <div className="workspace-segmented-actions">
                <Badge tone="info">{t('Matched')}: {filteredItems.length}</Badge>
                <Badge tone={summary.failed > 0 ? 'warning' : 'neutral'}>
                  {t('Failed reports')}: {summary.failed}
                </Badge>
                <Badge tone={summary.failedChecks > 0 ? 'warning' : 'neutral'}>
                  {t('Failed checks')}: {summary.failedChecks}
                </Badge>
                <Badge tone="neutral">
                  {t('Page')}: {safePage}/{totalPages}
                </Badge>
              </div>
            </div>
          </Card>
        }
        main={
          <div className="workspace-main-stack">
            <Card as="article">
              <WorkspaceSectionHeader
                title={t('Advanced report filters')}
                description={t('Date windows, sort order, and density controls stay available without crowding the top toolbar.')}
              />
              <AdvancedSection
                title={t('Expand advanced controls')}
                description={t('Use these when release evidence triage needs date windows or alternate ordering.')}
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
              </AdvancedSection>
            </Card>

            <Card as="article">
              <WorkspaceSectionHeader
                title={t('Verification reports')}
                description={t('Review the filtered evidence set and expand individual reports only when you need deeper check context.')}
                actions={
                  <Badge tone="neutral">
                    {t('Showing {count} items', { count: paginatedItems.length })}
                  </Badge>
                }
              />
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
                <ul className="workspace-record-list">
                  {paginatedItems.map((item) => {
                    const visibleChecks = failedOnly
                      ? item.checks.filter((check) => check.status !== 'passed')
                      : item.checks;

                    return (
                      <Panel key={item.id} as="li" className="workspace-record-item" tone="soft">
                        <div className="row between gap wrap align-center">
                          <strong>{item.filename}</strong>
                          <StatusTag status={item.status}>{t(item.status)}</StatusTag>
                        </div>
                        <small className="muted">{item.summary || t('No summary provided.')}</small>
                        <div className="row gap wrap">
                          <Badge tone="neutral">
                            {t('finished')}: {formatCompactTimestamp(item.finished_at_utc, notAvailable)}
                          </Badge>
                          <Badge tone="info">
                            {t('base_url')}: {item.target_base_url || notAvailable}
                          </Badge>
                          <Badge tone="neutral">
                            {t('business user')}: {item.business_username || notAvailable}
                          </Badge>
                          <Badge tone="neutral">
                            {t('probe user')}: {item.probe_username || notAvailable}
                          </Badge>
                          <Badge tone={item.checks_failed > 0 ? 'danger' : 'success'}>
                            {t('checks')}: {item.checks_total} {t('total')}, {item.checks_failed} {t('failed')}
                          </Badge>
                        </div>
                        {item.runtime_metrics_retention ? (
                          <div className="row gap wrap">
                            <Badge tone="neutral">
                              {t('metrics rows')}: {item.runtime_metrics_retention.current_total_rows} /{' '}
                              {item.runtime_metrics_retention.max_total_rows}
                            </Badge>
                            <Badge tone="warning">
                              {t('Per-job cap')}: {item.runtime_metrics_retention.max_points_per_job}
                            </Badge>
                          </div>
                        ) : null}
                        <details className="workspace-details">
                          <summary>{t('Checks detail ({count})', { count: visibleChecks.length })}</summary>
                          {visibleChecks.length > 0 ? (
                            <div className="stack tight">
                              {visibleChecks.map((check) => (
                                <Panel key={`${item.id}-${check.name}`} tone="soft">
                                  <div className="row gap wrap align-center">
                                    <StatusTag status={check.status}>{t(check.status)}</StatusTag>
                                    <strong>{check.name}</strong>
                                  </div>
                                  <small className="muted">{check.detail}</small>
                                </Panel>
                              ))}
                            </div>
                          ) : (
                            <small className="muted">{t('No checks to show for current filter.')}</small>
                          )}
                        </details>
                      </Panel>
                    );
                  })}
                </ul>
              )}
            </Card>
          </div>
        }
        side={
          <div className="workspace-inspector-rail">
            <Card as="article" className="workspace-inspector-card">
              <WorkspaceSectionHeader
                title={t('Current scope')}
                description={t('Keep the active triage context visible while scrolling through report evidence.')}
              />
              <div className="workspace-keyline-list">
                <div className="workspace-keyline-item">
                  <span>{t('Search')}</span>
                  <strong>{searchTerm.trim() || t('all')}</strong>
                </div>
                <div className="workspace-keyline-item">
                  <span>{t('Status')}</span>
                  <strong>{statusFilter === 'all' ? t('all') : t(statusFilter)}</strong>
                </div>
                <div className="workspace-keyline-item">
                  <span>{t('Base URL')}</span>
                  <small>{baseUrlFilter === 'all' ? t('all') : baseUrlFilter}</small>
                </div>
                <div className="workspace-keyline-item">
                  <span>{t('Date range')}</span>
                  <small>
                    {fromDate || toDate ? `${fromDate || '...'} -> ${toDate || '...'}` : t('all')}
                  </small>
                </div>
                <div className="workspace-keyline-item">
                  <span>{t('Sort')}</span>
                  <strong>{sortMode === 'latest' ? t('latest first') : sortMode === 'oldest' ? t('oldest first') : t('failed first')}</strong>
                </div>
              </div>
              <div className="row gap wrap">
                <Badge tone={failedOnly ? 'warning' : 'neutral'}>
                  {failedOnly ? t('Failed-only mode') : t('All checks visible')}
                </Badge>
                <Badge tone="neutral">{t('Quick range')}: {quickRange === 'all' ? t('none') : quickRange}</Badge>
              </div>
            </Card>

            <Card as="article" className="workspace-inspector-card">
              <WorkspaceSectionHeader
                title={t('Pagination')}
                description={t('Move between pages without resetting the current verification lens.')}
              />
              <div className="row gap wrap">
                <Badge tone="neutral">{t('total')}: {items.length}</Badge>
                <Badge tone="info">{t('matched')}: {filteredItems.length}</Badge>
                <Badge tone="neutral">
                  {t('page')}: {safePage}/{totalPages}
                </Badge>
              </div>
              <div className="workspace-button-stack">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                  disabled={safePage <= 1}
                >
                  {t('Prev Page')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
                  disabled={safePage >= totalPages}
                >
                  {t('Next Page')}
                </Button>
              </div>
            </Card>
          </div>
        }
      />
    </WorkspacePage>
  );
}
