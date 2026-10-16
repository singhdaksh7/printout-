# UI component system

Shared React/TypeScript component library for the PrintoutBuddy web app (shop dashboard and platform admin; customer screens wait for approved designs).
Source of truth for styling: `docs/design/1.pdf` (brand and design system), `2.pdf` (Platform Admin), `3.pdf` (Shopkeeper). Code lives in `apps/web/src/ui/`.

**Status.** Foundations and components are implemented, tested and shown in the development-only showcase. **Shopkeeper stage 1 (print queue and order detail) is migrated**; every other screen still uses the existing `sh-*`, `cx-*` and admin styles, which keep working. See [Migration](#migration).

## Using the library

```tsx
import { Button, TextField, Chip, Banner, Modal, DataTable } from '../ui';   // adjust the relative path
```

- Importing from `ui` loads the tokens, fonts and base CSS once; each component loads its own `.pb-*` CSS.
- New look is opt-in per screen: render inside `<div className="pb-theme">` (or `AppShell`, which does it). Everything outside stays on the old blue theme.
- Class names are `.pb-*`, tokens are `--pb-*`. Never hard-code a hex value in a component: use a token.
- Run the showcase: `pnpm dev:web`, open `/ui-showcase` (development builds only, see [Validation](#validation)).

## Tokens (`ui/tokens.css`)

All values below are from `1.pdf` p2 unless marked **DERIVED**.

| Group | Tokens |
|---|---|
| Brand | `--pb-navy #14213D`, `--pb-orange #E8772E`, `--pb-orange-ink #B04E17`, `--pb-orange-soft #FCEBDD`, `--pb-paper #FBFBF8`, `--pb-white #FFFFFF` |
| Neutral | `--pb-n50 #F6F7F9`, `n100 #EDEFF3`, `n200 #DADFE7`, `n300 #B9C1CE`, `n500 #6A7487`, `n700 #3B4558` |
| Status | `--pb-ok #1F7A4D`, `--pb-warn #9A6200`, `--pb-err #B42318`, `--pb-info #2456C9` |
| Soft status tints (**DERIVED**) | `--pb-ok-soft #E3F3EA`, `--pb-warn-soft #FDF3DF`, `--pb-err-soft #FDE8E6`, `--pb-info-soft #E5ECFB` |
| Other derived | `--pb-scrim` (navy at 55%), `--pb-shadow-2` (overlay shadow; the PDF shows the shadow, not its values) |
| Type | Rubik (display 32/700, h1 24/600, h2 18/600), DM Sans (body 15/400, label 13/600, caption 12/400), JetBrains Mono (mono 13/500), Devanagari falls back to the system font at 1.6 line height |
| Space | 4 8 12 16 (phone gutter) 24 (card gap) 32 48 (section) as `--pb-space-1..7` |
| Radius | `--pb-radius-sm 6` (skeleton), `md 10` (buttons, inputs), `lg 16` (cards, modals) |
| Layout | sidebar 232px, content max 1200px, gutters 16px (phone) / 24px (768px and up), 44px minimum target |
| Motion | 150ms state changes, 250ms drawers and sheets, new-row highlight 4s; all motion off under `prefers-reduced-motion` |

Fonts are self-hosted (`ui/fonts/`, latin subset, variable woff2) under the SIL Open Font License 1.1; the licence texts sit next to them. Icons are copied from Lucide (ISC) into `ui/icons/nodes.ts`; the licence is in `ui/icons/LICENSE-lucide.txt`. No runtime dependency was added for either.

### Contrast review of derived values

Computed with the WCAG 2.1 formula; the tests in `ui/__tests__/foundations.test.tsx` enforce them.

| Text on background | Ratio |
|---|---|
| ok on `ok-soft` | 4.63 |
| warn on `warn-soft` | 4.63 |
| err on `err-soft` | 5.59 |
| info on `info-soft` | 5.45 |
| orange-ink on `orange-soft` | 4.58 |
| navy on orange (button label) | 5.41 |
| n500 on white | 4.71 |
| **n500 on n50** | **4.39 (fails AA for small text)** |
| n500 on n100 | 4.09 (fails) |

The design's n500 secondary text only passes on white. Components therefore use `var(--pb-text-secondary)`: n500 on white surfaces (cards, tables, modals, inputs) and n700 on the n50 canvas, on tinted rows and inside the segmented track; inside banners it inherits the banner colour. Use `.pb-caption` / `.pb-muted` for secondary text and the variable resolves itself.

### Known deviations from the PDFs (for design review)

- **Chip radius.** The token card says chips use `sm 6`, but every printed chip is a fully rounded pill. The code follows the printed chips (pill).
- **Soft tints** are derived (above); the PDF shows them but does not give hex values.
- **Banner icons** are included (the Shopkeeper screens show them, the design-system card does not).
- **Banner `steps`** render as a vertical list; the Shopkeeper offline banner shows three columns. Easy to change per screen.

## Components

Every component is TypeScript-typed, uses native elements, and has tests in `ui/__tests__/`.
"States" lists what is implemented and covered. All are shown in the showcase.

### Actions

| Component | API | Variants / sizes | States and accessibility |
|---|---|---|---|
| `Button` | native button props + `variant`, `size`, `fullWidth`, `loading`, `iconStart`, `iconEnd`; forwards ref | `primary` (orange, navy label), `dark`, `outline`, `ghost`, `danger`; `sm` `md` `lg` | hover, active, focus-visible, disabled, loading (keeps width and label, `aria-busy`, ignores click, Enter, Space and form submit while staying focusable). `type` defaults to `button`. `sm` keeps a 44px hit area. One `primary` per screen. |
| `buttonClass()` | `{ variant, size, fullWidth, className }` | same | Use on `<Link>` or `<a>` that must look like a button. |
| `IconButton` | `icon`, `label` (required), `variant` `ghost`/`outline`, `size` `sm`/`md` | | `aria-label` + title, 44px target, disabled |
| `SegmentedControl` | `label`, `options[{value,label,count?,disabled?}]`, `value`, `onChange`, `size` | `sm` `md` | native radios: Tab enters, arrows move and select; counts; disabled options |
| `Tabs` | `label`, `tabs[{key,label,count?,disabled?}]`, `value`, `onChange`, `idPrefix`, `panelId?` | pill track | WAI-ARIA tabs (automatic activation): selected tab is the only Tab stop, Left/Right wrap and skip disabled tabs, Home/End; tab ids `${idPrefix}-tab-${key}` for the panel's `aria-labelledby`. Use for filters over one panel; use `SegmentedControl` for a plain setting. |

### Inputs

| Component | API | States and accessibility |
|---|---|---|
| `TextField` | `label`, `helperText`, `error`, `startAdornment`, `endAdornment`, `mono`, `hideLabel`, `density` `md`/`compact`, native input props, ref | label bound by generated unique id (never derived from the label text), `aria-describedby` = helper or error (plus any you pass), `aria-invalid`, error `role="alert"`; empty, filled, focus, invalid, disabled, readonly, required |
| `TextArea` | same without adornments | same |
| `Select` | `label`, `helperText`, `error`, `hideLabel`, native `<option>` children | same; native select |
| `Checkbox` | `label`, `hint`, `indeterminate` | native checkbox, 44px row, hint as description |
| `RadioGroup` | `legend`, `options[{value,label,description?,tag?,disabled?,locked?}]`, `value`, `onChange`, `variant` `list`/`card`, `error` | fieldset + native radios (arrow keys); `locked` options are disabled, show a lock and are announced "(locked)" |

### Status

| Component | API | Notes |
|---|---|---|
| `Chip` | `tone` `neutral` `info` `orange` `ok` `warn` `err`, `size` `sm`/`md`, `dot` | Always a `span` with visible text; never interactive. |
| `Badge` | `tone` `neutral` `orange` `err` `warn`, `onDark`, `caps` | counts, "Pro", "Due", SAMPLE |
| `Spinner` | `size`, `label?` | decorative unless labelled; only inside the control that was pressed |
| `ProgressBar` | `value`, `label` (required), `tone`, `size`, `onDark` | `role="progressbar"`, value clamped 0-100; only for real progress |

### Feedback

| Component | API | Notes |
|---|---|---|
| `Banner` | `tone` `info` `ok` `warn` `err` `orange`, `title`, `icon`, `steps`, `actions`, `onDismiss`, `layout` `box`/`bar` | errors `role="alert"`, others `role="status"`. `steps` are numbered and laid out in up to three columns from 768px, stacked below (as in `3.pdf` p14). |
| `ToastRegion` | `message` | polite live region, always mounted; navy toast |
| `useToast()` | `show(message)`, `node` | `show` then render `node` once; clears itself (default 4 s) |
| `Skeleton` | `variant` `text`/`block`, `lines`, `width`, `height`, `label` | text variant is a labelled `aria-busy` region; block is decorative |
| `EmptyState` | `icon`, `title`, `titleAs` `h2`/`h3`/`h4`, `children`, `action`, `callout` | one action at most; pick the heading level that fits the page |

### Layout, overlays, data, navigation

| Component | API | Notes |
|---|---|---|
| `Card`, `CardHeader` | `as`, `padding`, `accent` `warn`/`err`; header `title`, `as` h2-h4, `meta`, `actions` | no shadow (overlays only) |
| `StatTile` | `label`, `value`, `hint`, `accent`, `tag`, `loading` | `tag="Sample"` for placeholder numbers |
| `KeyValueList` | `items[{label,value,mono?,strong?}]`, `layout` `inline`/`stacked` | `dl`; `strong` emphasises a total row |
| `Timeline` | `items[{time,children,tone?}]` | `ol` |
| `Modal` | `title`, `footer`, `tone` `default`/`danger`, `size`, `eyebrow`, `initialFocusRef`, `busy` | mount = open; traps focus; Escape and scrim close unless `busy`; returns focus |
| `Drawer` | `title`, `header`, `footer`, `initialFocusRef`, `busy` | right panel (full screen on phones), same focus handling |
| `DataTable` | `columns`, `rows`, `getRowKey`, `caption`, `selectedKey`, `highlightKeys`, `onRowClick`, `loading`, `loadingLabel`, `empty`, `renderCard`, `cardsBelow`, `rowAttributes` | captioned table in a keyboard-scrollable region; cards below 768px when `renderCard` is given (never both in the DOM); skeleton rows; row click ignores clicks on inner buttons |
| `LoadMore` | `hasMore`, `loading`, `onClick`, `error`, `endLabel`, `summary` | cursor pagination control |
| `Sidebar`, `BottomNav`, `TopBar`, `AppShell` | `NavItem {to,label,icon,end,count,showZero,tag,alert,comingSoon}`; `onNavigate` can cancel (unsaved-changes guard) | `comingSoon` items are not links and are announced as such; sidebar becomes an icon rail at 768-1023px, `BottomNav` replaces it under 768px; skip link and `main` landmark |
| Charts | `BarChart`, `HBarList`, `HeartbeatStrip`, `SegmentedBar` | SVG/CSS, no dependency; each has a text alternative (hidden data table, list text, or summary) |

### Domain presentation (`ui/domain`)

Thin wrappers that only word and colour values the caller already has: no fetching, no business rules.

| Component | Purpose |
|---|---|
| `JobCode` | job code in mono (`row`) or Rubik 32 (`display`) |
| `JobStatusChip` | design vocabulary: Queued, Printing, Printed, Failed, Expired, Cancelled, Deleted, Paper out |
| `OrderStatusChip` | adapter for today's API values. **Wording is unchanged** (`Print started`, `... (legacy)`) because the API does not confirm physical printing; a test keeps it equal to the shop's `STATUS_LABEL`. |
| `ShopStatusChip`, `PresenceChip` | shop/subscription status; device and printer presence |
| `RetentionNotice` | "Auto-deletes at 12:42" from a server deadline; renders nothing without one. Policy minutes stay server-owned (`lib/retention.ts`). |
| `FileDeletedLine` | "✓ File deleted 11:31:20" |

### Not built (no verified use yet)

`Stepper` (agent setup is out of scope), `CodeField` (OTP/2FA out of scope), `FilterChip`, `PlanCard`, numbered `Pagination`, `Logo` (approved source files not supplied). Add them when a screen needs them.

## Migration

The library is additive. Screens keep their current markup until migrated, one family at a time, each as its own commit:

1. Shop: **done**: queue, order detail, rate card, QR and standee, devices, analytics (the app's History-type screen; the design's History table needs an endpoint that does not exist), settings, shell and sign-in. Staff and Reports appear in the sidebar as non-interactive "Soon" items.
2. Platform Admin: **done**: shell, dashboard, shops, shop detail, orders metadata, plans, subscriptions, audit log and sign-in. No 2FA, agent monitoring, support sessions or deletion audit (no backend).
3. Customer: after approved designs are supplied.

### Stage 1: print queue and order detail (migrated)

`shop/QueuePage.tsx`, `shop/OrderDetailPage.tsx`, styled with `shop/pb-pages.css`. Same routes (`/shop`, `/shop/orders/:id`), API calls, polling, realtime refresh, sound, retention countdowns, print/reprint/save/cancel behaviour and status wording. Built from `DataTable` (rows on desktop, cards below 768px), `Tabs`, `OrderStatusChip`, `Button`, `Banner`, `Modal`, `EmptyState`, `Card`, `KeyValueList`, `Timeline`, `LoadMore`, `useToast`.

Deliberate differences from `3.pdf` (backend or scope, not omissions by accident):

- **No stat tiles, printer/agent pill, pilot card, Staff/Reports/Billing/History nav, "Sound on" header control or logo.** There is no data behind them (printed-today and pages-today counts, printer health, plans), or they belong to the shell, which is the next stage. Nothing is faked.
- **Status vocabulary is the API's** (`New`, `Print started`, `Print confirmed (legacy)`, ...), not Queued/Printing/Printed, because the API does not confirm physical printing. `JobStatusChip` (design wording) exists but is not used until the API can back it.
- **Order detail is a page, not a drawer.** Keeping the route preserves deep links, the "Back to queue" link and the existing end-to-end flows; it is also what `3.pdf` p24 shows on phones. `Drawer` is available for a later decision.
- **The cancel dialog has no reason list.** The API's cancel transition takes no reason, so asking for one would not be honest.
- **Save file** stays next to Print (it is an existing feature the design does not show).
- **Tabs** are the real filters (New / Recent / Cancelled / expired), not Active / All today.

Rules: keep routes, API calls, auth and business logic as they are; features without a backend render as `comingSoon` or not at all (never fake live); keep `shop/components.tsx` and `admin/ui.tsx` exports working by re-exporting from `ui/` so imports do not break mid-migration.

## Validation

| Check | Command | Covers |
|---|---|---|
| Types | `pnpm --filter @printout/web check` | all of `apps/web` |
| Unit and component tests | `pnpm --filter @printout/web test` | roles, keyboard, loading, ids and descriptions, token values and contrast, showcase smoke test |
| Production bundle | `pnpm --filter @printout/web build && pnpm --filter @printout/web verify:bundle` | fails if the showcase leaks into `dist` (negative-controlled against a development build) |
| UI browser checks | `pnpm e2e:ui` | axe WCAG 2.1 A/AA at 1280, 855 and 375px, with the modal and drawer open; fonts load; focus ring; focus trap; reduced motion; no horizontal scroll; screenshots into `e2e-ui/artifacts/` |
| App end-to-end | `pnpm e2e` | existing suites plus `09-shop-stage1-ui` (axe on the migrated region and screenshots of every queue/detail state at 1440 and 390px). Needs Docker Postgres: it truncates the private `printout_e2e` database only. If port 55433 is unavailable (Windows can reserve it) run `E2E_DB_PORT=<port> E2E_PG_CONTAINER=<disposable postgres container> pnpm e2e` against a throwaway database with the migrations applied. |

Screenshots are reviewed by eye against the matching PDF page (same widths: 1280 desktop, 855 tablet as in `2.pdf` p20, 375 phone as in `3.pdf` p23-24); the designs use sample data, so layout, spacing, colour and type are compared, not pixels.

## Adding or changing a component

1. Check the inventory above and the PDFs: only build what a design shows and a screen needs.
2. Use tokens and `.pb-*` classes; no hex values, no new dependency.
3. Native semantics first; label, description and error wiring through `ui/inputs/FieldFrame`; focus through `useFocusTrap` for overlays.
4. Add tests (role/name queries, keyboard), add it to the showcase, run `pnpm e2e:ui`.
5. Document API, variants and states here.
