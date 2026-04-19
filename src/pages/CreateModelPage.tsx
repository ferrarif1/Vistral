import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { FileAttachment, ModelRecord } from '../../shared/domain';
import AdvancedSection from '../components/AdvancedSection';
import AttachmentUploader from '../components/AttachmentUploader';
import StateBlock from '../components/StateBlock';
import StepIndicator from '../components/StepIndicator';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { PageHeader } from '../components/ui/ConsolePage';
import { Checkbox, Input, Select, Textarea } from '../components/ui/Field';
import { Card } from '../components/ui/Surface';
import {
  WorkspacePage,
  WorkspaceSectionHeader,
  WorkspaceWorkbench
} from '../components/ui/WorkspacePage';
import useBackgroundPolling from '../hooks/useBackgroundPolling';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

const backgroundRefreshIntervalMs = 5000;
const modelTypeOptions = ['ocr', 'detection', 'classification', 'segmentation', 'obb'] as const;

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
  const [searchParams] = useSearchParams();
  const preferredModelType = (searchParams.get('task_type') ?? searchParams.get('model_type') ?? '').trim();
  const preferredTrainingJobId = (searchParams.get('job') ?? '').trim();
  const preferredVersionName = (searchParams.get('version_name') ?? searchParams.get('versionName') ?? '').trim();
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
  const [modelType, setModelType] = useState<'ocr' | 'detection' | 'classification' | 'segmentation' | 'obb'>(() =>
    modelTypeOptions.includes(preferredModelType as (typeof modelTypeOptions)[number])
      ? (preferredModelType as (typeof modelTypeOptions)[number])
      : 'classification'
  );
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

  const readyFileCount = useMemo(() => modelFiles.filter((file) => file.status === 'ready').length, [modelFiles]);
  const hasTransientModelFiles = useMemo(
    () => modelFiles.some((file) => file.status === 'uploading' || file.status === 'processing'),
    [modelFiles]
  );
  const draftStatusLabel = draftModel ? t(draftModel.status) : t('not started');
  const versionRegistrationPath = useMemo(() => {
    if (!draftModel) {
      return '';
    }

    const params = new URLSearchParams();
    params.set('model', draftModel.id);
    if (preferredTrainingJobId) {
      params.set('job', preferredTrainingJobId);
    }
    if (preferredVersionName) {
      params.set('version_name', preferredVersionName);
    }
    return `/models/versions?${params.toString()}`;
  }, [draftModel, preferredTrainingJobId, preferredVersionName]);

  useBackgroundPolling(
    () => {
      refreshModelFiles().catch(() => {
        // No-op in poll loop.
      });
    },
    {
      intervalMs: backgroundRefreshIntervalMs,
      enabled: Boolean(draftModel) && hasTransientModelFiles
    }
  );

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
        text: preferredTrainingJobId
          ? t('Draft created. Continue with model file upload and then version registration.')
          : t('Draft created. Continue with model file upload.')
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
      await api.submitApprovalRequest({
        model_id: draftModel.id,
        review_notes: t('Round-1 submission from create wizard.'),
        parameter_snapshot: {
          learning_rate: learningRate,
          batch_size: batchSize,
          early_stop: enableEarlyStop ? 'true' : 'false'
        }
      });

      setDraftModel({ ...draftModel, status: 'pending_approval' });
      setFeedback({
        variant: 'success',
        text: t('Approval request submitted. Model status is now pending approval.')
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
        <Card className="stack">
          <div className="stack tight">
            <h3>{stepTitles[step]}</h3>
            <small className="muted">{stepDescriptions[step]}</small>
          </div>
          <div className="workspace-form-grid">
            <label className="workspace-form-span-2">
              {t('Model Name')}
              <Input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="workspace-form-span-2">
              {t('Description')}
              <Textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} />
            </label>
            <label>
              {t('Model Type')}
              <Select
                value={modelType}
                onChange={(event) =>
                  setModelType(
                    event.target.value as 'ocr' | 'detection' | 'classification' | 'segmentation' | 'obb'
                  )
                }
              >
                {modelTypeOptions.map((option) => (
                  <option key={option} value={option}>
                    {t(option)}
                  </option>
                ))}
              </Select>
            </label>
            <label>
              {t('Visibility')}
              <Select
                value={visibility}
                onChange={(event) => setVisibility(event.target.value as 'private' | 'workspace' | 'public')}
              >
                <option value="private">{t('private')}</option>
                <option value="workspace">{t('workspace')}</option>
                <option value="public">{t('public')}</option>
              </Select>
            </label>
          </div>
        </Card>
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
          <Card className="stack">
            <div className="stack tight">
              <h3>{stepTitles[step]}</h3>
              <small className="muted">{stepDescriptions[step]}</small>
            </div>
            <div className="workspace-form-grid">
              <label>
                {t('Learning Rate')}
                <Input value={learningRate} onChange={(event) => setLearningRate(event.target.value)} />
              </label>
              <label>
                {t('Batch Size')}
                <Input value={batchSize} onChange={(event) => setBatchSize(event.target.value)} />
              </label>
            </div>
          </Card>
          <AdvancedSection>
            <label className="row gap align-center workspace-checkbox-row">
              <Checkbox
                checked={enableEarlyStop}
                onChange={(event) => setEnableEarlyStop(event.target.checked)}
              />
              {t('Enable early stop')}
            </label>
            <label>
              {t('Warmup Ratio')}
              <Input defaultValue="0.1" />
            </label>
            <label>
              {t('Weight Decay')}
              <Input defaultValue="0.0001" />
            </label>
          </AdvancedSection>
        </section>
      );
    }

    return (
      <Card className="stack">
        <div className="stack tight">
          <h3>{stepTitles[step]}</h3>
          <small className="muted">{stepDescriptions[step]}</small>
        </div>
        {draftModel ? (
          <ul className="workspace-record-list compact">
            <li className="workspace-record-item compact">
              <div className="row between gap wrap">
                <strong>{draftModel.name}</strong>
                <StatusTag status={draftModel.status}>{t(draftModel.status)}</StatusTag>
              </div>
              <small className="muted">{draftModel.description}</small>
            </li>
            <li className="workspace-record-item compact">
              <div className="row between gap wrap">
                <strong>{t('Visibility')}</strong>
                <StatusTag status="info">{t(draftModel.visibility)}</StatusTag>
              </div>
              <small className="muted">
                {t('Model Type')}: {t(draftModel.model_type)}
              </small>
            </li>
            <li className="workspace-record-item compact">
              <div className="row between gap wrap">
                <strong>{t('Ready model files')}</strong>
                <StatusTag status="info">{readyFileCount}</StatusTag>
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
      </Card>
    );
  };

  return (
    <WorkspacePage>
      <PageHeader
        eyebrow={t('Model Draft Studio')}
        title={t('Create Model')}
        description={t('Move from metadata shell to approval-ready artifact package with a calm guided flow.')}
        meta={
          <div className="row gap wrap align-center">
            <Badge tone="neutral">{t('Step')}: {step + 1}/{steps.length}</Badge>
            <Badge tone="info">{t('Ready model files')}: {readyFileCount}</Badge>
            <Badge tone="neutral">{t('Draft status')}: {draftStatusLabel}</Badge>
          </div>
        }
      />

      {feedback ? (
        <StateBlock
          variant={feedback.variant}
          title={feedback.variant === 'success' ? t('Action Completed') : t('Action Failed')}
          description={feedback.text}
        />
      ) : null}

      <WorkspaceWorkbench
        toolbar={
          <Card as="section" className="workspace-toolbar-card">
            <div className="workspace-toolbar-head">
              <div className="workspace-toolbar-copy">
                <h3>{t('Flow controls')}</h3>
                <small className="muted">{stepDescriptions[step]}</small>
              </div>
              <div className="workspace-toolbar-actions">
                <Button type="button" variant="secondary" onClick={previousStep} disabled={step === 0 || loading} size="sm">
                  {t('Back')}
                </Button>
                <Button type="button" variant="secondary" onClick={nextStep} disabled={step === steps.length - 1 || loading} size="sm">
                  {t('Next')}
                </Button>
                <Button type="button" onClick={submitApproval} disabled={step !== steps.length - 1 || loading} size="sm">
                  {loading ? t('Submitting...') : t('Submit Approval')}
                </Button>
              </div>
            </div>
          </Card>
        }
        main={
          <div className="workspace-main-stack">
            <Card as="article">
              <WorkspaceSectionHeader
                title={t('Current step')}
                description={stepTitles[step]}
                actions={<StatusTag status="info">{`${step + 1}/${steps.length}`}</StatusTag>}
              />
              <small className="muted">{stepDescriptions[step]}</small>
              <StepIndicator steps={steps} current={step} />
            </Card>
            {renderStage()}
          </div>
        }
        side={
          <div className="workspace-inspector-rail">
            <Card as="article" className="workspace-inspector-card">
              <div className="stack tight">
                <h3>{t('Current draft')}</h3>
                <small className="muted">{stepDescriptions[step]}</small>
              </div>
              {draftModel ? (
                <div className="stack tight">
                  <div className="workspace-keyline-list">
                    <div className="workspace-keyline-item">
                      <span>{t('Model')}</span>
                      <strong>{draftModel.name}</strong>
                    </div>
                    <div className="workspace-keyline-item">
                      <span>{t('Status')}</span>
                      <strong>{t(draftModel.status)}</strong>
                    </div>
                    <div className="workspace-keyline-item">
                      <span>{t('Files')}</span>
                      <strong>{readyFileCount}</strong>
                    </div>
                  </div>
                  <div className="row gap wrap">
                    <Badge tone="neutral">{t('Model Type')}: {t(draftModel.model_type)}</Badge>
                    <Badge tone="info">{t('Visibility')}: {t(draftModel.visibility)}</Badge>
                  </div>
                </div>
              ) : (
                <StateBlock
                  variant="empty"
                  title={t('No draft yet.')}
                  description={t('Create the metadata shell first, then upload model artifacts in the next step.')}
                  extra={<small className="muted">{t('Start with name, type, visibility, and description in Step 1.')}</small>}
                />
              )}
            </Card>

            {draftModel && preferredTrainingJobId ? (
              <Card as="article" className="workspace-inspector-card">
                <div className="stack tight">
                  <h3>{t('Next step')}</h3>
                  <small className="muted">
                    {t('Return to version registration after the draft and files are ready.')}
                  </small>
                </div>
                <div className="row gap wrap">
                  <ButtonLink to={versionRegistrationPath} variant="secondary" size="sm">
                    {t('Open version registration')}
                  </ButtonLink>
                </div>
              </Card>
            ) : null}

            <Card as="article" className="workspace-inspector-card">
              <div className="row between gap wrap align-center">
                <h3>{t('Submission status')}</h3>
                <Badge tone="neutral">
                  {checklist.filter((item) => item.done).length}/{checklist.length}
                </Badge>
              </div>
              <small className="muted">
                {t('Keep this as a quick check, not a second workflow.')}
              </small>
              <div className="stack tight">
                {checklist.slice(0, 2).map((item) => (
                  <div key={item.label} className="workspace-keyline-item">
                    <span>{item.label}</span>
                    <small>{item.done ? t('Ready') : t('Pending')}</small>
                  </div>
                ))}
              </div>
            </Card>

          </div>
        }
      />
    </WorkspacePage>
  );
}
