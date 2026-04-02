import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FileAttachment, ModelRecord } from '../../shared/domain';
import AdvancedSection from '../components/AdvancedSection';
import AttachmentUploader from '../components/AttachmentUploader';
import StateBlock from '../components/StateBlock';
import StepIndicator from '../components/StepIndicator';
import { api } from '../services/api';

const STEPS = ['Metadata', 'Model File', 'Parameters', 'Review'];

export default function CreateModelPage() {
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [modelType, setModelType] = useState<
    'ocr' | 'detection' | 'classification' | 'segmentation' | 'obb'
  >('classification');
  const [visibility, setVisibility] = useState<'private' | 'workspace' | 'public'>('private');
  const [draftModel, setDraftModel] = useState<ModelRecord | null>(null);
  const [modelFiles, setModelFiles] = useState<FileAttachment[]>([]);
  const [learningRate, setLearningRate] = useState('0.001');
  const [batchSize, setBatchSize] = useState('16');
  const [enableEarlyStop, setEnableEarlyStop] = useState(true);
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<{ variant: 'success' | 'error'; text: string } | null>(null);

  const refreshModelFiles = useCallback(async () => {
    if (!draftModel) {
      setModelFiles([]);
      return;
    }

    const files = await api.listModelAttachments(draftModel.id);
    setModelFiles(files);
  }, [draftModel]);

  useEffect(() => {
    refreshModelFiles().catch(() => {
      // Keep page usable; explicit actions report errors via feedback block.
    });
  }, [refreshModelFiles]);

  useEffect(() => {
    if (!draftModel) {
      return;
    }

    const timer = window.setInterval(() => {
      refreshModelFiles().catch(() => {
        // No-op in poll loop.
      });
    }, 500);

    return () => window.clearInterval(timer);
  }, [draftModel, refreshModelFiles]);

  const readyFileCount = useMemo(
    () => modelFiles.filter((file) => file.status === 'ready').length,
    [modelFiles]
  );

  const createDraft = async () => {
    if (!name.trim() || !description.trim()) {
      setFeedback({ variant: 'error', text: 'Name and description are required before creating a draft.' });
      return;
    }

    setLoading(true);
    setFeedback(null);

    try {
      const created = await api.createModelDraft({
        name: name.trim(),
        description: description.trim(),
        model_type: modelType,
        visibility
      });

      setDraftModel(created);
      setStep(1);
      setFeedback({ variant: 'success', text: `Draft ${created.id} created. Continue with model file upload.` });
      await refreshModelFiles();
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setLoading(false);
    }
  };

  const onUploadModelFile = async (filename: string) => {
    if (!draftModel) {
      throw new Error('Create metadata draft first.');
    }
    await api.uploadModelAttachment(draftModel.id, filename);
    await refreshModelFiles();
  };

  const onDeleteModelFile = async (attachmentId: string) => {
    await api.removeAttachment(attachmentId);
    await refreshModelFiles();
  };

  const nextStep = async () => {
    if (step === 0) {
      await createDraft();
      return;
    }

    if (step === 1 && readyFileCount === 0) {
      setFeedback({
        variant: 'error',
        text: 'Upload at least one ready model file before proceeding.'
      });
      return;
    }

    if (step < STEPS.length - 1) {
      setStep((value) => value + 1);
      setFeedback(null);
    }
  };

  const previousStep = () => {
    if (step > 0) {
      setStep((value) => value - 1);
      setFeedback(null);
    }
  };

  const submitApproval = async () => {
    if (!draftModel) {
      setFeedback({ variant: 'error', text: 'Draft model is missing.' });
      return;
    }

    setLoading(true);
    setFeedback(null);

    try {
      const request = await api.submitApprovalRequest({
        model_id: draftModel.id,
        review_notes: 'Round-1 mock submission from create wizard.',
        parameter_snapshot: {
          learning_rate: learningRate,
          batch_size: batchSize,
          early_stop: enableEarlyStop ? 'true' : 'false'
        }
      });

      setDraftModel({ ...draftModel, status: 'pending_approval' });
      setFeedback({
        variant: 'success',
        text: `Approval request ${request.id} submitted. Model status is now pending_approval.`
      });
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="stack page-width">
      <h2>Create Model</h2>
      <StepIndicator steps={STEPS} current={step} />

      {feedback ? (
        <StateBlock
          variant={feedback.variant}
          title={feedback.variant === 'success' ? 'Action Completed' : 'Action Failed'}
          description={feedback.text}
        />
      ) : null}

      {step === 0 ? (
        <section className="card stack">
          <h3>Step 1. Metadata</h3>
          <label>
            Model Name
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            Description
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={4}
            />
          </label>
          <label>
            Model Type
            <select
              value={modelType}
              onChange={(event) =>
                setModelType(
                  event.target.value as
                    | 'ocr'
                    | 'detection'
                    | 'classification'
                    | 'segmentation'
                    | 'obb'
                )
              }
            >
              <option value="ocr">ocr</option>
              <option value="classification">classification</option>
              <option value="detection">detection</option>
              <option value="segmentation">segmentation</option>
              <option value="obb">obb</option>
            </select>
          </label>
          <label>
            Visibility
            <select
              value={visibility}
              onChange={(event) =>
                setVisibility(event.target.value as 'private' | 'workspace' | 'public')
              }
            >
              <option value="private">private</option>
              <option value="workspace">workspace</option>
              <option value="public">public</option>
            </select>
          </label>
        </section>
      ) : null}

      {step === 1 ? (
        <AttachmentUploader
          title="Step 2. Model File Upload"
          items={modelFiles}
          onUpload={onUploadModelFile}
          onDelete={onDeleteModelFile}
          emptyDescription="Upload model artifact files here. Status will transition from uploading to ready."
          uploadButtonLabel="Upload Model File"
          disabled={loading}
        />
      ) : null}

      {step === 2 ? (
        <section className="stack">
          <section className="card stack">
            <h3>Step 3. Parameters</h3>
            <label>
              Learning Rate
              <input value={learningRate} onChange={(event) => setLearningRate(event.target.value)} />
            </label>
            <label>
              Batch Size
              <input value={batchSize} onChange={(event) => setBatchSize(event.target.value)} />
            </label>
          </section>
          <AdvancedSection>
            <label className="row gap align-center">
              <input
                type="checkbox"
                checked={enableEarlyStop}
                onChange={(event) => setEnableEarlyStop(event.target.checked)}
              />
              Enable early stop
            </label>
            <label>
              Warmup Ratio
              <input defaultValue="0.1" />
            </label>
            <label>
              Weight Decay
              <input defaultValue="0.0001" />
            </label>
          </AdvancedSection>
        </section>
      ) : null}

      {step === 3 ? (
        <section className="card stack">
          <h3>Step 4. Review and Submit</h3>
          {draftModel ? (
            <>
              <p>
                <strong>{draftModel.name}</strong> ({draftModel.model_type})
              </p>
              <p>{draftModel.description}</p>
              <p className="muted">
                Visibility: {draftModel.visibility} · Ready model files: {readyFileCount}
              </p>
              <p className="muted">
                Parameters: learning rate {learningRate}, batch size {batchSize}, early stop{' '}
                {enableEarlyStop ? 'enabled' : 'disabled'}.
              </p>
            </>
          ) : (
            <StateBlock
              variant="empty"
              title="Missing Draft"
              description="Go back to metadata step and create draft first."
            />
          )}
        </section>
      ) : null}

      <div className="row gap">
        <button onClick={previousStep} disabled={step === 0 || loading}>
          Back
        </button>
        <button onClick={nextStep} disabled={step === STEPS.length - 1 || loading}>
          Next
        </button>
        <button onClick={submitApproval} disabled={step !== STEPS.length - 1 || loading}>
          {loading ? 'Submitting...' : 'Submit Approval'}
        </button>
      </div>
    </div>
  );
}
