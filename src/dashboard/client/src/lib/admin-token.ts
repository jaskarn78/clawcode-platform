/**
 * dashboard-rework P4 — client side of the admin auth gate.
 *
 * The operator pastes the shared admin token once (Settings → Admin access);
 * it's kept in localStorage and attached as `Authorization: Bearer <token>` to
 * every same-origin /api request via a one-time window.fetch wrapper (NOT to
 * /preview, which is a separate origin). A 401 from /api dispatches
 * AUTH_REQUIRED_EVENT so a banner can
 * prompt for the token. When the server has no token configured the gate is
 * fail-open, so an unset token here simply means "no header" and read-only
 * viewing keeps working.
 */
const KEY = 'clawcode:admin-token'

export const AUTH_REQUIRED_EVENT = 'clawcode:auth-required'

export function getAdminToken(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

export function setAdminToken(token: string): void {
  try {
    const t = token.trim()
    if (t) localStorage.setItem(KEY, t)
    else localStorage.removeItem(KEY)
  } catch {
    /* private mode — ignore */
  }
}

export function clearAdminToken(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

let installed = false

/** Install the token-attaching + 401-detecting fetch wrapper. Idempotent. */
export function installFetchAuth(): void {
  if (installed) return
  installed = true
  const orig = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input)
    let nextInit = init
    // Only attach the admin token to the dashboard's own /api surface — never to
    // /preview (served by a separate-origin activity container with its own gate).
    const sameOriginApi = url.startsWith('/api')
    if (sameOriginApi) {
      const token = getAdminToken()
      if (token) {
        const headers = new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : undefined),
        )
        if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`)
        nextInit = { ...init, headers }
      }
    }
    const res = await orig(input, nextInit)
    if (res.status === 401 && url.startsWith('/api')) {
      window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT))
    }
    return res
  }
}
