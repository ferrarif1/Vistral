import { useEffect, useMemo, useState } from 'react';
import type {
  ModelFramework,
  RuntimeConnectivityRecord,
  RuntimeMetricsRetentionSummary
} from '../../shared/domain';
import AdvancedSection from '../components/AdvancedSection';
import StateBlock from '../components/StateBlock';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

const FRAMEWORKS: ModelFramework[] = ['paddleocr', 'doctr', 'yolo'];

const endpointEnvByFramework: Record<ModelFramework, { endpoint: string; apiKey: string }> = {
  paddleocr: {
    endpoint: 'PADDLEOCR_RUNTIME_ENDPOINT',
    apiKey: 'PADDLEOCR_RUNTIME_API_KEY'
  },
  doctr: {
    endpoint: 'DOCTR_RUNTIME_ENDPOINT',
    apiKey: 'DOCTR_RUNTIME_API_KEY'
  },
  yolo: {
    endpoint: 'YOLO_RUNTIME_ENDPOINT',
    apiKey: 'YOLO_RUNTIME_API_KEY'
  }
};

const sampleInputByFramework: Record<ModelFramework, Record<string, unknown>> = {
  paddleocr: {
    framework: 'paddleocr',
    model_id: 'm-ocr',
    model_version_id: 'mv-ocr-v1',
    input_attachment_id: 'f-ocr-001',
    filename: 'invoice-sample.jpg',
    task_type: 'ocr'
  },
  doctr: {
    framework: 'doctr',
    model_id: 'm-ocr',
    model_version_id: 'mv-ocr-v2',
    input_attachment_id: 'f-ocr-001',
    filename: 'invoice-sample.jpg',
    task_type: 'ocr'
  },
  yolo: {
    framework: 'yolo',
    model_id: 'm-det',
    model_version_id: 'mv-det-v1',
    input_attachment_id: 'f-det-001',
    filename: 'defect-sample.jpg',
    task_type: 'detection'
  }
};

const sampleOutputByFramework: Record<ModelFramework, Record<string, unknown>> = {
  paddleocr: {
    image: { filename: 'invoice-sample.jpg', width: 1280, height: 720 },
    lines: [
      { text: 'Invoice No. 2026-0402', confidence: 0.95 },
      { text: 'Total: 458.30', confidence: 0.92 }
    ],
    words: [
      { text: 'Invoice', confidence: 0.96 },
      { text: 'Total', confidence: 0.93 }
    ]
  },
  doctr: {
    image: { filename: 'invoice-sample.jpg', width: 1280, height: 720 },
    ocr: {
      lines: [{ text: 'docTR line output', confidence: 0.94 }],
      words: [{ text: 'docTR', confidence: 0.91 }]
    }
  },
  yolo: {
    image: { filename: 'defect-sample.jpg', width: 1280, height: 720 },
    boxes: [
      { x: 180, y: 210, width: 170, height: 110, label: 'defect', score: 0.91 },
      { x: 540, y: 360, width: 200, height: 120, label: 'scratch', score: 0.87 }
    ]
  }
};

