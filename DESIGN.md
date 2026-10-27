---
version: alpha
name: Command Center
description: Personal automation command center — data-dense, calm, one accent. Source of truth for UI agents; apps/web/app/globals.css implements it.
colors:
  primary: "#4552d6"
  on-primary: "#ffffff"
  background: "#f4f4f8"
  surface: "#ffffff"
  foreground: "#14151c"
  muted: "#ececf3"
  muted-foreground: "#5c5f6f"
  border: "#dfe0ea"
  success: "#1f9c68"
  warning: "#a6690f"
  destructive: "#c94343"
  dark-primary: "#6673ff"
  dark-background: "#0d0f14"
  dark-surface: "#15171f"
  dark-foreground: "#e8e9ee"
  dark-muted: "#1b1e28"
  dark-muted-foreground: "#8d92a3"
  dark-border: "#262a36"
  dark-success: "#2fd191"
  dark-warning: "#e8a33d"
  dark-destructive: "#ef5b5b"
typography:
  heading:
    fontFamily: "Bricolage Grotesque"
    fontWeight: 600
    letterSpacing: -0.01em
  body:
    fontFamily: "Hanken Grotesk"
    fontSize: 14px
    lineHeight: 1.55
  label:
    fontFamily: "Spline Sans Mono"
    fontSize: 11px
    letterSpacing: 0.06em
  data:
    fontFamily: "Spline Sans Mono"
    fontSize: 13px
    fontFeature: "tnum"
rounded:
  control: 8px
  card: 12px
  section: 16px
  pill: 999px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.control}"
    padding: 8px
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.card}"
    padding: 16px
  status-on:
    textColor: "{colors.success}"
    rounded: "{rounded.pill}"
  status-failing:
    textColor: "{colors.destructive}"
    rounded: "{rounded.pill}"
  status-needs-setup:
    textColor: "{colors.warning}"
    rounded: "{rounded.pill}"
  status-paused:
    textColor: "{colors.muted-foreground}"
    rounded: "{rounded.pill}"
---

## Overview

A control room for one power user today and a few users later. Screens are scanned, not read: summary before detail, state visible at a glance, one accent color (indigo) used for actions and selection only. Light and dark are both first-class; `dark-*` tokens are the dark-theme values of the same roles.

Navigation is data-driven: sidebar groups (Money, Career, Knowledge, Life, System) and automation pages come from `automation_catalog` (`area`, `ui_route`, `ui_label`, `icon`). Never hard-code a list of automations in a component.

## Colors

- `primary` is for actions, focus rings and the selected item. Never decorate with it.
- Semantic colors (`success`, `warning`, `destructive`) carry status only and always appear with a word.
- Neutrals are slightly blue-tinted, matching the accent; do not introduce pure greys.

## Typography

Bricolage Grotesque for page and panel headings only. Hanken Grotesk for everything a user reads. Spline Sans Mono for uppercase labels, ids (`a5.mail`), times and any column of numbers (tabular figures).

## Layout

Sidebar 224px + content. Panels sit in CSS grid with `gap`, never per-element margins. Dense by default: 8–16px inside panels, 16–24px between them. Every list has a designed empty state saying what will appear and how to add the first item.

## Elevation & Depth

Three levels only:
1. **Page** — `background`, no border.
2. **Panel** — `surface` with a 1px `border`, no shadow.
3. **Floating** — command palette, popovers, menus, dialogs, sticky header: shadow plus an optional `backdrop-blur` glass fill. Glass is allowed **only** here, where text sits on a blurred copy of the page; never on data panels.

## Shapes

`control` 8px for buttons and inputs, `card` 12px for panels, `section` 16px for top-level hub cards, `pill` for status and chips.

## Components

- **Automation status**: exactly four states — on, paused, failing, needs setup — rendered as a pill with dot + word.
- **Run health strip**: last 14 runs as small bars (success / failed / no run). Pair with "last run" text.
- **Sparkline**: allowed in money and health tiles; area fill, faint baseline, emphasised last point.
- **Inbox row**: title, source automation, age; selected row gets an inset primary bar.

## Do's and Don'ts

- Do keep motion to 150–200ms ease-out on hover, press and panel open; respect `prefers-reduced-motion`.
- Do show the zone (`personal` / `business`) on every money row.
- Don't use neumorphic controls — low contrast fails on data screens.
- Don't use scroll-reveal or entrance animations inside the app; content is present at rest.
- Don't use glassmorphism on panels, tables or forms.
- Don't use emoji as icons; use lucide.
- Don't add a visual node-graph workflow builder — automations are code (Temporal workflows).
