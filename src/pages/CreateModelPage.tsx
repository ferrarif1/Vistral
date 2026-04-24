import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import type { FileAttachment, ModelRecord, User } from '../../shared/domain';
import AdvancedSection from '../components/AdvancedSection';
import AttachmentUploader from '../components/AttachmentUploader';
import TrainingLaunchContextPills from '../components/onboarding/TrainingLaunchContextPills';
import StateBlock from '../components/StateBlock';
import StepIndicator from '../components/StepIndicator';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { InlineAlert, PageHeader } from '../components/ui/ConsolePage';
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

const buildPendingModelsPath = (model: ModelRecord | null, launchContext?: LaunchContext): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('lane', 'pending');
  searchParams.set('status', 'pending_approval');
  if (model) {
    searchParams.set('q', model.name);
  }
  appendTrainingLaunchContext(searchParams, launchContext);
  return `/models/my-models?${searchParams.toString()}`;
};

const buildAdminApprovalQueuePath = (model: ModelRecord | null, launchContext?: LaunchContext): string => {
  const searchParams = new URLSearchParams();
  if (model) {
    searchParams.set('model', model.id);
    searchParams.set('q', model.name);
  }
  appendTrainingLaunchContext(searchParams, launchContext);
  const query = searchParams.toString();
  return query ? `/admin/models/pending?${query}` : '/admin/models/pending';
};

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
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const requestedReturnTo = sanitizeReturnToPath(searchParams.get('return_to'));
  const currentTaskPath = useMemo(
    () => `${location.pathname}${location.search || ''}`,
    [location.pathname, location.search]
  );
  const outboundReturnTo = requestedReturnTo ?? currentTaskPath;
  const preferredModelType = (searchParams.get('task_type') ?? searchParams.get('model_type') ?? '').trim();
  const preferredModelId = (searchParams.get('model') ?? searchParams.get('model_id') ?? '').trim();
  const preferredTrainingJobId = (searchParams.get('job') ?? '').trim();
  const preferredVersionName = (searchParams.get('version_name') ?? searchParams.get('versionName') ?? '').trim();
  const preferredDatasetId = (searchParams.get('dataset') ?? '').trim();
  const preferredDatasetVersionId = (searchParams.get('version') ?? '').trim();
  const preferredFramework = (searchParams.get('framework') ?? searchParams.get('profile') ?? '').trim().toLowerCase();
  const preferredExecutionTarget = (searchParams.get('execution_target') ?? '').trim().toLowerCase();
  const preferredWorkerId = (searchParams.get('worker') ?? '').trim();
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
  const [currentUser, setCurrentUser] = useState<User | null>(null);
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
  const [requestedModelMissing, setRequestedModelMissing] = useState(false);
  const modelFilesSignatureRef = useRef(buildModelFilesSignature(null, []));
  const backgroundSyncHint = t(
    'Background sync is unavailable right now. Deletion is already applied locally. Click Refresh to retry.'
  );
  const hasImportedTrainingContext = Boolean(
    preferredTrainingJobId ||
      preferredVersionName ||
      preferredDatasetId ||
      preferredDatasetVersionId ||
      preferredFramework ||
      preferredExecutionTarget ||
      preferredWorkerId
  );
  const clearRequestedModelContextPath = useMemo(() => {
    const next = new URLSearchParams(searchParams);
    next.delete('model');
    next.delete('model_id');
    const query = next.toString();
    return query ? `${location.pathname}?${query}` : location.pathname;
  }, [location.pathname, searchParams]);

  useEffect(() => {
    setRequestedModelMissing(false);
  }, [preferredModelId]);

  useEffect(() => {
    let active = true;

    Promise.all([
      api.me().catch(() => null),
      preferredModelId ? api.listModels().catch(() => []) : Promise.resolve<ModelRecord[]>([])
    ]).then(([user, visibleModels]) => {
      if (!active) {
        return;
      }

      setCurrentUser(user);

      if (!preferredModelId) {
        return;
      }

      const selectedModel = visibleModels.find((item) => item.id === preferredModelId) ?? null;
      if (!selectedModel) {
        setRequestedModelMissing(true);
        setFeedback({
          variant: 'error',
          text: t('The requested model draft is no longer available. Open My Models and choose another draft.')
        });
        return;
      }

      setRequestedModelMissing(false);
      setDraftModel(selectedModel);
      setName(selectedModel.name);
      setDescription(selectedModel.description);
      setModelType(selectedModel.model_type);
      setVisibility(selectedModel.visibility);
      setStep(selectedModel.status === 'pending_approval' ? steps.length - 1 : 1);
      setFeedback({
        variant: 'success',
        text:
          selectedModel.status === 'pending_approval'
            ? t('Loaded existing model submission. Track approval from the next-step panel.')
            : t('Loaded existing model draft. Continue with files, review, and approval handoff.')
      });
    });

    return () => {
      active = false;
    };
  }, [preferredModelId, steps.length, t]);

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
  const metadataLocked = Boolean(draftModel);
  const approvalSubmitted = draftModel?.status === 'pending_approval';
  const draftStatusLabel = draftModel ? t(draftModel.status) : t('not started');
  const launchContext: LaunchContext = {
    datasetId: preferredDatasetId || null,
    versionId: preferredDatasetVersionId || null,
    taskType: modelType || preferredModelType || null,
    framework: preferredFramework || null,
    executionTarget: preferredExecutionTarget || null,
    workerId: preferredWorkerId || null,
    returnTo: outboundReturnTo
  };
  const pendingModelsPath = useMemo(
    () => buildPendingModelsPath(draftModel, launchContext),
    [draftModel, launchContext]
  );
  const adminApprovalQueuePath = useMemo(
    () => buildAdminApprovalQueuePath(draftModel, launchContext),
    [draftModel, launchContext]
  );
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
    appendTrainingLaunchContext(params, launchContext);
    return `/models/versions?${params.toString()}`;
  }, [draftModel, launchContext, preferredTrainingJobId, preferredVersionName]);

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
    if (draftModel) {
      setStep(1);
      setFeedback({
        variant: 'success',
        text: t('Draft already exists. Continue with model file upload or final review.')
      });
      return;
    }

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
    setModelFiles((prev) => prev.filter((item) => item.id !== attachmentId));
    refreshModelFiles().catch(() => {
      setFeedback({ variant: 'success', text: backgroundSyncHint });
    });
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

    if (approvalSubmitted || (draftModel.status !== 'draft' && draftModel.status !== 'rejected')) {
      setFeedback({
        variant: 'error',
        text: t('Approval has already been submitted or completed for this model. Continue from My Models or the approval queue.')
      });
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
        text: t('Approval request submitted. Model status is now pending approval. Continue in My Models or the approval queue.')
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
              <Input value={name} onChange={(event) => setName(event.target.value)} disabled={metadataLocked} />
            </label>
            <label className="workspace-form-span-2">
              {t('Description')}
              <Textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={4}
                disabled={metadataLocked}
              />
            </label>
            <label>
              {t('Model Type')}
              <Select
                value={modelType}
                disabled={metadataLocked}
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
                disabled={metadataLocked}
                onChange={(event) => setVisibility(event.target.value as 'private' | 'workspace' | 'public')}
              >
                <option value="private">{t('private')}</option>
                <option value="workspace">{t('workspace')}</option>
                <option value="public">{t('public')}</option>
              </Select>
            </label>
          </div>
          {metadataLocked ? (
            <small className="muted">
              {t('Metadata is locked after the draft shell is created. Continue with file packaging, review, and approval from the next steps.')}
            </small>
          ) : null}
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
          <div className="stack tight">
            <div className="row gap wrap align-center">
              <Badge tone="neutral">{t('Step')}: {step + 1}/{steps.length}</Badge>
              <Badge tone="info">{t('Ready model files')}: {readyFileCount}</Badge>
              <Badge tone="neutral">{t('Draft status')}: {draftStatusLabel}</Badge>
            </div>
            <TrainingLaunchContextPills
              taskType={launchContext.taskType}
              framework={launchContext.framework}
              executionTarget={launchContext.executionTarget}
              workerId={launchContext.workerId}
              t={t}
            />
          </div>
        }
        secondaryActions={
          requestedReturnTo ? (
            <ButtonLink to={requestedReturnTo} variant="ghost" size="sm">
              {t('Return to current task')}
            </ButtonLink>
          ) : undefined
        }
      />

      {feedback ? (
        <StateBlock
          variant={feedback.variant}
          title={feedback.variant === 'success' ? t('Action Completed') : t('Action Failed')}
          description={feedback.text}
        />
      ) : null}
      {hasImportedTrainingContext ? (
        <InlineAlert
          tone="info"
          title={t('Training context imported')}
          description={t('This draft flow was opened with training context. Keep model governance and version registration in the same lane.')}
        />
      ) : null}
      {requestedModelMissing ? (
        <InlineAlert
          tone="warning"
          title={t('Requested model draft not found')}
          description={t('The incoming model context is unavailable. Continue by creating a new draft or opening My Models.')}
          actions={
            <ButtonLink to={clearRequestedModelContextPath} variant="ghost" size="sm">
              {t('Clear context')}
            </ButtonLink>
          }
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
                <Button
                  type="button"
                  onClick={submitApproval}
                  disabled={step !== steps.length - 1 || loading || approvalSubmitted}
                  size="sm"
                >
                  {loading ? t('Submitting...') : approvalSubmitted ? t('Approval Submitted') : t('Submit Approval')}
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

            <Card as="article" className="workspace-inspector-card">
              <div className="stack tight">
                <h3>{t('Next step')}</h3>
                <small className="muted">
                  {!draftModel
                    ? t('Create the model shell first, then this panel will point you to the next operational page.')
                    : approvalSubmitted
                      ? t('Approval has been submitted. Track the decision first, then continue into version registration or validation.')
                      : readyFileCount === 0
                        ? t('Upload at least one ready model artifact so the package can move toward review and approval.')
                        : step < steps.length - 1
                          ? t('The package is almost ready. Move into the final review step and submit approval from there.')
                          : t('Submit approval now, then continue in the ownership lane instead of searching across pages.')}
                </small>
              </div>
              <div className="row gap wrap">
                {!draftModel ? null : approvalSubmitted ? (
                  <>
                    <ButtonLink to={pendingModelsPath} variant="secondary" size="sm">
                      {t('Open my pending models')}
                    </ButtonLink>
                    {currentUser?.role === 'admin' ? (
                      <ButtonLink to={adminApprovalQueuePath} variant="ghost" size="sm">
                        {t('Open admin queue')}
                      </ButtonLink>
                    ) : null}
                    {preferredTrainingJobId ? (
                      <ButtonLink to={versionRegistrationPath} variant="ghost" size="sm">
                        {t('Keep version registration nearby')}
                      </ButtonLink>
                    ) : null}
                  </>
                ) : readyFileCount === 0 ? (
                  <Button type="button" variant="secondary" size="sm" onClick={() => setStep(1)}>
                    {t('Go to model files')}
                  </Button>
                ) : step < steps.length - 1 ? (
                  <Button type="button" variant="secondary" size="sm" onClick={() => setStep(steps.length - 1)}>
                    {t('Go to final review')}
                  </Button>
                ) : (
                  <Button type="button" variant="secondary" size="sm" onClick={submitApproval} disabled={loading}>
                    {t('Submit Approval')}
                  </Button>
                )}
              </div>
            </Card>

            {draftModel && preferredTrainingJobId ? (
              <Card as="article" className="workspace-inspector-card">
                <div className="stack tight">
                  <h3>{t('Version registration handoff')}</h3>
                  <small className="muted">
                    {approvalSubmitted
                      ? t('After approval finishes, return here and register the linked training output as a version.')
                      : t('Return to version registration after the draft and files are ready.')}
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
