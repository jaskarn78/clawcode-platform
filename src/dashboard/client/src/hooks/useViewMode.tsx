/**
 * Phase 116 T09 — Basic / Advanced view-mode toggle.
 *
 * Persists to localStorage (`dashboard.viewMode`); first-mount default is
 * Basic on viewports < 1024 px, Advanced otherwise. Operator can toggle at
 * any time; the choice sticks across reloads.
 *
 * Tier-gating: Plan 116-01 components read `useViewMode()` to decide what
 * to render. Basic mode shows the answer-one-question UI (which agents
 * need attention?); Advanced mode unlocks all Tier 1 + Tier 2 surfaces.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

export type ViewMode = 'basic' | 'advanced'

const STORAGE_KEY = 'dashboard.viewMode'
const ADVANCED_VIEWPORT_BREAKPOINT_PX = 1024

/**
 * Resolve the initial view mode on first mount. Priority:
 *   1. localStorage value (operator's previous choice)
 *   2. Viewport heuristic — < 1024 px → basic; otherwise advanced
 */
function computeInitialMode(): ViewMode {
  if (typeof window === 'undefined') return 'basic'
  const stored = window.localStorage.getItem(STORAGE_KEY)
  if (stored === 'basic' || stored === 'advanced') return stored
  return window.innerWidth < ADVANCED_VIEWPORT_BREAKPOINT_PX ? 'basic' : 'advanced'
}

type ViewModeContextValue = {
  readonly mode: ViewMode
  readonly setMode: (mode: ViewMode) => void
  readonly toggle: () => void
}

const ViewModeContext = createContext<ViewModeContextValue | null>(null)

export function ViewModeProvider({ children }: { readonly children: ReactNode }) {
  const [mode, setModeState] = useState<ViewMode>(computeInitialMode)

  // Persist every change so the next reload picks up the latest selection.
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, mode)
    } catch {
      // localStorage may be blocked (private browsing, embedded contexts).
      // Silently degrade — the user just loses cross-reload persistence.
    }
  }, [mode])

  const setMode = useCallback((next: ViewMode) => {
    setModeState(next)
  }, [])

  const toggle = useCallback(() => {
    setModeState((curr) => (curr === 'basic' ? 'advanced' : 'basic'))
  }, [])

  const value = useMemo(
    () => ({ mode, setMode, toggle }),
    [mode, setMode, toggle],
  )

  return (
    <ViewModeContext.Provider value={value}>{children}</ViewModeContext.Provider>
  )
}

/**
 * Consumer hook — throws if used outside <ViewModeProvider /> (caller bug).
 */
export function useViewMode(): ViewModeContextValue {
  const ctx = useContext(ViewModeContext)
  if (!ctx) {
    throw new Error(
      'useViewMode must be used inside a <ViewModeProvider> (mounted at the app root in main.tsx).',
    )
  }
  return ctx
}
