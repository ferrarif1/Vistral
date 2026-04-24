import { useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { ModelFramework } from '../../shared/domain';
import SettingsTabs from '../components/settings/SettingsTabs';
import { Badge } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import {
  ActionBar,
  PageHeader,
  SectionCard
} from '../components/ui/ConsolePage';
import { Select } from '../components/ui/Field';
import { Card } from '../components/ui/Surface';
import { WorkspacePage, WorkspaceWorkbench } from '../components/ui/WorkspacePage';
import { useI18n } from '../i18n/I18nProvider';

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
    image: { filename: 'license-plate-sample.jpg', width: 1280, height: 720 },
    lines: [
      { text: '沪A12345', confidence: 0.98 },
      { text: '停车场入口', confidence: 0.91 }
    ],
    words: [
      { text: '沪A12345', confidence: 0.99 },
      { text: '入口', confidence: 0.95 }
    ]
  },
  doctr: {
    image: { filename: 'license-plate-sample.jpg', width: 1280, height: 720 },
    ocr: {
      lines: [{ text: '沪A12345', confidence: 0.97 }],
      words: [{ text: '沪A12345', confidence: 0.95 }]
    }
  },
  yolo: {
    image: { filename: 'traffic-sample.jpg', width: 1280, height: 720 },
    boxes: [
      { x: 180, y: 210, width: 170, height: 110, label: 'person', score: 0.91 },
      { x: 540, y: 360, width: 200, height: 120, label: 'vehicle', score: 0.87 }
    ]
  }
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

const buildRuntimeSettingsPath = (
  launchContext?: LaunchContext,
  framework?: ModelFramework | null
): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('focus', 'readiness');
  if (framework) {
    searchParams.set('framework', framework);
  }
  appendTrainingLaunchContext(searchParams, launchContext);
  return `/settings/runtime?${searchParams.toString()}`;
};

const buildWorkerSettingsPath = (
  launchContext?: LaunchContext,
  framework?: ModelFramework | null
): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('focus', 'inventory');
  if (framework) {
    searchParams.set('profile', framework);
  }
  appendTrainingLaunchContext(searchParams, launchContext);
  return `/settings/workers?${searchParams.toString()}`;
};

