import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type {
  DatasetItemRecord,
  DatasetRecord,
  DatasetVersionRecord,
  FileAttachment
} from '../../shared/domain';
import AdvancedSection from '../components/AdvancedSection';
import AttachmentUploader from '../components/AttachmentUploader';
import StateBlock from '../components/StateBlock';
import StepIndicator from '../components/StepIndicator';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

export default function DatasetDetailPage() {
  const { t } = useI18n();
  const steps = useMemo(() => [t('Upload'), t('Split'), t('Version')], [t]);
  const { datasetId } = useParams<{ datasetId: string }>();
  const [dataset, setDataset] = useState<DatasetRecord | null>(null);
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [items, setItems] = useState<DatasetItemRecord[]>([]);
  const [versions, setVersions] = useState<DatasetVersionRecord[]>([]);
  const [splitTrain, setSplitTrain] = useState('0.7');
  const [splitVal, setSplitVal] = useState('0.2');
  const [splitTest, setSplitTest] = useState('0.1');
  const [versionName, setVersionName] = useState('');
  const [importFormat, setImportFormat] = useState<'yolo' | 'coco' | 'labelme' | 'ocr'>('yolo');
  const [exportFormat, setExportFormat] = useState<'yolo' | 'coco' | 'labelme' | 'ocr'>('yolo');
  const [importAttachmentId, setImportAttachmentId] = useState('');
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ variant: 'success' | 'error'; text: string } | null>(null);

  const loadDetail = useCallback(async () => {
    if (!datasetId) {
      return;
    }

    const detail = await api.getDatasetDetail(datasetId);
    setDataset(detail.dataset);
    setAttachments(detail.attachments);
    setItems(detail.items);
    setVersions(detail.versions);
  }, [datasetId]);

  useEffect(() => {
    if (!datasetId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    loadDetail()
      .then(() => setFeedback(null))
      .catch((error) => setFeedback({ variant: 'error', text: (error as Error).message }))
      .finally(() => setLoading(false));
  }, [datasetId, loadDetail]);

  useEffect(() => {
    if (!datasetId) {
      return;
    }

    const timer = window.setInterval(() => {
      loadDetail().catch(() => {
        // keep UI stable in polling loop
      });
    }, 700);

    return () => window.clearInterval(timer);
  }, [datasetId, loadDetail]);

  const readyCount = useMemo(
    () => attachments.filter((attachment) => attachment.status === 'ready').length,
    [attachments]
  );

  useEffect(() => {
    if (importAttachmentId) {
      return;
    }

    const ready = attachments.find((attachment) => attachment.status === 'ready');
    if (ready) {
      setImportAttachmentId(ready.id);
    }
  }, [attachments, importAttachmentId]);

  const uploadDatasetFile = async (filename: string) => {
    if (!datasetId) {
      throw new Error(t('Missing Dataset ID'));
    }

    await api.uploadDatasetAttachment(datasetId, filename);
    await loadDetail();
  };

  const uploadDatasetFiles = async (files: File[]) => {
    if (!datasetId) {
      throw new Error(t('Missing Dataset ID'));
    }

    for (const file of files) {
      await api.uploadDatasetFile(datasetId, file);
    }
    await loadDetail();
  };

  const deleteAttachment = async (attachmentId: string) => {
    await api.removeAttachment(attachmentId);
    await loadDetail();
  };

  const runSplit = async () => {
    if (!datasetId) {
      return;
    }

    setBusy(true);
    setFeedback(null);

    try {
      const trainRatio = Number(splitTrain);
      const valRatio = Number(splitVal);
      const testRatio = Number(splitTest);
      const total = trainRatio + valRatio + testRatio;

      if (Math.abs(total - 1) > 0.0001) {
        throw new Error(t('Split ratios must sum to 1.0.'));
      }

      await api.splitDataset({
        dataset_id: datasetId,
        train_ratio: trainRatio,
        val_ratio: valRatio,
        test_ratio: testRatio,
        seed: 42
      });

      await loadDetail();
      setStep(2);
      setFeedback({ variant: 'success', text: t('Dataset split updated successfully.') });
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const createVersion = async () => {
    if (!datasetId) {
      return;
    }

    setBusy(true);
    setFeedback(null);

    try {
      const created = await api.createDatasetVersion(datasetId, versionName.trim() || undefined);
      await loadDetail();
      setFeedback({
        variant: 'success',
        text: t('Dataset version {versionName} created.', { versionName: created.version_name })
      });
      setVersionName('');
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const importAnnotations = async () => {
    if (!datasetId) {
      return;
    }

    if (!importAttachmentId) {
      setFeedback({ variant: 'error', text: t('Select a ready dataset attachment as import source.') });
      return;
    }

    setBusy(true);
    setFeedback(null);

    try {
      const result = await api.importDatasetAnnotations({
        dataset_id: datasetId,
        format: importFormat,
        attachment_id: importAttachmentId
      });
      await loadDetail();
      setFeedback({
        variant: 'success',
        text: t('Import finished ({format}). imported {imported}, updated {updated}.', {
          format: result.format,
          imported: result.imported,
          updated: result.updated
        })
      });
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const exportAnnotations = async () => {
    if (!datasetId) {
      return;
    }

    setBusy(true);
    setFeedback(null);

    try {
      const result = await api.exportDatasetAnnotations({
        dataset_id: datasetId,
        format: exportFormat
      });
      await loadDetail();
      setFeedback({
        variant: 'success',
        text: t('Export ready ({format}). file {filename}, records {count}.', {
          format: result.format,
          filename: result.filename,
          count: result.exported
        })
      });
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (!datasetId) {
    return (
      <div className="stack">
        <h2>{t('Dataset Detail')}</h2>
        <StateBlock variant="error" title={t('Missing Dataset ID')} description={t('Open from dataset list page.')} />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="stack">
        <h2>{t('Dataset Detail')}</h2>
        <StateBlock variant="loading" title={t('Loading Dataset')} description={t('Preparing dataset detail view.')} />
      </div>
    );
  }

  if (!dataset) {
    return (
      <div className="stack">
        <h2>{t('Dataset Detail')}</h2>
        <StateBlock variant="error" title={t('Dataset Not Found')} description={t('The requested dataset is unavailable.')} />
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="row between gap align-center">
        <div className="stack tight">
          <h2>{t('Dataset Detail')}</h2>
          <p className="muted">
            {dataset.name} · {t(dataset.task_type)} · {t(dataset.status)}
          </p>
        </div>
        <Link className="quick-link" to={`/datasets/${dataset.id}/annotate`}>
          {t('Open Annotation Workspace')}
        </Link>
      </div>

      <StepIndicator steps={steps} current={step} />

      {feedback ? (
        <StateBlock
          variant={feedback.variant}
          title={feedback.variant === 'success' ? t('Action Completed') : t('Action Failed')}
          description={feedback.text}
        />
      ) : null}

      <AttachmentUploader
        title={t('Step 1. Dataset File Upload')}
        items={attachments}
        onUpload={uploadDatasetFile}
        onUploadFiles={uploadDatasetFiles}
        contentUrlBuilder={api.attachmentContentUrl}
        onDelete={deleteAttachment}
        emptyDescription={t('Upload images or archives. Files stay visible for this dataset context.')}
        uploadButtonLabel={t('Upload Dataset File')}
        disabled={busy}
      />

      <section className="card stack">
        <h3>{t('Step 2. Train/Val/Test Split')}</h3>
        <div className="three-col">
          <label>
            {t('Train Ratio')}
            <input value={splitTrain} onChange={(event) => setSplitTrain(event.target.value)} />
          </label>
          <label>
            {t('Val Ratio')}
            <input value={splitVal} onChange={(event) => setSplitVal(event.target.value)} />
          </label>
          <label>
            {t('Test Ratio')}
            <input value={splitTest} onChange={(event) => setSplitTest(event.target.value)} />
          </label>
        </div>
        <button onClick={runSplit} disabled={busy || items.length === 0}>
          {t('Apply Split')}
        </button>
      </section>

      <section className="card stack">
        <h3>{t('Step 3. Dataset Version')}</h3>
        <label>
          {t('Version Name (optional)')}
          <input
            value={versionName}
            onChange={(event) => setVersionName(event.target.value)}
            placeholder={t('for example: v2')}
          />
        </label>
        <button onClick={createVersion} disabled={busy || items.length === 0}>
          {t('Create Version Snapshot')}
        </button>
      </section>

      <AdvancedSection
        title={t('Annotation Import / Export')}
        description={t('Use this section to run minimal import/export stubs with format selection.')}
      >
        <section className="card stack">
          <h4>{t('Import Annotations')}</h4>
          <label>
            {t('Format')}
            <select
              value={importFormat}
              onChange={(event) =>
                setImportFormat(event.target.value as 'yolo' | 'coco' | 'labelme' | 'ocr')
              }
            >
              <option value="yolo">{t('yolo')}</option>
              <option value="coco">{t('coco')}</option>
              <option value="labelme">{t('labelme')}</option>
              <option value="ocr">{t('ocr')}</option>
            </select>
          </label>
          <label>
            {t('Source Attachment')}
            <select
              value={importAttachmentId}
              onChange={(event) => setImportAttachmentId(event.target.value)}
            >
              {attachments
                .filter((attachment) => attachment.status === 'ready')
                .map((attachment) => (
                  <option key={attachment.id} value={attachment.id}>
                    {attachment.filename} ({attachment.id})
                  </option>
                ))}
            </select>
          </label>
          <button onClick={importAnnotations} disabled={busy || !importAttachmentId}>
            {t('Run Import')}
          </button>
        </section>

        <section className="card stack">
          <h4>{t('Export Annotations')}</h4>
          <label>
            {t('Format')}
            <select
              value={exportFormat}
              onChange={(event) =>
                setExportFormat(event.target.value as 'yolo' | 'coco' | 'labelme' | 'ocr')
              }
            >
              <option value="yolo">{t('yolo')}</option>
              <option value="coco">{t('coco')}</option>
              <option value="labelme">{t('labelme')}</option>
              <option value="ocr">{t('ocr')}</option>
            </select>
          </label>
          <button onClick={exportAnnotations} disabled={busy}>
            {t('Run Export')}
          </button>
        </section>
      </AdvancedSection>

      <section className="card stack">
        <h3>{t('Dataset Items')}</h3>
        <small className="muted">{t('Ready files: {count}', { count: readyCount })}</small>
        {items.length === 0 ? (
          <StateBlock variant="empty" title={t('No Items')} description={t('Upload dataset files to generate items.')} />
        ) : (
          <ul className="list">
            {items.map((item) => (
              <li key={item.id} className="list-item">
                <div className="row between gap">
                  <span>{item.id}</span>
                  <span className="chip">
                    {t(item.split)} · {t(item.status)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card stack">
        <h3>{t('Dataset Versions')}</h3>
        {versions.length === 0 ? (
          <StateBlock variant="empty" title={t('No Versions')} description={t('Create first version snapshot after split.')} />
        ) : (
          <ul className="list">
            {versions.map((version) => (
              <li key={version.id} className="list-item stack tight">
                <strong>{version.version_name}</strong>
                <small className="muted">
                  {t('Items {count} · Coverage {coverage}', {
                    count: version.item_count,
                    coverage: version.annotation_coverage
                  })}
                </small>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
