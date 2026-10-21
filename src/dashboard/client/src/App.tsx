/**
 * Top-level SPA entry. Lazy-loads the operator dashboard (AppShell + SSE
 * bridge + operator views) so first paint only downloads what it needs.
 */
import { lazy, Suspense, type JSX } from 'react'

const OperatorApp = lazy(() => import('./OperatorApp'))

function App(): JSX.Element {
  return (
    <Suspense fallback={<div className="min-h-screen bg-background" />}>
      <OperatorApp />
    </Suspense>
  )
}

export default App
