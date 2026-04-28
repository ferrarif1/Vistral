import type { ReactNode } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Panel } from '../ui/Surface';

type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export type AgentModeStepState = 'complete' | 'active' | 'pending' | 'blocked' | 'warning';

export interface AgentModeStep {
  id: string;
  label: ReactNode;
  detail?: ReactNode;
  state: AgentModeStepState;
  action?: {
    label: ReactNode;
    onClick: () => void;
    disabled?: boolean;
  } | null;
}

export interface AgentModeEvidence {
  id: string;
  label: ReactNode;
  value: ReactNode;
  tone?: BadgeTone;
}

export interface AgentModeAction {
  label: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
}

interface AgentModePanelProps {
  eyebrow?: ReactNode;
  title: ReactNode;
  summary: ReactNode;
  statusLabel: ReactNode;
  statusTone?: BadgeTone;
  steps: AgentModeStep[];
  evidence?: AgentModeEvidence[];
  primaryAction?: AgentModeAction | null;
  secondaryActions?: AgentModeAction[];
  details?: ReactNode;
}

const joinClasses = (...values: Array<string | false | null | undefined>) =>
  values.filter(Boolean).join(' ');

const stepToneByState: Record<AgentModeStepState, BadgeTone> = {
  complete: 'success',
  active: 'info',
  pending: 'neutral',
  blocked: 'danger',
  warning: 'warning'
};

const stepStateLabel: Record<AgentModeStepState, string> = {
  complete: 'Complete',
  active: 'Active',
  pending: 'Pending',
  blocked: 'Blocked',
  warning: 'Warning'
};

export default function AgentModePanel({
  eyebrow,
  title,
  summary,
  statusLabel,
  statusTone = 'neutral',
  steps,
  evidence = [],
  primaryAction,
  secondaryActions = [],
  details
}: AgentModePanelProps) {
  const { t } = useI18n();

  return (
    <Panel as="section" className="agent-mode-panel" tone="soft">
      <div className="agent-mode-panel__header">
        <div className="agent-mode-panel__copy">
          {eyebrow ? <small className="agent-mode-panel__eyebrow">{eyebrow}</small> : null}
          <strong>{title}</strong>
          <small className="muted">{summary}</small>
        </div>
        <Badge tone={statusTone}>{statusLabel}</Badge>
      </div>

      <ol className="agent-mode-panel__steps" aria-label={t('Agent steps')}>
        {steps.map((step, index) => (
          <li
            key={step.id}
            className={joinClasses('agent-mode-panel__step', `agent-mode-panel__step--${step.state}`)}
          >
            <span className="agent-mode-panel__step-index">{index + 1}</span>
            <span className="agent-mode-panel__step-copy">
              <strong>{step.label}</strong>
              {step.detail ? <small>{step.detail}</small> : null}
            </span>
            <Badge tone={stepToneByState[step.state]}>{t(stepStateLabel[step.state])}</Badge>
            {step.action ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={step.action.onClick}
                disabled={step.action.disabled}
              >
                {step.action.label}
              </Button>
            ) : null}
          </li>
        ))}
      </ol>

      {evidence.length > 0 ? (
        <div className="agent-mode-panel__evidence" aria-label={t('Agent evidence')}>
          {evidence.map((item) => (
            <Badge key={item.id} tone={item.tone ?? 'neutral'}>
              {item.label}: {item.value}
            </Badge>
          ))}
        </div>
      ) : null}

      {(primaryAction || secondaryActions.length > 0) ? (
        <div className="agent-mode-panel__actions">
          {primaryAction ? (
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={primaryAction.onClick}
              disabled={primaryAction.disabled || primaryAction.busy}
            >
              {primaryAction.busy ? primaryAction.label : primaryAction.label}
            </Button>
          ) : null}
          {secondaryActions.map((action, index) => (
            <Button
              key={index}
              type="button"
              variant="ghost"
              size="sm"
              onClick={action.onClick}
              disabled={action.disabled || action.busy}
            >
              {action.label}
            </Button>
          ))}
        </div>
      ) : null}

      {details ? (
        <details className="workspace-details">
          <summary>{t('Diagnostics')}</summary>
          {details}
        </details>
      ) : null}
    </Panel>
  );
}
