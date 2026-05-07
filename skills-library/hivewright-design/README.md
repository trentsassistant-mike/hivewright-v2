# HiveWright Design System

> Crafted infrastructure for autonomous operations. Premium graphite, molten honey, honeycomb logic.

HiveWright is a B2B AI operations automation platform. Each customer's business or project is a **Hive** — a coordinated swarm of AI agents that runs end-to-end operations. The product surfaces are:

- **PWA Dashboard** — desktop + installable on mobile. The command center for monitoring agents, automations, runs, and system health.
- **Discord Executive Assistant** — agentic EA reachable through a customer's Discord workspace.
- **Voice EA** — phone-callable EA for hands-free operations.

This design system is the source of truth for HiveWright's visual language: a dark "Modern Guild" identity made of refined graphite surfaces, molten honey accents, and engineered honeycomb geometry. It is professional, premium, intelligent, operational, and warm — never soft, playful, or cute.

---

## Sources

- `uploads/hivewright design.png` → copied to `assets/brand/hivewright_moodboard.png`. The mood board provided by the founders: glossy translucent honeycomb material, the geometric hexagonal "H" mark, a graphite UI sketch with amber accents and muted sage system status, a swatch row, and several application states of the brandmark on dark / light / amber surfaces.

No codebase, Figma file, or slide deck was provided. The design system below is derived from the brief and the reference image.

---

## Index

| File / Folder | Purpose |
|---|---|
| `README.md` | This file — full guidelines, content rules, visual foundations, iconography. |
| `SKILL.md` | Front-matter for use as a downloadable Claude Skill. |
| `colors_and_type.css` | All design tokens (color, type, spacing, radius, shadow). Drop into any HTML file. |
| `fonts/` | Self-hosted webfonts (Manrope for UI, Fraunces wordmark off — see Type notes). |
| `assets/brand/` | Logo lockups, brandmark SVGs, mood board, honeycomb material textures. |
| `assets/icons/` | Fine-line construction-style icon set (SVG). |
| `preview/` | Card files that populate the **Design System** tab. |
| `ui_kits/app/` | The HiveWright PWA dashboard UI kit + interactive prototype (`index.html`). |

---

## CONTENT FUNDAMENTALS

HiveWright copy is **operational, confident, practical, and quiet**. It reads like a flight-deck checklist written by a senior engineer — never marketing, never hype.

### Tone

- **Confident, not loud.** State what is happening, what needs attention, and what to do next.
- **Operational vocabulary.** "Hive", "agent swarm", "operations map", "workflow run", "system health", "active automations", "human approval required", "suggested improvement".
- **Calm under load.** Even alerts are matter-of-fact. We do not use exclamation marks. We do not say "Oops!" or "Whoops".
- **No hype-AI language.** Avoid: "magic", "supercharged", "AI-powered" (we just say "agent"), "next-generation", "revolutionize", "unlock", "10x".
- **No emoji** in product UI. The brand uses geometric icons, not emoji.

### Voice

- **Second person, sparingly.** "Approve this run" — not "Click here to approve your workflow run".
- **Imperative for actions.** "Build a hive", "Add agent", "Pause automation".
- **Plain present tense for status.** "3 agents active", "2 runs need approval", not "There are 3 agents that are currently active".
- **No "we" in product surfaces.** The product does not narrate itself. It reports.

### Casing

- **Sentence case** for all UI strings: button labels, headings, menu items, table headers. ("Create automation", not "Create Automation".)
- **Title Case** is reserved for proper nouns: product names (HiveWright, Hive, Agent), and the names of user-defined Hives ("Acme Operations").
- **ALL CAPS** is reserved for tiny eyebrow labels and section dividers in the marketing surface only. Never on dense UI.

### Numbers + units

- Always pair a number with its unit or noun. "12 runs", "92% uptime", "3 agents active".
- Use real units: ms, s, MB, %. No vague "fast".
- Tabular figures everywhere there's a column of numbers (`font-variant-numeric: tabular-nums`).

### Examples

| Bad | Good |
|---|---|
| "🎉 Your workflow ran successfully!" | "Run 4821 completed · 1.2s" |
| "Whoops, something went wrong." | "Run failed: timeout on step 3 of 7" |
| "Supercharge your operations with AI" | "Build a hive that runs your operations" |
| "Click here to add a new automation" | "New automation" |
| "AI is thinking..." | "Agent: drafting reply" |
| "Hooray, all done!" | "Hive healthy · 0 incidents" |

