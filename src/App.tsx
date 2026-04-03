import { Navigate, Route, Routes } from 'react-router-dom';
import AppShell from './layouts/AppShell';
import DualEntryPage from './pages/DualEntryPage';
import ConversationPage from './pages/ConversationPage';
import ProfessionalConsolePage from './pages/ProfessionalConsolePage';
import ModelsExplorePage from './pages/ModelsExplorePage';
import MyModelsPage from './pages/MyModelsPage';
import CreateModelPage from './pages/CreateModelPage';
import LlmSettingsPage from './pages/LlmSettingsPage';
import AdminApprovalsPage from './pages/AdminApprovalsPage';
import AdminAuditPage from './pages/AdminAuditPage';
import AdminVerificationReportsPage from './pages/AdminVerificationReportsPage';
import AuthRegisterPage from './pages/AuthRegisterPage';
import AuthLoginPage from './pages/AuthLoginPage';
import DatasetsPage from './pages/DatasetsPage';
import DatasetDetailPage from './pages/DatasetDetailPage';
import AnnotationWorkspacePage from './pages/AnnotationWorkspacePage';
import TrainingJobsPage from './pages/TrainingJobsPage';
import CreateTrainingJobPage from './pages/CreateTrainingJobPage';
import TrainingJobDetailPage from './pages/TrainingJobDetailPage';
import ModelVersionsPage from './pages/ModelVersionsPage';
import InferenceValidationPage from './pages/InferenceValidationPage';
import RuntimeSettingsPage from './pages/RuntimeSettingsPage';

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<DualEntryPage />} />
        <Route path="/workspace/chat" element={<ConversationPage />} />
        <Route path="/workspace/console" element={<ProfessionalConsolePage />} />
        <Route path="/settings/llm" element={<LlmSettingsPage />} />
        <Route path="/settings/runtime" element={<RuntimeSettingsPage />} />
        <Route path="/conversation" element={<Navigate to="/workspace/chat" replace />} />
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
        <Route path="/inference/validate" element={<InferenceValidationPage />} />
        <Route path="/admin/models/pending" element={<AdminApprovalsPage />} />
        <Route path="/admin/audit" element={<AdminAuditPage />} />
        <Route path="/admin/verification-reports" element={<AdminVerificationReportsPage />} />
        <Route path="/auth/register" element={<AuthRegisterPage />} />
        <Route path="/auth/login" element={<AuthLoginPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
