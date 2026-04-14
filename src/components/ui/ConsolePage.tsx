import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Badge, StatusTag } from './Badge';
import { Button } from './Button';
import { Input } from './Field';
import { Drawer, Modal } from './Overlay';
import { Card, Panel } from './Surface';
import { EmptyState } from './StateView';

const joinClasses = (...values: Array<string | false | null | undefined>) =>
  values.filter(Boolean).join(' ');

type StatTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export interface PageHeaderAction {
  label: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  loading?: boolean;
}

interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  meta?: ReactNode;
  primaryAction?: PageHeaderAction;
  secondaryActions?: ReactNode;
}

interface KPIStatItem {
  label: ReactNode;
  value: ReactNode;
  tone?: StatTone;
  hint?: ReactNode;
}

interface KPIStatRowProps {
  items: KPIStatItem[];
  className?: string;
}

interface FilterToolbarProps {
  filters?: ReactNode;
  actions?: ReactNode;
  summary?: ReactNode;
  className?: string;
}

interface SectionCardProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

type InlineAlertTone = 'info' | 'success' | 'warning' | 'danger';

interface InlineAlertProps {
  tone?: InlineAlertTone;
  title?: ReactNode;
  description: ReactNode;
  actions?: ReactNode;
  className?: string;
}

interface HealthSummaryPanelItem {
  label: ReactNode;
  value: ReactNode;
  tone?: StatTone;
}

interface HealthSummaryPanelProps {
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  items: HealthSummaryPanelItem[];
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export interface StatusTableColumn<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
  headerClassName?: string;
  width?: string;
}

interface StatusTableProps<T> {
  columns: StatusTableColumn<T>[];
  rows: T[];
  getRowKey: (row: T) => string;
  emptyTitle?: ReactNode;
  emptyDescription?: ReactNode;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string | undefined;
  className?: string;
}

interface DetailDrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

interface ActionBarProps {
  primary?: ReactNode;
  secondary?: ReactNode;
  tertiary?: ReactNode;
  className?: string;
}

interface ConfirmDangerDialogProps {
  open: boolean;
  title: ReactNode;
  description: ReactNode;
  confirmLabel?: ReactNode;
  cancelLabel?: ReactNode;
  confirmationPhrase?: string;
  onConfirm: () => void;
  onClose: () => void;
  busy?: boolean;
}

const toneToBadge = (tone: StatTone = 'neutral') => tone;

