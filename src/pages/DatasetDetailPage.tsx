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
import { api } from '../services/api';

const STEPS = ['Upload', 'Split', 'Version'];

export default function DatasetDetailPage() {
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
      throw new Error('Missing dataset id.');
    }

    await api.uploadDatasetAttachment(datasetId, filename);
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
        throw new Error('Split ratios must sum to 1.0.');
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
      setFeedback({ variant: 'success', text: 'Dataset split updated successfully.' });
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
      setFeedback({ variant: 'success', text: `Dataset version ${created.version_name} created.` });
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
      setFeedback({ variant: 'error', text: 'Select a ready dataset attachment as import source.' });
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
        text: `Import finished (${result.format}). imported ${result.imported}, updated ${result.updated}.`
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
        text: `Export ready (${result.format}). file ${result.filename}, records ${result.exported}.`
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
        <h2>Dataset Detail</h2>
        <StateBlock variant="error" title="Missing Dataset ID" description="Open from dataset list page." />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="stack">
        <h2>Dataset Detail</h2>
        <StateBlock variant="loading" title="Loading Dataset" description="Preparing dataset detail view." />
      </div>
    );
  }

  if (!dataset) {
    return (
      <div className="stack">
        <h2>Dataset Detail</h2>
        <StateBlock variant="error" title="Dataset Not Found" description="The requested dataset is unavailable." />
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="row between gap align-center">
        <div className="stack tight">
          <h2>Dataset Detail</h2>
          <p className="muted">
            {dataset.name} · {dataset.task_type} · {dataset.status}
          </p>
        </div>
        <Link className="quick-link" to={`/datasets/${dataset.id}/annotate`}>
          Open Annotation Workspace
        </Link>
      </div>

      <StepIndicator steps={STEPS} current={step} />

      {feedback ? (
        <StateBlock
          variant={feedback.variant}
          title={feedback.variant === 'success' ? 'Action Completed' : 'Action Failed'}
          description={feedback.text}
        />
      ) : null}

      <AttachmentUploader
        title="Step 1. Dataset File Upload"
        items={attachments}
        onUpload={uploadDatasetFile}
        onDelete={deleteAttachment}
        emptyDescription="Upload images or archives. Files stay visible for this dataset context."
        uploadButtonLabel="Upload Dataset File"
        disabled={busy}
      />

      <section className="card stack">
        <h3>Step 2. Train/Val/Test Split</h3>
        <div className="three-col">
          <label>
            Train Ratio
            <input value={splitTrain} onChange={(event) => setSplitTrain(event.target.value)} />
          </label>
          <label>
            Val Ratio
            <input value={splitVal} onChange={(event) => setSplitVal(event.target.value)} />
          </label>
          <label>
            Test Ratio
            <input value={splitTest} onChange={(event) => setSplitTest(event.target.value)} />
          </label>
        </div>
        <button onClick={runSplit} disabled={busy || items.length === 0}>
          Apply Split
        </button>
      </section>

      <section className="card stack">
        <h3>Step 3. Dataset Version</h3>
        <label>
          Version Name (optional)
          <input
            value={versionName}
            onChange={(event) => setVersionName(event.target.value)}
            placeholder="v2"
          />
        </label>
        <button onClick={createVersion} disabled={busy || items.length === 0}>
          Create Version Snapshot
        </button>
      </section>

      <AdvancedSection
        title="Annotation Import / Export"
        description="Use this section to run minimal import/export stubs with format selection."
      >
        <section className="card stack">
          <h4>Import Annotations</h4>
          <label>
            Format
            <select
              value={importFormat}
              onChange={(event) =>
                setImportFormat(event.target.value as 'yolo' | 'coco' | 'labelme' | 'ocr')
              }
            >
              <option value="yolo">yolo</option>
              <option value="coco">coco</option>
              <option value="labelme">labelme</option>
              <option value="ocr">ocr</option>
            </select>
          </label>
          <label>
            Source Attachment
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
            Run Import
          </button>
        </section>

        <section className="card stack">
          <h4>Export Annotations</h4>
          <label>
            Format
            <select
              value={exportFormat}
              onChange={(event) =>
                setExportFormat(event.target.value as 'yolo' | 'coco' | 'labelme' | 'ocr')
              }
            >
              <option value="yolo">yolo</option>
              <option value="coco">coco</option>
              <option value="labelme">labelme</option>
              <option value="ocr">ocr</option>
            </select>
          </label>
          <button onClick={exportAnnotations} disabled={busy}>
            Run Export
          </button>
        </section>
      </AdvancedSection>

      <section className="card stack">
        <h3>Dataset Items</h3>
        <small className="muted">Ready files: {readyCount}</small>
        {items.length === 0 ? (
          <StateBlock variant="empty" title="No Items" description="Upload dataset files to generate items." />
        ) : (
          <ul className="list">
            {items.map((item) => (
              <li key={item.id} className="list-item">
                <div className="row between gap">
                  <span>{item.id}</span>
                  <span className="chip">
                    {item.split} · {item.status}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card stack">
        <h3>Dataset Versions</h3>
        {versions.length === 0 ? (
          <StateBlock variant="empty" title="No Versions" description="Create first version snapshot after split." />
        ) : (
          <ul className="list">
            {versions.map((version) => (
              <li key={version.id} className="list-item stack tight">
                <strong>{version.version_name}</strong>
                <small className="muted">
                  items {version.item_count} · coverage {version.annotation_coverage}
                </small>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
