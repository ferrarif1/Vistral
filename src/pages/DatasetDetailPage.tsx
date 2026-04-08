import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import type {
  AnnotationWithReview,
  DatasetItemRecord,
  DatasetRecord,
  DatasetVersionRecord,
  FileAttachment
} from '../../shared/domain';
import AdvancedSection from '../components/AdvancedSection';
import AttachmentUploader from '../components/AttachmentUploader';
import StateBlock from '../components/StateBlock';
import StepIndicator from '../components/StepIndicator';
import VirtualList from '../components/VirtualList';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { Input, Select, Textarea } from '../components/ui/Field';
import { Card, Panel } from '../components/ui/Surface';
import {
  WorkspaceHero,
  WorkspaceMetricGrid,
  WorkspacePage,
  WorkspaceSectionHeader,
  WorkspaceSplit
} from '../components/ui/WorkspacePage';
import {
  filterItemsByAnnotationQueue,
  getAnnotationByItemId,
  summarizeAnnotationQueues,
  type AnnotationQueueFilter
} from '../features/annotationQueue';
import useBackgroundPolling from '../hooks/useBackgroundPolling';
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

const buildAnnotationWorkspacePath = (
  datasetId: string,
  queue: AnnotationQueueFilter,
  itemId?: string
): string => {
  const searchParams = new URLSearchParams();
  if (queue !== 'all') {
    searchParams.set('queue', queue);
  }
  if (itemId) {
    searchParams.set('item', itemId);
  }
  const query = searchParams.toString();
  return query ? `/datasets/${datasetId}/annotate?${query}` : `/datasets/${datasetId}/annotate`;
};

const backgroundRefreshIntervalMs = 5000;

type LoadMode = 'initial' | 'manual' | 'background';
type DatasetDetailSnapshot = {
  dataset: DatasetRecord;
  attachments: FileAttachment[];
  items: DatasetItemRecord[];
  versions: DatasetVersionRecord[];
  annotations: AnnotationWithReview[];
};

const buildDatasetDetailSignature = (detail: {
  dataset: DatasetRecord;
  attachments: FileAttachment[];
  items: DatasetItemRecord[];
  versions: DatasetVersionRecord[];
  annotations: AnnotationWithReview[];
}): string =>
  JSON.stringify({
    dataset: detail.dataset,
    attachments: [...detail.attachments].sort((left, right) => left.id.localeCompare(right.id)),
    items: [...detail.items].sort((left, right) => left.id.localeCompare(right.id)),
    versions: [...detail.versions].sort((left, right) => left.id.localeCompare(right.id)),
    annotations: [...detail.annotations].sort((left, right) => left.id.localeCompare(right.id))
  });

