# Design: Viewer Reading Width — 120ch Fixed + Quick Toggle

Project: `loom-reading-width-120ch` (Atelier project id 9) · Author: priya-pm · 2026-06-12

## 1. Goal

The Viewer's fixed reading width becomes 120 characters of the content font, and the user can flip between fixed and full-width from the Viewer header or a keyboard shortcut, with the choice persisted.

## 2. Scope

- **Fixed width = `120ch`**: replace the `.md { max-width: 792px }` rule (renderer.css:1237) with `max-width: 120ch` (the `ch` unit tracks the content font, so code samples inside markdown fit ~120 monospace columns and prose gets an equivalent measure). `margin-inline: auto` centering stays.
- **Width mode now applies to ALL viewer content, not just markdown**: source-code/plaintext files currently ignore the setting (no `data-mdwidth` on their wrapper). The fixed/full mode will cap them at `120ch` of the code font too, centered, so "the content display" toggles consistently for every file type. (Flagged as a deliberate behavior extension.)
- **Quick toggle**:
  - A Viewer-header button (mirroring the `copy-rendered-btn` idiom: `type="button"`, title `"Reading width: fixed/full (Ctrl/Cmd+Shift+W)"`, aria-pressed, inline SVG icon) that flips `fit ↔ full`.
  - A new rebindable command `toggleReadingWidth`, default `Ctrl+Shift+W` (verified collision-free vs DEFAULT_BINDINGS, RESERVED_COMBOS, PLATFORM_CRITICAL_COMBOS), wired through the existing dispatcher.
  - Both routes call the existing `setMdWidthMode` (state + `persistMdWidth` localStorage), announce via the polite live region, and keep the Settings-panel radio group in sync (it reflects the same state).
- **Settings panel label**: "Fixed (792px)" → "Fixed (120 ch)"; announcement text updated likewise.
- **Tests**: update `test/md-width.mjs` pins; bump `acceptance.mjs` COMMANDS pin 10→11; new pins for the command's default binding + no-collision; e2e addition to the existing reading-width coverage (toggle via button flips `data-mdwidth`).

## 3. Non-goals

- No per-file-type or user-configurable width value (120ch is the one fixed measure; no numeric input).
- No change to the `loom.viewer.mdWidth` storage key or the `'fit' | 'full'` value vocabulary (no migration needed; existing persisted values keep working).
- No main-process/IPC involvement (stays pure-renderer localStorage, as today).
- No change to chat pane or terminal rendering widths.

## 4. Acceptance criteria

1. A markdown file in fixed mode renders content capped at `120ch`, centered (boolean — CSS + e2e attribute check).
2. A source-code file in fixed mode is likewise capped at `120ch` of the code font (boolean — new behavior).
3. Clicking the Viewer-header toggle flips fixed↔full instantly and the button's pressed state + title update (boolean).
4. `Ctrl+Shift+W` does the same from anywhere outside editable targets (boolean).
5. The choice survives app restart (localStorage, existing mechanism) (boolean).
6. The Settings panel radios reflect toggles made via button/shortcut and vice versa (boolean).
7. COMMANDS count = 11; all gates (`typecheck`, `build`, `npm test`) green (boolean).

## 5. Constraints

- Pure renderer change; no IPC/CSP/main edits.
- Follow existing idioms: md-width.ts pure helpers, Viewer header button pattern, keybindings COMMANDS append, live-region announcements, WCAG AA (aria-pressed, focus-visible).
- `ch` rule must not break the `?mdwidth=` capture hint or existing e2e.

## 6. Stakeholders

- **nitekeeper (product owner)** — requested 120-char measure + quick toggle.
- **Future maintainers** — Settings/keybindings surfaces must stay consistent.

## 7. Dependencies / Prerequisites

- Existing md-width machinery (PR #5) and merged main at `3ed2bcc`. None external.

## 8. Risks / Unknowns

- **`ch` in proportional prose fonts** is the width of "0", so 120ch of prose is wider than 120 average glyphs — accepted: it is the standard CSS interpretation of the user's choice ("120ch of the content font").
- **Code-file capping is new behavior** — if the user dislikes capped code, the toggle (or Settings) restores full width in one click. Accept.
- **Ctrl+Shift+W proximity to Ctrl+W (close window)** — soft risk of mistyping; mitigated by it being rebindable and not destructive. Accept.

## 9. Success metrics

- All 7 acceptance criteria pass; user confirms the toggle feels right in the installed build (boolean).
