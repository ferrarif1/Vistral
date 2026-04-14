import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileAttachment, ModelRecord } from '../../shared/domain';
import AdvancedSection from '../components/AdvancedSection';
import AttachmentUploader from '../components/AttachmentUploader';
import WorkspaceFollowUpHint from '../components/onboarding/WorkspaceFollowUpHint';
import WorkspaceOnboardingCard from '../components/onboarding/WorkspaceOnboardingCard';
import StateBlock from '../components/StateBlock';
import StepIndicator from '../components/StepIndicator';
import { StatusTag } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import WorkspaceActionPanel from '../components/ui/WorkspaceActionPanel';
import { Checkbox, Input, Select, Textarea } from '../components/ui/Field';
import { Card } from '../components/ui/Surface';
import {
  WorkspaceHero,
  WorkspaceMetricGrid,
  WorkspacePage,
  WorkspaceSectionHeader,
  WorkspaceWorkbench
} from '../components/ui/WorkspacePage';
import useBackgroundPolling from '../hooks/useBackgroundPolling';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

const backgroundRefreshIntervalMs = 5000;
const modelTypeOptions = ['ocr', 'detection', 'classification', 'segmentation', 'obb'] as const;
const createModelOnboardingDismissedStorageKey = 'vistral-create-model-onboarding-dismissed';

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

  const readyFileCount = useMemo(() => modelFiles.filter((file) => file.status === 'ready').length, [modelFiles]);
  const hasTransientModelFiles = useMemo(
    () => modelFiles.some((file) => file.status === 'uploading' || file.status === 'processing'),
    [modelFiles]
  );
  const draftStatusLabel = draftModel ? t(draftModel.status) : t('not started');
  const onboardingSteps = useMemo(
    () => [
      {
        key: 'metadata',
        label: t('Create metadata shell'),
        detail: t('Start with name, description, model type, and visibility so the draft has a stable identity.'),
        done: Boolean(draftModel),
        to: '/models/create',
        cta: t('Fill metadata')
      },
      {
        key: 'artifact',
        label: t('Upload ready artifact'),
        detail: t('Add at least one ready model file before moving into parameter review and approval submission.'),
        done: readyFileCount > 0,
        to: '/models/create',
        cta: t('Upload model file')
      },
      {
        key: 'submit',
        label: t('Submit approval request'),
        detail: t('Use the final review step to submit the draft into the approval queue and keep governance traceable.'),
        done: draftModel?.status === 'pending_approval',
        to: '/admin/models/pending',
        cta: t('Open Approval Queue'),
        secondaryTo: '/models/my-models',
        secondaryLabel: t('Open My Models')
      }
    ],
    [draftModel, readyFileCount, t]
  );

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
        text: t('Draft created. Continue with model file upload.')
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
      <WorkspaceHero
        eyebrow={t('Model Draft Studio')}
        title={t('Create Model')}
        description={t('Move from metadata shell to approval-ready artifact package with a calmer guided flow.')}
        stats={[
          {
            label: t('Current step'),
            value: `${step + 1}/${steps.length}`
          },
          {
            label: t('Ready model files'),
            value: readyFileCount
          },
          {
            label: t('Draft status'),
            value: draftStatusLabel
          }
        ]}
      />

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
            title: t('Draft shell'),
            description: t('Metadata shell for the model record.'),
            value: draftModel ? 1 : 0
          },
          {
            title: t('Ready model files'),
            description: t('Artifacts already ready for review and approval flow.'),
            value: readyFileCount
          },
          {
            title: t('Visibility'),
            description: t('Current exposure setting for this draft.'),
            value: t(draftModel?.visibility ?? visibility)
          },
          {
            title: t('Submission readiness'),
            description: t('The final review step is where approval submission becomes available.'),
            value: step === steps.length - 1 && readyFileCount > 0 ? t('Ready') : t('draft'),
            tone: step === steps.length - 1 && readyFileCount > 0 ? 'default' : 'attention'
          }
        ]}
      />

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
            <div className="workspace-toolbar-meta">
              <div className="workspace-segmented-actions">
                <StatusTag status={draftModel?.status ?? 'draft'}>{draftStatusLabel}</StatusTag>
                <StatusTag status="info">{t('Ready model files')}: {readyFileCount}</StatusTag>
                <StatusTag status="info">
                  {t('Current step')}: {step + 1}/{steps.length}
                </StatusTag>
                {draftModel ? <StatusTag status="info">{t('Model Type')}: {t(draftModel.model_type)}</StatusTag> : null}
              </div>
            </div>
          </Card>
        }
        main={
          <div className="workspace-main-stack">
            <WorkspaceOnboardingCard
              title={t('Model draft first-run guide')}
              description={t('Use this wizard to move from model metadata into artifact upload, parameter review, and approval submission.')}
              summary={t('Guide status is computed from draft creation, ready artifact count, and approval queue status.')}
              storageKey={createModelOnboardingDismissedStorageKey}
              steps={onboardingSteps.map((stepItem) => ({
                key: stepItem.key,
                label: stepItem.label,
                detail: stepItem.detail,
                done: stepItem.done,
                primaryAction: {
                  to: stepItem.to,
                  label: stepItem.cta
                },
                secondaryAction:
                  stepItem.secondaryTo && stepItem.secondaryLabel
                    ? {
                        to: stepItem.secondaryTo,
                        label: stepItem.secondaryLabel
                      }
                    : undefined
              }))}
            />

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
                <ul className="workspace-record-list compact">
                  <li className="workspace-record-item compact">
                    <div className="row between gap wrap">
                      <strong>{draftModel.name}</strong>
                      <StatusTag status={draftModel.status}>{t(draftModel.status)}</StatusTag>
                    </div>
                    <small className="muted">
                      {t('Model Type')}: {t(draftModel.model_type)}
                    </small>
                  </li>
                  <li className="workspace-record-item compact">
                    <div className="row between gap wrap">
                      <strong>{t('Visibility')}</strong>
                      <StatusTag status="info">{t(draftModel.visibility)}</StatusTag>
                    </div>
                    <small className="muted">
                      {t('Metadata ready')} · {t('Ready model files')}: {readyFileCount}
                    </small>
                  </li>
                </ul>
              ) : (
                <StateBlock
                  variant="empty"
                  title={t('No draft yet.')}
                  description={t('Create the metadata shell first, then upload model artifacts in the next step.')}
                  extra={
                    <WorkspaceFollowUpHint
                      detail={t(
                        'Start with name, type, visibility, and description on the left. When step 1 is complete, this inspector will reflect the draft immediately.'
                      )}
                    />
                  }
                />
              )}
            </Card>

            <Card as="article" className="workspace-inspector-card">
              <div className="stack tight">
                <h3>{t('Submission checklist')}</h3>
                <small className="muted">{t('Keep the approval path visible while you finish the wizard.')}</small>
              </div>
              <ul className="workspace-record-list compact">
                {checklist.map((item) => (
                  <li key={item.label} className="workspace-record-item compact">
                    <div className="row between gap wrap">
                      <strong>{item.label}</strong>
                      <StatusTag status={item.done ? 'ready' : 'draft'}>
                        {item.done ? t('Ready') : t('draft')}
                      </StatusTag>
                    </div>
                    <small className="muted">{item.hint}</small>
                  </li>
                ))}
              </ul>
            </Card>

            <WorkspaceActionPanel
              title={t('Review links')}
              description={t('Track draft progress and approval results from the model workspace.')}
              surface="panel"
              actions={
                <>
                  <ButtonLink to="/models/my-models" variant="secondary" block>
                    {t('Manage My Models')}
                  </ButtonLink>
                  <ButtonLink to="/models/versions" variant="secondary" block>
                    {t('Open Model Versions')}
                  </ButtonLink>
                </>
              }
            />
          </div>
        }
      />
    </WorkspacePage>
  );
}
