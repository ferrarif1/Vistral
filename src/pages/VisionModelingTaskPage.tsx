import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { VisionModelingTaskRecord } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import { Badge } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { DetailList, PageHeader, SectionCard } from '../components/ui/ConsolePage';
import { WorkspacePage } from '../components/ui/WorkspacePage';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

const prettyJson = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const parseJsonSafely = (raw: string | null | undefined): unknown => {
  if (!raw || !raw.trim()) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

const gateTone = (status: string): 'success' | 'warning' | 'danger' | 'info' | 'neutral' => {
  if (status === 'pass') {
    return 'success';
  }
  if (status === 'needs_review') {
    return 'warning';
  }
  if (status === 'fail') {
    return 'danger';
  }
  if (status === 'pending') {
    return 'info';
  }
  return 'neutral';
};

const buildInferenceRunPath = (
  runId: string,
  modelVersionId: string,
  visionTaskId: string,
  returnTo: string
): string => {
  const searchParams = new URLSearchParams();
  if (runId.trim()) {
    searchParams.set('run', runId.trim());
  }
  if (modelVersionId.trim()) {
    searchParams.set('modelVersion', modelVersionId.trim());
  }
  if (visionTaskId.trim()) {
    searchParams.set('vision_task', visionTaskId.trim());
  }
  if (returnTo.trim()) {
    searchParams.set('return_to', returnTo.trim());
  }
  searchParams.set('focus', 'feedback');
  return `/inference/validate?${searchParams.toString()}`;
};

export default function VisionModelingTaskPage() {
  const { t } = useI18n();
  const { taskId } = useParams<{ taskId: string }>();
  const currentTaskPath = taskId?.trim()
    ? `/vision/tasks/${encodeURIComponent(taskId.trim())}`
    : '/vision/tasks';
  const [task, setTask] = useState<VisionModelingTaskRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [generatingFeedback, setGeneratingFeedback] = useState(false);
  const [autoContinuing, setAutoContinuing] = useState(false);
  const [registeringModel, setRegisteringModel] = useState(false);
  const [autoAdvancing, setAutoAdvancing] = useState(false);
  const [feedbackMessage, setFeedbackMessage] = useState('');

  const loadTask = useCallback(async () => {
    if (!taskId?.trim()) {
      setError(t('Task id is missing.'));
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const detail = await api.getVisionTask(taskId);
      setTask(detail);
    } catch (requestError) {
      setError((requestError as Error).message);
      setTask(null);
    } finally {
      setLoading(false);
    }
  }, [taskId, t]);

  useEffect(() => {
    void loadTask();
  }, [loadTask]);

  const handleGenerateFeedbackDataset = useCallback(async () => {
    if (!task) {
      return;
    }
    setGeneratingFeedback(true);
    setFeedbackMessage('');
    try {
      const result = await api.generateVisionTaskFeedbackDataset(task.id, { max_samples: 12 });
      setTask(result.task);
      setFeedbackMessage(
        t('Collected {{count}} low-confidence samples into dataset {{dataset}}.', {
          count: String(result.sample_count),
          dataset: result.dataset_id
        })
      );
    } catch (requestError) {
      setFeedbackMessage((requestError as Error).message);
    } finally {
      setGeneratingFeedback(false);
    }
  }, [task, t]);

  const handleAutoContinue = useCallback(async () => {
    if (!task) {
      return;
    }
    setAutoContinuing(true);
    setFeedbackMessage('');
    try {
      const result = await api.autoContinueVisionTask(task.id, { max_rounds: 3 });
      setTask(result.task);
      if (result.launched) {
        setFeedbackMessage(
          t('Round {{round}} started. Training job: {{job}}.', {
            round: String(result.next_round ?? ''),
            job: result.training_job_id ?? '-'
          })
        );
      } else {
        setFeedbackMessage(
          t('Auto-continue not launched: {{reason}}.', {
            reason: result.reason
          })
        );
      }
    } catch (requestError) {
      setFeedbackMessage((requestError as Error).message);
    } finally {
      setAutoContinuing(false);
    }
  }, [task, t]);

  const handleRegisterModel = useCallback(async () => {
    if (!task) {
      return;
    }
    setRegisteringModel(true);
    setFeedbackMessage('');
    try {
      const result = await api.registerVisionTaskModel(task.id, {});
      setTask(result.task);
      setFeedbackMessage(
        t('Model version registered: {{version}}.', {
          version: result.model_version.id
        })
      );
    } catch (requestError) {
      setFeedbackMessage((requestError as Error).message);
    } finally {
      setRegisteringModel(false);
    }
  }, [task, t]);

  const handleAutoAdvance = useCallback(async () => {
    if (!task) {
      return;
    }
    setAutoAdvancing(true);
    setFeedbackMessage('');
    try {
      const result = await api.autoAdvanceVisionTask(task.id, { max_rounds: 3 });
      setTask(result.task);
      setFeedbackMessage(
        t('Auto advance: {{action}} - {{message}}', {
          action: result.action,
          message: result.message
        })
      );
    } catch (requestError) {
      setFeedbackMessage((requestError as Error).message);
    } finally {
      setAutoAdvancing(false);
    }
  }, [task, t]);

  const recommendation = task?.agent_next_action ?? null;
  const datasetProfile = task?.dataset_profile ?? null;
  const activeLearningClusterLabels = useMemo(
    () =>
      new Map(
        (task?.active_learning_pool?.clusters ?? []).map((cluster) => [cluster.cluster_id, cluster.title])
      ),
    [task?.active_learning_pool?.clusters]
  );

  const quickActions = useMemo(() => {
    if (!task) {
      return null;
    }
    const launchParams = new URLSearchParams();
    if (task.dataset_id) {
      launchParams.set('dataset', task.dataset_id);
    }
    if (task.dataset_version_id) {
      launchParams.set('version', task.dataset_version_id);
    }
    if (task.spec.task_type && task.spec.task_type !== 'unknown') {
      launchParams.set('task_type', task.spec.task_type);
    }
    const suggestedFramework =
      task.spec.task_type === 'ocr'
        ? 'paddleocr'
        : task.spec.task_type === 'classification' ||
            task.spec.task_type === 'detection' ||
            task.spec.task_type === 'segmentation'
          ? 'yolo'
          : '';
    if (suggestedFramework) {
      launchParams.set('framework', suggestedFramework);
    }
    launchParams.set('source_vision_task', task.id);
    const launchHref = `/training/jobs/new?${launchParams.toString()}`;
    const feedbackDatasetId = (task.metadata.feedback_dataset_id ?? '').trim();
    const autoTuneHistoryRaw = parseJsonSafely(task.metadata.auto_tune_history_json);
    const autoTuneHistory = Array.isArray(autoTuneHistoryRaw) ? autoTuneHistoryRaw : [];
    return (
      <div className="inline-actions">
        {!task.training_job_id && task.missing_requirements.length === 0 ? (
          <ButtonLink to={launchHref} variant="secondary" size="sm">
            {t('Launch training')}
          </ButtonLink>
        ) : null}
        {task.missing_requirements.length === 0 ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void handleAutoContinue()}
            disabled={autoContinuing}
          >
            {autoContinuing
              ? t('Scheduling...')
              : autoTuneHistory.length > 0
                ? t('Run next round')
                : t('Start round 1')}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={() => void handleAutoAdvance()}
          disabled={autoAdvancing}
        >
          {autoAdvancing ? t('Agent continuing...') : t('Continue as agent')}
        </Button>
        {(task.model_version_id || task.training_job_id) ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void handleGenerateFeedbackDataset()}
            disabled={generatingFeedback || autoContinuing || registeringModel || autoAdvancing}
          >
            {generatingFeedback ? t('Generating...') : t('Mine badcases')}
          </Button>
        ) : null}
        {!task.model_version_id && task.training_job_id ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void handleRegisterModel()}
            disabled={registeringModel || autoContinuing || autoAdvancing}
          >
            {registeringModel ? t('Registering...') : t('Register model')}
          </Button>
        ) : null}
        {feedbackDatasetId ? (
          <ButtonLink to={`/datasets/${encodeURIComponent(feedbackDatasetId)}`} variant="secondary" size="sm">
            {t('Open feedback dataset')}
          </ButtonLink>
        ) : null}
        {task.training_job_id ? (
          <ButtonLink to={`/training/jobs/${encodeURIComponent(task.training_job_id)}`} variant="secondary" size="sm">
            {t('Open training job')}
          </ButtonLink>
        ) : null}
        {task.model_version_id ? (
          <ButtonLink
            to={`/models/versions?selectedVersion=${encodeURIComponent(task.model_version_id)}`}
            variant="secondary"
            size="sm"
          >
            {t('Open model version')}
          </ButtonLink>
        ) : null}
        {task.dataset_id ? (
          <ButtonLink to={`/datasets/${encodeURIComponent(task.dataset_id)}`} variant="ghost" size="sm">
            {t('Open dataset')}
          </ButtonLink>
        ) : null}
      </div>
    );
  }, [
    autoContinuing,
    autoAdvancing,
    generatingFeedback,
    handleAutoAdvance,
    handleAutoContinue,
    handleGenerateFeedbackDataset,
    handleRegisterModel,
    registeringModel,
    task,
    t
  ]);

  if (loading) {
    return (
      <WorkspacePage>
        <StateBlock variant="loading" title={t('Loading')} description={t('Reading vision modeling task.')} />
      </WorkspacePage>
    );
  }

  if (error || !task) {
    return (
      <WorkspacePage>
        <div className="stack page-width">
          <StateBlock
            variant="error"
            title={t('Unable to load vision task')}
            description={error || t('Task was not found.')}
          />
          <div>
            <button
              type="button"
              className="ui-button ui-button--secondary ui-button--sm"
              onClick={() => void loadTask()}
            >
              {t('Retry')}
            </button>
          </div>
        </div>
      </WorkspacePage>
    );
  }

  return (
    <WorkspacePage>
      <div className="stack page-width">
        <PageHeader
          eyebrow={t('Vision Modeling')}
          title={task.id}
          description={task.source_prompt || t('No prompt recorded.')}
          meta={
            <DetailList
              items={[
                { label: t('Status'), value: task.status },
                { label: t('Task type'), value: task.spec.task_type },
                { label: t('Primary metric'), value: task.validation_report?.summary.primary_metric ?? '-' },
                { label: t('Primary value'), value: task.validation_report?.summary.primary_value ?? '-' },
                {
                  label: t('Recommended action'),
                  value: recommendation ? t(recommendation.title) : t('Pending recommendation')
                },
                {
                  label: t('Evaluation suite'),
                  value: task.evaluation_suite ? t(task.evaluation_suite.title) : '-'
                },
                {
                  label: t('Promotion gate'),
                  value: task.promotion_gate ? t(task.promotion_gate.title) : t('Gate pending')
                },
                {
                  label: t('Comparison decision'),
                  value: task.run_comparison ? t(task.run_comparison.title) : t('Comparison pending')
                }
              ]}
            />
          }
          secondaryActions={quickActions}
        />
        {feedbackMessage ? <p className="muted">{feedbackMessage}</p> : null}
        {recommendation ? (
          <SectionCard
            title={t('Agent recommendation')}
            description={t('Backend-generated next step for the current goal state.')}
            actions={
              <div className="inline-actions">
                <Badge tone="info">{t(recommendation.title)}</Badge>
                <Badge tone={recommendation.requires_confirmation ? 'warning' : 'success'}>
                  {recommendation.requires_confirmation
                    ? t('Operator confirmation required')
                    : t('No extra confirmation required')}
                </Badge>
              </div>
            }
          >
            <div className="stack-tight">
              <p>{t(recommendation.summary)}</p>
              <p className="muted">{t(recommendation.reason)}</p>
              {(recommendation.blocking_items ?? []).length > 0 ? (
                <div>
                  <strong>{t('Blocking items')}</strong>
                  <ul>
                    {recommendation.blocking_items.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {(recommendation.evidence ?? []).length > 0 ? (
                <div>
                  <strong>{t('Current evidence')}</strong>
                  <ul>
                    {recommendation.evidence.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </SectionCard>
        ) : (
          <SectionCard title={t('Agent recommendation')} description={t('Backend-generated next step for the current goal state.')}>
            <p className="muted">
              {t('The recommendation will appear after task understanding or runtime synchronization.')}
            </p>
          </SectionCard>
        )}

        {task.evaluation_suite ? (
          <SectionCard
            title={t('Evaluation suite')}
            description={t('The metric contract the agent uses for gate and comparison decisions.')}
            actions={
              <div className="inline-actions">
                <Badge tone={task.evaluation_suite.status === 'ready' ? 'success' : 'info'}>
                  {t(task.evaluation_suite.title)}
                </Badge>
                <Badge tone="neutral">
                  {task.evaluation_suite.primary_metric}: {task.evaluation_suite.threshold_target ?? '-'}
                </Badge>
              </div>
            }
          >
            <div className="stack-tight">
              <p>{t(task.evaluation_suite.summary)}</p>
              <DetailList
                items={[
                  { label: t('Primary metric'), value: task.evaluation_suite.primary_metric },
                  {
                    label: t('Threshold target'),
                    value:
                      typeof task.evaluation_suite.threshold_target === 'number'
                        ? task.evaluation_suite.threshold_target.toFixed(4)
                        : '-'
                  },
                  {
                    label: t('Threshold source'),
                    value: t(task.evaluation_suite.threshold_source)
                  },
                  {
                    label: t('Dataset Version'),
                    value: task.dataset_version_id ?? '-'
                  },
                  {
                    label: t('Recipe id'),
                    value: task.training_plan?.recipe_id ?? '-'
                  }
                ]}
              />
            </div>
          </SectionCard>
        ) : null}

        {task.promotion_gate ? (
          <SectionCard
            title={t('Promotion gate')}
            description={t('Should the current evidence be promoted into model registration now?')}
            actions={
              <div className="inline-actions">
                <Badge tone={gateTone(task.promotion_gate.status)}>{t(task.promotion_gate.title)}</Badge>
                <Badge tone="neutral">
                  {task.promotion_gate.threshold_metric}: {task.promotion_gate.threshold_target ?? '-'}
                </Badge>
              </div>
            }
          >
            <div className="stack-tight">
              <p>{t(task.promotion_gate.summary)}</p>
              <p className="muted">{t(task.promotion_gate.reason)}</p>
              <DetailList
                items={[
                  {
                    label: t('Current metric value'),
                    value:
                      typeof task.promotion_gate.current_value === 'number'
                        ? task.promotion_gate.current_value.toFixed(4)
                        : '-'
                  },
                  {
                    label: t('Best metric value'),
                    value:
                      typeof task.promotion_gate.best_value === 'number'
                        ? task.promotion_gate.best_value.toFixed(4)
                        : '-'
                  },
                  {
                    label: t('Best training job'),
                    value: task.promotion_gate.best_training_job_id ?? '-'
                  }
                ]}
              />
            </div>
          </SectionCard>
        ) : null}

        {task.run_comparison ? (
          <SectionCard
            title={t('Run comparison')}
            description={t('Why the agent currently prefers promote, train again, collect data, or observe.')}
            actions={
              <div className="inline-actions">
                <Badge tone="info">{t(task.run_comparison.title)}</Badge>
                <Badge tone="neutral">{t(task.run_comparison.decision)}</Badge>
              </div>
            }
          >
            <div className="stack-tight">
              <p>{t(task.run_comparison.summary)}</p>
              <p className="muted">{t(task.run_comparison.reason)}</p>
              <DetailList
                items={[
                  {
                    label: t('Best training job'),
                    value: task.run_comparison.best_training_job_id ?? '-'
                  },
                  {
                    label: t('Champion'),
                    value: task.run_comparison.champion_training_job_id ?? '-'
                  },
                  {
                    label: t('Challenger'),
                    value: task.run_comparison.challenger_training_job_id ?? '-'
                  },
                  {
                    label: t('Latest training job'),
                    value: task.run_comparison.latest_training_job_id ?? '-'
                  },
                  {
                    label: t('Champion margin'),
                    value:
                      typeof task.run_comparison.champion_margin === 'number'
                        ? task.run_comparison.champion_margin.toFixed(4)
                        : '-'
                  },
                  {
                    label: t('Best value'),
                    value:
                      typeof task.run_comparison.best_value === 'number'
                        ? task.run_comparison.best_value.toFixed(4)
                        : '-'
                  },
                  {
                    label: t('Latest value'),
                    value:
                      typeof task.run_comparison.latest_value === 'number'
                        ? task.run_comparison.latest_value.toFixed(4)
                        : '-'
                  },
                  {
                    label: t('Improvement'),
                    value:
                      typeof task.run_comparison.improvement === 'number'
                        ? task.run_comparison.improvement.toFixed(4)
                        : '-'
                  }
                ]}
              />
              {task.run_comparison.candidates.length > 0 ? (
                <div>
                  <strong>{t('Compared runs')}</strong>
                  <ul>
                    {task.run_comparison.candidates.map((entry) => (
                      <li key={entry.training_job_id}>
                        {entry.training_job_id} · {t('Round')} {entry.round} · {t(entry.status)} ·{' '}
                        {entry.primary_metric ?? '-'}={typeof entry.primary_value === 'number' ? entry.primary_value.toFixed(4) : '-'} ·{' '}
                        {t(entry.pass_status)}
                        {entry.is_best ? ` · ${t('Champion')}` : ''}
                        {entry.is_challenger ? ` · ${t('Challenger')}` : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </SectionCard>
        ) : null}

        {task.active_learning_pool ? (
          <SectionCard
            title={t('Active learning pool')}
            description={t('Clustered badcases the agent would mine next from linked inference evidence.')}
            actions={
              <div className="inline-actions">
                <Badge tone="info">
                  {t('Total candidates')}: {task.active_learning_pool.total_candidates}
                </Badge>
                <Badge tone="neutral">
                  {t('Recommended sample count')}: {task.active_learning_pool.recommended_sample_count}
                </Badge>
              </div>
            }
          >
            <div className="stack-tight">
              <p>{t(task.active_learning_pool.summary)}</p>
              <DetailList
                items={[
                  {
                    label: t('Total candidates'),
                    value: String(task.active_learning_pool.total_candidates)
                  },
                  {
                    label: t('Recommended sample count'),
                    value: String(task.active_learning_pool.recommended_sample_count)
                  },
                  {
                    label: t('Updated'),
                    value: task.active_learning_pool.refreshed_at
                  }
                ]}
              />
              {task.active_learning_pool.clusters.length > 0 ? (
                <div>
                  <strong>{t('Candidate clusters')}</strong>
                  <ul>
                    {task.active_learning_pool.clusters.map((cluster) => (
                      <li key={cluster.cluster_id}>
                        {t(cluster.title)} · {cluster.count} · {t('Average score')}=
                        {typeof cluster.average_score === 'number' ? cluster.average_score.toFixed(4) : '-'}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {task.active_learning_pool.top_candidates.length > 0 ? (
                <div>
                  <strong>{t('Top candidates')}</strong>
                  <ul>
                    {task.active_learning_pool.top_candidates.map((candidate) => (
                      <li key={candidate.run_id}>
                        <ButtonLink
                          to={buildInferenceRunPath(
                            candidate.run_id,
                            candidate.model_version_id,
                            task.id,
                            currentTaskPath
                          )}
                          variant="ghost"
                          size="sm"
                        >
                          {t('Open run')}
                        </ButtonLink>{' '}
                        {candidate.run_id} ·{' '}
                        {t(activeLearningClusterLabels.get(candidate.cluster_id) ?? candidate.cluster_id)} ·{' '}
                        {candidate.score.toFixed(4)}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </SectionCard>
        ) : null}

        <SectionCard title={t('Agent decision log')} description={t('Compact trail of recommended and executed next steps.')}>
          {task.agent_decision_log.length > 0 ? (
            <div className="stack-tight">
              {task.agent_decision_log.slice(0, 10).map((entry, index) => (
                <div key={`${entry.created_at}-${entry.action}-${index}`} className="stack-tight">
                  <div className="inline-actions">
                    <Badge tone="neutral">{t(entry.action)}</Badge>
                    <Badge
                      tone={
                        entry.outcome === 'executed'
                          ? 'success'
                          : entry.outcome === 'skipped'
                            ? 'warning'
                            : 'info'
                      }
                    >
                      {t(entry.outcome)}
                    </Badge>
                    <small className="muted">{entry.created_at}</small>
                  </div>
                  <strong>{t(entry.summary)}</strong>
                  <small className="muted">{t(entry.reason)}</small>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">{t('No agent decision has been recorded yet.')}</p>
          )}
        </SectionCard>

        <SectionCard title={t('Task spec')} description={t('Structured understanding result from prompt and samples.')}>
          <pre className="code-block">{prettyJson(task.spec)}</pre>
        </SectionCard>

        <SectionCard title={t('Dataset inspection')} description={t('Trainability checks and detected issues.')}>
          <pre className="code-block">{prettyJson(task.dataset_profile)}</pre>
        </SectionCard>

        {datasetProfile ? (
          <SectionCard
            title={t('Dataset diagnostics')}
            description={t('Signals that explain whether the next improvement should come from more data instead of more rounds.')}
            actions={
              datasetProfile.diagnostics.recommended_data_actions.length > 0 ? (
                <div className="inline-actions">
                  {datasetProfile.diagnostics.recommended_data_actions.slice(0, 3).map((action) => (
                    <Badge key={action} tone="info">
                      {t(action)}
                    </Badge>
                  ))}
                </div>
              ) : undefined
            }
          >
            <div className="stack-tight">
              <DetailList
                items={[
                  {
                    label: t('Duplicate attachment ratio'),
                    value: `${Math.round(datasetProfile.diagnostics.duplicate_attachment_ratio * 100)}%`
                  },
                  {
                    label: t('Split overlap'),
                    value: t(datasetProfile.diagnostics.split_overlap_detected ? 'Yes' : 'No')
                  },
                  {
                    label: t('Label balance score'),
                    value:
                      typeof datasetProfile.diagnostics.label_balance_score === 'number'
                        ? datasetProfile.diagnostics.label_balance_score.toFixed(4)
                        : '-'
                  },
                  {
                    label: t('Long-tail labels'),
                    value:
                      datasetProfile.diagnostics.long_tail_labels.length > 0
                        ? datasetProfile.diagnostics.long_tail_labels.join(', ')
                        : '-'
                  },
                  {
                    label: t('Charset size'),
                    value: String(datasetProfile.diagnostics.charset_size)
                  }
                ]}
              />
              {datasetProfile.diagnostics.recommended_data_actions.length > 0 ? (
                <div>
                  <strong>{t('Recommended data actions')}</strong>
                  <ul>
                    {datasetProfile.diagnostics.recommended_data_actions.map((action) => (
                      <li key={action}>{t(action)}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {datasetProfile.label_stats.length > 0 ? (
                <div>
                  <strong>{t('Top label counts')}</strong>
                  <ul>
                    {datasetProfile.label_stats.map((entry) => (
                      <li key={entry.label}>
                        {entry.label} · {entry.count} · {(entry.share * 100).toFixed(1)}%
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </SectionCard>
        ) : null}

        <SectionCard title={t('Training plan')} description={t('Recipe-based plan generated by registry.')}>
          <pre className="code-block">{prettyJson(task.training_plan)}</pre>
        </SectionCard>
        <SectionCard title={t('Auto tune candidates')} description={t('Three round template configs and threshold rule.')}>
          <pre className="code-block">
            {prettyJson({
              auto_tune_rounds: parseJsonSafely(task.metadata.auto_tune_rounds_json) ?? [],
              auto_tune_history: parseJsonSafely(task.metadata.auto_tune_history_json) ?? [],
              threshold_rule: parseJsonSafely(task.metadata.threshold_rule_json),
              active_round: task.metadata.auto_tune_active_round ?? null
            })}
          </pre>
        </SectionCard>

        <SectionCard title={t('Validation report')} description={t('Unified report for metrics and recommendations.')}>
          <pre className="code-block">{prettyJson(task.validation_report)}</pre>
        </SectionCard>

        <SectionCard title={t('Missing requirements')} description={t('Requirements still needed before launch.')}>
          {task.missing_requirements.length > 0 ? (
            <ul>
              {task.missing_requirements.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">{t('No blocking requirements.')}</p>
          )}
        </SectionCard>
      </div>
    </WorkspacePage>
  );
}
