import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { FileAttachment, ModelRecord } from '../../shared/domain';
import AdvancedSection from '../components/AdvancedSection';
import AttachmentUploader from '../components/AttachmentUploader';
import StateBlock from '../components/StateBlock';
import StepIndicator from '../components/StepIndicator';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

const backgroundRefreshIntervalMs = 5000;

const buildModelFilesSignature = (modelId: string | null, files: FileAttachment[]): string =>
  JSON.stringify({
    model_id: modelId,
    files: [...files]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((file) => ({
        id: file.id,
        filename: file.filename,
        status: file.status,
        updated_at: file.updated_at,
        upload_error: file.upload_error
      }))
  });

export default function CreateModelPage() {
  const { t } = useI18n();
  const steps = useMemo(() => [t('Metadata'), t('Model File'), t('Parameters'), t('Review')], [t]);
  const stepTitles = useMemo(
    () => [t('Step 1. Metadata'), t('Step 2. Model File Upload'), t('Step 3. Parameters'), t('Step 4. Review and Submit')],
    [t]
  );
  const stepDescriptions = useMemo(
    () => [
      t('Complete metadata to create the first draft shell.'),
      t('Upload at least one ready artifact before moving on.'),
      t('Tune the release parameters with advanced values collapsed by default.'),
      t('Review metadata, files, and parameter snapshot before approval submission.')
    ],
    [t]
  );

  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [modelType, setModelType] = useState<'ocr' | 'detection' | 'classification' | 'segmentation' | 'obb'>('classification');
  const [visibility, setVisibility] = useState<'private' | 'workspace' | 'public'>('private');
  const [draftModel, setDraftModel] = useState<ModelRecord | null>(null);
  const [modelFiles, setModelFiles] = useState<FileAttachment[]>([]);
  const [learningRate, setLearningRate] = useState('0.001');
  const [batchSize, setBatchSize] = useState('16');
  const [enableEarlyStop, setEnableEarlyStop] = useState(true);
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<{ variant: 'success' | 'error'; text: string } | null>(null);
  const modelFilesSignatureRef = useRef(buildModelFilesSignature(null, []));

  const refreshModelFiles = useCallback(async () => {
    if (!draftModel) {
      const emptySignature = buildModelFilesSignature(null, []);
      if (modelFilesSignatureRef.current !== emptySignature) {
        modelFilesSignatureRef.current = emptySignature;
        setModelFiles([]);
      }
      return;
    }

    const files = await api.listModelAttachments(draftModel.id);
    const nextSignature = buildModelFilesSignature(draftModel.id, files);
    if (modelFilesSignatureRef.current !== nextSignature) {
      modelFilesSignatureRef.current = nextSignature;
      setModelFiles(files);
    }
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
    }, backgroundRefreshIntervalMs);

    return () => window.clearInterval(timer);
  }, [draftModel, refreshModelFiles]);

  const readyFileCount = useMemo(() => modelFiles.filter((file) => file.status === 'ready').length, [modelFiles]);
  const draftStatusLabel = draftModel ? t(draftModel.status) : t('not started');

  const createDraft = async () => {
    if (!name.trim() || !description.trim()) {
      setFeedback({ variant: 'error', text: t('Name and description are required before creating a draft.') });
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
      setFeedback({
        variant: 'success',
        text: t('Draft {draftId} created. Continue with model file upload.', { draftId: created.id })
      });
      await refreshModelFiles();
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setLoading(false);
    }
  };

  const onUploadModelFile = async (filename: string) => {
    if (!draftModel) {
      throw new Error(t('Create metadata draft first.'));
    }

    await api.uploadModelAttachment(draftModel.id, filename);
    await refreshModelFiles();
  };

  const onUploadModelFiles = async (files: File[]) => {
    if (!draftModel) {
      throw new Error(t('Create metadata draft first.'));
    }

    for (const file of files) {
      await api.uploadModelFile(draftModel.id, file);
    }

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
        text: t('Upload at least one ready model file before proceeding.')
      });
      return;
    }

    if (step < steps.length - 1) {
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
      setFeedback({ variant: 'error', text: t('Draft model is missing.') });
      return;
    }

    setLoading(true);
    setFeedback(null);

    try {
      const request = await api.submitApprovalRequest({
        model_id: draftModel.id,
        review_notes: t('Round-1 mock submission from create wizard.'),
        parameter_snapshot: {
          learning_rate: learningRate,
          batch_size: batchSize,
          early_stop: enableEarlyStop ? 'true' : 'false'
        }
      });

      setDraftModel({ ...draftModel, status: 'pending_approval' });
      setFeedback({
        variant: 'success',
        text: t('Approval request {requestId} submitted. Model status is now pending_approval.', {
          requestId: request.id
        })
      });
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setLoading(false);
    }
  };

  const checklist = [
    {
      label: t('Metadata ready'),
      done: Boolean(name.trim() && description.trim()),
      hint: t('Create the metadata shell first, then upload model artifacts in the next step.')
    },
    {
      label: t('Ready model files'),
      done: readyFileCount > 0,
      hint: t('Ready model files attached.')
    },
    {
      label: t('Parameter snapshot'),
      done: Boolean(learningRate && batchSize),
      hint: t('Parameter snapshot prepared.')
    },
    {
      label: t('Approval gate'),
      done: step === steps.length - 1 && Boolean(draftModel) && readyFileCount > 0,
      hint: t('Approval can be submitted from the final review step.')
    }
  ];

  const renderStage = () => {
    if (step === 0) {
      return (
        <section className="card stack">
          <div className="stack tight">
            <h3>{stepTitles[step]}</h3>
            <small className="muted">{stepDescriptions[step]}</small>
          </div>
          <div className="workspace-form-grid">
            <label className="workspace-form-span-2">
              {t('Model Name')}
              <input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="workspace-form-span-2">
              {t('Description')}
              <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} />
            </label>
            <label>
              {t('Model Type')}
              <select
                value={modelType}
                onChange={(event) =>
                  setModelType(
                    event.target.value as 'ocr' | 'detection' | 'classification' | 'segmentation' | 'obb'
                  )
                }
              >
                <option value="ocr">{t('ocr')}</option>
                <option value="classification">{t('classification')}</option>
                <option value="detection">{t('detection')}</option>
                <option value="segmentation">{t('segmentation')}</option>
                <option value="obb">{t('obb')}</option>
              </select>
            </label>
            <label>
              {t('Visibility')}
              <select
                value={visibility}
                onChange={(event) => setVisibility(event.target.value as 'private' | 'workspace' | 'public')}
              >
                <option value="private">{t('private')}</option>
                <option value="workspace">{t('workspace')}</option>
                <option value="public">{t('public')}</option>
              </select>
            </label>
          </div>
        </section>
      );
    }

    if (step === 1) {
      return (
        <AttachmentUploader
          title={stepTitles[step]}
          items={modelFiles}
          onUpload={onUploadModelFile}
          onUploadFiles={onUploadModelFiles}
          contentUrlBuilder={api.attachmentContentUrl}
          onDelete={onDeleteModelFile}
          emptyDescription={t('Upload model artifact files here. Status will transition from uploading to ready.')}
          uploadButtonLabel={t('Upload Model File')}
          disabled={loading}
        />
      );
    }

    if (step === 2) {
      return (
        <section className="stack">
          <section className="card stack">
            <div className="stack tight">
              <h3>{stepTitles[step]}</h3>
              <small className="muted">{stepDescriptions[step]}</small>
            </div>
            <div className="workspace-form-grid">
              <label>
                {t('Learning Rate')}
                <input value={learningRate} onChange={(event) => setLearningRate(event.target.value)} />
              </label>
              <label>
                {t('Batch Size')}
                <input value={batchSize} onChange={(event) => setBatchSize(event.target.value)} />
              </label>
            </div>
          </section>
          <AdvancedSection>
            <label className="row gap align-center">
              <input
                type="checkbox"
                checked={enableEarlyStop}
                onChange={(event) => setEnableEarlyStop(event.target.checked)}
              />
              {t('Enable early stop')}
            </label>
            <label>
              {t('Warmup Ratio')}
              <input defaultValue="0.1" />
            </label>
            <label>
              {t('Weight Decay')}
              <input defaultValue="0.0001" />
            </label>
          </AdvancedSection>
        </section>
      );
    }

    return (
      <section className="card stack">
        <div className="stack tight">
          <h3>{stepTitles[step]}</h3>
          <small className="muted">{stepDescriptions[step]}</small>
        </div>
        {draftModel ? (
          <ul className="workspace-record-list compact">
            <li className="workspace-record-item compact">
              <div className="row between gap wrap">
                <strong>{draftModel.name}</strong>
                <span className={`workspace-status-pill ${draftModel.status}`}>{t(draftModel.status)}</span>
              </div>
              <small className="muted">{draftModel.description}</small>
            </li>
            <li className="workspace-record-item compact">
              <div className="row between gap wrap">
                <strong>{t('Visibility')}</strong>
                <span className="chip">{t(draftModel.visibility)}</span>
              </div>
              <small className="muted">
                {t('Model Type')}: {t(draftModel.model_type)}
              </small>
            </li>
            <li className="workspace-record-item compact">
              <div className="row between gap wrap">
                <strong>{t('Ready model files')}</strong>
                <span className="chip">{readyFileCount}</span>
              </div>
              <small className="muted">
                {t('Parameters')}: {t('learning rate')} {learningRate}, {t('batch size')} {batchSize}, {t('early stop')}{' '}
                {enableEarlyStop ? t('enabled') : t('disabled')}
              </small>
            </li>
          </ul>
        ) : (
          <StateBlock
            variant="empty"
            title={t('Missing Draft')}
            description={t('Go back to metadata step and create draft first.')}
          />
        )}
      </section>
    );
  };

  return (
    <div className="workspace-overview-page stack">
      <section className="card workspace-overview-hero">
        <div className="workspace-overview-hero-grid">
          <div className="workspace-overview-copy stack">
            <small className="workspace-eyebrow">{t('Model Draft Studio')}</small>
            <h1>{t('Create Model')}</h1>
            <p className="muted">
              {t('Move from metadata shell to approval-ready artifact package with a calmer guided flow.')}
            </p>
          </div>
          <div className="workspace-overview-badges">
            <div className="workspace-overview-badge">
              <span>{t('Current step')}</span>
              <strong>
                {step + 1}/{steps.length}
              </strong>
            </div>
            <div className="workspace-overview-badge">
              <span>{t('Ready model files')}</span>
              <strong>{readyFileCount}</strong>
            </div>
            <div className="workspace-overview-badge">
              <span>{t('Draft status')}</span>
              <strong>{draftStatusLabel}</strong>
            </div>
          </div>
        </div>
      </section>

      {feedback ? (
        <StateBlock
          variant={feedback.variant}
          title={feedback.variant === 'success' ? t('Action Completed') : t('Action Failed')}
          description={feedback.text}
        />
      ) : null}

      <section className="workspace-overview-signal-grid">
        <article className="card stack workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Draft shell')}</h3>
            <small className="muted">{t('Metadata shell for the model record.')}</small>
          </div>
          <strong className="metric">{draftModel ? 1 : 0}</strong>
        </article>
        <article className="card stack workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Ready model files')}</h3>
            <small className="muted">{t('Artifacts already ready for review and approval flow.')}</small>
          </div>
          <strong className="metric">{readyFileCount}</strong>
        </article>
        <article className="card stack workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Visibility')}</h3>
            <small className="muted">{t('Current exposure setting for this draft.')}</small>
          </div>
          <strong className="metric">{t(draftModel?.visibility ?? visibility)}</strong>
        </article>
        <article className={`card stack workspace-signal-card${step === steps.length - 1 && readyFileCount > 0 ? '' : ' attention'}`}>
          <div className="workspace-signal-top">
            <h3>{t('Submission readiness')}</h3>
            <small className="muted">{t('The final review step is where approval submission becomes available.')}</small>
          </div>
          <strong className="metric">{step === steps.length - 1 && readyFileCount > 0 ? t('Ready') : t('draft')}</strong>
        </article>
      </section>

      <section className="workspace-overview-panel-grid">
        <div className="workspace-overview-main">
          <StepIndicator steps={steps} current={step} />
          {renderStage()}
        </div>

        <div className="workspace-overview-side">
          <article className="card stack">
            <div className="stack tight">
              <h3>{t('Current draft')}</h3>
              <small className="muted">{stepDescriptions[step]}</small>
            </div>
            {draftModel ? (
              <ul className="workspace-record-list compact">
                <li className="workspace-record-item compact">
                  <div className="row between gap wrap">
                    <strong>{draftModel.name}</strong>
                    <span className={`workspace-status-pill ${draftModel.status}`}>{t(draftModel.status)}</span>
                  </div>
                  <small className="muted">
                    {t('Model Type')}: {t(draftModel.model_type)}
                  </small>
                </li>
                <li className="workspace-record-item compact">
                  <div className="row between gap wrap">
                    <strong>{t('Visibility')}</strong>
                    <span className="chip">{t(draftModel.visibility)}</span>
                  </div>
                  <small className="muted">{draftModel.id}</small>
                </li>
              </ul>
            ) : (
              <StateBlock
                variant="empty"
                title={t('No draft yet.')}
                description={t('Create the metadata shell first, then upload model artifacts in the next step.')}
              />
            )}
          </article>

          <article className="card stack">
            <div className="stack tight">
              <h3>{t('Submission checklist')}</h3>
              <small className="muted">{t('Keep the approval path visible while you finish the wizard.')}</small>
            </div>
            <ul className="workspace-record-list compact">
              {checklist.map((item) => (
                <li key={item.label} className="workspace-record-item compact">
                  <div className="row between gap wrap">
                    <strong>{item.label}</strong>
                    <span className={`workspace-status-pill ${item.done ? 'ready' : 'draft'}`}>
                      {item.done ? t('Ready') : t('draft')}
                    </span>
                  </div>
                  <small className="muted">{item.hint}</small>
                </li>
              ))}
            </ul>
          </article>

          <article className="card stack">
            <div className="stack tight">
              <h3>{t('Review links')}</h3>
              <small className="muted">{t('Track draft progress and approval results from the model workspace.')}</small>
            </div>
            <div className="workspace-button-stack">
              <button type="button" className="workspace-inline-button" onClick={previousStep} disabled={step === 0 || loading}>
                {t('Back')}
              </button>
              <button type="button" className="workspace-inline-button" onClick={nextStep} disabled={step === steps.length - 1 || loading}>
                {t('Next')}
              </button>
              <button type="button" onClick={submitApproval} disabled={step !== steps.length - 1 || loading}>
                {loading ? t('Submitting...') : t('Submit Approval')}
              </button>
              <Link to="/models/my-models" className="workspace-inline-link">
                {t('Manage My Models')}
              </Link>
              <Link to="/models/versions" className="workspace-inline-link">
                {t('Open Model Versions')}
              </Link>
            </div>
          </article>
        </div>
      </section>
    </div>
  );
}
