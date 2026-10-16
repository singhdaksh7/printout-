# Web UI primitive contract: Button, TextField, Chip

> **Superseded for the web app.** The approved design PDFs (`docs/design/1.pdf`, `2.pdf`, `3.pdf`) now define the styling, and the implemented library in `apps/web/src/ui/` (documented in `docs/UI_COMPONENT_SYSTEM.md`) defines the components, variants and states. This file is kept as the earlier working contract; where it differs (for example the Chip contract), follow the library docs. Android Compose still needs its own native equivalents.

**Source separation:** PDF pages 3–5 show customer/shop/admin **flows**, but do not prescribe component variants or a design system. Component names/variants below are **proposed working standards** based on the user's explicit three-component request and the Codex UI audit, pending design approval. Implement in React for the web; Android Compose needs separate native equivalents.

## Shared design rules
- Prefer semantic HTML/native button and input, consistent CSS custom properties/tokens.
- Clearly labeled keyboard focus, disabled states, touch-friendly control sizing and high contrast.
- Don't break submit vs click semantics (`type=button` by default for non-submit controls).
- Keep domain states (PrintJob/ShopStatus) out of primitive appearance components; map through adapters.
- Avoid a single global CSS rewrite; migrate one screen family and test before the next.

## Button
- Props: native `ButtonHTMLAttributes`, `variant`, `size`, `loading`, `fullWidth`, `children`, optional ref.
- Proposed variants: `primary`, `secondary`, `outline`, `ghost`, `destructive`.
- Proposed sizes: `sm`, `md`, `lg`.
- States: hover, active, `:focus-visible`, disabled, loading; loading disables activation, accessible label remains available.
- Test: native type, forwardRef, click, keyboard, busy/disabled, preventing double-submit and no accidental form submission.

## TextField
- Props: `id?`, `label`, `helperText?`, `error?`, native input props and forwarded ref.
- Proposed input types: text/email/password/number; support standard and compact density if design requests it.
- States: empty/filled, focus, invalid, disabled, readonly, required.
- Generate stable unique IDs when not provided; `aria-describedby` must reference error/helper; `aria-invalid` true when error. Never derive IDs from label text alone.
- Test: associated label, errors, helper descriptions, controlled/uncontrolled usage, focus/keyboard, required and ref.

## Chip
- Separate **noninteractive status** from **interactive filter** usage; never make informational status chips button-like by accident.
- Props: `tone` (neutral/info/success/warning/danger), `size` (sm/md); filter version receives `selected`, `onClick`, disabled.
- Maps for print-job/document/device/subscription statuses belong in separate adapters.
- Test: semantic span for status; button for filter; `aria-pressed` and disabled state for filters; keyboard operation.

## Component examples
See `templates/ui/` for three standalone TSX + CSS source examples. These templates are a starting point, **not** changes in the user's Git repository. Review tokens/colors with approved UI before integration.
