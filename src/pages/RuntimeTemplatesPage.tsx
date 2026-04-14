import { useMemo, useState } from 'react';
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
    image: { filename: 'invoice-sample.jpg', width: 1280, height: 720 },
    lines: [
      { text: 'TEMPLATE_OCR_LINE_1', confidence: 0.95 },
      { text: 'TEMPLATE_OCR_LINE_2', confidence: 0.92 }
    ],
    words: [
      { text: 'TEMPLATE', confidence: 0.96 },
      { text: 'OCR', confidence: 0.93 }
    ]
  },
  doctr: {
    image: { filename: 'invoice-sample.jpg', width: 1280, height: 720 },
    ocr: {
      lines: [{ text: 'TEMPLATE_OCR_LINE_1', confidence: 0.94 }],
      words: [{ text: 'TEMPLATE', confidence: 0.91 }]
    }
  },
  yolo: {
    image: { filename: 'defect-sample.jpg', width: 1280, height: 720 },
    boxes: [
      { x: 180, y: 210, width: 170, height: 110, label: 'TEMPLATE_DETECTION_OBJECT', score: 0.91 },
      { x: 540, y: 360, width: 200, height: 120, label: 'TEMPLATE_DETECTION_OBJECT', score: 0.87 }
    ]
  }
};

export default function RuntimeTemplatesPage() {
  const { t } = useI18n();
  const [templateFramework, setTemplateFramework] = useState<ModelFramework>('yolo');
  const [copyMessage, setCopyMessage] = useState('');

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
            window.location.assign('/settings/runtime');
          }
        }}
        secondaryActions={
          <ButtonLink to="/settings/workers" size="sm" variant="ghost">
            {t('Open Worker Settings')}
          </ButtonLink>
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
                <h3>{t('Prediction response example (expected minimum fields)')}</h3>
                <Button type="button" variant="ghost" size="sm" onClick={() => void copyText(t('Prediction response example'), responseSnippet)}>
                  {t('Copy')}
                </Button>
              </div>
              <pre className="code-block">{responseSnippet}</pre>
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
                  <ButtonLink to="/settings/runtime" variant="secondary" size="sm">
                    {t('Open Runtime Settings')}
                  </ButtonLink>
                }
                secondary={
                  <ButtonLink to="/settings/workers" variant="ghost" size="sm">
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