export default function RuntimeSettingsPage() {
  const { t } = useI18n();
  const [checks, setChecks] = useState<RuntimeConnectivityRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [inferenceSourceSummary, setInferenceSourceSummary] = useState<Array<{ key: string; count: number }>>([]);
  const [trainingModeSummary, setTrainingModeSummary] = useState<Array<{ key: string; count: number }>>([]);
  const [metricsRetentionSummary, setMetricsRetentionSummary] = useState<RuntimeMetricsRetentionSummary | null>(null);
  const [frameworkFilter, setFrameworkFilter] = useState<'all' | ModelFramework>('all');
  const [templateFramework, setTemplateFramework] = useState<ModelFramework>('yolo');
  const [copyMessage, setCopyMessage] = useState('');

  const describeErrorKind = (kind: RuntimeConnectivityRecord['error_kind']) => {
    if (kind === 'timeout') {
      return t('Runtime responded too slowly. Check endpoint latency and timeout.');
    }
    if (kind === 'network') {
      return t('Network connection failed. Check host/port/DNS and service reachability.');
    }
    if (kind === 'http_status') {
      return t('Runtime returned non-200 status. Check endpoint path and auth.');
    }
    if (kind === 'invalid_payload') {
      return t('Runtime payload shape is incompatible. Check response JSON contract.');
    }
    if (kind === 'none') {
      return t('No connectivity error.');
    }
    return t('Unknown runtime error. Check runtime logs for details.');
  };

  const copyText = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyMessage(t('{label} copied.', { label }));
    } catch (copyError) {
      setCopyMessage(t('Copy failed: {message}', { message: (copyError as Error).message }));
    }
  };

  const refresh = async (framework?: ModelFramework) => {
    setChecking(true);
    setError('');

    try {
      const result = await api.getRuntimeConnectivity(framework);
      if (framework) {
        setChecks((prev) => {
          const map = new Map(prev.map((item) => [item.framework, item]));
          result.forEach((item) => map.set(item.framework, item));
          return FRAMEWORKS.map((entry) => map.get(entry)).filter(
            (item): item is RuntimeConnectivityRecord => Boolean(item)
          );
        });
      } else {
        setChecks(result);
      }
    } catch (runtimeError) {
      setError((runtimeError as Error).message);
    } finally {
      setChecking(false);
      setLoading(false);
    }
  };

  const refreshExecutionSummary = async () => {
    setSummaryLoading(true);
    try {
      const [runs, jobs, retention] = await Promise.all([
        api.listInferenceRuns(),
        api.listTrainingJobs(),
        api.getRuntimeMetricsRetentionSummary()
      ]);
      const sourceCounter = new Map<string, number>();
      runs.forEach((run) => {
        const source =
          typeof run.execution_source === 'string' && run.execution_source.trim()
            ? run.execution_source
            : typeof run.normalized_output?.normalized_output?.source === 'string'
              ? run.normalized_output.normalized_output.source
              : 'unknown';
        sourceCounter.set(source, (sourceCounter.get(source) ?? 0) + 1);
      });

      const modeCounter = new Map<string, number>();
      jobs.forEach((job) => {
        const mode = job.execution_mode || 'unknown';
        modeCounter.set(mode, (modeCounter.get(mode) ?? 0) + 1);
      });

      setInferenceSourceSummary(
        Array.from(sourceCounter.entries())
          .sort((left, right) => right[1] - left[1])
          .map(([key, count]) => ({ key, count }))
      );
      setTrainingModeSummary(
        Array.from(modeCounter.entries())
          .sort((left, right) => right[1] - left[1])
          .map(([key, count]) => ({ key, count }))
      );
      setMetricsRetentionSummary(retention);
    } catch {
      setInferenceSourceSummary([]);
      setTrainingModeSummary([]);
      setMetricsRetentionSummary(null);
    } finally {
      setSummaryLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    void refreshExecutionSummary();
  }, []);

  const checkByFramework = useMemo(
    () => new Map(checks.map((item) => [item.framework, item])),
    [checks]
  );

  const selectedTemplateRuntime = checkByFramework.get(templateFramework);

  const predictEndpointForTemplate =
    selectedTemplateRuntime?.endpoint ?? 'http://127.0.0.1:9393/predict';

  const healthEndpointForTemplate = (() => {
    const normalized = predictEndpointForTemplate.replace(/\/+$/, '');
    if (normalized.endsWith('/predict')) {
      return `${normalized.slice(0, -'/predict'.length)}/health`;
    }

    return `${normalized}/health`;
  })();

  return (
    <div className="stack page-width">
      <h2>{t('Runtime Settings')}</h2>
      <p className="muted">
        {t('Verify runtime bridge connectivity for PaddleOCR, docTR, and YOLO directly in the platform.')}
      </p>

      {loading ? (
        <StateBlock variant="loading" title={t('Loading Runtime Status')} description={t('Checking framework endpoints.')} />
      ) : null}

      {error ? <StateBlock variant="error" title={t('Runtime Check Failed')} description={error} /> : null}

      <section className="card stack">
        <div className="row gap wrap align-center">
          <label>
            {t('Framework')}
            <select
              value={frameworkFilter}
              onChange={(event) => setFrameworkFilter(event.target.value as 'all' | ModelFramework)}
            >
              <option value="all">{t('all')}</option>
              <option value="paddleocr">{t('paddleocr')}</option>
              <option value="doctr">{t('doctr')}</option>
              <option value="yolo">{t('yolo')}</option>
            </select>
          </label>
        </div>
        <div className="row gap wrap">
          <button onClick={() => refresh()} disabled={checking}>
            {checking && frameworkFilter === 'all' ? t('Checking...') : t('Refresh All')}
          </button>
          <button
            onClick={() => refresh(frameworkFilter === 'all' ? undefined : frameworkFilter)}
            disabled={checking || frameworkFilter === 'all'}
          >
            {checking && frameworkFilter !== 'all' ? t('Checking...') : t('Check Selected')}
          </button>
        </div>
      </section>

      <section className="three-col">
        {FRAMEWORKS.map((framework) => {
          const item = checkByFramework.get(framework);
          const source = item?.source ?? 'not_configured';
          const statusText =
            source === 'reachable' ? t('reachable') : source === 'unreachable' ? t('unreachable') : t('not configured');

          return (
            <article key={framework} className="card stack tight">
              <strong>{t(framework)}</strong>
              <span className="chip">{statusText}</span>
              <small className="muted">
                {t('env')}: {endpointEnvByFramework[framework].endpoint} (+{' '}
                {endpointEnvByFramework[framework].apiKey} {t('optional')})
              </small>
              <small className="muted">{t('endpoint')}: {item?.endpoint ?? t('not set')}</small>
              <small className="muted">{t('error kind')}: {item?.error_kind ? t(item.error_kind) : t('none')}</small>
              <small className="muted">{t('checked at')}: {item?.checked_at ?? t('n/a')}</small>
              {source === 'reachable' ? (
                <StateBlock
                  variant="success"
                  title={t('Runtime Ready')}
                  description={item?.message ?? t('Runtime endpoint responded with compatible payload.')}
                />
              ) : source === 'unreachable' ? (
                <StateBlock
                  variant="error"
                  title={t('Runtime Unreachable')}
                  description={`${item?.message ?? t('Runtime endpoint call failed.')} ${describeErrorKind(item?.error_kind ?? 'unknown')}`}
                />
              ) : (
                <StateBlock
                  variant="empty"
                  title={t('Not Configured')}
                  description={t('Set endpoint env vars to enable runtime bridge for this framework.')}
                />
              )}
            </article>
          );
        })}
      </section>

      <section className="card stack">
        <h3>{t('Recent Execution Summary')}</h3>
        {summaryLoading ? (
          <StateBlock
            variant="loading"
            title={t('Loading Summary')}
            description={t('Collecting recent training and inference execution sources.')}
          />
        ) : (
          <>
            <div className="stack tight">
              <strong>{t('Inference source distribution')}</strong>
              {inferenceSourceSummary.length === 0 ? (
                <small className="muted">{t('No inference runs yet.')}</small>
              ) : (
                <div className="row gap wrap">
                  {inferenceSourceSummary.map((entry) => (
                    <span key={entry.key} className="chip">
                      {entry.key}: {entry.count}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="stack tight">
              <strong>{t('Training execution mode distribution')}</strong>
              {trainingModeSummary.length === 0 ? (
                <small className="muted">{t('No training jobs yet.')}</small>
              ) : (
                <div className="row gap wrap">
                  {trainingModeSummary.map((entry) => (
                    <span key={entry.key} className="chip">
                      {entry.key}: {entry.count}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="stack tight">
              <strong>{t('Training metric retention')}</strong>
              {!metricsRetentionSummary ? (
                <small className="muted">{t('Retention summary unavailable.')}</small>
              ) : (
                <>
                  <div className="row gap wrap">
                    <span className="chip">
                      {t('Current rows')}: {metricsRetentionSummary.current_total_rows}
                    </span>
                    <span className="chip">
                      {t('Total cap')}: {metricsRetentionSummary.max_total_rows}
                    </span>
                    <span className="chip">
                      {t('Per-job cap')}: {metricsRetentionSummary.max_points_per_job}
                    </span>
                    <span className="chip">
                      {t('Jobs with metrics')}: {metricsRetentionSummary.jobs_with_metrics}
                    </span>
                    <span className="chip">
                      {t('Visible jobs')}: {metricsRetentionSummary.visible_job_count}
                    </span>
                    <span className="chip">
                      {t('Max rows (single job)')}: {metricsRetentionSummary.max_rows_single_job}
                    </span>
                  </div>
                  <small className="muted">
                    {metricsRetentionSummary.near_total_cap
                      ? t('Retention usage is close to cap. Consider lowering metric density or increasing cap.')
                      : t('Retention usage is within normal range.')}
                  </small>
                  {metricsRetentionSummary.top_jobs.length > 0 ? (
                    <div className="row gap wrap">
                      {metricsRetentionSummary.top_jobs.map((item) => (
                        <span key={item.training_job_id} className="chip">
                          {item.training_job_id}: {item.rows}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </>
              )}
            </div>
            <div className="row gap wrap">
              <button type="button" onClick={() => void refreshExecutionSummary()} disabled={summaryLoading}>
                {summaryLoading ? t('Refreshing...') : t('Refresh Summary')}
              </button>
            </div>
          </>
        )}
      </section>

      <AdvancedSection
        title={t('Runtime Integration Templates')}
        description={t('Executable snippets for framework runtime adapters. Use this to align payload contracts quickly.')}
      >
        {copyMessage ? (
          <StateBlock variant="success" title={t('Clipboard')} description={copyMessage} />
        ) : null}

        <label>
          {t('Template Framework')}
          <select
            value={templateFramework}
            onChange={(event) => setTemplateFramework(event.target.value as ModelFramework)}
          >
            <option value="paddleocr">{t('paddleocr')}</option>
            <option value="doctr">{t('doctr')}</option>
            <option value="yolo">{t('yolo')}</option>
          </select>
        </label>

        <section className="card stack">
          <div className="row between gap align-center">
            <h3>{t('Environment Variables')}</h3>
            <button
              type="button"
              onClick={() =>
                copyText(
                  t('Environment snippet'),
                  `${endpointEnvByFramework[templateFramework].endpoint}=${predictEndpointForTemplate}\n${endpointEnvByFramework[templateFramework].apiKey}=<optional-bearer-key>`
                )
              }
            >
              {t('Copy')}
            </button>
          </div>
          <pre className="code-block">{`${endpointEnvByFramework[templateFramework].endpoint}=${predictEndpointForTemplate}\n${endpointEnvByFramework[templateFramework].apiKey}=<optional-bearer-key>`}</pre>
        </section>

        <section className="card stack">
          <div className="row between gap align-center">
            <h3>{t('Health Check Curl')}</h3>
            <button type="button" onClick={() => copyText(t('Health curl'), `curl -sS ${healthEndpointForTemplate}`)}>
              {t('Copy')}
            </button>
          </div>
          <pre className="code-block">{`curl -sS ${healthEndpointForTemplate}`}</pre>
        </section>

        <section className="card stack">
          <div className="row between gap align-center">
            <h3>{t('Predict Request Payload (from Vistral)')}</h3>
            <button
              type="button"
              onClick={() =>
                copyText(
                  t('Predict request payload'),
                  JSON.stringify(sampleInputByFramework[templateFramework], null, 2)
                )
              }
            >
              {t('Copy')}
            </button>
          </div>
          <pre className="code-block">
            {JSON.stringify(sampleInputByFramework[templateFramework], null, 2)}
          </pre>
        </section>

        <section className="card stack">
          <div className="row between gap align-center">
            <h3>{t('Predict Response Payload (expected minimal shape)')}</h3>
            <button
              type="button"
              onClick={() =>
                copyText(
                  t('Predict response payload'),
                  JSON.stringify(sampleOutputByFramework[templateFramework], null, 2)
                )
              }
            >
              {t('Copy')}
            </button>
          </div>
          <pre className="code-block">
            {JSON.stringify(sampleOutputByFramework[templateFramework], null, 2)}
          </pre>
        </section>
      </AdvancedSection>
    </div>
  );
}