export default function RuntimeTemplatesPage() {
  const { t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedReturnTo = sanitizeReturnToPath(searchParams.get('return_to'));
  const currentTaskPath = useMemo(
    () => `${location.pathname}${location.search || ''}`,
    [location.pathname, location.search]
  );
  const outboundReturnTo = requestedReturnTo ?? currentTaskPath;
  const [templateFramework, setTemplateFramework] = useState<ModelFramework>('yolo');
  const [copyMessage, setCopyMessage] = useState('');
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
  const runtimeSettingsPath = useMemo(
    () => buildRuntimeSettingsPath(launchContext, templateFramework),
    [launchContext, templateFramework]
  );
  const workerSettingsPath = useMemo(
    () => buildWorkerSettingsPath(launchContext, templateFramework),
    [launchContext, templateFramework]
  );

  const predictEndpointForTemplate = useMemo(() => {
    if (templateFramework === 'paddleocr') {
      return 'http://127.0.0.1:9393/predict';
    }
    if (templateFramework === 'doctr') {
      return 'http://127.0.0.1:9494/predict';
    }
    return 'http://127.0.0.1:9595/predict';
  }, [templateFramework]);

  const healthEndpointForTemplate = useMemo(() => {
    return predictEndpointForTemplate.replace(/\/predict$/, '/health');
  }, [predictEndpointForTemplate]);

  const copyText = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyMessage(t('{label} copied.', { label }));
    } catch (copyError) {
      setCopyMessage(t('Copy failed: {message}', { message: (copyError as Error).message }));
    }
  };

  const envSnippet = `${endpointEnvByFramework[templateFramework].endpoint}=${predictEndpointForTemplate}\n${endpointEnvByFramework[templateFramework].apiKey}=<optional-bearer-key>`;
  const healthSnippet = `curl -sS ${healthEndpointForTemplate}`;
  const requestSnippet = JSON.stringify(sampleInputByFramework[templateFramework], null, 2);
  const responseSnippet = JSON.stringify(sampleOutputByFramework[templateFramework], null, 2);
  const publicApiBaseUrl = useMemo(() => {
    if (typeof window === 'undefined') {
      return 'http://127.0.0.1:8080/api/runtime/public';
    }
    return `${window.location.origin}/api/runtime/public`;
  }, []);
  const publicInferenceCurlSnippet = useMemo(() => {
    const requestPayload = {
      model_version_id: sampleInputByFramework[templateFramework].model_version_id,
      task_type: sampleInputByFramework[templateFramework].task_type,
      filename: sampleInputByFramework[templateFramework].filename,
      image_base64: '<base64-image-content>'
    };
    return [
      `curl -sS ${publicApiBaseUrl}/inference \\`,
      '  -H "Authorization: Bearer <runtime-api-key>" \\',
      '  -H "Content-Type: application/json" \\',
      '  -X POST \\',
      `  -d '${JSON.stringify(requestPayload)}'`
    ].join('\n');
  }, [publicApiBaseUrl, templateFramework]);
  const publicModelPackageCurlSnippet = useMemo(() => {
    const requestPayload = {
      model_version_id: sampleInputByFramework[templateFramework].model_version_id,
      encryption_key: '<delivery-encryption-key>'
    };
    return [
      `curl -sS ${publicApiBaseUrl}/model-package \\`,
      '  -H "Authorization: Bearer <runtime-api-key>" \\',
      '  -H "Content-Type: application/json" \\',
      '  -X POST \\',
      `  -d '${JSON.stringify(requestPayload)}'`
    ].join('\n');
  }, [publicApiBaseUrl, templateFramework]);
  const publicModelPackageResponseSnippet = JSON.stringify(
    {
      delivery_id: 'pubpkg-1001',
      model_version_id: sampleInputByFramework[templateFramework].model_version_id,
      framework: templateFramework,
      runtime_auth_binding: 'model_version',
      source_filename: 'model.bin',
      source_byte_size: 1048576,
      encryption: {
        algorithm: 'aes-256-gcm',
        kdf: 'sha256',
        iv_base64: '<base64>',
        tag_base64: '<base64>',
        ciphertext_base64: '<base64>'
      }
    },
    null,
    2
  );

  return (
    <WorkspacePage>
      <SettingsTabs />
      <PageHeader
        eyebrow={t('Runtime operations')}
        title={t('Runtime Templates')}
        description={t('Copy runtime endpoint integration snippets in one dedicated page. Runtime/Worker state operations stay on their own pages.')}
        meta={
          <div className="row gap wrap align-center">
            <Badge tone="info">{t('Single primary task')}</Badge>
            <Badge tone="neutral">{t('Snippet only')}</Badge>
          </div>
        }
        primaryAction={{
          label: t('Open Runtime Settings'),
          onClick: () => {
            navigate(runtimeSettingsPath);
          }
        }}
        secondaryActions={
          <div className="row gap wrap">
            {requestedReturnTo ? (
              <ButtonLink to={requestedReturnTo} size="sm" variant="ghost">
                {t('Return to current task')}
              </ButtonLink>
            ) : null}
            <ButtonLink to={workerSettingsPath} size="sm" variant="ghost">
              {t('Open Worker Settings')}
            </ButtonLink>
          </div>
        }
      />

      <WorkspaceWorkbench
        main={
          <div className="workspace-main-stack">
            <SectionCard
              title={t('Template framework')}
              description={t('Choose one framework and copy env/curl/request/response snippets.')}
              actions={<Badge tone="neutral">{t(templateFramework)}</Badge>}
            >
              <label className="stack tight">
                <small className="muted">{t('Framework')}</small>
                <Select
                  value={templateFramework}
                  onChange={(event) => setTemplateFramework(event.target.value as ModelFramework)}
                >
                  <option value="paddleocr">{t('paddleocr')}</option>
                  <option value="doctr">{t('doctr')}</option>
                  <option value="yolo">{t('yolo')}</option>
                </Select>
              </label>
              {copyMessage ? <small className="muted">{copyMessage}</small> : null}
            </SectionCard>

            <Card as="section" className="workspace-record-item stack tight" tone="soft">
              <div className="row between gap wrap align-center">
                <h3>{t('Environment Variables')}</h3>
                <Button type="button" variant="ghost" size="sm" onClick={() => void copyText(t('Environment snippet'), envSnippet)}>
                  {t('Copy')}
                </Button>
              </div>
              <pre className="code-block">{envSnippet}</pre>
            </Card>

            <Card as="section" className="workspace-record-item stack tight" tone="soft">
              <div className="row between gap wrap align-center">
                <h3>{t('Health Check Curl')}</h3>
                <Button type="button" variant="ghost" size="sm" onClick={() => void copyText(t('Health curl'), healthSnippet)}>
                  {t('Copy')}
                </Button>
              </div>
              <pre className="code-block">{healthSnippet}</pre>
            </Card>

            <Card as="section" className="workspace-record-item stack tight" tone="soft">
              <div className="row between gap wrap align-center">
                <h3>{t('Prediction request example (from Vistral)')}</h3>
                <Button type="button" variant="ghost" size="sm" onClick={() => void copyText(t('Prediction request example'), requestSnippet)}>
                  {t('Copy')}
                </Button>
              </div>
              <pre className="code-block">{requestSnippet}</pre>
            </Card>

            <Card as="section" className="workspace-record-item stack tight" tone="soft">
              <div className="row between gap wrap align-center">
                <h3>{t('Prediction response example')}</h3>
                <Button type="button" variant="ghost" size="sm" onClick={() => void copyText(t('Prediction response example'), responseSnippet)}>
                  {t('Copy')}
                </Button>
              </div>
              <pre className="code-block">{responseSnippet}</pre>
            </Card>

            <Card as="section" className="workspace-record-item stack tight" tone="soft">
              <div className="row between gap wrap align-center">
                <h3>{t('Public model inference API (remote call)')}</h3>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void copyText(t('Public inference curl'), publicInferenceCurlSnippet)}
                >
                  {t('Copy')}
                </Button>
              </div>
              <small className="muted">
                {t('Use Runtime API key binding (model_version/model/framework) from Runtime Settings.')}
              </small>
              <pre className="code-block">{publicInferenceCurlSnippet}</pre>
            </Card>

            <Card as="section" className="workspace-record-item stack tight" tone="soft">
              <div className="row between gap wrap align-center">
                <h3>{t('Encrypted model package delivery')}</h3>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void copyText(t('Encrypted package curl'), publicModelPackageCurlSnippet)}
                >
                  {t('Copy')}
                </Button>
              </div>
              <small className="muted">
                {t('Returns AES-256-GCM encrypted payload for cross-machine secure model handoff.')}
              </small>
              <pre className="code-block">{publicModelPackageCurlSnippet}</pre>
              <div className="row between gap wrap align-center">
                <h4>{t('Encrypted package response example')}</h4>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    void copyText(
                      t('Encrypted package response example'),
                      publicModelPackageResponseSnippet
                    )
                  }
                >
                  {t('Copy')}
                </Button>
              </div>
              <pre className="code-block">{publicModelPackageResponseSnippet}</pre>
            </Card>
          </div>
        }
        side={
          <div className="workspace-inspector-rail">
            <Card as="article" className="workspace-inspector-card">
              <strong>{t('Page boundary')}</strong>
              <small className="muted">
                {t('This page only provides integration snippets. Runtime configuration/readiness and worker lifecycle stay in their own pages.')}
              </small>
              <ActionBar
                primary={
                  <ButtonLink to={runtimeSettingsPath} variant="secondary" size="sm">
                    {t('Open Runtime Settings')}
                  </ButtonLink>
                }
                secondary={
                  <ButtonLink to={workerSettingsPath} variant="ghost" size="sm">
                    {t('Open Worker Settings')}
                  </ButtonLink>
                }
              />
            </Card>
          </div>
        }
      />
    </WorkspacePage>
  );
}