export default function DatasetDetailPage() {
  const { t } = useI18n();
  const steps = useMemo(() => [t('Upload'), t('Split'), t('Version')], [t]);
  const { datasetId } = useParams<{ datasetId: string }>();
  const [dataset, setDataset] = useState<DatasetRecord | null>(null);
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [items, setItems] = useState<DatasetItemRecord[]>([]);
  const [versions, setVersions] = useState<DatasetVersionRecord[]>([]);
  const [annotations, setAnnotations] = useState<AnnotationWithReview[]>([]);
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
  const [sectionRefreshing, setSectionRefreshing] = useState<'attachments' | 'items' | 'versions' | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ variant: 'success' | 'error'; text: string } | null>(null);
  const detailSignatureRef = useRef('');

  const applyDetailSnapshot = useCallback((snapshot: DatasetDetailSnapshot) => {
    const nextSignature = buildDatasetDetailSignature(snapshot);
    if (detailSignatureRef.current !== nextSignature) {
      detailSignatureRef.current = nextSignature;
      setDataset(snapshot.dataset);
      setAttachments(snapshot.attachments);
      setItems(snapshot.items);
      setVersions(snapshot.versions);
      setAnnotations(snapshot.annotations);
    }
  }, []);

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
      const [detail, attachmentList, itemList, versionList, annotationList] = await Promise.all([
        api.getDatasetDetail(datasetId),
        api.listDatasetAttachments(datasetId),
        api.listDatasetItems(datasetId),
        api.listDatasetVersions(datasetId),
        api.listDatasetAnnotations(datasetId)
      ]);

      applyDetailSnapshot({
        dataset: detail.dataset,
        attachments: attachmentList,
        items: itemList,
        versions: versionList,
        annotations: annotationList
      });
    } finally {
      if (mode === 'initial') {
        setLoading(false);
      }

      if (mode === 'manual') {
        setRefreshing(false);
      }
    }
  }, [applyDetailSnapshot, datasetId]);

  useEffect(() => {
    if (!datasetId) {
      setLoading(false);
      return;
    }

    loadDetail('initial')
      .then(() => setFeedback(null))
      .catch((error) => setFeedback({ variant: 'error', text: (error as Error).message }));
  }, [datasetId, loadDetail]);

  const readyCount = useMemo(
    () => attachments.filter((attachment) => attachment.status === 'ready').length,
    [attachments]
  );
  const hasTransientDatasetState = useMemo(
    () =>
      attachments.some((attachment) => attachment.status === 'uploading' || attachment.status === 'processing') ||
      items.some((item) => item.status === 'uploading' || item.status === 'processing') ||
      annotations.some((annotation) => annotation.status === 'in_review'),
    [annotations, attachments, items]
  );
  const attachmentById = useMemo(
    () => new Map(attachments.map((attachment) => [attachment.id, attachment])),
    [attachments]
  );
  const annotationByItemId = useMemo(() => getAnnotationByItemId(annotations), [annotations]);
  const annotationSummary = useMemo(
    () => summarizeAnnotationQueues(items, annotations),
    [annotations, items]
  );
  const formatTimestamp = (value: string | null) => {
    if (!value) {
      return t('n/a');
    }

    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) {
      return value;
    }

    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(parsed));
  };
  const formatCoveragePercent = (value: number) => `${Math.round(value * 100)}%`;
  const selectedItem = useMemo(
    () => items.find((item) => item.id === selectedItemId) ?? null,
    [items, selectedItemId]
  );
  const shouldVirtualizeItemList = items.length > 10;
  const queuePreviewEntries = useMemo(
    () => {
      const needsWorkItems = filterItemsByAnnotationQueue(items, annotations, 'needs_work');
      const inReviewItems = filterItemsByAnnotationQueue(items, annotations, 'in_review');
      const rejectedItems = filterItemsByAnnotationQueue(items, annotations, 'rejected');
      const approvedItems = filterItemsByAnnotationQueue(items, annotations, 'approved');

      return [
        {
          key: 'needs_work' as const,
          label: t('Needs Work'),
          count: annotationSummary.needs_work,
          description: t('Items that still need annotation or submit-review actions.'),
          items: needsWorkItems.slice(0, 3),
          firstItemId: needsWorkItems[0]?.id ?? ''
        },
        {
          key: 'in_review' as const,
          label: t('in_review'),
          count: annotationSummary.in_review,
          description: t('Items waiting for reviewer approval or rejection.'),
          items: inReviewItems.slice(0, 3),
          firstItemId: inReviewItems[0]?.id ?? ''
        },
        {
          key: 'rejected' as const,
          label: t('rejected'),
          count: annotationSummary.rejected,
          description: t('Rejected items keep the latest review reason visible for rework.'),
          items: rejectedItems.slice(0, 3),
          firstItemId: rejectedItems[0]?.id ?? ''
        },
        {
          key: 'approved' as const,
          label: t('approved'),
          count: annotationSummary.approved,
          description: t('Approved items are ready for downstream dataset versioning and training.'),
          items: approvedItems.slice(0, 3),
          firstItemId: approvedItems[0]?.id ?? ''
        }
      ];
    },
    [annotationSummary.approved, annotationSummary.in_review, annotationSummary.needs_work, annotationSummary.rejected, annotations, items, t]
  );
  const prioritizedAnnotationWorkspacePath = useMemo(() => {
    if (!datasetId) {
      return '';
    }

    const queuePriority: AnnotationQueueFilter[] = ['rejected', 'in_review', 'needs_work', 'approved'];
    for (const queue of queuePriority) {
      const entry = queuePreviewEntries.find((item) => item.key === queue);
      if (entry && entry.count > 0) {
        return buildAnnotationWorkspacePath(datasetId, queue, entry.firstItemId);
      }
    }

    return buildAnnotationWorkspacePath(datasetId, 'all');
  }, [datasetId, queuePreviewEntries]);

  useBackgroundPolling(
    () => {
      loadDetail('background').catch(() => {
        // keep UI stable in polling loop
      });
    },
    {
      intervalMs: backgroundRefreshIntervalMs,
      enabled: Boolean(datasetId) && hasTransientDatasetState
    }
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

  const refreshAttachmentSection = useCallback(async () => {
    if (!datasetId || !dataset) {
      return;
    }

    setSectionRefreshing('attachments');
    try {
      const attachmentList = await api.listDatasetAttachments(datasetId);
      applyDetailSnapshot({
        dataset,
        attachments: attachmentList,
        items,
        versions,
        annotations
      });
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setSectionRefreshing(null);
    }
  }, [annotations, applyDetailSnapshot, dataset, datasetId, items, versions]);

  const refreshItemSection = useCallback(async () => {
    if (!datasetId || !dataset) {
      return;
    }

    setSectionRefreshing('items');
    try {
      const itemList = await api.listDatasetItems(datasetId);
      applyDetailSnapshot({
        dataset,
        attachments,
        items: itemList,
        versions,
        annotations
      });
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setSectionRefreshing(null);
    }
  }, [annotations, applyDetailSnapshot, attachments, dataset, datasetId, versions]);

  const refreshVersionSection = useCallback(async () => {
    if (!datasetId || !dataset) {
      return;
    }

    setSectionRefreshing('versions');
    try {
      const versionList = await api.listDatasetVersions(datasetId);
      applyDetailSnapshot({
        dataset,
        attachments,
        items,
        versions: versionList,
        annotations
      });
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setSectionRefreshing(null);
    }
  }, [annotations, applyDetailSnapshot, attachments, dataset, datasetId, items]);

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

  const heroSection = (
    <WorkspaceHero
      eyebrow={t('Dataset Lane')}
      title={t('Dataset Detail')}
      description={
        dataset
          ? `${dataset.name} · ${t(dataset.task_type)} · ${t(dataset.status)}`
          : t('Inspect dataset files, annotation readiness, and version snapshots in one lane.')
      }
      actions={
        dataset ? (
          <div className="row gap wrap">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                loadDetail('manual').catch((error) => {
                  setFeedback({ variant: 'error', text: (error as Error).message });
                });
              }}
              disabled={busy || refreshing}
            >
              {refreshing ? t('Refreshing...') : t('Refresh')}
            </Button>
            <ButtonLink
              size="sm"
              variant="ghost"
              to={prioritizedAnnotationWorkspacePath || `/datasets/${dataset.id}/annotate`}
            >
              {t('Open Annotation Workspace')}
            </ButtonLink>
          </div>
        ) : null
      }
      stats={[
        { label: t('Attachments'), value: attachments.length },
        { label: t('Items'), value: items.length },
        { label: t('Versions'), value: versions.length },
        { label: t('Ready files'), value: readyCount }
      ]}
    />
  );

  const renderShell = (content: ReactNode) => (
    <WorkspacePage>
      {heroSection}
      {content}
    </WorkspacePage>
  );

  if (!datasetId) {
    return renderShell(
      <StateBlock variant="error" title={t('Missing Dataset ID')} description={t('Open from dataset list page.')} />
    );
  }

  if (loading) {
    return renderShell(
      <StateBlock variant="loading" title={t('Loading Dataset')} description={t('Preparing dataset detail view.')} />
    );
  }

  if (!dataset) {
    return renderShell(
      <StateBlock variant="error" title={t('Dataset Not Found')} description={t('The requested dataset is unavailable.')} />
    );
  }

  return (
    <WorkspacePage>
      {heroSection}

      <StepIndicator steps={steps} current={step} />

      {feedback ? (
        <StateBlock
          variant={feedback.variant}
          title={feedback.variant === 'success' ? t('Action Completed') : t('Action Failed')}
          description={feedback.text}
        />
      ) : null}

      <WorkspaceMetricGrid
        items={[
          {
            title: t('Needs Work'),
            description: t('Items that still require annotation or submit-review actions.'),
            value: annotationSummary.needs_work
          },
          {
            title: t('in_review'),
            description: t('Items currently waiting for reviewer decisions.'),
            value: annotationSummary.in_review,
            tone: annotationSummary.in_review > 0 ? 'attention' : 'default'
          },
          {
            title: t('rejected'),
            description: t('Rejected items retain latest review context for focused rework.'),
            value: annotationSummary.rejected,
            tone: annotationSummary.rejected > 0 ? 'attention' : 'default'
          },
          {
            title: t('approved'),
            description: t('Approved items are ready for versioning and training readiness checks.'),
            value: annotationSummary.approved
          }
        ]}
      />

      <WorkspaceSplit
        main={
          <>
          <Card as="section">
            <WorkspaceSectionHeader
              title={t('Annotation Summary')}
              description={t('Review annotation progress and jump directly into the next focused queue.')}
              actions={
                <ButtonLink
                  size="sm"
                  variant="ghost"
                  to={prioritizedAnnotationWorkspacePath || `/datasets/${dataset.id}/annotate`}
                >
                  {t('Open Annotation Workspace')}
                </ButtonLink>
              }
            />

            <div className="annotation-summary-grid">
              {queuePreviewEntries.map((entry) => (
                <Card key={entry.key} as="article" className="annotation-summary-card">
                  <div className="annotation-summary-card-top">
                    <div className="stack tight">
                      <small className="muted">{entry.label}</small>
                      <strong className="metric">{entry.count}</strong>
                    </div>
                    <ButtonLink
                      size="sm"
                      variant="secondary"
                      className="annotation-summary-action-link"
                      to={buildAnnotationWorkspacePath(dataset.id, entry.key, entry.firstItemId)}
                    >
                      {t('Open Queue')}
                    </ButtonLink>
                  </div>
                  <small className="muted">{entry.description}</small>
                  {entry.items.length > 0 ? (
                    <ul className="workspace-record-list compact">
                      {entry.items.map((item) => {
                        const itemAnnotation = annotationByItemId.get(item.id) ?? null;
                        const itemFilename = attachmentById.get(item.attachment_id)?.filename ?? item.attachment_id;
                        return (
                          <Panel key={item.id} as="li" className="workspace-record-item compact" tone="soft">
                            <div className="row between gap wrap">
                              <strong>{itemFilename}</strong>
                              <StatusTag status={itemAnnotation?.status ?? 'draft'}>
                                {t(itemAnnotation?.status ?? 'unannotated')}
                              </StatusTag>
                            </div>
                            {itemAnnotation?.latest_review ? (
                              <div className="row gap wrap">
                                <Badge tone="neutral">
                                  {t('Latest Review')}: {t(itemAnnotation.latest_review.status)}
                                </Badge>
                                {itemAnnotation.latest_review.review_reason_code ? (
                                  <Badge tone="warning">
                                    {t(itemAnnotation.latest_review.review_reason_code)}
                                  </Badge>
                                ) : null}
                              </div>
                            ) : null}
                            <small className="muted">{item.id}</small>
                            {itemAnnotation?.latest_review?.review_comment ? (
                              <small className="muted">{itemAnnotation.latest_review.review_comment}</small>
                            ) : null}
                            <ButtonLink
                              size="sm"
                              variant="ghost"
                              to={buildAnnotationWorkspacePath(dataset.id, entry.key, item.id)}
                            >
                              {t('Open Item')}
                            </ButtonLink>
                          </Panel>
                        );
                      })}
                    </ul>
                  ) : (
                    <small className="muted">{t('No items in this queue right now.')}</small>
                  )}
                </Card>
              ))}
            </div>
          </Card>

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
            headerActions={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  void refreshAttachmentSection();
                }}
                disabled={busy || sectionRefreshing === 'attachments'}
              >
                {sectionRefreshing === 'attachments' ? t('Refreshing...') : t('Refresh')}
              </Button>
            }
          />

          <Card as="section">
            <WorkspaceSectionHeader
              title={t('Dataset Items')}
              actions={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void refreshItemSection();
                  }}
                  disabled={busy || sectionRefreshing === 'items'}
                >
                  {sectionRefreshing === 'items' ? t('Refreshing...') : t('Refresh')}
                </Button>
              }
            />
            <small className="muted">{t('Ready files: {count}', { count: readyCount })}</small>
            {items.length === 0 ? (
              <StateBlock variant="empty" title={t('No Items')} description={t('Upload dataset files to generate items.')} />
            ) : (
              <div className="stack">
                <Panel as="section" className="stack tight" tone="soft">
                  <h4>{t('Item Editor')}</h4>
                  <label>
                    {t('Selected Item')}
                    <Select
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
                    </Select>
                  </label>
                  <div className="three-col">
                    <label>
                      {t('Item Split')}
                      <Select
                        value={itemSplit}
                        onChange={(event) =>
                          setItemSplit(event.target.value as 'train' | 'val' | 'test' | 'unassigned')
                        }
                      >
                        <option value="unassigned">{t('unassigned')}</option>
                        <option value="train">{t('train')}</option>
                        <option value="val">{t('val')}</option>
                        <option value="test">{t('test')}</option>
                      </Select>
                    </label>
                    <label>
                      {t('Item Status')}
                      <Select
                        value={itemStatus}
                        onChange={(event) =>
                          setItemStatus(event.target.value as 'uploading' | 'processing' | 'ready' | 'error')
                        }
                      >
                        <option value="ready">{t('ready')}</option>
                        <option value="processing">{t('processing')}</option>
                        <option value="uploading">{t('uploading')}</option>
                        <option value="error">{t('error')}</option>
                      </Select>
                    </label>
                  </div>
                  <label>
                    {t('Metadata (key=value per line, optional)')}
                    <Textarea
                      value={itemMetadataText}
                      onChange={(event) => setItemMetadataText(event.target.value)}
                      placeholder={t('for example: source=import_reference')}
                      rows={3}
                    />
                  </label>
                  <Button onClick={saveItemUpdates} disabled={busy || !selectedItemId}>
                    {t('Save Item Updates')}
                  </Button>
                  <small className="muted">
                    {selectedItem && Object.keys(selectedItem.metadata).length > 0
                      ? t('Current metadata: {metadata}', { metadata: metadataToText(selectedItem.metadata) })
                      : t('No metadata')}
                  </small>
                </Panel>

                {shouldVirtualizeItemList ? (
                  <VirtualList
                    items={items}
                    itemHeight={96}
                    height={420}
                    ariaLabel={t('Dataset Items')}
                    listClassName="workspace-record-list"
                    itemKey={(item) => item.id}
                    renderItem={(item) => (
                      <div className="workspace-record-item virtualized">
                        <div className="stack tight">
                          <div className="row between gap wrap">
                            <strong>{attachmentById.get(item.attachment_id)?.filename ?? item.attachment_id}</strong>
                            <div className="row gap wrap">
                              <Badge tone="neutral">{t(item.split)}</Badge>
                              <StatusTag status={item.status}>{t(item.status)}</StatusTag>
                            </div>
                          </div>
                          <small className="muted">{item.id}</small>
                          <div className="row between gap wrap">
                            <small className="muted">
                              {Object.keys(item.metadata).length > 0
                                ? t('Metadata keys: {count}', { count: Object.keys(item.metadata).length })
                                : t('No metadata')}
                            </small>
                            <Button size="sm" variant="ghost" onClick={() => selectItemForEditing(item)} disabled={busy}>
                              {t('Edit Item')}
                            </Button>
                          </div>
                        </div>
                      </div>
                    )}
                  />
                ) : (
                  <ul className="workspace-record-list">
                    {items.map((item) => (
                      <Panel key={item.id} as="li" className="workspace-record-item" tone="soft">
                        <div className="stack tight">
                          <div className="row between gap wrap">
                            <strong>{attachmentById.get(item.attachment_id)?.filename ?? item.attachment_id}</strong>
                            <div className="row gap wrap">
                              <Badge tone="neutral">{t(item.split)}</Badge>
                              <StatusTag status={item.status}>{t(item.status)}</StatusTag>
                            </div>
                          </div>
                          <small className="muted">{item.id}</small>
                          <div className="row between gap wrap">
                            <small className="muted">
                              {Object.keys(item.metadata).length > 0
                                ? t('Metadata keys: {count}', { count: Object.keys(item.metadata).length })
                                : t('No metadata')}
                            </small>
                            <Button size="sm" variant="ghost" onClick={() => selectItemForEditing(item)} disabled={busy}>
                              {t('Edit Item')}
                            </Button>
                          </div>
                        </div>
                      </Panel>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </Card>
          </>
        }
        side={
          <>
          <Card as="section">
            <WorkspaceSectionHeader
              title={t('Step 2. Train/Val/Test Split')}
              description={t('Adjust split ratios and apply when the dataset item set is ready.')}
            />
            <label>
              {t('Train Ratio')}
              <Input value={splitTrain} onChange={(event) => setSplitTrain(event.target.value)} />
            </label>
            <label>
              {t('Val Ratio')}
              <Input value={splitVal} onChange={(event) => setSplitVal(event.target.value)} />
            </label>
            <label>
              {t('Test Ratio')}
              <Input value={splitTest} onChange={(event) => setSplitTest(event.target.value)} />
            </label>
            <Button onClick={runSplit} disabled={busy || items.length === 0}>
              {t('Apply Split')}
            </Button>
          </Card>

          <Card as="section">
            <WorkspaceSectionHeader
              title={t('Step 3. Dataset Version')}
              description={t('Create immutable snapshots before training so runs stay reproducible.')}
            />
            <label>
              {t('Version Name (optional)')}
              <Input
                value={versionName}
                onChange={(event) => setVersionName(event.target.value)}
                placeholder={t('for example: v2')}
              />
            </label>
            <Button onClick={createVersion} disabled={busy || items.length === 0}>
              {t('Create Version Snapshot')}
            </Button>
          </Card>

          <AdvancedSection
            title={t('Annotation Import / Export')}
            description={t('Use this section to import or export annotation files in selected format.')}
          >
            <Card as="section">
              <h4>{t('Import Annotations')}</h4>
              <label>
                {t('Format')}
                <Select
                  value={importFormat}
                  onChange={(event) =>
                    setImportFormat(event.target.value as 'yolo' | 'coco' | 'labelme' | 'ocr')
                  }
                >
                  <option value="yolo">{t('yolo')}</option>
                  <option value="coco">{t('coco')}</option>
                  <option value="labelme">{t('labelme')}</option>
                  <option value="ocr">{t('ocr')}</option>
                </Select>
              </label>
              <label>
                {t('Source Attachment')}
                <Select
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
                </Select>
              </label>
              <Button onClick={importAnnotations} disabled={busy || !importAttachmentId}>
                {t('Run Import')}
              </Button>
            </Card>

            <Card as="section">
              <h4>{t('Export Annotations')}</h4>
              <label>
                {t('Format')}
                <Select
                  value={exportFormat}
                  onChange={(event) =>
                    setExportFormat(event.target.value as 'yolo' | 'coco' | 'labelme' | 'ocr')
                  }
                >
                  <option value="yolo">{t('yolo')}</option>
                  <option value="coco">{t('coco')}</option>
                  <option value="labelme">{t('labelme')}</option>
                  <option value="ocr">{t('ocr')}</option>
                </Select>
              </label>
              <Button onClick={exportAnnotations} disabled={busy}>
                {t('Run Export')}
              </Button>
            </Card>

            <Card as="section">
              <h4>{t('Reference Dataset Items')}</h4>
              <small className="muted">
                {t('Create metadata-only items when file binary is not uploaded yet.')}
              </small>
              <label>
                {t('Reference Filename')}
                <Input
                  value={referenceFilename}
                  onChange={(event) => setReferenceFilename(event.target.value)}
                  placeholder={t('for example: camera-A/frame-001.jpg')}
                />
              </label>
              <label>
                {t('Item Split')}
                <Select
                  value={referenceSplit}
                  onChange={(event) =>
                    setReferenceSplit(event.target.value as 'train' | 'val' | 'test' | 'unassigned')
                  }
                >
                  <option value="unassigned">{t('unassigned')}</option>
                  <option value="train">{t('train')}</option>
                  <option value="val">{t('val')}</option>
                  <option value="test">{t('test')}</option>
                </Select>
              </label>
              <label>
                {t('Item Status')}
                <Select
                  value={referenceStatus}
                  onChange={(event) =>
                    setReferenceStatus(event.target.value as 'uploading' | 'processing' | 'ready' | 'error')
                  }
                >
                  <option value="ready">{t('ready')}</option>
                  <option value="processing">{t('processing')}</option>
                  <option value="uploading">{t('uploading')}</option>
                  <option value="error">{t('error')}</option>
                </Select>
              </label>
              <label>
                {t('Metadata (key=value per line, optional)')}
                <Textarea
                  value={referenceMetadataText}
                  onChange={(event) => setReferenceMetadataText(event.target.value)}
                  placeholder={t('for example: source=import_reference')}
                  rows={3}
                />
              </label>
              <Button onClick={createReferenceItem} disabled={busy}>
                {t('Create Reference Item')}
              </Button>
            </Card>
          </AdvancedSection>

          <Card as="section">
            <WorkspaceSectionHeader
              title={t('Dataset Versions')}
              actions={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void refreshVersionSection();
                  }}
                  disabled={busy || sectionRefreshing === 'versions'}
                >
                  {sectionRefreshing === 'versions' ? t('Refreshing...') : t('Refresh')}
                </Button>
              }
            />
            {versions.length === 0 ? (
              <StateBlock variant="empty" title={t('No Versions')} description={t('Create first version snapshot after split.')} />
            ) : (
              <ul className="workspace-record-list compact">
                {versions.map((version) => (
                  <Panel key={version.id} as="li" className="workspace-record-item compact stack tight" tone="soft">
                    <div className="row between gap wrap align-center">
                      <strong>{version.version_name}</strong>
                      <Badge tone="neutral">{formatTimestamp(version.created_at)}</Badge>
                    </div>
                    <div className="row gap wrap">
                      <Badge tone="neutral">{t('Items')}: {version.item_count}</Badge>
                      <Badge tone="info">{t('Coverage')}: {formatCoveragePercent(version.annotation_coverage)}</Badge>
                      <Badge tone="neutral">
                        {t('train')} {version.split_summary.train} / {t('val')} {version.split_summary.val} / {t('test')} {version.split_summary.test}
                      </Badge>
                    </div>
                    <small className="muted">{version.id}</small>
                  </Panel>
                ))}
              </ul>
            )}
          </Card>
          </>
        }
      />
    </WorkspacePage>
  );
}
