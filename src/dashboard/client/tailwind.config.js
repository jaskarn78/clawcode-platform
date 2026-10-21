/** @type {import('tailwindcss').Config} */

// Phase 116 — ClawCode dashboard v2 Tailwind config.
//
// Design tokens locked per 116-CONTEXT.md aesthetic section. Dark base
// (#0e0e12) + emerald primary (#10b981) + Cabinet Grotesk display +
// Geist body + JetBrains Mono data. Breakpoints override Tailwind
// defaults to match the mobile-first design lock (375 / 768 / 1024 /
// 1280 / 1920).
//
// Tier 1 components in Plan 116-01 will consume these tokens via
// `bg-bg-base`, `text-fg-1`, `font-display`, `md:grid-cols-2`, etc.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  // Breakpoints — explicit OVERRIDE of Tailwind defaults (NOT additive).
  // Plan 116-00 T06: 375 / 768 / 1024 / 1280 / 1920.
  theme: {
    screens: {
      sm: '375px', // iPhone SE — mobile-first basic-mode default
      md: '768px', // tablet portrait — 2-column tile grid
      lg: '1024px', // tablet landscape / small laptop — sidebar fixed
      xl: '1280px', // laptop — 3-column tile grid
      '2xl': '1920px', // desktop — 4-column tile grid
    },
    extend: {
      colors: {
        // Surfaces — CSS-var-resolved so `bg-bg-base`, `text-fg-1`, etc.
        // flip with the .dark class. Defined in index.css `:root` (light)
        // and `.dark` (dark) blocks. The `rgb(<channels> / <alpha-value>)`
        // form preserves Tailwind opacity modifiers like `bg-bg-base/50`.
        //
        // 116-UI redesign (2026-05): converted from literal hex to vars
        // so the 380+ existing token usages (`bg-bg-elevated`, `text-fg-2`,
        // etc.) flip with theme without touching every component.
        bg: {
          base: 'rgb(var(--bg-base) / <alpha-value>)',
          elevated: 'rgb(var(--bg-elevated) / <alpha-value>)',
          muted: 'rgb(var(--bg-muted) / <alpha-value>)',
          s3: 'rgb(var(--bg-s3) / <alpha-value>)',
        },
        fg: {
          1: 'rgb(var(--fg-1) / <alpha-value>)',
          2: 'rgb(var(--fg-2) / <alpha-value>)',
          3: 'rgb(var(--fg-3) / <alpha-value>)',
        },
        // Status palette — locked from 116-CONTEXT aesthetic section.
        // SLO gauges in F03 + agent tile borders consume these directly.
        // NOTE: `primary` + `destructive` are ALSO consumed by shadcn
        // primitives via CSS vars (--primary etc. in index.css). The hex
        // here is the literal "primary" Tailwind utility — keep the values
        // matched so `bg-primary` (literal #10b981) and `bg-primary`
        // (CSS-var resolved) agree visually.
        info: '#3b82f6', // blue — informational
        // 116-postdeploy fix-pass: warn + danger upgraded to theme-aware
        // CSS vars (HSL channels declared in index.css :root / .dark).
        // Tailwind utilities (`bg-warn`, `text-warn/40`, `border-danger/30`,
        // etc.) continue to compile but now flip with the active theme.
        // The remaining literals (info/gold/pink) stay hex because they
        // are not currently used in light-vs-dark-sensitive surfaces; lift
        // them to CSS vars on demand when a real contrast bug surfaces.
        warn: 'hsl(var(--warn) / <alpha-value>)', // amber — degraded / warning
        danger: 'hsl(var(--danger) / <alpha-value>)', // red — breach / errored
        gold: '#eab308', // yellow — escalation / priority
        pink: '#ff3366', // magenta — accent / SLO-breach banner highlight

        // dash-redesign (Mission Control) — new utility surface.
        // `mc-accent` is the kit's warm amber/copper "live"/heartbeat
        // accent (NOT shadcn's neutral --accent slot — that stays
        // untouched below to keep Popover/Dialog/Button hover states).
        // `mc-primary-*` are composed wash + ring colors used by tiles
        // and stat cards. `mc-bg-line` is the hairline-border token.
        //
        // These resolve via simple `var(--mc-*)` (no <alpha-value>
        // wrapping) because the underlying tokens are full colors with
        // their own alpha baked in — Tailwind's opacity modifiers won't
        // apply, but the dashboard's design lock only needs these as
        // solid colors at canonical opacity.
        'mc-accent': 'var(--mc-accent)',
        'mc-accent-fg': 'var(--mc-accent-fg)',
        'mc-accent-soft': 'var(--mc-accent-soft)',
        'mc-primary-soft': 'var(--mc-primary-soft)',
        'mc-primary-ring': 'var(--mc-primary-ring)',
        'mc-bg-line': 'var(--mc-bg-line)',
        'mc-bg-inset': 'var(--mc-bg-inset)',

        // shadcn/ui token utilities — every primitive in components/ui/
        // expects these. They resolve through the CSS variables declared in
        // index.css (`@layer base { :root { ... } }`). Using HSL channels
        // (no commas) lets Tailwind opacity modifiers work (e.g.
        // `bg-background/80`).
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
        // dash-redesign (Mission Control) — kit-scoped radii so
        // `rounded-mc-lg` etc. resolve. Independent from shadcn's
        // `rounded-lg` so primitives keep their existing radius.
        'mc-xs': 'var(--mc-radius-xs)',
        'mc-sm': 'var(--mc-radius-sm)',
        'mc': 'var(--mc-radius)',
        'mc-lg': 'var(--mc-radius-lg)',
        'mc-xl': 'var(--mc-radius-xl)',
      },
      fontFamily: {
        // Headings + display copy — Cabinet Grotesk (free, Indian Type
        // Foundry). Self-hosted WOFF2 from public/fonts/.
        display: ['"Cabinet Grotesk"', 'system-ui', 'sans-serif'],
        // Body copy — Geist (Vercel OFL). Self-hosted WOFF2.
        sans: ['Geist', 'system-ui', 'sans-serif'],
        // Numerals + code + tabular metric values — JetBrains Mono.
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
}