### Help / empty states

State what is missing and the single action to fix it. Two short lines max.

> No automations yet.
> Build your first one to start the swarm.

---

## VISUAL FOUNDATIONS

### Mood

A premium **command center** at night. Graphite surfaces lit by molten amber. Honeycomb geometry as structural language — never decoration. Restrained glow. No stock cyberpunk neons, no purple gradients.

### Surfaces

- **Background** is near-black graphite (`#0B0C0E`) with a barely-visible 1px hex grid texture (`assets/brand/hexgrid.svg`) at ~3% opacity. The grid is structural; it is not "art".
- **Cards** sit on `#14161A` (raised) with a 1px stroke of `rgba(255,255,255,0.06)` and corner radius **12px**. Cards do **not** nest cards.
- **Input wells** sit on `#0F1114` — darker than the card they live in, reinforcing depth.
- **Hover** raises a card by lightening its stroke to `rgba(255,255,255,0.12)`. No translate, no shadow change.
- **Press** dims by 6% — not a scale change.

### Color

Three roles. Use them with discipline.

- **Graphite** (background → card → input). Steps from `#0B0C0E` → `#14161A` → `#1B1E22` → `#262A2F`.
- **Honey** (primary action, key data, brand moments). The hero is `--honey-500: #E59A1B` with a hotter `--honey-300: #FFC562` for highlights and a deeper `--honey-700: #A86A0F` for pressed states.
- **Brass** (refined linework, dividers, axis ticks). `--brass-400: #B8895A` at low alpha. Brass is for *structure*, not for filling shapes.

Plus two restrained accent roles:

- **Sage** (`--sage-400: #7E9B7E`) for *system OK / agent active*.
- **Ember** (`--ember-500: #C24A2C`) for *failures / human approval required*. Used at most twice on a screen.

Text is a warm ivory (`--ivory-50: #F2EBDD`) for primary, stepping down to `--ivory-300: #B8B0A0` and `--ivory-500: #6F6A60` for tertiary. Pure white is **banned** — it breaks the warmth.

### Typography

- **UI / body — Manrope.** Compact, geometric, readable at 13–14px in dense tables. Weights 400 / 500 / 600 / 700.
- **Wordmark / display — Fraunces.** A slightly crafted modern serif that gives the wordmark and major moments a hand-built feeling. Used for the HiveWright wordmark and rarely for top-level numbers (`92%`).
- **Mono — JetBrains Mono.** Run IDs, payload snippets, log lines.

> **Substitution flag:** the brief did not ship font files. Manrope, Fraunces, and JetBrains Mono are all loaded from Google Fonts. If HiveWright has licensed display faces (e.g. a custom modern serif for the wordmark), please drop the WOFF2 into `fonts/` and update `colors_and_type.css`.

Type scale (UI density first):

| Token | Size / line | Use |
|---|---|---|
| `--t-display` | 56 / 60 Fraunces 500 | Marquee numbers, wordmark |
| `--t-h1` | 28 / 34 Manrope 600 | Page title |
| `--t-h2` | 20 / 26 Manrope 600 | Card title |
| `--t-h3` | 15 / 22 Manrope 600 | Section header |
| `--t-body` | 14 / 20 Manrope 400 | Default copy |
| `--t-small` | 13 / 18 Manrope 400 | Tables, dense rows |
| `--t-eyebrow` | 11 / 14 Manrope 600 +0.08em tracking, uppercase | Section dividers |
| `--t-mono` | 13 / 20 JetBrains Mono 400 | Run IDs, payloads |

### Spacing

A 4px base. Tokens at `4 / 8 / 12 / 16 / 20 / 24 / 32 / 48 / 64`. Cards have 20px padding; dense tables drop to 12px row padding. Sidebar nav items are 12 / 14.

### Radii

`--r-sm: 6px` (chips, badges) · `--r-md: 10px` (inputs, buttons) · `--r-lg: 12px` (cards) · `--r-xl: 18px` (modals) · `--r-hex: 0` (geometry uses real polygon clipping, not radius).

### Shadows + glow

Two systems.

- **Elevation** (cards / modals): a single soft `0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 24px rgba(0,0,0,0.4)`. No multi-layer soft fluff.
- **Honey glow** (active node, primary button, brand mark): `0 0 0 1px rgba(229,154,27,0.35), 0 0 24px -4px rgba(229,154,27,0.45)`. Used **only** on the truly-active element on a screen — never on hover, never on more than one element at once.

