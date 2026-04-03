import { useCallback, useEffect, useMemo, useState } from 'react';
import type { User, VerificationReportRecord, VerificationReportStatus } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

const formatUtcToLocal = (value: string, fallback: string): string => {
  if (!value) {
    return fallback;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString();
};

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
  const [error, setError] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | VerificationReportStatus>('all');
  const [baseUrlFilter, setBaseUrlFilter] = useState('all');
  const [failedOnly, setFailedOnly] = useState(false);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [sortMode, setSortMode] = useState<ReportSortMode>('failed_first');
  const [quickRange, setQuickRange] = useState<DateQuickRange>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZE_OPTIONS)[number]>(10);

  const loadReports = useCallback(async () => {
    setLoading(true);
    setError('');

    try {
      const [user, reports] = await Promise.all([api.me(), api.listVerificationReports()]);
      setCurrentUser(user);
      setItems(reports);
    } catch (loadError) {
      setError((loadError as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadReports().catch(() => {
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
    const keyword = searchTerm.trim().toLowerCase();
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
  }, [baseUrlFilter, failedOnly, fromDate, items, searchTerm, sortMode, statusFilter, toDate]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, statusFilter, baseUrlFilter, failedOnly, fromDate, toDate, sortMode, pageSize]);

  const totalPages = Math.max(1, Math.ceil(filteredItems.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const pageStart = (safePage - 1) * pageSize;
  const paginatedItems = filteredItems.slice(pageStart, pageStart + pageSize);

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

  if (loading) {
    return (
      <div className="stack">
        <h2>{t('Admin Verification Reports')}</h2>
        <StateBlock
          variant="loading"
          title={t('Loading')}
          description={t('Scanning deployment verification reports.')}
        />
      </div>
    );
  }

  if (error) {
    return (
      <div className="stack">
        <h2>{t('Admin Verification Reports')}</h2>
        <StateBlock variant="error" title={t('Load Failed')} description={error} />
      </div>
    );
  }

  if (currentUser && currentUser.role !== 'admin') {
    return (
      <div className="stack">
        <h2>{t('Admin Verification Reports')}</h2>
        <StateBlock
          variant="error"
          title={t('Permission Denied')}
          description={t('Only admin can view deployment verification reports.')}
        />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="stack">
        <h2>{t('Admin Verification Reports')}</h2>
        <StateBlock
          variant="empty"
          title={t('No Reports Yet')}
          description={t('Run docker verification scripts to generate reports.')}
        />
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="row between align-center gap wrap">
        <h2>{t('Admin Verification Reports')}</h2>
        <button
          className="small-btn"
          onClick={() => {
            loadReports().catch(() => {
              // handled by local state
            });
          }}
        >
          {t('Refresh')}
        </button>
      </div>
      <p className="muted">
        {t('Reports generated by `docker:verify:full` are collected from server runtime data.')}
      </p>

      <div className="card stack">
        <div className="filters-grid">
          <label>
            {t('Search')}
            <input
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder={t('filename, summary, username, base_url')}
            />
          </label>
          <label>
            {t('Status')}
            <select
              value={statusFilter}
              onChange={(event) =>
                setStatusFilter(event.target.value as 'all' | VerificationReportStatus)
              }
            >
              <option value="all">{t('all')}</option>
              <option value="passed">{t('passed')}</option>
              <option value="failed">{t('failed')}</option>
              <option value="unknown">{t('unknown')}</option>
            </select>
          </label>
          <label>
            {t('Target Base URL')}
            <select value={baseUrlFilter} onChange={(event) => setBaseUrlFilter(event.target.value)}>
              <option value="all">{t('all')}</option>
              {baseUrlOptions.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('From Date')}
            <input
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
            <input
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
            <select
              value={sortMode}
              onChange={(event) => setSortMode(event.target.value as ReportSortMode)}
            >
              <option value="latest">{t('latest first')}</option>
              <option value="oldest">{t('oldest first')}</option>
              <option value="failed_first">{t('failed first')}</option>
            </select>
          </label>
          <label>
            {t('Page Size')}
            <select
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
            </select>
          </label>
        </div>
        <div className="row gap wrap">
          <button
            className={quickRange === '7d' ? 'small-btn quick-range active' : 'small-btn quick-range'}
            onClick={() => applyQuickRange('7d')}
          >
            {t('Last 7 Days')}
          </button>
          <button
            className={quickRange === '30d' ? 'small-btn quick-range active' : 'small-btn quick-range'}
            onClick={() => applyQuickRange('30d')}
          >
            {t('Last 30 Days')}
          </button>
          <button
            className={quickRange === 'all' ? 'small-btn quick-range active' : 'small-btn quick-range'}
            onClick={() => applyQuickRange('all')}
          >
            {t('Clear Range')}
          </button>
        </div>
        <label className="row align-center gap">
          <input
            type="checkbox"
            className="inline-checkbox"
            checked={failedOnly}
            onChange={(event) => setFailedOnly(event.target.checked)}
          />
          <span>{t('Only show reports with failed checks')}</span>
        </label>
        <small className="muted">
          {t('total')}: {items.length} · {t('matched')}: {filteredItems.length} · {t('page')}:{' '}
          {safePage}/{totalPages}
        </small>
        <div className="row gap wrap">
          <button className="small-btn" onClick={exportFilteredReports}>
            {t('Export Filtered JSON')}
          </button>
          <button
            className="small-btn"
            onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
            disabled={safePage <= 1}
          >
            {t('Prev Page')}
          </button>
          <button
            className="small-btn"
            onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
            disabled={safePage >= totalPages}
          >
            {t('Next Page')}
          </button>
        </div>
      </div>

      {filteredItems.length === 0 ? (
        <StateBlock
          variant="empty"
          title={t('No Matching Reports')}
          description={t('Adjust filters or run docker verification scripts to create new reports.')}
        />
      ) : (
        <ul className="list">
          {paginatedItems.map((item) => {
            const visibleChecks = failedOnly
              ? item.checks.filter((check) => check.status !== 'passed')
              : item.checks;

            return (
              <li key={item.id} className="card stack">
                <div className="row between gap align-center">
                  <strong>{item.filename}</strong>
                  <span className="chip">{t(item.status)}</span>
                </div>
                <small className="muted">{item.summary || t('No summary provided.')}</small>
                <small className="muted">
                  {t('finished')}: {formatUtcToLocal(item.finished_at_utc, notAvailable)} · {t('base_url')}:{' '}
                  {item.target_base_url || notAvailable}
                </small>
                <small className="muted">
                  {t('business user')}: {item.business_username || notAvailable} · {t('probe user')}:{' '}
                  {item.probe_username || notAvailable}
                </small>
                <small className="muted">
                  {t('checks')}: {item.checks_total} {t('total')}, {item.checks_failed} {t('failed')}
                </small>
                {item.runtime_metrics_retention ? (
                  <small className="muted">
                    {t('metrics rows')}: {item.runtime_metrics_retention.current_total_rows} /{' '}
                    {item.runtime_metrics_retention.max_total_rows} · {t('Per-job cap')}:{' '}
                    {item.runtime_metrics_retention.max_points_per_job}
                  </small>
                ) : null}
                <details className="report-details">
                  <summary>{t('Checks detail ({count})', { count: visibleChecks.length })}</summary>
                  {visibleChecks.length > 0 ? (
                    <div className="stack tight">
                      {visibleChecks.map((check) => (
                        <small key={`${item.id}-${check.name}`} className="muted">
                          [{t(check.status)}] {check.name} - {check.detail}
                        </small>
                      ))}
                    </div>
                  ) : (
                    <small className="muted">{t('No checks to show for current filter.')}</small>
                  )}
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
