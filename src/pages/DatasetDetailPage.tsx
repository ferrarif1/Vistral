import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

const metadataToText = (metadata: Record<string, string>): string =>
  Object.entries(metadata)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

const parseMetadataText = (source: string): Record<string, string> =>
  Object.fromEntries(
    source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separatorIndex = line.indexOf('=');
        if (separatorIndex <= 0) {
          return [line.trim(), 'true'] as const;
        }
        const key = line.slice(0, separatorIndex).trim();
        const value = line.slice(separatorIndex + 1).trim();
        return [key, value || 'true'] as const;
      })
      .filter(([key]) => key.length > 0)
  );

const backgroundRefreshIntervalMs = 5000;

type LoadMode = 'initial' | 'manual' | 'background';

const buildDatasetDetailSignature = (detail: {
  dataset: DatasetRecord;
  attachments: FileAttachment[];
  items: DatasetItemRecord[];
  versions: DatasetVersionRecord[];
}): string =>
  JSON.stringify({
    dataset: detail.dataset,
    attachments: [...detail.attachments].sort((left, right) => left.id.localeCompare(right.id)),
    items: [...detail.items].sort((left, right) => left.id.localeCompare(right.id)),
    versions: [...detail.versions].sort((left, right) => left.id.localeCompare(right.id))
  });

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
  const [referenceFilename, setReferenceFilename] = useState('');
  const [referenceSplit, setReferenceSplit] = useState<'train' | 'val' | 'test' | 'unassigned'>('unassigned');
  const [referenceStatus, setReferenceStatus] = useState<'uploading' | 'processing' | 'ready' | 'error'>('ready');
  const [referenceMetadataText, setReferenceMetadataText] = useState('source=import_reference');
  const [selectedItemId, setSelectedItemId] = useState('');
  const [itemSplit, setItemSplit] = useState<'train' | 'val' | 'test' | 'unassigned'>('unassigned');
  const [itemStatus, setItemStatus] = useState<'uploading' | 'processing' | 'ready' | 'error'>('ready');
  const [itemMetadataText, setItemMetadataText] = useState('');
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ variant: 'success' | 'error'; text: string } | null>(null);
  const detailSignatureRef = useRef('');

  const loadDetail = useCallback(async (mode: LoadMode) => {
    if (!datasetId) {
      return;
    }

    if (mode === 'initial') {
      setLoading(true);
    }

    if (mode === 'manual') {
      setRefreshing(true);
    }

    try {
      const detail = await api.getDatasetDetail(datasetId);
      const nextSignature = buildDatasetDetailSignature(detail);

      if (detailSignatureRef.current !== nextSignature) {
        detailSignatureRef.current = nextSignature;
        setDataset(detail.dataset);
        setAttachments(detail.attachments);
        setItems(detail.items);
        setVersions(detail.versions);
      }
    } finally {
      if (mode === 'initial') {
        setLoading(false);
      }

      if (mode === 'manual') {
        setRefreshing(false);
      }
    }
  }, [datasetId]);

  useEffect(() => {
    if (!datasetId) {
      setLoading(false);
      return;
    }

    loadDetail('initial')
      .then(() => setFeedback(null))
      .catch((error) => setFeedback({ variant: 'error', text: (error as Error).message }));
  }, [datasetId, loadDetail]);

  useEffect(() => {
    if (!datasetId) {
      return;
    }

    const timer = window.setInterval(() => {
      loadDetail('background').catch(() => {
        // keep UI stable in polling loop
      });
    }, backgroundRefreshIntervalMs);

    return () => window.clearInterval(timer);
  }, [datasetId, loadDetail]);

  const readyCount = useMemo(
    () => attachments.filter((attachment) => attachment.status === 'ready').length,
    [attachments]
  );
  const attachmentById = useMemo(
    () => new Map(attachments.map((attachment) => [attachment.id, attachment])),
    [attachments]
  );
  const selectedItem = useMemo(
    () => items.find((item) => item.id === selectedItemId) ?? null,
    [items, selectedItemId]
  );

  useEffect(() => {
    const readyAttachments = attachments.filter((attachment) => attachment.status === 'ready');

    if (readyAttachments.length === 0) {
      if (importAttachmentId) {
        setImportAttachmentId('');
      }
      return;
    }

    if (importAttachmentId && readyAttachments.some((attachment) => attachment.id === importAttachmentId)) {
      return;
    }

    setImportAttachmentId(readyAttachments[0]?.id ?? '');
  }, [attachments, importAttachmentId]);

  useEffect(() => {
    if (items.length === 0) {
      if (selectedItemId) {
        setSelectedItemId('');
      }
      return;
    }
    const existing = items.find((item) => item.id === selectedItemId);
    if (existing) {
      return;
    }

    const first = items[0];
    setSelectedItemId(first.id);
    setItemSplit(first.split);
    setItemStatus(first.status);
    setItemMetadataText(metadataToText(first.metadata));
  }, [items, selectedItemId]);

  const uploadDatasetFile = async (filename: string) => {
    if (!datasetId) {
      throw new Error(t('Missing Dataset ID'));
    }

    await api.uploadDatasetAttachment(datasetId, filename);
    await loadDetail('manual');
  };

  const uploadDatasetFiles = async (files: File[]) => {
    if (!datasetId) {
      throw new Error(t('Missing Dataset ID'));
    }

    for (const file of files) {
      await api.uploadDatasetFile(datasetId, file);
    }
    await loadDetail('manual');
  };

  const deleteAttachment = async (attachmentId: string) => {
    await api.removeAttachment(attachmentId);
    await loadDetail('manual');
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

      await loadDetail('manual');
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
      await loadDetail('manual');
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
      await loadDetail('manual');
      setFeedback({
        variant: 'success',
        text: t('Import finished ({format}). imported {imported}, updated {updated}, created items {createdItems}.', {
          format: result.format,
          imported: result.imported,
          updated: result.updated,
          createdItems: result.created_items
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
      await loadDetail('manual');
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

  const createReferenceItem = async () => {
    if (!datasetId) {
      return;
    }
    const normalizedFilename = referenceFilename.trim();
    if (!normalizedFilename) {
      setFeedback({ variant: 'error', text: t('Reference filename is required.') });
      return;
    }

    const metadata = parseMetadataText(referenceMetadataText);

    setBusy(true);
    setFeedback(null);
    try {
      const created = await api.createDatasetItem(datasetId, {
        filename: normalizedFilename,
        split: referenceSplit,
        status: referenceStatus,
        metadata
      });
      await loadDetail('manual');
      setFeedback({
        variant: 'success',
        text: t('Reference item {itemId} created.', { itemId: created.id })
      });
      setReferenceFilename('');
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const selectItemForEditing = (item: DatasetItemRecord) => {
    setSelectedItemId(item.id);
    setItemSplit(item.split);
    setItemStatus(item.status);
    setItemMetadataText(metadataToText(item.metadata));
  };

  const saveItemUpdates = async () => {
    if (!datasetId || !selectedItemId) {
      setFeedback({ variant: 'error', text: t('Select item first.') });
      return;
    }

    const metadata = parseMetadataText(itemMetadataText);
    setBusy(true);
    setFeedback(null);
    try {
      const updated = await api.updateDatasetItem(datasetId, selectedItemId, {
        split: itemSplit,
        status: itemStatus,
        metadata
      });
      await loadDetail('manual');
      setFeedback({
        variant: 'success',
        text: t('Item {itemId} updated.', { itemId: updated.id })
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
        <div className="row gap align-center">
          <button
            type="button"
            className="workspace-inline-button"
            onClick={() => {
              loadDetail('manual').catch((error) => {
                setFeedback({ variant: 'error', text: (error as Error).message });
              });
            }}
            disabled={busy || refreshing}
          >
            {refreshing ? t('Refreshing...') : t('Refresh')}
          </button>
          <Link className="quick-link" to={`/datasets/${dataset.id}/annotate`}>
            {t('Open Annotation Workspace')}
          </Link>
        </div>
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
        description={t('Use this section to import or export annotation files in selected format.')}
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

        <section className="card stack">
          <h4>{t('Reference Dataset Items')}</h4>
          <small className="muted">
            {t('Create metadata-only items when file binary is not uploaded yet.')}
          </small>
          <label>
            {t('Reference Filename')}
            <input
              value={referenceFilename}
              onChange={(event) => setReferenceFilename(event.target.value)}
              placeholder={t('for example: camera-A/frame-001.jpg')}
            />
          </label>
          <div className="three-col">
            <label>
              {t('Item Split')}
              <select
                value={referenceSplit}
                onChange={(event) =>
                  setReferenceSplit(event.target.value as 'train' | 'val' | 'test' | 'unassigned')
                }
              >
                <option value="unassigned">{t('unassigned')}</option>
                <option value="train">{t('train')}</option>
                <option value="val">{t('val')}</option>
                <option value="test">{t('test')}</option>
              </select>
            </label>
            <label>
              {t('Item Status')}
              <select
                value={referenceStatus}
                onChange={(event) =>
                  setReferenceStatus(event.target.value as 'uploading' | 'processing' | 'ready' | 'error')
                }
              >
                <option value="ready">{t('ready')}</option>
                <option value="processing">{t('processing')}</option>
                <option value="uploading">{t('uploading')}</option>
                <option value="error">{t('error')}</option>
              </select>
            </label>
          </div>
          <label>
            {t('Metadata (key=value per line, optional)')}
            <textarea
              value={referenceMetadataText}
              onChange={(event) => setReferenceMetadataText(event.target.value)}
              placeholder={t('for example: source=import_reference')}
              rows={3}
            />
          </label>
          <button onClick={createReferenceItem} disabled={busy}>
            {t('Create Reference Item')}
          </button>
        </section>
      </AdvancedSection>

      <section className="card stack">
        <h3>{t('Dataset Items')}</h3>
        <small className="muted">{t('Ready files: {count}', { count: readyCount })}</small>
        {items.length === 0 ? (
          <StateBlock variant="empty" title={t('No Items')} description={t('Upload dataset files to generate items.')} />
        ) : (
          <div className="stack">
            <section className="card stack tight">
              <h4>{t('Item Editor')}</h4>
              <label>
                {t('Selected Item')}
                <select
                  value={selectedItemId}
                  onChange={(event) => {
                    const nextId = event.target.value;
                    const next = items.find((item) => item.id === nextId);
                    if (!next) {
                      return;
                    }
                    selectItemForEditing(next);
                  }}
                >
                  {items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.id} · {attachmentById.get(item.attachment_id)?.filename ?? item.attachment_id}
                    </option>
                  ))}
                </select>
              </label>
              <div className="three-col">
                <label>
                  {t('Item Split')}
                  <select
                    value={itemSplit}
                    onChange={(event) =>
                      setItemSplit(event.target.value as 'train' | 'val' | 'test' | 'unassigned')
                    }
                  >
                    <option value="unassigned">{t('unassigned')}</option>
                    <option value="train">{t('train')}</option>
                    <option value="val">{t('val')}</option>
                    <option value="test">{t('test')}</option>
                  </select>
                </label>
                <label>
                  {t('Item Status')}
                  <select
                    value={itemStatus}
                    onChange={(event) =>
                      setItemStatus(event.target.value as 'uploading' | 'processing' | 'ready' | 'error')
                    }
                  >
                    <option value="ready">{t('ready')}</option>
                    <option value="processing">{t('processing')}</option>
                    <option value="uploading">{t('uploading')}</option>
                    <option value="error">{t('error')}</option>
                  </select>
                </label>
              </div>
              <label>
                {t('Metadata (key=value per line, optional)')}
                <textarea
                  value={itemMetadataText}
                  onChange={(event) => setItemMetadataText(event.target.value)}
                  placeholder={t('for example: source=import_reference')}
                  rows={3}
                />
              </label>
              <button onClick={saveItemUpdates} disabled={busy || !selectedItemId}>
                {t('Save Item Updates')}
              </button>
              <small className="muted">
                {selectedItem && Object.keys(selectedItem.metadata).length > 0
                  ? t('Current metadata: {metadata}', { metadata: metadataToText(selectedItem.metadata) })
                  : t('No metadata')}
              </small>
            </section>

            <ul className="list">
              {items.map((item) => (
                <li key={item.id} className="list-item">
                  <div className="stack tight">
                    <div className="row between gap">
                      <span>{item.id}</span>
                      <span className="chip">
                        {t(item.split)} · {t(item.status)}
                      </span>
                    </div>
                    <small className="muted">
                      {attachmentById.get(item.attachment_id)?.filename ?? item.attachment_id}
                    </small>
                    <div className="row between gap">
                      <small className="muted">
                        {Object.keys(item.metadata).length > 0
                          ? t('Metadata keys: {count}', { count: Object.keys(item.metadata).length })
                          : t('No metadata')}
                      </small>
                      <button onClick={() => selectItemForEditing(item)} disabled={busy}>
                        {t('Edit Item')}
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
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