export function PageHeader({
  title,
  description,
  eyebrow,
  meta,
  primaryAction,
  secondaryActions
}: PageHeaderProps) {
  return (
    <Card as="section" className="console-page-header">
      <div className="console-page-header__copy">
        {eyebrow ? <small className="workspace-eyebrow">{eyebrow}</small> : null}
        <div className="console-page-header__title-row">
          <div className="console-page-header__title-block">
            <h1>{title}</h1>
            {description ? <p className="muted">{description}</p> : null}
          </div>
          <div className="console-page-header__actions">
            {secondaryActions}
            {primaryAction ? (
              <Button
                type="button"
                onClick={primaryAction.onClick}
                disabled={primaryAction.disabled || primaryAction.loading}
              >
                {primaryAction.loading ? '...' : primaryAction.label}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
      {meta ? <div className="console-page-header__meta">{meta}</div> : null}
    </Card>
  );
}

export function KPIStatRow({ items, className }: KPIStatRowProps) {
  return (
    <section className={joinClasses('console-kpi-row', className)}>
      {items.map((item) => (
        <Card key={String(item.label)} as="article" className="console-kpi-card">
          <div className="console-kpi-card__head">
            <span>{item.label}</span>
            <Badge tone={toneToBadge(item.tone)}>{item.value}</Badge>
          </div>
          {item.hint ? <small className="muted">{item.hint}</small> : null}
        </Card>
      ))}
    </section>
  );
}

export function FilterToolbar({
  filters,
  actions,
  summary,
  className
}: FilterToolbarProps) {
  return (
    <Card as="section" className={joinClasses('console-filter-toolbar', className)}>
      <div className="console-filter-toolbar__row">
        <div className="console-filter-toolbar__filters">{filters}</div>
        {actions ? <div className="console-filter-toolbar__actions">{actions}</div> : null}
      </div>
      {summary ? <div className="console-filter-toolbar__summary">{summary}</div> : null}
    </Card>
  );
}

export function SectionCard({
  title,
  description,
  actions,
  children,
  className
}: SectionCardProps) {
  return (
    <Card as="section" className={joinClasses('console-section-card', className)}>
      <div className="console-section-card__header">
        <div className="console-section-card__copy">
          <h3>{title}</h3>
          {description ? <small className="muted">{description}</small> : null}
        </div>
        {actions ? <div className="console-section-card__actions">{actions}</div> : null}
      </div>
      <div className="console-section-card__body">{children}</div>
    </Card>
  );
}

export function InlineAlert({
  tone = 'info',
  title,
  description,
  actions,
  className
}: InlineAlertProps) {
  return (
    <Panel
      as="section"
      tone={tone === 'danger' ? 'danger' : tone === 'success' ? 'accent' : 'soft'}
      className={joinClasses('console-inline-alert', `console-inline-alert--${tone}`, className)}
    >
      <div className="console-inline-alert__copy">
        {title ? <strong>{title}</strong> : null}
        <span>{description}</span>
      </div>
      {actions ? <div className="console-inline-alert__actions">{actions}</div> : null}
    </Panel>
  );
}

export function HealthSummaryPanel({
  title,
  description,
  status,
  items,
  actions,
  children,
  className
}: HealthSummaryPanelProps) {
  return (
    <Card as="section" className={joinClasses('console-health-summary', className)}>
      <div className="console-health-summary__header">
        <div className="console-health-summary__copy">
          <div className="console-health-summary__title-row">
            <h3>{title}</h3>
            {status ? <div>{status}</div> : null}
          </div>
          {description ? <small className="muted">{description}</small> : null}
        </div>
        {actions ? <div className="console-health-summary__actions">{actions}</div> : null}
      </div>
      <div className="console-health-summary__stats">
        {items.map((item) => (
          <div className="console-health-summary__stat" key={String(item.label)}>
            <span>{item.label}</span>
            <Badge tone={toneToBadge(item.tone)}>{item.value}</Badge>
          </div>
        ))}
      </div>
      {children ? <div className="console-health-summary__body">{children}</div> : null}
    </Card>
  );
}

export function StatusTable<T>({
  columns,
  rows,
  getRowKey,
  emptyTitle = 'No rows',
  emptyDescription = 'No data available.',
  onRowClick,
  rowClassName,
  className
}: StatusTableProps<T>) {
  if (rows.length === 0) {
    return (
      <EmptyState
        className={joinClasses('console-status-table-empty', className)}
        title={String(emptyTitle)}
        description={String(emptyDescription)}
      />
    );
  }

  return (
    <div className={joinClasses('console-status-table-wrap', className)}>
      <table className="console-status-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                className={column.headerClassName}
                style={column.width ? { width: column.width } : undefined}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const clickable = Boolean(onRowClick);
            return (
              <tr
                key={getRowKey(row)}
                className={joinClasses(
                  clickable && 'is-clickable',
                  rowClassName ? rowClassName(row) : undefined
                )}
                onClick={clickable ? () => onRowClick?.(row) : undefined}
              >
                {columns.map((column) => (
                  <td key={column.key} className={column.className}>
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function DetailDrawer({
  open,
  onClose,
  title,
  description,
  actions,
  children,
  className
}: DetailDrawerProps) {
  return (
    <Drawer
      open={open}
      onClose={onClose}
      side="right"
      title={typeof title === 'string' ? title : 'Detail'}
      className={joinClasses('console-detail-drawer', className)}
    >
      <div className="console-detail-drawer__header">
        <div className="console-detail-drawer__copy">
          <h3>{title}</h3>
          {description ? <small className="muted">{description}</small> : null}
        </div>
        <div className="console-detail-drawer__actions">
          {actions}
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
      <div className="console-detail-drawer__body">{children}</div>
    </Drawer>
  );
}

export function ActionBar({ primary, secondary, tertiary, className }: ActionBarProps) {
  return (
    <div className={joinClasses('console-action-bar', className)}>
      <div className="console-action-bar__group console-action-bar__group--primary">{primary}</div>
      <div className="console-action-bar__group console-action-bar__group--secondary">
        {secondary}
      </div>
      <div className="console-action-bar__group console-action-bar__group--tertiary">
        {tertiary}
      </div>
    </div>
  );
}

export function ConfirmDangerDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  confirmationPhrase,
  onConfirm,
  onClose,
  busy = false
}: ConfirmDangerDialogProps) {
  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (!open) {
      setDraft('');
    }
  }, [open]);

  const confirmationReady = useMemo(() => {
    if (!confirmationPhrase) {
      return true;
    }
    return draft.trim() === confirmationPhrase.trim();
  }, [confirmationPhrase, draft]);

  return (
    <Modal open={open} onClose={onClose} title={typeof title === 'string' ? title : 'Confirm'}>
      <Card as="section" className="console-confirm-dialog">
        <div className="console-confirm-dialog__copy">
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        {confirmationPhrase ? (
          <label className="stack tight">
            <small className="muted">
              Type <code>{confirmationPhrase}</code> to continue.
            </small>
            <Input value={draft} onChange={(event) => setDraft(event.target.value)} />
          </label>
        ) : null}
        <div className="console-confirm-dialog__actions">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant="danger"
            onClick={onConfirm}
            disabled={!confirmationReady || busy}
          >
            {busy ? '...' : confirmLabel}
          </Button>
        </div>
      </Card>
    </Modal>
  );
}

export function DetailList({
  items
}: {
  items: Array<{ label: ReactNode; value: ReactNode }>;
}) {
  return (
    <div className="console-detail-list">
      {items.map((item) => (
        <div key={String(item.label)} className="console-detail-list__item">
          <span>{item.label}</span>
          <div>{item.value}</div>
        </div>
      ))}
    </div>
  );
}

export function SimpleStatus({
  label,
  status
}: {
  label: ReactNode;
  status: string;
}) {
  return (
    <div className="console-simple-status">
      <span>{label}</span>
      <StatusTag status={status}>{status}</StatusTag>
    </div>
  );
}
