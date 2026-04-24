import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { VisionModelingTaskRecord } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
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

export default function VisionModelingTaskPage() {
  const { t } = useI18n();
  const { taskId } = useParams<{ taskId: string }>();
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
          <ButtonLink to={launchHref} variant="primary" size="sm">
            {t('Launch training')}
          </ButtonLink>
        ) : null}
        {task.missing_requirements.length === 0 ? (
          <Button
            type="button"
            variant="primary"
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
          variant="secondary"
          size="sm"
          onClick={() => void handleAutoAdvance()}
          disabled={autoAdvancing}
        >
          {autoAdvancing ? t('Advancing...') : t('Auto advance')}
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

  const nextStepSummary = useMemo(() => {
    if (!task) {
      return null;
    }
    const passStatus = task.validation_report?.summary.pass_status ?? 'needs_review';
    const missing = task.missing_requirements.length;
    if (missing > 0) {
      return t('Fill missing requirements first, then start round 1.');
    }
    if (!task.training_job_id) {
      return t('Ready to train. Start round 1 now.');
    }
    if (!task.model_version_id && passStatus === 'pass') {
      return t('Metrics reached threshold. Register model version.');
    }
    if (!task.model_version_id && passStatus !== 'pass') {
      return t('Metrics need improvement. Run next round or mine badcases.');
    }
    if (task.model_version_id && !(task.metadata.feedback_dataset_id ?? '').trim()) {
      return t('Model is registered. Mine badcases to build feedback dataset.');
    }
    return t('Closed loop is ready. Continue iterative optimization as needed.');
  }, [task, t]);

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
                { label: t('Primary value'), value: task.validation_report?.summary.primary_value ?? '-' }
              ]}
            />
          }
          secondaryActions={quickActions}
        />
        {feedbackMessage ? <p className="muted">{feedbackMessage}</p> : null}
        {nextStepSummary ? (
          <SectionCard title={t('Next step')} description={t('System recommendation for fastest progress.')}>
            <p className="muted">{nextStepSummary}</p>
          </SectionCard>
        ) : null}

        <SectionCard title={t('Task spec')} description={t('Structured understanding result from prompt and samples.')}>
          <pre className="code-block">{prettyJson(task.spec)}</pre>
        </SectionCard>

        <SectionCard title={t('Dataset inspection')} description={t('Trainability checks and detected issues.')}>
          <pre className="code-block">{prettyJson(task.dataset_profile)}</pre>
        </SectionCard>

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
