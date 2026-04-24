import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import AppShell from './layouts/AppShell';
import ApiHealthBanner from './components/ApiHealthBanner';
import StateBlock from './components/StateBlock';
import { useI18n } from './i18n/I18nProvider';

const ConversationPage = lazy(() => import('./pages/ConversationPage'));
const ProfessionalConsolePage = lazy(() => import('./pages/ProfessionalConsolePage'));
const ModelsExplorePage = lazy(() => import('./pages/ModelsExplorePage'));
const MyModelsPage = lazy(() => import('./pages/MyModelsPage'));
const CreateModelPage = lazy(() => import('./pages/CreateModelPage'));
const LlmSettingsPage = lazy(() => import('./pages/LlmSettingsPage'));
const AdminApprovalsPage = lazy(() => import('./pages/AdminApprovalsPage'));
const AdminAuditPage = lazy(() => import('./pages/AdminAuditPage'));
const AdminVerificationReportsPage = lazy(() => import('./pages/AdminVerificationReportsPage'));
const AuthLoginPage = lazy(() => import('./pages/AuthLoginPage'));
const AccountSettingsPage = lazy(() => import('./pages/AccountSettingsPage'));
const DatasetsPage = lazy(() => import('./pages/DatasetsPage'));
const DatasetDetailPage = lazy(() => import('./pages/DatasetDetailPage'));
const AnnotationWorkspacePage = lazy(() => import('./pages/AnnotationWorkspacePage'));
const TrainingJobsPage = lazy(() => import('./pages/TrainingJobsPage'));
const CreateTrainingJobPage = lazy(() => import('./pages/CreateTrainingJobPage'));
const TrainingJobDetailPage = lazy(() => import('./pages/TrainingJobDetailPage'));
const TrainingClosurePage = lazy(() => import('./pages/TrainingClosurePage'));
const ModelVersionsPage = lazy(() => import('./pages/ModelVersionsPage'));
const InferenceValidationPage = lazy(() => import('./pages/InferenceValidationPage'));
const VisionModelingTasksPage = lazy(() => import('./pages/VisionModelingTasksPage'));
const VisionModelingTaskPage = lazy(() => import('./pages/VisionModelingTaskPage'));
const RuntimeSettingsPage = lazy(() => import('./pages/RuntimeSettingsPage'));
const WorkerSettingsPage = lazy(() => import('./pages/WorkerSettingsPage'));
const RuntimeTemplatesPage = lazy(() => import('./pages/RuntimeTemplatesPage'));

function PreserveQueryRedirect({ to }: { to: string }) {
  const location = useLocation();
  const target = location.search ? `${to}${location.search}` : to;
  return <Navigate to={target} replace />;
}

export default function App() {
  const { t } = useI18n();

  return (
    <>
      <ApiHealthBanner />
      <AppShell>
        <Suspense
          fallback={
            <div className="stack page-width">
              <StateBlock
                variant="loading"
                title={t('Loading')}
                description={t('Preparing page content.')}
              />
            </div>
          }
        >
          <Routes>
            <Route path="/" element={<PreserveQueryRedirect to="/workspace/chat" />} />
            <Route path="/workspace/chat" element={<ConversationPage />} />
            <Route path="/workspace/console" element={<ProfessionalConsolePage />} />
            <Route path="/settings" element={<PreserveQueryRedirect to="/settings/account" />} />
            <Route path="/settings/account" element={<AccountSettingsPage />} />
            <Route path="/settings/llm" element={<LlmSettingsPage />} />
            <Route path="/settings/runtime" element={<RuntimeSettingsPage />} />
            <Route path="/settings/workers" element={<WorkerSettingsPage />} />
            <Route path="/settings/runtime/templates" element={<RuntimeTemplatesPage />} />
            <Route path="/conversation" element={<PreserveQueryRedirect to="/workspace/chat" />} />
            <Route path="/models/explore" element={<ModelsExplorePage />} />
            <Route path="/models/my-models" element={<MyModelsPage />} />
            <Route path="/models/create" element={<CreateModelPage />} />
            <Route path="/models/versions" element={<ModelVersionsPage />} />
            <Route path="/datasets" element={<DatasetsPage />} />
            <Route path="/datasets/:datasetId" element={<DatasetDetailPage />} />
            <Route path="/datasets/:datasetId/annotate" element={<AnnotationWorkspacePage />} />
            <Route path="/training/jobs" element={<TrainingJobsPage />} />
            <Route path="/training/jobs/new" element={<CreateTrainingJobPage />} />
            <Route path="/training/jobs/:jobId" element={<TrainingJobDetailPage />} />
            <Route path="/vision/tasks" element={<VisionModelingTasksPage />} />
            <Route path="/vision/tasks/:taskId" element={<VisionModelingTaskPage />} />
            <Route path="/workflow/closure" element={<TrainingClosurePage />} />
            <Route path="/inference/validate" element={<InferenceValidationPage />} />
            <Route path="/admin/models/pending" element={<AdminApprovalsPage />} />
            <Route path="/admin/audit" element={<AdminAuditPage />} />
            <Route path="/admin/verification-reports" element={<AdminVerificationReportsPage />} />
            <Route path="/auth/register" element={<PreserveQueryRedirect to="/auth/login" />} />
            <Route path="/auth/login" element={<AuthLoginPage />} />
            <Route path="*" element={<PreserveQueryRedirect to="/workspace/chat" />} />
          </Routes>
        </Suspense>
      </AppShell>
    </>
  );
}
