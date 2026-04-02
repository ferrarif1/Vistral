import { Navigate, Route, Routes } from 'react-router-dom';
import AppShell from './layouts/AppShell';
import DualEntryPage from './pages/DualEntryPage';
import ConversationPage from './pages/ConversationPage';
import ProfessionalConsolePage from './pages/ProfessionalConsolePage';
import ModelsExplorePage from './pages/ModelsExplorePage';
import MyModelsPage from './pages/MyModelsPage';
import CreateModelPage from './pages/CreateModelPage';
import AuthRegisterPage from './pages/AuthRegisterPage';
import AuthLoginPage from './pages/AuthLoginPage';

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<DualEntryPage />} />
        <Route path="/workspace/chat" element={<ConversationPage />} />
        <Route path="/workspace/console" element={<ProfessionalConsolePage />} />
        <Route path="/conversation" element={<Navigate to="/workspace/chat" replace />} />
        <Route path="/models/explore" element={<ModelsExplorePage />} />
        <Route path="/models/my-models" element={<MyModelsPage />} />
        <Route path="/models/create" element={<CreateModelPage />} />
        <Route path="/auth/register" element={<AuthRegisterPage />} />
        <Route path="/auth/login" element={<AuthLoginPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
