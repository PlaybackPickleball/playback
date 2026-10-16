import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ConfigProvider } from './components/Config';
import { I18nProvider } from './i18n/context';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <ConfigProvider>
        <App />
      </ConfigProvider>
    </I18nProvider>
  </StrictMode>,
);
