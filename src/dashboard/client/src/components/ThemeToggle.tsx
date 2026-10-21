/**
 * Phase 116-06 F21 — theme toggle.
 *
 * Three options:
 *   - "system"  (default) — follow prefers-color-scheme.
 *   - "light"             — force light theme.
 *   - "dark"              — force dark theme.
 *
 * Persisted to localStorage under `clawcode:theme`. The FOUC guard in
 * `src/dashboard/client/index.html` reads the same key BEFORE React
 * hydrates, so first-paint already matches the operator's preference.
 *
 * Switching is a single `documentElement.classList.add/remove('dark')`
 * call per shadcn convention; every primitive that reads from CSS vars
 * (via `bg-background` / `text-foreground` / `border` etc.) flips
 * instantly when the class changes.
 *
 * System-mode listener: when the operator selects "system", we attach
 * a MediaQueryList listener so OS dark-mode toggles propagate without
 * a refresh. When the operator picks "light" or "dark" explicitly, the
 * listener is removed (their explicit pick wins over OS changes).
 */
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

export type ThemePreference = 'system' | 'light' | 'dark'
/** Alias for cross-module use (CommandPalette). */
export type ThemePref = ThemePreference

const STORAGE_KEY = 'clawcode:theme'

function readStoredTheme(): ThemePreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  } catch {
    // localStorage may throw in private/sandbox modes — fall through.
  }
  return 'system'
}

/**
 * Public canonical reader. Phase 116-postdeploy 2026-05-11: exported so
 * CommandPalette and any future surface (settings panel, etc.) share ONE
 * theme source-of-truth instead of forking their own localStorage keys.
 */
export function getStoredThemePref(): ThemePreference {
  return readStoredTheme()
}

export function setStoredThemePref(pref: ThemePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, pref)
  } catch {
    /* private/sandbox modes — silent */
  }
}

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return true // safer default (matches historical dark-only behavior)
  }
}

function applyTheme(pref: ThemePreference): void {
  const isDark = pref === 'dark' || (pref === 'system' && systemPrefersDark())
  const root = document.documentElement
  if (isDark) root.classList.add('dark')
  else root.classList.remove('dark')
}

/** Public alias for cross-module DOM application. */
export function applyThemePref(pref: ThemePreference): void {
  applyTheme(pref)
}

/**
 * Resolve a stored ThemePreference to the effective rendered theme.
 * `'system'` collapses to either `'light'` or `'dark'` based on
 * `prefers-color-scheme`. Used by Cmd+K's quick-toggle to compute
 * the explicit opposite.
 */
export function resolveEffectiveTheme(
  pref: ThemePreference,
): 'light' | 'dark' {
  if (pref === 'light') return 'light'
  if (pref === 'dark') return 'dark'
  return systemPrefersDark() ? 'dark' : 'light'
}

/**
 * Inline SVG icons — tiny, single-purpose, dependency-free.
 */
function SunIcon(): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  )
}

function MoonIcon(): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  )
}

function MonitorIcon(): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  )
}

export function ThemeToggle(): JSX.Element {
  const [pref, setPref] = useState<ThemePreference>(() => readStoredTheme())

  // Apply once on mount + every time the preference changes. The FOUC
  // guard in index.html already handled the very-first paint; this hook
  // synchronizes subsequent preference toggles.
  useEffect(() => {
    applyTheme(pref)
    try {
      localStorage.setItem(STORAGE_KEY, pref)
    } catch {
      /* private mode — preference is in-memory only */
    }
  }, [pref])

  // System-mode listener: when the operator chooses "system", track OS
  // dark-mode changes live. Cleanup on preference change so the
  // listener is only active while the operator wants OS-following.
  useEffect(() => {
    if (pref !== 'system') return
    let mql: MediaQueryList
    try {
      mql = window.matchMedia('(prefers-color-scheme: dark)')
    } catch {
      return
    }
    const onChange = (): void => applyTheme('system')
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [pref])

  const currentIcon =
    pref === 'light' ? <SunIcon /> : pref === 'dark' ? <MoonIcon /> : <MonitorIcon />

  const select = useCallback((next: ThemePreference): void => {
    setPref(next)
  }, [])

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Theme"
          data-testid="theme-toggle-trigger"
          className="gap-2"
        >
          {currentIcon}
          <span className="text-xs text-fg-3 hidden sm:inline">
            {pref === 'system' ? 'System' : pref === 'light' ? 'Light' : 'Dark'}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-40 p-1" align="end">
        <ThemeMenuItem
          active={pref === 'system'}
          onClick={() => select('system')}
          icon={<MonitorIcon />}
          label="System"
        />
        <ThemeMenuItem
          active={pref === 'light'}
          onClick={() => select('light')}
          icon={<SunIcon />}
          label="Light"
        />
        <ThemeMenuItem
          active={pref === 'dark'}
          onClick={() => select('dark')}
          icon={<MoonIcon />}
          label="Dark"
        />
      </PopoverContent>
    </Popover>
  )
}

function ThemeMenuItem(props: {
  readonly active: boolean
  readonly onClick: () => void
  readonly icon: JSX.Element
  readonly label: string
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent ${
        props.active ? 'bg-accent text-accent-foreground' : ''
      }`}
      role="menuitemradio"
      aria-checked={props.active}
    >
      {props.icon}
      <span>{props.label}</span>
      {props.active && (
        <span className="ml-auto text-xs text-fg-3" aria-hidden="true">
          ✓
        </span>
      )}
    </button>
  )
}
