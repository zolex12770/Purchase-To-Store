import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// The UI face, bundled into dist/assets so it is served over the LAN with no
// internet. Its @font-face rules are split by unicode-range, so a browser only
// fetches the latin (and, for ₹, latin-ext) files it actually needs.
import '@fontsource-variable/inter';
import './styles/tokens.css';
import './styles/base.css';
import './styles/simple.css';

import { AuthProvider } from './lib/auth';
import { ThemeProvider } from './lib/theme';
import { ToastProvider, useToast } from './components/Toast';
import { shouldRetryQuery } from './lib/queryRetry';
import { reportUnhandledApiError } from './lib/unhandledApiErrors';
import App from './App';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      // Never what will not fix itself, nor a request that timed out (C01): lib/queryRetry.ts.
      retry: shouldRetryQuery,
    },
    mutations: { retry: false },
  },
});

/** An API failure nobody awaited is shown as a toast, not lost (C12): lib/unhandledApiErrors.ts. */
function UnhandledApiErrors() {
  const toast = useToast();
  useEffect(() => {
    const onRejection = (event: PromiseRejectionEvent) => { reportUnhandledApiError(event, (err) => toast.fromError(err)); };
    window.addEventListener('unhandledrejection', onRejection);
    return () => window.removeEventListener('unhandledrejection', onRejection);
  }, [toast]);
  return null;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <BrowserRouter>
          <ToastProvider>
            <UnhandledApiErrors />
            <AuthProvider>
              <App />
            </AuthProvider>
          </ToastProvider>
        </BrowserRouter>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
