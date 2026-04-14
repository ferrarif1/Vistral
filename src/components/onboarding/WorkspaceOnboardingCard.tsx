import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Badge } from '../ui/Badge';
import { Button, ButtonLink } from '../ui/Button';
import { Card, Panel } from '../ui/Surface';
import { WorkspaceSectionHeader } from '../ui/WorkspacePage';
import useDismissibleGuide from '../../hooks/useDismissibleGuide';
import { useI18n } from '../../i18n/I18nProvider';

type OnboardingAction = {
  label: string;
  variant?: 'secondary' | 'ghost';
  to?: string;
  onClick?: () => void;
};

export type WorkspaceOnboardingStep = {
  key: string;
  label: string;
  detail: string;
  done: boolean;
  primaryAction: OnboardingAction;
  secondaryAction?: OnboardingAction;
};

interface WorkspaceOnboardingCardProps {
  title: string;
  description: string;
  summary: string;
  storageKey: string;
  steps: WorkspaceOnboardingStep[];
  as?: 'article' | 'section';
  className?: string;
  inlineMode?: 'full' | 'summary';
}

export default function WorkspaceOnboardingCard({
  title,
  description,
  summary,
  storageKey,
  steps,
  as = 'article',
  className,
  inlineMode = 'full'
}: WorkspaceOnboardingCardProps) {
  const { t } = useI18n();
  const { visible, dismiss, reopen } = useDismissibleGuide(storageKey);
  const floatingHelpSeenStorageKey = `${storageKey}:floating-help-seen`;
  const completedCount = steps.filter((step) => step.done).length;
  const nextStep = steps.find((step) => !step.done) ?? null;
  const allStepsCompleted = completedCount === steps.length;
  const [panelOpen, setPanelOpen] = useState(false);
  const [inlineChecklistOpen, setInlineChecklistOpen] = useState(false);
  const [floatingHelpSeen, setFloatingHelpSeen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(floatingHelpSeenStorageKey) === 'true';
    } catch {
      return false;
    }
  });
  const floatingRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();

  const renderAction = useCallback(
    (
      action: OnboardingAction,
      options?: {
        defaultVariant?: 'secondary' | 'ghost';
        closePanelAfterClick?: boolean;
      }
    ) => {
      const variant = action.variant ?? options?.defaultVariant ?? 'secondary';
      if (action.onClick) {
        return (
          <Button
            type="button"
            variant={variant}
            size="sm"
            onClick={() => {
              action.onClick?.();
              if (options?.closePanelAfterClick) {
                setPanelOpen(false);
              }
            }}
          >
            {action.label}
          </Button>
        );
      }

      if (!action.to) {
        return null;
      }

      return (
        <ButtonLink to={action.to} variant={variant} size="sm">
          {action.label}
        </ButtonLink>
      );
    },
    []
  );

  const markFloatingHelpSeen = useCallback(() => {
    setFloatingHelpSeen(true);
    try {
      localStorage.setItem(floatingHelpSeenStorageKey, 'true');
    } catch {
      // Ignore storage failures in prototype mode.
    }
  }, [floatingHelpSeenStorageKey]);

  useEffect(() => {
    if (!visible || floatingHelpSeen) {
      return;
    }

    const timer = window.setTimeout(() => {
      setPanelOpen(true);
      markFloatingHelpSeen();
    }, 420);

    return () => {
      window.clearTimeout(timer);
    };
  }, [floatingHelpSeen, markFloatingHelpSeen, visible]);

  useEffect(() => {
    if (!panelOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!floatingRef.current?.contains(event.target as Node)) {
        setPanelOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPanelOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [panelOpen]);

  useEffect(() => {
    if (!visible) {
      setInlineChecklistOpen(false);
    }
  }, [visible]);

  return (
    <>
      <div className="workspace-guide-floating" ref={floatingRef}>
        <Button
          type="button"
          variant={panelOpen ? 'secondary' : 'ghost'}
          size="sm"
          className="workspace-guide-trigger"
          aria-expanded={panelOpen}
          aria-controls={panelId}
          onClick={() =>
            setPanelOpen((previous) => {
              const next = !previous;
              if (next && !floatingHelpSeen) {
                markFloatingHelpSeen();
              }
              return next;
            })
          }
        >
          <span className="workspace-guide-trigger-copy">
            <span>{t('Page tips')}</span>
            <span className="workspace-guide-trigger-progress">
              {completedCount}/{steps.length}
            </span>
          </span>
        </Button>

        {panelOpen ? (
          <Card as="aside" id={panelId} className="workspace-guide-popover stack">
            <div className="workspace-guide-popover-head">
              <div className="stack tight">
                <small className="workspace-eyebrow">{t('Current page guide')}</small>
                <h3>{title}</h3>
                <small className="muted">{description}</small>
              </div>
              <Badge tone={completedCount === steps.length ? 'success' : 'info'}>
                {t('Completed')}: {completedCount}/{steps.length}
              </Badge>
            </div>

            <small className="muted">{summary}</small>
            <small className="muted">
              {visible ? t('Inline guide is visible on this page.') : t('Inline guide is hidden on this page.')}
            </small>

            <Panel className="workspace-guide-highlight" tone="soft">
              <div className="workspace-guide-highlight-head">
                <Badge tone={nextStep ? 'warning' : 'success'}>
                  {nextStep ? t('Recommended next step') : t('Completed')}
                </Badge>
                <strong>{nextStep ? nextStep.label : t('All steps on this page are complete.')}</strong>
              </div>
              <small className="muted">
                {nextStep
                  ? nextStep.detail
                  : t('You can reopen any step below if you want a quick refresher.')}
              </small>
              {nextStep ? (
                <div className="row gap wrap">
                  {renderAction(nextStep.primaryAction, {
                    defaultVariant: 'secondary',
                    closePanelAfterClick: true
                  })}
                  {nextStep.secondaryAction ? (
                    renderAction(nextStep.secondaryAction, {
                      defaultVariant: 'ghost',
                      closePanelAfterClick: true
                    })
                  ) : null}
                </div>
              ) : null}
            </Panel>

            <div className="row gap wrap">
              {visible ? (
                <Button type="button" variant="ghost" size="sm" onClick={dismiss}>
                  {t('Hide inline guide')}
                </Button>
              ) : (
                <Button type="button" variant="secondary" size="sm" onClick={reopen}>
                  {t('Show inline guide')}
                </Button>
              )}
              <Button type="button" variant="ghost" size="sm" onClick={() => setPanelOpen(false)}>
                {t('Close tips')}
              </Button>
            </div>

	            <ul className="workspace-record-list compact workspace-guide-popover-list">
	              {steps.map((step, index) => (
	                <Panel key={step.key} as="li" className="workspace-record-item compact" tone="soft">
                  <div className="workspace-record-item-top">
                    <div className="workspace-record-summary stack tight">
                      <strong>
                        {index + 1}. {step.label}
                      </strong>
                      <small className="muted">{step.detail}</small>
                    </div>
                    <Badge tone={step.done ? 'success' : 'warning'}>
                      {step.done ? t('Completed') : t('Next')}
                    </Badge>
	                  </div>
	                  <div className="row gap wrap">
	                    {renderAction(step.primaryAction, {
	                      defaultVariant: step.done ? 'ghost' : 'secondary',
	                      closePanelAfterClick: true
	                    })}
	                    {step.secondaryAction ? (
	                      renderAction(step.secondaryAction, {
	                        defaultVariant: 'ghost',
	                        closePanelAfterClick: true
	                      })
	                    ) : null}
	                  </div>
	                </Panel>
              ))}
            </ul>
          </Card>
        ) : null}
      </div>

      <Card as={as} className={className}>
        <WorkspaceSectionHeader
          title={title}
          description={visible ? description : undefined}
          actions={
            visible ? (
              <Button type="button" variant="ghost" size="sm" onClick={dismiss}>
                {t('Hide guide')}
              </Button>
            ) : (
              <Button type="button" variant="ghost" size="sm" onClick={reopen}>
                {t('Show guide')}
              </Button>
            )
          }
        />
        {visible ? (
          <>
            <div className="row gap wrap align-center">
              <Badge tone={completedCount === steps.length ? 'success' : 'info'}>
                {t('Completed')}: {completedCount}/{steps.length}
              </Badge>
              <small className="muted">{summary}</small>
            </div>
            <Panel className="workspace-guide-highlight" tone="soft">
              <div className="workspace-guide-highlight-head">
                <Badge tone={nextStep ? 'warning' : 'success'}>
                  {nextStep ? t('Recommended next step') : t('Completed')}
                </Badge>
                <strong>{nextStep ? nextStep.label : t('All steps on this page are complete.')}</strong>
              </div>
              <small className="muted">
                {nextStep
                  ? nextStep.detail
                  : t('You can reopen any step below if you want a quick refresher.')}
              </small>
              {nextStep ? (
                <div className="row gap wrap">
                  {renderAction(nextStep.primaryAction, {
                    defaultVariant: 'secondary'
                  })}
                  {nextStep.secondaryAction ? (
                    renderAction(nextStep.secondaryAction, {
                      defaultVariant: 'ghost'
                    })
                  ) : null}
                </div>
              ) : null}
            </Panel>
            {inlineMode === 'full' ? (
              <>
                <div className="row gap wrap">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setInlineChecklistOpen((previous) => !previous)}
                  >
                    {inlineChecklistOpen ? t('Hide full checklist') : t('Show full checklist')}
                  </Button>
                </div>
                {inlineChecklistOpen ? (
                  <ul className="workspace-record-list compact">
                    {steps.map((step, index) => (
                      <Panel key={step.key} as="li" className="workspace-record-item compact" tone="soft">
                        <div className="workspace-record-item-top">
                          <div className="workspace-record-summary stack tight">
                            <strong>
                              {index + 1}. {step.label}
                            </strong>
                            <small className="muted">{step.detail}</small>
                          </div>
                          <Badge tone={step.done ? 'success' : 'warning'}>
                            {step.done ? t('Completed') : t('Next')}
                          </Badge>
                        </div>
                        <div className="row gap wrap">
                          {renderAction(step.primaryAction, {
                            defaultVariant: step.done ? 'ghost' : 'secondary'
                          })}
                          {step.secondaryAction ? (
                            renderAction(step.secondaryAction, {
                              defaultVariant: 'ghost'
                            })
                          ) : null}
                        </div>
                      </Panel>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : (
              <small className="muted">{t('Use Page tips for the full walkthrough.')}</small>
            )}
          </>
        ) : (
          <Panel className="workspace-guide-highlight" tone="soft">
            <div className="workspace-guide-highlight-head">
              <Badge tone={allStepsCompleted ? 'success' : 'info'}>
                {allStepsCompleted ? t('Completed') : t('Page tips')}
              </Badge>
              <strong>{allStepsCompleted ? t('All steps on this page are complete.') : title}</strong>
            </div>
            <small className="muted">
              {allStepsCompleted
                ? t('Guide is hidden. This page is already complete, but you can reopen the walkthrough anytime.')
                : t('Inline guide hidden. Use Page tips or reopen here anytime.')}
            </small>
          </Panel>
        )}
      </Card>
    </>
  );
}
