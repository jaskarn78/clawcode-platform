import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import App from './App.tsx'
import { ViewModeProvider } from './hooks/useViewMode.tsx'
import { installFetchAuth } from './lib/admin-token'

// P4 admin auth — attach the stored admin token to /api requests + surface 401s.
// Installed before render so the very first queries carry the header.
installFetchAuth()

// Phase 116 — single QueryClient per browser tab. Defaults intentionally
// conservative: SSE pushes mostly drive invalidations (useSse.ts), so
// background refetches stay off. Components that need polling (fleet-stats)
// opt in via `refetchInterval` on their own useQuery call.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
      retry: 1,
      staleTime: 30_000,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ViewModeProvider>
        <App />
      </ViewModeProvider>
    </QueryClientProvider>
  </StrictMode>,
)