### Borders

Hairlines only. `1px solid rgba(255,255,255,0.06)` for default. `rgba(229,154,27,0.45)` for selected. We never use 2px borders — the depth comes from the contrast of card→bg, not from heavy outlines.

### Backgrounds + imagery

- **Hexgrid** behind the app shell, 3% opacity. Generated from `assets/brand/hexgrid.svg`.
- **Material moments** — for marketing surfaces or brand moments only — a glossy translucent amber honeycomb texture, lit. Stored at `assets/brand/honeycomb_material.png` (placeholder until renders are supplied).
- **No stock photos** of bees, honey jars, hands, smiling people, or "AI brains".
- Imagery is warm-toned, dark, with deep shadow and amber rim light. No cool / blue tones in brand imagery.

### Animation

- **Easing default** `cubic-bezier(0.2, 0.8, 0.2, 1)` (Quint out) for all UI transitions.
- **Durations** 120ms for hover/state, 220ms for layout, 360ms max for entrance.
- **No bounces.** No springs. Operational software does not boing.
- **Honey activity pulse** — a 2.4s ease-in-out opacity pulse on the active agent's connector line, from 30% to 100%. Used on the operations map only.
- **Number tickers** count up over 600ms with `tabular-nums` so widths don't shift.

### Hover / press

- **Hover:** lighten card stroke to 12% white, lighten icon to ivory-50. No translate.
- **Press:** dim opacity to 0.94, no scale. Active button → inset 1px shadow to suggest "pushed in".

### Transparency + blur

- **Sidebar overlays + modal backdrops** use `backdrop-filter: blur(12px) saturate(140%)` over a `rgba(11,12,14,0.6)` graphite tint.
- **Inline glass** — never. We do not use frosted glass on cards or inputs. Glass is reserved for floating surfaces.

### Layout rules

- **Sidebar fixed left**, 64px collapsed / 240px expanded. Never floats.
- **Top bar fixed**, 56px tall, blends into background (no shadow, just a hairline).
- **Content max-width** 1440px on the dashboard, but cards reflow on a 12-column grid below 1280px.
- **Honeycomb geometry** appears in: the brandmark, the operations map nodes, and the empty-state illustrations. Nowhere else. Resist the urge to put hexes on every chart.

### Data-vis

- Line charts: 1.5px stroke, honey for primary series, brass for grid, ivory-500 for axis labels.
- Donuts/rings: 8px stroke, sage for healthy, honey for in-progress, ember for failed.
- Tables: zebra rows are off; rows are separated by a hairline. Numeric columns right-aligned, tabular-nums.

---

## ICONOGRAPHY

HiveWright uses a custom **fine-line construction set** — 1.5px stroke, 24×24 grid, square caps, 90° / 60° angles only (the 60° honors the hex geometry). All icons live in `assets/icons/` as SVG with `currentColor` strokes so they tint with text color.

The set covers the core nav + actions: `overview`, `hives`, `agents`, `automations`, `workflows`, `runs`, `knowledge`, `settings`, plus operational verbs `play`, `pause`, `approve`, `reject`, `add`, `search`, `bell`, `filter`, `sort`, `more`, and brand glyphs `hex`, `hex-h`, `swarm`, `honey-drop`.

> **Substitution flag:** if the team prefers an existing licensed set (Phosphor Duotone, Lucide), I can swap in CDN-loaded glyphs — see `assets/icons/README.md`. The fine-line set in this repo is a HiveWright-original drawn to match the brief.

**Emoji are not used** anywhere in product UI. Status uses sage/ember dots, not 🟢🔴.
**Unicode is used sparingly** — only for `·` (middle dot) as a separator and `→` (rightward arrow) inline in copy.

---

## VISUAL FOUNDATIONS — quick reference

```
Surfaces:   #0B0C0E → #14161A → #1B1E22 → #262A2F
Honey:      #FFC562 / #E59A1B / #A86A0F
Brass:      #B8895A
Sage:       #7E9B7E   Ember: #C24A2C
Ivory:      #F2EBDD / #B8B0A0 / #6F6A60
Radius:     6 / 10 / 12 / 18
Spacing:    4 / 8 / 12 / 16 / 20 / 24 / 32 / 48 / 64
Easing:     cubic-bezier(0.2, 0.8, 0.2, 1)
```
