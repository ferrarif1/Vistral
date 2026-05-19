import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { I18nProvider } from './i18n/I18nProvider';
import './styles/tokens.css';
import './styles/theme.css';
import './styles/workspace.css';
import './styles/visualization.css';
import './styles/workshop.css';
import './styles/game-workshop.css';
import './styles/pixel-workshop-skin.css';
import './styles/agent-studio.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </I18nProvider>
  </React.StrictMode>
);
