import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
import { setSession } from './api.js';
import { AppProvider } from './app-context.js';
import './styles.css';
import { TooltipProvider } from './components/ui/tooltip.js';

// Hand-off from openpark.io: the signup form passes the new session in the URL fragment,
// which browsers never send to servers. Take it and clean the address bar.
const handoff = /^#token=([^&]+)&tenant=([^&]+)/.exec(location.hash);
if (handoff) {
  setSession({ token: decodeURIComponent(handoff[1]!), tenant: decodeURIComponent(handoff[2]!) });
  history.replaceState(null, '', location.pathname + location.search);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AppProvider>
        <TooltipProvider>
          <App />
        </TooltipProvider>
      </AppProvider>
    </BrowserRouter>
  </StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}
