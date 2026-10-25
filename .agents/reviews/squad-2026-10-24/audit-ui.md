# OpenPark UI/UX audit: apps/web + packages/ui

Track: UI/UX (`audit-ui-shadcn`). Date: 2026-10-24. Branch: `squad/2026-10-24`. Read-only audit: nothing in the repo was edited except this file.

## 0. How this was done, and what it does not prove

- Read in full: `AGENTS.md`, `README.md`, `components.json`, `package.json`, `vite.config.ts`, `styles.css`, `packages/ui/src/*`, every file in `src/components/` and `src/components/ui/` that matters (button, input, native-select, badge, alert, card, table, tabs, sheet, checkbox, label, empty, skeleton, spinner, sidebar excerpts), `main.tsx`, `App.tsx`, `menu.ts`, `app-context.tsx`, `api.ts`, `offline.ts`, `i18n.tsx` excerpts, and every screen under `src/screens/` (Attendant, Resident, People, Parking, Integrations, Auth, Bulk, Inventory, Platform, Rates, Settings, GuestPasses, GuestPass, Sessions, Slots, Dashboard, Queue). Skimmed `ARCHITECTURE.md` (UI, i18n, RTL, screens) and `docs/DOMAIN.md`.
- Taste rules applied as review criteria: `antislop.md` (core), `skills/antislop-ui/SKILL.md`, `skills/antislop-layoutmobile/SKILL.md`. Rule IDs (R-xx) are cited where a finding maps to one.
- antislop mode notice: the mode was unresolved (no session choice, no `~/.config/antislop/settings.json`) and the standing autonomy policy forbids asking. I used the audit ("after") style: numbered findings, severity, rule citation, no edits. This is not a claimed session override or global preference.
- Measured, not guessed: contrast ratios were computed from `tokens.css` and the `styles.css` overrides (script, light and dark); `pnpm --filter @openpark/web check:css` passes today (`css: logical properties only`); counts of class usage come from grep over `src/screens` and `src/components`.
- NOT done: the app was not run, no screenshots, no device or screen-reader testing, no Playwright. Pixel math (e.g. keypad key width) is derived from the CSS. Cascade-order claims (UI-01) follow Tailwind v4 layer semantics (unlayered CSS beats `@layer` utilities); WP-0 step 1 must confirm in DevTools before the bulk migration.
- `work_brief` returned an identity error (session not bound to a ledger), so the acceptance text is the dispatch message: findings with ID, severity, file:line, exact fix, shadcn add list, parallel work packages, written to this path. `work_report` was therefore not attempted.
- No `DESIGN.md` exists (see UI-17), so "taste" findings are judged against the existing tokens (green accent `#0f7a4b`, neutral surfaces) and the antislop filter, not against an owner-written direction.

## 1. Executive summary

The app is mid-migration. shadcn/ui (style `base-nova`, Base UI primitives, Tailwind v4, `rtl: true`) is installed, and most screens import `Button`, `Input`, `Card`, `Alert`, `Badge`, `Table`, `NativeSelect`. But the screens are still laid out and styled by a 242-line hand-written `styles.css` (`.btn`, `.card`, `.pill`, `.banner`, `.field`, `.row`, `.stack`, `.tablewrap`, `table`, `input`, ...). Counts: 106 `Button` usages carry the legacy `btn` class, 43 `Card` carry `card`, 60 `Alert` carry `banner`, 15 `Badge` carry `pill`, 91 `<label class="field">`, 90 `.row`, 36 `.stack`; the screens use essentially zero Tailwind utilities (2 in total). Because that CSS is unlayered and Tailwind utilities live in a cascade layer, the legacy rules win, so `variant`/`size` props on `Button` and utility overrides on `Table*` are dead in practice (UI-01..UI-05).

Seven themes drive almost everything else:

1. Cascade inversion plus class stacking (UI-01..UI-05, UI-11, UI-12): finish the migration, delete the legacy layer.
2. shadcn primitives that exist but are not used, and hand-rolled replacements that are subtly wrong: `Dialog`/`Sheet`/`Tabs`/`DropdownMenu`/`Empty`/`Skeleton`/`Spinner`/`Label` have 0 importing screens. Hand-rolled instead: tab toggles, listbox/combobox with invalid ARIA, bottom-sheet keypad, disclosure, `window.confirm`/`prompt`, banners (UI-38, UI-61..UI-64).
3. Destructive actions with no confirmation (8 delete/revoke/remove paths) and 4 native `confirm()`/`prompt()` calls (UI-38).
4. No information architecture for admin CRUD: `Parking.tsx` is one 263-line page for sites, zones, slots and community settings; edit state lives in `useState`, not in the URL; create forms are always open above the table; no sorting, filtering or pagination anywhere (UI-29, UI-39..UI-41).
5. The connection/sync indicator is hidden when online, has no "syncing" state, is mounted twice (two independent flush loops), and the "Synced N" note never clears (UI-19).
6. Attendant touch ergonomics: the plate keypad keys are about 29 px wide on a 360 px phone; checkboxes in attendant forms are 16 px; three navigation systems at once; the custom keypad sheet opens on focus on top of the native keyboard (UI-25, UI-60..UI-67).
7. Quality gaps: dark-mode variants never fire (`dark:` is class-based, the app uses `prefers-color-scheme`), RTL gaps the CSS guard cannot see (glyph carets, translate transforms), color-only state signals, glyph icons (`⚠ ↻ ▸ ▾ ✕ ⌫ ●`), device-timezone dates, raw `TypeError: Failed to fetch` strings.

### Findings by severity

76 findings: 0 Critical, 16 High, 44 Medium, 16 Low (table and ID lists at the end of section 9).

### Recommended order

WP-0 (foundation, one owner, blocking) then WP-1..WP-6 in parallel (disjoint file ownership), then WP-7 (tests, locales, guards). Details in section 8.

---

## 2. Foundation: design system, tokens, CSS

### UI-01 · High · Unlayered legacy CSS silently overrides Tailwind/shadcn utilities
- Evidence: `src/styles.css:1` imports Tailwind (utilities live in `@layer utilities`), then `styles.css:72-242` is unlayered: element selectors `table` (115), `th, td` (116), `input, select, textarea` (123), `input:focus-visible...` (125) and component classes `.btn` (126), `.card` (104), `.pill` (108), `.banner` (132), `.tablewrap` (114). Unlayered rules beat layered ones regardless of specificity or order.
- Effect: `TableCell`'s `p-2`/`whitespace-nowrap`, `Input`'s `rounded-lg`/`px-2.5`, `Button` `bg-primary`/`rounded-lg`/`h-11` are overridden wherever the legacy selector matches; `.btn.primary` and `.btn.danger` exist only to re-create what `variant` already does. `.showpw input` (150) exists only to undo the global `input` rule for the checkbox's hidden input.
- Fix (WP-0 step 1): confirm in DevTools, then wrap everything from `styles.css:72` to `:241` in `@layer components { ... }` (utilities then win), keeping `:root`/token blocks outside. Visual diffs in this step are the intended migration; screens are then converted file by file (UI-02..UI-05, UI-11) and each deleted legacy class is removed from `styles.css`. End state: `styles.css` holds only `@import`s, `@theme inline` mapping, `@layer base` resets, and the plate/capacity-bar rules that have no shadcn equivalent.

### UI-02 · High · `Button` is wrapped in legacy `btn` classes (106 of 120 usages)
- Evidence: e.g. `Parking.tsx:98,169,199,200,209,217,246`, `People.tsx:101,111,124,134-137,147,151,179,327-328,350-352,368-369`, `Attendant.tsx:217-218,351,357,360,380,407,561,612-613,749,773-776`, `Integrations.tsx:55,64,85,95-96`, `Platform.tsx:66,80-82`. Patterns: `<Button className="btn primary">`, `<Button variant="destructive" className="btn danger">`, `<Button variant="outline" className="btn">`. `variant` and `className` disagree (variant="default" plus `btn` renders a neutral button).
- Fix: replace with real variants only: primary action `<Button>`, secondary `variant="outline"`, tertiary `variant="ghost"`, destructive `variant="destructive"`; sizes via `size`. Attendant "big" buttons become a new `size="touch"` (`h-14 text-lg w-full`). No `className="btn..."` may remain (WP-7 adds a grep gate). Add `loading` prop to `Button` (renders `Spinner`, sets `aria-busy`, `disabled`) to replace the repeated `disabled={busy}` and give pending feedback.

### UI-03 · High · `Card` is stacked with `.card` (43 usages), double chrome
- Evidence: `Dashboard.tsx:37-40`, `Sessions.tsx:57`, `Queue.tsx:25,30`, `Parking.tsx:64,95,166,206,240`, `People.tsx:103,116,142,163,301,321`, `Platform.tsx:62`, `Attendant.tsx:162,221,356,768`, `Resident.tsx:201,221,257,362`. shadcn `Card` brings `ring-1 ring-foreground/10 rounded-xl py-(--card-spacing)`; `.card` adds `border`, `box-shadow`, `border-radius: 10px`, `padding` (styles.css:104). `className="card row"`/`"card stack"` also works only because `.row` (unlayered, `display:flex`) beats Card's `flex-col`.
- Fix: delete `.card`. Use `Card` / `CardHeader` / `CardTitle` / `CardDescription` / `CardContent` / `CardFooter` (`CardAction` for the header action). Cards that are only layout wrappers around a form become plain `<form className="grid gap-4">` inside a page section; reserve `Card` for things that are real objects (a site, a pass, a stat). Forms in Cards use `render={<form ...>}` as today.

### UI-04 · Medium · `Alert` carries a parallel `.banner` system (60 usages) and conflicting variants
- Evidence: `variant="destructive" className="banner warn"` in `GuestPass.tsx:31,39` (two meanings at once); `Alert className="banner bad" variant="destructive"` in `Invitations.tsx:17,37`, `QueryState.tsx:23`; `Alert className="banner"` for info everywhere (`Settings.tsx:36`, `Slots.tsx:56`). `alert.tsx:9-14` has only `default` and `destructive`; the `default` variant gives no hue, which is why the legacy classes were kept.
- Fix: extend `alert.tsx` with `variant: default | info | success | warning | destructive` using token pairs (`bg-info-soft text-info`, etc., see UI-07), a leading icon slot (lucide `Info`, `CircleCheck`, `TriangleAlert`, `CircleAlert`), and use `AlertTitle`/`AlertDescription`. Only the `destructive` and live-region ones keep `role="alert"`; informational and success use `role="status"` (the base `Alert` hard-codes `role="alert"` at `alert.tsx:30`, which makes every info banner an assertive announcement; add a `role` prop default derived from variant).

### UI-05 · Medium · `Badge` is wrapped in `.pill` plus ad-hoc color classes (15 usages)
- Evidence: `Sessions.tsx:49`, `Dashboard.tsx:33,61`, `Platform.tsx:80`, `Slots.tsx:52`, `GuestPasses.tsx:73`, `People.tsx:133,345-346`, `Integrations.tsx:63,94`, `Rates.tsx:51`, `SyncBadge.tsx:57`, `Resident.tsx:80,222,263`.
- Fix: add Badge variants `success | warning | info | destructive | neutral` in `badge.tsx` (token pairs; contrast checked in section 7), a `dot` prop only for real states, and a `StatusBadge` helper (`<StatusBadge kind="session" value="open" />`) so status to variant mapping lives once (session open/closed/void, slot available/reserved/out_of_service/occupied, pass status, key active/revoked, webhook active/paused). Always icon plus text for state (never color alone).

### UI-06 · High · Dark-mode variants are dead; theme is OS-only with no control (R-34)
- Evidence: `styles.css:8` `@custom-variant dark (&:is(.dark *))` while tokens switch via `@media (prefers-color-scheme: dark)` (`tokens.css:30`, `styles.css:15`). Nothing ever adds a `.dark` class (grep: no `classList` toggling). Yet 10 files under `components/ui/` contain `dark:` utilities (`input.tsx`, `button.tsx`, `native-select.tsx`, `checkbox.tsx`, `badge.tsx`, `textarea.tsx`, ...), so e.g. `dark:bg-input/30`, `dark:hover:bg-muted/50`, `dark:aria-invalid:*` never apply in OS dark mode.
- Fix: choose one mechanism. Recommended: keep OS-follow plus an explicit user override: `@custom-variant dark (&:where(.dark, .dark *))`, a tiny `ThemeProvider` (`light | dark | system`, persisted in `localStorage` key `op.theme`, sets `.dark` on `<html>` and `color-scheme`), and move the dark token block from `@media` to `.dark { ... }` plus a `@media (prefers-color-scheme: dark) { :root:not(.light) { ... } }` fallback. Add a theme item to the user menu (UI-24). This is the R-21 "build the toggle" path.

### UI-07 · Medium · Token definitions are duplicated, diverge, and collide with shadcn names (R-29, R-31)
- Evidence: `--warn` is `#b45309` in `tokens.css:15` but `#a34b07` in `styles.css:11` (and `#f2a54a` twice); `--font-sans`/`--font-mono` defined in `tokens.css:3-4` and again in `styles.css:23-25`; `--radius-sm` is `6px` in `tokens.css:23` but `calc(var(--radius) * 0.6)` = 6px by coincidence in `@theme` (`styles.css:57`); `--color-accent: var(--surface-2)` (`styles.css:38`, shadcn "accent" = subtle hover) while the brand color is `--accent` (`tokens.css:12`), so `bg-accent` is grey and `text-accent`/`a { color: var(--accent) }` (`styles.css:77`) is green. `--color-ring: var(--info)` (blue) while the brand is green.
- Fix: make `packages/ui/src/tokens.css` the only token source and name tokens by the shadcn semantic scheme (`--background`, `--foreground`, `--card`, `--primary`, `--primary-foreground`, `--muted`, `--muted-foreground`, `--accent`, `--destructive`, `--border`, `--input`, `--ring`) plus app additions (`--success`, `--warning`, `--info` and their `-soft` pairs, `--radius`). `styles.css` then only maps `@theme inline` one-to-one. Single place for `--warn`. Link color: use `text-primary underline underline-offset-4` via a `Link` style, not a global `a` rule. Marketing site imports the same `tokens.css`, so coordinate with that owner (outside this track) before renaming.

### UI-08 · Medium · Typography is inconsistent and unexplained (R-06, R-31)
- Evidence: `body` uses the system stack (`styles.css:74`) but `.shell` switches to `'Geist Variable'` (`styles.css:85`), so Auth, Attendant, Resident and Guest pass pages render in a different font from the admin shell; `@fontsource-variable/geist` is a dependency. Roughly 14 distinct hand-set sizes (0.7, 0.78, 0.8, 0.85, 0.875, 0.9, 0.93, 1, 1.1, 1.15, 1.25, 1.5, 1.6, 2, 3 rem) across `styles.css`; `h1/h2/h3` are global element rules (`styles.css:75-76`); `.feetotal` (2rem/800) is reused for a countdown (`Resident.tsx:229`, `GuestPass.tsx:45`).
- Fix: pick one family for the whole app and write the reason in `DESIGN.md` (UI-17). If Geist is kept it must load everywhere (set on `html` via `@theme inline --font-sans`), not only inside `.shell`; antislop lists Geist/Inter as the AI-default roster, so a one-line reason is needed. Define a 6-step scale in `@theme` (`text-xs 12`, `sm 14`, `base 16`, `lg 20`, `2xl 32`, `display 48`) and map: page title `text-2xl font-semibold`, section `text-lg font-medium`, stat `text-4xl tabular-nums`. Provide `<H1>`/`<H2>` primitives (or classes in `PageHeader`) instead of global element rules. Rename `.feetotal` usage to the stat style.

### UI-09 · Low · Two focus indicators on the same element
- Evidence: global `input:focus-visible, select..., button:focus-visible, a:focus-visible { outline: 3px solid var(--info); outline-offset: 2px }` (`styles.css:125`) plus shadcn `focus-visible:ring-3 ring-ring/50` and `outline-none` on `Button`/`Input` (`button.tsx:7`, `input.tsx:12`). Because the global rule is unlayered, the outline wins over `outline-none` and the ring also draws.
- Fix: delete `styles.css:125`; keep the shadcn ring (`ring-3`, `--ring`) as the single indicator; make `--ring` a ≥3:1 color against both `--background` and `--card` in light and dark. Links get `focus-visible:ring-3 focus-visible:ring-ring/50 rounded-sm` through the `Link` style (UI-07).

### UI-10 · Medium · Every control is 44 px tall; no density control for admin screens
- Evidence: `button.tsx:24-33` sets `h-11`/`size-11` for `default`, `xs`, `sm`, `lg`, `icon`, `icon-xs`, `icon-sm`, `icon-lg`; `input.tsx:12` and `native-select.tsx:26` are `h-11`; `tabs.tsx` list is `h-8`. So `size="xs"` and `size="sm"` are 44 px, and tables of 7 columns with two row buttons each (`Parking.tsx:198-201,231-234`) are 44 px tall rows.
- Fix: make height a token: `--control-h: 2.75rem` on `pointer:coarse` and attendant routes, `2.25rem` (36px) for mouse/fine pointers in admin. Tailwind v4: `h-9 pointer-coarse:h-11` on `default`, `h-8 pointer-coarse:h-11` on `sm`, `h-7 pointer-coarse:h-9` on `xs` (never used on attendant screens), `touch` = `h-14`. Same for `Input`, `NativeSelect`/`Select`, `Tabs`. Attendant screens add `data-density="touch"` on their layout root so they are always 44+ regardless of pointer.

### UI-11 · Medium · Layout is built from hand-rolled utility classes instead of Tailwind
- Evidence: `.row` (90 uses), `.stack` (36), `.field` (91), `.muted` (71), `.grow`, `.between`, `.tiles` (`styles.css:80-82,105,121,71`), vs 2 Tailwind utility classes in all of `src/screens`. Inline `style={{...}}` remains in 12 places: `Settings.tsx:38`, `GuestPasses.tsx:55` (`fieldset` reset), `Auth.tsx:86`, `Sessions.tsx:65`, `Attendant.tsx:221,796`, `LiveCamera.tsx:76`, `QrScanner.tsx:55`, `SyncBadge.tsx:58`, `Inventory.tsx:87`, `Bulk.tsx:127`, `People.tsx:171`.
- Fix: replace by Tailwind (`flex flex-wrap items-center gap-3`, `grid gap-4`, `text-muted-foreground`, `grow`, `justify-between`). Introduce three layout primitives so the diff is mechanical and screens stay consistent: `PageHeader` (UI-21), `Section` (`<section className="grid gap-4">` with optional heading), `FormGrid` (`grid gap-4 sm:grid-cols-2`). Forms use `Field` (UI-42), not `.field`. Delete the classes as each screen is converted.

### UI-12 · Medium · Tables: double container, double border, forced `nowrap`, no sticky header
- Evidence: 15 `<div className="tablewrap"><Table>` wrappers (`Sessions.tsx:40`, `Dashboard.tsx:44,56`, `Parking.tsx:193,224`, `People.tsx:127,334,363`, `Integrations.tsx:57,88`, `Platform.tsx:70`, `GuestPasses.tsx:67`, plus preview tables `Inventory.tsx:87`, `Bulk.tsx:127`, `People.tsx:171`). `Table` already renders `div[data-slot=table-container].overflow-x-auto` (`table.tsx:6-9`), so there are two scroll containers and two borders; `th, td { white-space: nowrap }` (`styles.css:116`) and `TableCell whitespace-nowrap` (`table.tsx:83`) mean long plates/emails never wrap.
- Fix: drop `.tablewrap`; wrap in `<div className="rounded-lg border">` (or `Card` with `CardContent className="p-0"`) once, inside the new `DataTable` (UI-29); allow wrap on text columns (`whitespace-normal` on name/note), keep `nowrap` on code/number columns; sticky header (`[&_th]:sticky top-0 bg-card`) for preview tables with `max-h`; `TableCaption` (sr-only) for each table for screen readers.

### UI-13 · Low · Mixed `cn` import styles will drift on the next `shadcn add`
- Evidence: all 23 files in `components/ui/` import `cn` from the npm package `"cn"` (`^0.5.0`), `src/lib/utils.ts` re-exports it; `shadcn add` writes `@/lib/utils`. After adding components the folder will mix both.
- Fix: do a one-time codemod of `from "cn"` to `from "@/lib/utils"` in `components/ui/*` so the CLI output and existing files agree; keep `utils.ts` as the single seam.

### UI-14 · Low · Reduced motion only disables transitions
- Evidence: `styles.css:242` sets `transition: none` only; `@keyframes sheet-up` (`styles.css:208`), Tailwind `animate-pulse`/`animate-spin`/`tw-animate-css` entries keep running.
- Fix: `@media (prefers-reduced-motion: reduce) { *, ::before, ::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; scroll-behavior: auto !important } }` inside `@layer base`, and use the `motion-safe:` prefix on `Skeleton`'s pulse.

### UI-15 · Low · The RTL guard has blind spots
- Evidence: `scripts/check-logical-css.mjs:6-20` scans only `.css` files and only the listed properties. Not covered: Tailwind physical utilities in TSX (`left-0`/`right-0` appear in `ui/sheet.tsx:54`, `ui/sidebar.tsx:235,294`; shadcn handles these with `side`/`rtl:` variants, but new code is unchecked), `transform: translateX(...)` and `rotate()` that assume LTR: `.avatar-pill { inset-inline-start: 50%; transform: translateX(-50%) }` (`styles.css:226`) is off-center in RTL; `.collapsible-caret.open { transform: rotate(90deg) }` (`styles.css:231-232`).
- Fix: (a) extend the script to scan `src/**/*.tsx` for `\b(ml|mr|pl|pr|left|right|text-left|text-right|rounded-[lr]|border-[lr]|space-x)-` outside `components/ui/` and fail with the `rtl-ok` escape; (b) replace `.avatar-pill` with shadcn `AvatarBadge` (`avatar.tsx:54`) in the Resident header; (c) see UI-16 for carets and arrows.

### UI-16 · Medium · Directional glyphs do not mirror in RTL (ARCHITECTURE: "only directional icons mirror")
- Evidence: `▸`/`▾` disclosure carets: `Attendant.tsx:35,488`, `Resident.tsx:63` (`.collapsible-caret` rotates 90deg regardless of direction); text arrows `→` in `Sessions.tsx:50` (`in_by → out_by`) and `People.tsx:173` (`before → after`); `.mirror` class exists (`styles.css:213`) but has zero users (grep). Only the sidebar chevron is handled (`styles.css:99`).
- Fix: use lucide `ChevronRight`/`ChevronDown` with `rtl:-scale-x-100` for collapsed state, `ArrowRight` with `rtl:-scale-x-100` for sequence arrows (`<ArrowRight aria-hidden className="inline size-3.5 rtl:-scale-x-100"/>`); delete `.mirror`. Add a Playwright RTL smoke (locale `ar`) in WP-7 that opens one disclosure and one diff row.

### UI-17 · Medium · No `DESIGN.md` or declared direction (R-37, R-31)
- Evidence: no `DESIGN.md` in the repo; tokens exist (green `#0f7a4b` accent, warm-neutral surfaces) but there is no written reason for palette, type, radius (10px `.card` vs `rounded-xl` Card vs `rounded-lg` controls vs 8px `.roles` vs 999px pills), or the three dials (ENERGY/RHYTHM/MOTION). Result: radius is inconsistent today (`styles.css:104,215` vs shadcn defaults).
- Fix (owner decision): the product owner supplies a short `DESIGN.md` (identity, palette, type, radius scale, density, dial values). Until then WP-0 uses a conservative default and labels it "draft without direction": ENERGY 1 / RHYTHM 1 / MOTION 1, radius `0.5rem` (controls) / `0.75rem` (cards), one accent. Do not invent brand copy or a logo (R-23).

### UI-18 · Medium · Unicode glyphs used as icons, inaccessible and off-system (R-04)
- Evidence: `⚠`, `↻` in `SyncBadge.tsx:60` and as the only heading content in `Queue.tsx:26,31`; `●` in `Dashboard.tsx:33`; `▾ ▸` in `Attendant.tsx:35,488`; `✕` in `Attendant.tsx:243,641`; `⌫` in `Attendant.tsx:242`; `→` in `Sessions.tsx:50`; inline hand-drawn pencil SVG with undefined class `menu-icon` in `Resident.tsx:187`. Screen readers read "warning sign"/"clockwise open circle arrow" with no meaning, and Windows renders some of them as color emoji.
- Fix: lucide icons with `aria-hidden` plus visible or `sr-only` text: `TriangleAlert`, `RefreshCw` (spinning when syncing), `Circle`/`Wifi`/`WifiOff` for connection, `ChevronDown`, `X`, `Delete` (backspace), `Pencil`. Icon choice is functional (R-04: each glyph names its state); do not add decorative icons elsewhere.

---

## 3. App shell, navigation, connection status

### UI-19 · High · Connection/sync indicator is incomplete, duplicated and leaves stale text
- Evidence: `SyncBadge.tsx:52` returns `null` when `online && !pending && !conflicts && !note`, so the user never sees "Online"; there is no "syncing" state while `flush` runs (`SyncBadge.tsx:38`); the content is `${conflicts} ⚠` / `${pending} ↻` (`:60`), which is glyph-only; `note` ("Synced 3 actions") is set at `:40` and never cleared, so the badge stays on screen until reload; it is mounted twice (`Shell.tsx:35` in the top bar and `AppMenu.tsx:177` in the sidebar footer), and each instance owns its own 30 s interval and `online/offline` listeners and calls `flush` (`:48`) concurrently, risking double replay attempts; it is not a live region; it links to `/queue`, which residents cannot open (`App.tsx:63` area `staff`); inline `style={{ textDecoration: 'none' }}` (`:58`). Locale has no strings for online/syncing/last synced (only `att.offline`, `att.synced`).
- Fix (UI side; engine is the sync track's): one `<ConnectionStatus/>` in the app top bar (and in the compact attendant header, UI-25), always visible. States and look: `online` (Wifi icon + "Online", muted), `syncing` (RefreshCw spinning + "Syncing N", info), `pending` (CloudUpload + "N waiting", warning), `offline` (WifiOff + "Offline, saved on device", warning, persistent), `conflicts` (TriangleAlert + "N need review", destructive, links to `/queue?tab=conflicts`). Implementation: shadcn `Badge` + `Popover` (details: pending count, last successful sync time in the site timezone, "Sync now" `Button`, link to queue); wrapper `role="status" aria-live="polite"`, text never glyph-only, color never the only signal. Success feedback is a one-shot sonner toast ("Synced 3 actions") that auto-dismisses, not persistent badge text. Hide the Queue link for residents. The engine (single `SyncProvider` context owning online state, pending/conflict counts, and exactly one flush loop) is a hand-off to the offline/sync track; the UI contract is `useSync(): { status: 'online'|'syncing'|'pending'|'offline'|'conflicts', pending: number, conflicts: number, lastSyncedAt: Date|null, syncNow(): Promise<void> }`. New i18n keys: `sync.online`, `sync.syncing`, `sync.pending`, `sync.offline`, `sync.conflicts`, `sync.lastSynced`, `sync.syncNow`, `sync.synced`.

### UI-20 · High · Cold start offline or slow is a blank screen, then the login page
- Evidence: `app-context.tsx:126` `if (!loaded) return null;` renders nothing during bootstrap; `reload()` (`:79-101`) swallows non-`ApiError` failures (a network `TypeError`), leaving `me`/`who` null, after which `AppShell` redirects to `/login` (`Shell.tsx:47`). An attendant who opens the installed PWA in a garage with no signal is sent to a login form that cannot work, even though README claims offline-first.
- Fix: (a) a `BootSplash` (app mark, `Spinner`, "Opening OpenPark...") instead of `null`; (b) UI contract for the offline track: if bootstrap fails with a network error and a cached snapshot (`who`, `me`, `sites`, `config`) exists, render the app with a persistent `Alert variant="warning"` "Offline: showing saved data"; if no snapshot exists, render an `Empty` ("You are offline and this device has not signed in yet. Connect once to sign in.") with a "Try again" `Button`, never the login form. (c) `Auth` shows the same message instead of a raw error when the sign-in call fails with a network error. Engine and cache design belong to the offline track.

### UI-21 · Medium · No page header or breadcrumbs; every screen re-implements its title row
- Evidence: titles are bare `<h1>` with ad-hoc rows: `Dashboard.tsx:31-34`, `Rates.tsx:51`, `Slots.tsx:37-43`, `People.tsx:101`, `Platform.tsx:61`; top bar shows only the tenant name (`Shell.tsx:33`); there is no Breadcrumb component installed; deep admin pages (site, zone, slot, webhook) have no "where am I" cue.
- Fix: `PageHeader` component: `<PageHeader title description breadcrumbs={[{label,to}...]} actions={<Button>Add unit</Button>} />` renders `Breadcrumb` (shadcn) above an `h1` (`text-2xl font-semibold`), description (`text-muted-foreground`), and a right-aligned (logical `ms-auto`) actions slot where the single primary action lives; on mobile the primary action drops under the title at full width. Every admin screen starts with it. Adds `document.title` per route (UI-22).

### UI-22 · Medium · No document title, no skip link; landmarks partly relied on
- Evidence: grep finds no `document.title` and no skip link; `<main>` comes from `SidebarInset` (`ui/sidebar.tsx:309`), `nav` landmarks from the sidebar and `Shell.tsx:73`. Screen-reader users get the same tab title on every route.
- Fix: `usePageTitle(t('...'))` in `PageHeader` (sets `"{title} · {tenant} · OpenPark"`); a visually hidden "Skip to content" link as first focusable child of the shell targeting `#content` (`main`); `aria-current="page"` already present on NavLink.

### UI-23 · Medium · Menu structure and route/menu mismatches
- Evidence: `menu.ts:55` and `menu.ts:67` both list Queue (platform group and operator group), so two items highlight the same route; `/inventory` is routed (`App.tsx:60`) but absent from the menu (`menu.ts:76-84`) and reachable only via a link at the bottom of an expanded site card (`Parking.tsx:258`); the Resident group items are deep links with query/hash (`menu.ts:42-43`: `/r?edit=1`, `/r#new`), and `NavLink end` can never be active on them; groups are two-level collapsibles whose headings also navigate (`AppMenu.tsx:122-170`), so the group label is both a link and a toggle depending on item count.
- Fix: flat, role-scoped groups with real destinations: Operate (Dashboard, Sessions, Slots, Guest passes, Sync queue), Parking (Parking), People (Units, Users), Data (Bulk import/export), Settings (Rates, Integrations, AI, Community); Queue appears once; Operator view for attendants is the attendant layout (UI-25), not a sidebar group. Resident items become real routes (UI-56). Use shadcn `SidebarGroup`+`SidebarGroupLabel` (non-clickable labels) instead of collapsible parents unless a group exceeds 6 items.

### UI-24 · Medium · Sidebar header/footer carries unrelated controls; org name appears three times
- Evidence: `AppMenu.tsx:88-116` shows brand + tenant name text (`:93`) + tenant `NativeSelect` + site `NativeSelect`; `Shell.tsx:33` shows the tenant name again in the top bar; the footer holds `SyncBadge`, a language `NativeSelect` and a sign-out `Button` (`:176-193`). With the sidebar collapsed (icon mode) all of these are hidden (`group-data-[collapsible=icon]:hidden`).
- Fix: follow the shadcn sidebar pattern: Header = `TenantSwitcher` (`DropdownMenu` showing current community and site, with "Switch community" submenu for multi-membership/super admin and a site list; `Combobox` inside when more than 7 entries); Footer = `NavUser` (`DropdownMenu` with avatar, name, email, Language submenu (`DropdownMenuRadioGroup`), Theme submenu (UI-06), Sign out). Top bar then shows `SidebarTrigger`, breadcrumbs/page title, `ConnectionStatus` and the site chip only. Removes three native selects from the sidebar and fixes the collapsed-mode dead end.

### UI-25 · Medium · Attendant has three navigation systems at once and loses ~116 px of a phone screen (R-03, layoutmobile "Sticky Nav Steals the Screen")
- Evidence: attendants are inside `AppShell` (`App.tsx:68-70`), so they get the sidebar (opened from a 44 px trigger), a 64 px sticky top bar (`styles.css:88`, 48 px when collapsed), and the fixed bottom `.tabbar` (`Shell.tsx:73-77`, `styles.css:158-160`, ~52 px plus safe area). On a 640 px tall viewport that is about 18 percent of the height before content; `.att` reserves 96 px bottom padding (`styles.css:155`).
- Fix: a dedicated `AttendantLayout` outside `AppShell`: compact 48 px header (site name, `ConnectionStatus`, `NavUser` menu for language/theme/sign out) plus the bottom tab bar (Home, Check in, Check out) as three `NavLink`s each `min-h-14` with icon + label and `pb-[env(safe-area-inset-bottom)]`; no sidebar for attendant-only roles. Supervisors/admins who also attend keep the sidebar and get the same tab bar only on `/a/*` below `md`. The tab bar uses `bg-card border-t` tokens, not a new CSS block.

### UI-26 · Low · Small shell issues
- `ui/sidebar.tsx:30` sets the toggle shortcut to `#` (stock shadcn is `b`); Ctrl/Cmd+`#` is not reachable on many keyboard layouts. Restore `b`.
- Collapse state is persisted twice: `localStorage op.menu.collapsed` (`Shell.tsx:10-12,51`) and the shadcn cookie `sidebar_state` (`ui/sidebar.tsx:86`). Keep one (the cookie write is unused in a Vite SPA; remove it).
- Menu buttons set both `title` and `tooltip` (`AppMenu.tsx:130,145-146`), producing duplicate native + shadcn tooltips; keep `tooltip` only.

### UI-27 · Medium · No toast/feedback layer; success and error messages are inconsistent and not announced
- Evidence: save feedback is a muted `<span>` next to the button with no live region: `Settings.tsx:60`, `GuestPasses.tsx:62`, `Rates.tsx:63`, `Parking.tsx:104`; some success banners are `role="status"` (`Platform.tsx:68`, `People.tsx:317`), others are not (`Inventory.tsx:79`); success and error share one `msg` state in several places (`Rates.tsx:27,41,46`, `GuestPasses.tsx:26`) so an error renders in the same muted style as "Saved".
- Fix: install `sonner`; mount one `<Toaster position="bottom-center" richColors closeButton />` in `main.tsx` inside the providers; `toast.success(t('common.saved'))` for save/create/delete success (with `Undo` action where the API supports it), `toast.error` or inline `Alert` for errors that need action (form-level errors stay inline). `sonner` live-region behavior satisfies announcements. Note: the generated `sonner.tsx` imports `next-themes`; replace `useTheme` with the app `ThemeProvider` (UI-06) or drop the prop. Do not use toasts for attendant-critical errors (check-in failure stays an inline `Alert`).

### UI-28 · Low · Enhancement: command palette for staff
- Evidence: admins/supervisors jump between 12+ screens and look up vehicles by plate via the Sessions filter; no keyboard navigation aid exists.
- Fix: `CommandDialog` (shadcn `command` + `dialog`) opened with Cmd/Ctrl+K in `AppShell` only (not attendant): groups "Go to" (menu items), "Switch site", "Find plate" (navigates to `/sessions?plate=...`), "Create" (unit, user, site). Low priority; schedule after WP-1.

---

## 4. Data views (lists, dashboards, states)

### UI-29 · High · No sorting, filtering or pagination on any list
- Evidence: `Sessions.tsx:25` requests `limit=100` and ignores `total` (shown only as text at `:38`), so session 101+ is unreachable; `GuestPasses.tsx:24` `limit=50`; Units (`People.tsx:129`), Users (`:338`), Slots (`Parking.tsx:228`), Keys/Hooks (`Integrations.tsx:61,92`) render every row; no column sorts anywhere; only Slots/Parking have a zone `NativeSelect`.
- Fix: one `DataTable<T>` component (`components/data-table.tsx`) built on shadcn `Table` + `@tanstack/react-table` (pin an exact version; client-side sort/filter works offline on cached data) with: column `SortableHead` (`aria-sort`, `ArrowUpDown` icon), a toolbar slot (`InputGroup` search with `Search` icon, facet `Select`s, "Clear" button), server pagination props for sessions (`page`, `pageSize`, `total`, shadcn `Pagination` with prev/next and "Showing 101-200 of 1,284"), `PageSize` select (25/50/100), row selection optional, empty/loading/error rendering via `TableState` (UI-31), sticky header (UI-12). Sessions, Slots, Units, Users, Passes, Keys, Webhooks, Organisations (Platform) all use it. Filters and pagination state live in the URL search params (UI-40) so a list is a bookmarkable, idempotent GET.

### UI-30 · High · Units list has no loading, error or empty state (R-27 violation)
- Evidence: `People.tsx:129` renders `units.data?.map(...)` directly; `units.loading` and `units.error` are never read, and the only error surface is `err` from mutations (`:114`). A failed `/v1/units` fetch shows an empty table with no message; first load flashes empty.
- Fix: use `TableState` (UI-31) in the table body: `<TableState loading={units.loading} error={units.error} onRetry={units.reload} empty={!units.data?.length} colSpan={7} emptyTitle="No units yet" emptyBody="Add the first unit or import a list." emptyAction={<Button>Add unit</Button>} />`.

### UI-31 · Medium · Loading, empty and error states are plain text; generic copy; raw error strings leak
- Evidence: `QueryState.tsx:17-25` renders `Loading…` as text (no `Skeleton`/`Spinner`), empty as `common.none` ("None") or a one-line muted paragraph with no next action, errors as an `Alert` with no retry; `Skeleton`, `Spinner` and `Empty` are installed but imported by 0 screens (grep). `useApi` converts non-API errors with `String(e)` (`hooks.ts:12`) so a dropped connection shows `TypeError: Failed to fetch`; the same pattern in `Platform.tsx:44,51,53`, `Rates.tsx:42,46`, `Settings.tsx:31`, `GuestPasses.tsx:33,35`, `Slots.tsx:32` while other screens use `errText` (`errors.ts`).
- Fix: replace `QueryState` with `ViewState` (non-table) and `TableState` (table) built on `Skeleton` rows (3-5 rows matching the final column count), `Empty` (`EmptyHeader`, `EmptyMedia variant="icon"`, `EmptyTitle`, `EmptyDescription`, `EmptyContent` with the one action that fills it, per antislop "Placeholder Empty and Loading States") and an error `Alert` with a "Try again" `Button` wired to `reload`. Distinguish three empties: first run (CTA), filtered to nothing ("No sessions match. Clear filters"), forbidden. Make `useApi` return `error` via `errText` and add `isOffline` (network error) so views can show "You are offline. Showing saved data" (hand-off to offline track). Replace every `String(e)` with `errText(e)`. Locale: add `state.emptyFiltered`, `state.retry`, `state.offlineNoData`, per-screen `*.emptyTitle`/`*.emptyBody`.

### UI-32 · Medium · Dashboard: four identical stat Cards, no hierarchy, "Live" overstated (antislop "Stat Cards", R-14)
- Evidence: `Dashboard.tsx:37-40` four same-size `Card className="card tile"`; Free / Occupied / Out of service / Fees 24h carry equal weight although "free now" is the decision number; `reserved` is omitted from the tiles but included in capacity (`Attendant.tsx:112`), so tiles do not sum to total; tiles show `–` while loading (no skeleton); `Dashboard.tsx:33` shows `● Live` and `hooks.ts:64` calls `setLive(true)` for polling hosts too, so on serverless deployments the badge says Live while data refreshes every 15 s.
- Fix: layout: one primary stat (Free now, `text-5xl`, with a thin segmented capacity bar under it using the same component as the attendant home, UI-69) spanning two columns on `md+`, and a secondary row (Occupied, Reserved, Out of service) as smaller stats; Fees 24h in its own "Last 24 h" card with closed-stays count (`last24h.closed` is returned and unused). Skeletons while loading. Replace the `● Live` pill with `ConnectionStatus` plus a muted "Updated 10:42" (`useLiveEvents` returns `{ live, updatedAt, mode: 'sse'|'poll' }`; copy: "Live" for SSE, "Updates every 15 s" for polling). Tables get `DataTable` (zone breakdown is sortable by free count).

### UI-33 · Medium · Sessions: invalid row ARIA, hidden detail, filters in local state
- Evidence: `Sessions.tsx:47` puts `aria-selected` and `onClick` on a `<tr>` that has no `role="row"` in a grid/treegrid context (invalid for a plain table row) and duplicates the click handling of the inner button (`:48`); the timeline `Card` renders under a 100-row table (`:56-69`), off-screen; `:33` puts `aria-label` on a `<label>`; filter state is `useState` (`:22-24`), lost on reload/back; plate filter fires a request per keystroke (`:25`, no debounce); `Sessions.tsx:50` formats `in_by → out_by` with a text arrow (UI-16); the `open` badge says "Open" in the Out column (`:49`).
- Fix: filters via `useSearchParams` (`?status=open&plate=ABC&page=2`), plate search debounced 300 ms; row action = a real link `<Link to={`/t/${slug}/sessions/${id}`}>` on the plate cell; the detail opens as a `Sheet` (right on desktop, bottom on mobile) routed at `/sessions/:id` containing the plate chip, fee summary and the timeline (`Item` list with icons and relative times), closable with Esc and restoring focus to the row. Status filter becomes `ToggleGroup type="single"` (All / Open / Closed / Void) with counts. Duration and fee columns right-aligned `tabular-nums`; use `StatusBadge`.

### UI-34 · Medium · Slots: detail panel off-screen, status by color only, grid buttons restyled by legacy CSS
- Evidence: `Slots.tsx:45-49` renders one `Button` per slot styled by `.slot` (`styles.css:137-142`, 12.5 px text); the editor `Card` appears below the whole grid (`:50-71`), i.e. off-screen on a phone after tapping a slot; status is conveyed by background/border color only (`data-status`), with the text only in `title` (`:46`, not available to touch or screen readers); the status `NativeSelect` fires a write on change with no confirmation or visible save (`:60`); zone filter is a `NativeSelect` (`:39`).
- Fix: slot tile = `Button variant="outline"` with an explicit status mark (lucide `Car` for occupied, `Lock`/`Ban` for out of service, `Clock` for reserved, none for free) and `sr-only` status text, legend row above the grid; zone filter as `ToggleGroup` or `Tabs variant="line"` with counts; tapping a tile opens a `Sheet` (`side` bottom on mobile) with plate chip, status `Select`, note `Input`, `Save`/`Cancel` footer and inline success via toast; occupied shows the existing read-only `Alert` (`:55-57`). Tile min size 72x64.

### UI-35 · Medium · Tables are unusable on phones (7-column tables, `nowrap`)
- Evidence: Slots table has 7 columns plus two buttons (`Parking.tsx:224-238`), Units 7 (`People.tsx:128`), Sessions 7 (`Sessions.tsx:41`), all with `white-space: nowrap` (`styles.css:116`) in a horizontally scrolling wrapper; admins do use phones (mobile PWA).
- Fix: below `md`, `DataTable` renders each row as an `Item` card (primary field as title, 2-3 secondary fields as description, status `Badge`, row `DropdownMenu`), hiding low-value columns with `hidden md:table-cell`; at `md+` the table. Keep first column sticky (`sticky start-0 bg-card`) when horizontal scroll remains.

### UI-36 · Low · Organisations table row actions (Platform)
- Evidence: `Platform.tsx:79-83` shows Suspend (destructive), Resume, Enter side by side per row; name cell uses `<br/>` for the secondary line (`:76`); country `NativeSelect` options have no `value` and only 6 countries (`:64`, vs 14 in `Auth.tsx:16`).
- Fix: primary `Enter` button plus `DropdownMenu` (`MoreHorizontal`, aria-label "Actions for {name}") containing Suspend/Resume (with typed-confirm `AlertDialog`, UI-38); name cell as `flex flex-col` with `text-muted-foreground text-xs`; shared `COUNTRIES` constant in `src/lib/countries.ts` (Auth, Platform, Onboarding) rendered by a `CountrySelect` (`Combobox`).

### UI-37 · High · Sync queue (`Queue.tsx`) is the conflict-resolution surface and is the roughest screen
- Evidence: headings are glyph plus count only, `↻ 3` and `⚠ 1` (`Queue.tsx:26,31`), so the page has no readable section names (also fails R-04 relevance, UI-18); rows show the HTTP method and path (`GET /v1/...`, `Queue.tsx:20`) not what the attendant did; timestamps use `new Date(w.at).toLocaleString()` (`:27`), the device clock and timezone, contradicting "Dates render in the site's timezone" (`i18n.tsx` `useFormat`); "Dismiss" (`att.done`, `:35`) permanently deletes the conflict record with no confirmation or detail; `Button variant="outline" className="btn"` pairs; no empty-state action; no live update beyond the `changes` event.
- Fix: `PageHeader` "Sync queue" with `Tabs` (Waiting `n` | Needs review `n`, via `?tab=`); rows as `Item` with: action in words ("Check-in", "Check-out"), `PlateChip`, site-timezone time (`useFormat`), status badge; conflicts show the server reason in a plain-language `Alert` ("The slot was taken by ABC123"), buttons `Retry` and `Discard` (`AlertDialog`: "Discard this check-in? The car was never recorded."), plus `Resolve with...` when the sync track exposes alternatives (slot pick via the existing `SlotPicker`, rebuilt as `Combobox`). Header action "Sync now" (`useSync().syncNow`). `Empty` states: "Nothing waiting. Everything is synced." / "No conflicts." Implement the compare ("your change vs server state") as two `Card` columns once the sync track defines the conflict payload (microsecond timestamps, UI-19 contract).

---

## 5. Forms and admin CRUD

### UI-38 · High · Destructive and irreversible actions run without confirmation; native `confirm()`/`prompt()` elsewhere
- Evidence, no confirmation at all: remove zone (`Parking.tsx:200`), remove slot (`Parking.tsx:233`), remove unit (`People.tsx:136` to `:71`), remove member (`People.tsx:352` to `:271`), remove invite (`People.tsx:369` to `:273`), revoke API key (`Integrations.tsx:64`), delete webhook (`Integrations.tsx:96`), cancel guest pass as staff (`GuestPasses.tsx:75`), suspend tenant is only guarded by `prompt()` (below), rollback import in Inventory (`Inventory.tsx:99`), dismiss sync conflict (`Queue.tsx:35`), `replace`-mode import Apply (`Bulk.tsx:133`, `People.tsx:179`, `Inventory.tsx:94`).
- Evidence, native dialogs (not styled, not translated by the app, blocked in some PWA/iOS contexts, untestable in e2e): `confirm()` at `Parking.tsx:187`, `Resident.tsx:246`, `Bulk.tsx:138`; `prompt()` at `Platform.tsx:49`.
- Fix: add shadcn `alert-dialog`; build `ConfirmDialog` + `useConfirm()` in `components/confirm-dialog.tsx`: `confirm({ title, description, confirmLabel, destructive, requireText?: string })` returns a promise; the dialog names the object ("Remove zone A-2?"), states consequences and reversibility ("Its 12 slots must be moved first" or "History is kept"), default focus on Cancel, destructive action uses `Button variant="destructive"`. `requireText` (type the site code) for: retire site, suspend organisation, `replace` import apply, discard sync conflict is simple. Suspend reason input moves into the dialog as a required `Textarea` (replaces `prompt`). All of these must work with the keyboard and be closable with Esc.

### UI-39 · High · `Parking.tsx` is a 263-line god screen: sites, zones, slots and community settings on one page
- Evidence: `Parking()` (`:30-80`) renders `CommunitySettings` (`:83-109`), an always-open "add site" form (`:64-74`), then a `SiteCard` (`:111-263`) per site, each with an expand toggle (`:169`), a site edit form, a zones table + edit form + add form (`:192-219`), a slots table + edit form + add form (`:221-257`), five `useSubmitKey`/`busy` combinations, and a hidden link to bulk import (`:258`). One task per screen is not possible; nothing is addressable; deleting is inline; state for 6 forms lives in `useState`.
- Fix (screens, each one task): `/parking` sites list (`DataTable`: name, code, timezone, zones, slots, inside now; primary action "Add site"), `/parking/sites/new`, `/parking/sites/:site` with `Tabs` as nested routes (Overview, Zones, Slots, Settings), `/parking/sites/:site/zones/new` and `/zones/:zone`, `/parking/sites/:site/slots/new` and `/slots/:slot`; community address/notes move to `/settings/community`. Create/edit forms for zone and slot open as a `Sheet` routed over the list (so the list stays visible and the URL is shareable); site create/edit is a full page. See route table in section 6. The submission-key logic (`useSubmitKey`) becomes a `useIdempotentForm()` hook shared by all create forms (also fixes the 6 near-identical `create(k, fingerprint, ...)` copies).

### UI-40 · High · Edit state lives in `useState`, not the URL; edit forms render far from the row
- Evidence: `editing` state at `People.tsx:45,243`, `Parking.tsx:118-119`, `Integrations.tsx:30`; the edit `Card` renders at the top of the page (`People.tsx:115-126,320-331`) or below the table (`Parking.tsx:205,239`), so after clicking Edit on row 40 the form appears off-screen with no scroll or focus move (none implemented); back button leaves the page; reload loses the edit; Bulk entity (`Bulk.tsx:37`), Sessions filters (`Sessions.tsx:22-24`), Slots zone (`Slots.tsx:22`), check-out target (`loc.state.ticket`, `Attendant.tsx:714`) are all non-URL state.
- Fix: every task has a URL (section 6). Create = `/x/new`, edit = `/x/:id` (or a routed `Sheet` at the same path), list filters in search params, selected detail in the path. Opening a routed form moves focus to its heading; Save navigates back to the list with a toast; Cancel/Esc goes back. Check-out accepts `?ticket=` and `?plate=` so a refresh or a shared link resolves the same stay (read idempotently, a GET).

### UI-41 · Medium · Always-visible create forms push the actual list down
- Evidence: Units (`People.tsx:103-113`), Users invite (`:301-315`), Integrations key + webhook forms (`Integrations.tsx:51-56,71-77`), Platform create (`Platform.tsx:62-67`), Parking add site (`Parking.tsx:64-74`) all render above their tables.
- Fix: list first. `PageHeader` primary action ("Add unit", "Invite user", "Create key", "New organisation") navigates to the create route (UI-40) or opens the routed `Sheet`. Keep inline quick-add only for zones/slots when a zone has zero slots (empty state CTA).

### UI-42 · Medium · No form-field system: implicit labels, no inline validation, no field-level API errors
- Evidence: 91 `<label className="field">text<Input/></label>` patterns; client validation is native only (`required`, `pattern`, `min`, `max` attributes: `Parking.tsx:67,214,251`, `People.tsx:105-108`, `Rates.tsx:55-60`), so messages come in the browser's language, not the app's, and `pattern` has no `title`; the API returns structured `details` (used for imports) but form submits only show a single banner (`Parking.tsx:61`, `People.tsx:114`); no `aria-invalid`/`aria-describedby`; `Label` is installed but unused; the one hint (`Auth.tsx:112`) is a bare `<small>` not tied to the input.
- Fix: install `field`, `input-group`; use `Field` + `FieldLabel` + `FieldDescription` + `FieldError` + `FieldGroup`/`FieldSet`/`FieldLegend` everywhere (this fixes `.roles` fieldsets too, UI-52). Add `useFormErrors(error)` that maps `ApiError.details` (paths) to per-field messages, sets `aria-invalid` and `aria-describedby`, and focuses the first invalid field on submit; forms use `noValidate` with app-language validation messages (new `validation.required`, `validation.pattern.code`, `validation.range`). Not recommended: shadcn `form` (react-hook-form + zod adds two dependencies and a second schema next to the API's Zod schemas); revisit if forms grow.

### UI-43 · Medium · Numeric and money inputs coerce badly
- Evidence: `Number(e.target.value)` writes `0`/`NaN` on empty input (`Settings.tsx:58`, `Rates.tsx:55-60`, `GuestPasses.tsx:36,47-52`); money fields use `value={rules[k] / 100}` with `Math.round(Number(x) * 100)` (`Rates.tsx:36-38,60`) which rewrites the field while typing (typing `1.` becomes `1`), and the daily cap shows `0` for "no cap" (`dailyCap ?? 0`, `:60`); no currency shown next to money fields (GuestPasses shows currency text in the label only, `:51`).
- Fix: `MoneyInput` (value in minor units, string draft state, parse on blur, `InputGroup` with currency symbol `InputGroupAddon`, `inputMode="decimal"`, locale decimal separator via `Intl.NumberFormat.formatToParts`) and `NumberField` (string draft, `min/max/step`, empty = `undefined`). "No cap" is an explicit `Switch` ("Limit daily total") revealing the amount.

### UI-44 · Medium · Rates: demo values in state, single default plan only, simulator hidden in the same page
- Evidence: `Rates.tsx:28-29` initialises the simulator with the fixed dates `'2026-10-20T08:12'` and `'2026-10-20T14:09'` (fabricated sample content shipped as defaults, R-38); only `plans.data?.find(is_default)` is shown (`:25`), so other plans/versions cannot be viewed (domain: versioned plans, used plans immutable); "New version" posts a new version of the shown plan (`:41`); the in-use notice is a banner (`:52`).
- Fix: `/rates` list of plans with version history (`DataTable`: name, version, default badge, in-use badge), `/rates/:plan` form with `Field`s grouped in `FieldSet`s (Grace, First period, Increment, Caps, Tax) and a sticky footer "Save as new version" (`Button`) with `Alert` "Saving creates version N+1; stays that way for stays already priced"; the simulator becomes a right-hand `Card` ("Try it") with empty fields or "now minus 3 h to now" computed values, not fixed dates.

### UI-45 · Medium · One-time secrets are shown in a status banner with no copy affordance
- Evidence: API key and webhook secret in `Integrations.tsx:48` (`Alert role="status"`), temporary passwords in `People.tsx:266` (`msg`, status), `Platform.tsx:42` (note), imports `People.tsx:189`. `role="status"` announces the secret aloud to screen readers and leaves it in the DOM until the next action; no Copy button; easy to lose (banner is replaced by the next message).
- Fix: `SecretDialog`: `Dialog` titled "Copy your API key now", body "It will not be shown again", `InputGroup` (readOnly, `dir=ltr`, monospace) with a copy `Button` (lucide `Copy` to `Check`, 2 s) and a `Checkbox`-free single "I saved it" `Button` as the only way to close (Esc also closes but clears state); no `aria-live` on the secret. Same dialog for temporary passwords and webhook secrets.

### UI-46 · Low · Settings and policy forms: fieldset hacks, checkbox for settings, no dirty state
- Evidence: `Settings.tsx:38` and `GuestPasses.tsx:55` use `<fieldset style={{border:0,...}}>`; boolean settings (training export, alert recipients) use `Checkbox` (`Settings.tsx:59`, `GuestPasses.tsx:57-59`); `Save` is always enabled and gives no unsaved-changes cue; `GuestPasses` shows read-only supervisors the same disabled fields with no explanation (`:47-52`, only `canEdit` hides Save).
- Fix: `FieldSet` + `Switch` for on/off settings (`Field orientation="horizontal"`), `Button` disabled until the form is dirty, `Alert variant="info"` "Only admins can change these" when read-only; success via toast (UI-27). Slider keeps an `aria-valuetext` with the percent.

### UI-47 · Low · Duplicated option lists and options without values
- Evidence: `COUNTRIES` (14) in `Auth.tsx:16`, 6-country literal in `Platform.tsx:64`; `<option key={c}>{c}</option>` without `value` (`Platform.tsx:64`, `Parking.tsx:70,179`); `timezones()` helper only in `Parking.tsx:23-27`.
- Fix: `src/lib/countries.ts`, `src/lib/timezones.ts`, a single `CountrySelect`/`TimezoneCombobox` (UI-50). Country labels via `Intl.DisplayNames` (already in `Auth.tsx:28`).

### UI-48 · Medium · The import/export flow exists three times (DRY)
- Evidence: `Inventory.tsx` (whole file, 102 lines), `Bulk.tsx:55-141` (`ImportExport`), and the units import block in `People.tsx:142-192` are the same state machine (text/file, mode, dry-run, preview, apply, rollback, error list) with copy-pasted JSX; `/inventory` and the Bulk "slots" tab are duplicate routes for the same job; Inventory lacks the `Idempotency-Key` handling Bulk has (`Inventory.tsx:39,46`).
- Fix: one `ImportWizard` component driven by the `SPECS` table in `Bulk.tsx:20-29` (add `diffRow` renderers per entity), as a 3-step flow: 1 Upload (`Dropzone`: drag area + file `Input`, paste in a collapsed `Textarea`), 2 Review (counts as `Badge`s `+ added ~ changed - removed ! conflicts`, a typed diff table with an icon and text per row, conflicts as destructive rows, "Download preview"), 3 Apply (`AlertDialog` summarizing counts; for `replace`, `requireText`), then result with `Rollback` as a prominent but confirmed action for the last job. Routes `/bulk/:entity`; `/inventory` redirects to `/bulk/slots`. Delete `Inventory.tsx` and the block in `People.tsx` (WP-4).

### UI-49 · Low · Import preview shows raw JSON and non-semantic diff markers
- Evidence: `Bulk.tsx:129` renders `JSON.stringify(item)` per row; diff markers are the plain characters `+ ~ − !` colored by `.diff-*` (`People.tsx:165-167,172-176`, `Inventory.tsx:83-84,88-91`); color is the only distinction beyond the symbol.
- Fix: part of UI-48 step 2: columns Change (icon + word), Key, Details (before to after as two `code` spans with an arrow icon that mirrors in RTL); counts as accessible text ("12 added").

### UI-50 · Medium · Native `<select>` for long and searchable lists; `Select`/`Combobox` unused
- Evidence: 28 `NativeSelect` usages including timezones (about 400 options, `Parking.tsx:70,179`), tenants for super admins (`AppMenu.tsx:95-104`, `People.tsx:308`), units (`People.tsx:290`), sites (`AppMenu.tsx:107-114`), language (`AppMenu.tsx:178-185`, `Auth.tsx:22`).
- Fix: add `select`, `combobox`. Rules: short fixed lists (status, role, mode, payment) use `Select` (or `ToggleGroup`/`RadioGroup` when 2-4 choices and primary); searchable or long lists (timezone, unit, community, site when > 7, country, plate region) use `Combobox` (Base UI) with `name` for `FormData` forms; keep `NativeSelect` only for the Attendant vehicle body-type field and any field that benefits from the OS picker on touch. Tests that query `select` elements (e.g. `crud-roles.test.tsx:208,223`, `language-switcher.test.tsx:47`) must be updated (WP-7).

### UI-51 · Medium · Users table: roles as joined text, three inline buttons, no triage view
- Evidence: roles joined with ` · ` (`People.tsx:223-224,341,365`); row actions Verify/Edit/Remove inline (`:350-352`); unverified residents get a "unverified" badge but there is no way to list only those, though "verify unit access" is the admin's main recurring task (DOMAIN: Users).
- Fix: `Tabs variant="line"` over the list: All | Needs verification `n` | Invitations `n` (nested route/search param), roles as `Badge variant="neutral"` chips, unit as a link, row `DropdownMenu` (Edit, Verify unit, Remove with `ConfirmDialog`), primary action "Invite user" in `PageHeader`. Edit and invite are routed forms (`/users/invite`, `/users/:id`), with `RoleBoxes` rebuilt as `FieldSet` + `Field orientation="horizontal"` + `Checkbox`/`Switch` and the description under each label.

### UI-52 · Low · File inputs hidden behind buttons; fieldset legends unstyled
- Evidence: `Input type="file" hidden` triggered by a `Button` (`Inventory.tsx:63`, `People.tsx:146`, `Bulk.tsx:106`) with an `aria-label` on a hidden input; role checkbox groups use `.roles` (`styles.css:215-220`) with fallback color `#d8d8d8` and `border-radius: 8px` (untokenized).
- Fix: Dropzone in `ImportWizard` (UI-48); `FieldSet`/`FieldLegend` for groups (UI-42).

---

## 6. CRUD routes: one task per screen, semantic idempotent URLs

Target route table (hand-off to the CRUD/URL track; this track owns the screens). All GET routes are bookmarkable and safe to reload; create routes use a per-mount idempotency key; edit routes load by stable identifier (never by array index). Identifier segments are `encodeURIComponent`-ed codes (units/sites/zones/slots) or ids (users, passes, keys).

```
/t/:slug/dashboard
/t/:slug/sessions?status=&plate=&page=&size=       list (filters in URL)
/t/:slug/sessions/:id                              detail (Sheet over the list)
/t/:slug/slots?zone=                               grid; /slots/:slot  detail Sheet
/t/:slug/passes?status=&page=                      list; /passes/:id detail; /passes/policy  rules form
/t/:slug/queue?tab=waiting|review                  sync queue
/t/:slug/parking                                   sites list
/t/:slug/parking/sites/new
/t/:slug/parking/sites/:site                       overview (nested: /zones, /slots, /settings)
/t/:slug/parking/sites/:site/zones/new   /zones/:zone
/t/:slug/parking/sites/:site/slots/new   /slots/:slot
/t/:slug/units?q=&page=      /units/new      /units/:code
/t/:slug/users?tab=all|unverified|invites   /users/invite   /users/:id    /users/invites/:inviteId
/t/:slug/integrations                              keys + webhooks tabs
/t/:slug/integrations/keys/new
/t/:slug/integrations/webhooks/new   /webhooks/:id
/t/:slug/rates     /rates/:plan
/t/:slug/settings/ai      /settings/community     (replaces /ai and Parking's CommunitySettings)
/t/:slug/bulk/:entity   (community|sites|slots|units|users)   /inventory -> redirect /bulk/slots
/t/:slug/a   /a/checkin   /a/checkin/review   /a/checkin/confirm   /a/checkout?ticket=&plate=
/t/:slug/r   /r/passes/new   /r/passes/:id   /r/profile
/platform    /platform/tenants/new    /platform/tenants/:slug
```
Today's routes are in `App.tsx:60-86`. Rules: no query/hash used as navigation (`/r?edit=1`, `/r#new`, `menu.ts:42-43`); no router `state` for data a refresh must keep (`Attendant.tsx:714` `loc.state.ticket`, `:310` `focusPlate`); no component-local `editing`/`open` for entities.

---

## 7. Accessibility, contrast, touch targets, RTL

Contrast (computed from tokens; AA requires 4.5:1 text, 3:1 non-text): light: ink-2/surface 7.24, accent text on accent-soft 4.64 (passes narrowly, only because `--accent` is dark enough; do not lighten), warn on warn-soft 5.24, danger on danger-soft 5.59, info on info-soft 5.44, accent-ink on accent (primary button) 5.38, control border `#6f7971` on surface 4.52 (passes 1.4.11), card border `--line` on surface 1.36 (decorative borders only, acceptable). Dark: all text pairs ≥ 6.4. One failure:

### UI-53 · Medium · Capacity-bar overlay glyph fails contrast in dark mode and the bar does not scale
- Evidence: `.capseg[data-over]::after { color: #fff; font-size: .7rem }` (`styles.css:189`) on `.capseg.over10 { background: var(--warn) }` (`:187`): dark-mode `--warn` is `#f2a54a`, white on it is about 2:1. Segment grid `repeat(var(--n), minmax(4px, 1fr))` (`:180`, `Attendant.tsx:133`): with n = 200 slots each segment is under 2 px, the over-10/12 stripes and glyph cannot render; legend is `aria-hidden` and duplicates data in the `role="img"` label (`Attendant.tsx:131-140`); inline `style` custom property.
- Fix: new `CapacityBar` component: for n ≤ 60 keep segments (with `text-warning-foreground`/dark ink on warn, `#7f1d1d` stripes need `#fff` which is 10:1, keep), for n > 60 render a three-part stacked bar (occupied / pending / free) as `Progress`-style divs with widths in %; below it three `Badge` stats (Occupied n, Waiting n, Free n) plus Over 10 h / Over 12 h badges with `TriangleAlert`, as real text (not `aria-hidden`). Hover/focus tooltip on the bar (`Tooltip`) with the full sentence.

### UI-54 · Medium · Reasons for disabled actions live only in `title` (not reachable by touch, keyboard or most screen readers)
- Evidence: disabled `Button`s explain themselves with `title`: retire site (`Parking.tsx:186`), remove zone (`Parking.tsx:200`), remove unit (`People.tsx:136`); a disabled button is not focusable, `title` is not shown on touch, and is not reliably announced. Same for the slot tile (`Slots.tsx:46`, status only in `title`) and `Badge title` for the suspend reason (`Platform.tsx:80`).
- Fix: keep the action enabled-looking but `aria-disabled="true"` (focusable) with a `Tooltip` (focus + hover + long-press) AND a visible one-line reason in the row or dialog ("Move its 12 slots first"); or use a `ConfirmDialog` that opens and explains why the action is blocked. Never convey a required explanation via `title` alone.

---

## 8. Attendant flow (mobile-first, touch, offline-capable)

### UI-55 · Medium · Pass lookup and plate capture screen is dense; actions share equal weight
- Evidence: `CheckInCapture` (`Attendant.tsx:251-386`) stacks, in order: heading, pass banner or scan Card with "Scan pass" + code input + "Use" (`:356-362`), pass error Alert, Camera/Manual tabs, the camera or keypad, error. A pass is an exception path, but its Card sits above the primary path (plate capture).
- Fix: primary path first: plate capture (camera/manual tabs) at the top; "Has a guest pass?" as a secondary `Button variant="outline"` with a `QrCode` icon opening a `Drawer` (scan + code entry), so the first screen is "point at the plate or type it". Pass banner (once accepted) is a sticky `Alert variant="success"` under the header.

### UI-56 · Medium · Resident screen routing hack: query/hash deep links and 50 lines of focus orchestration
- Evidence: `Resident.tsx:96-146` (`wantEdit`, `wantNew`, `loc.key`, three refs and two effects) exist only because the menu links to `/r?edit=1` and `/r#new` (`menu.ts:42-43`) and the page toggles two `Collapsible`s (`:56-69,195,253`); the comment at `:96-99` admits `window.location.hash` and router state can disagree.
- Fix: real routes (section 6): `/r` shows the active pass (QR, countdown, share) or an `Empty` with "Create a guest pass"; `/r/passes/new` is the form; `/r/passes/:id` shows one pass; history is a `DataTable`/`Item` list at `/r/passes`; `/r/profile` is the profile form. Delete the effects and both `Collapsible`s. Focus management is the router's: page `h1` gets focus on route change (a `FocusOnRouteChange` helper in the shell).

### UI-57 · High · Guest pass phone field rejects the number format its own placeholder shows
- Evidence: `Resident.tsx:204-212`: `Input name="guestPhone" type="tel" pattern="\+[1-9][0-9]{7,14}" placeholder="+52 55 1234 5678"` is uncontrolled; `onChange` only updates `guestPhone` state (`:126,211`) and does not rewrite the input, while FormData submit reads the raw field (`:159`). A user who types the placeholder's format (spaces) fails native `pattern` validation with a browser bubble in the browser's language; `PhoneInput` (`components/PhoneInput.tsx`) already sanitizes but is used only in `EditProfile` (`:366`). `guestPhone`/`formatGuestPhone` in `ResidentHome` are dead after the pattern blocks submit.
- Fix: use `PhoneInput` (extend it to accept `id`, `name`, `aria-*`, `autoComplete="tel"`; it hard-codes `name="phone"`, `PhoneInput.tsx:28`) or better a `PhoneField` with the dial code in an `InputGroupAddon` (default from tenant country); validate on blur with a translated message; remove the `pattern`. Remove the MX-specific placeholder `+52 55 1234 5678` (UI-59).

### UI-58 · Low · Resident miscellany
- Evidence: inline SVG pencil with undefined class `menu-icon` (`Resident.tsx:187`); history rows use `<br/>` inside a `span` (`:258-262`); `feetotal` class reused for the countdown (`:229`); `Avatar` built by hand with `.avatar-pill` (`:71-83`, UI-15); `resizeToWebP` (48 lines, `:273-320`) lives in the screen file.
- Fix: lucide `Pencil`; `Item`/flex stack for history; a `text-3xl tabular-nums` stat style; `Avatar` + `AvatarBadge`; move image resize to `src/lib/image.ts` (code-quality hand-off).

### UI-59 · Medium · Hard-coded, locale-specific, device-time strings
- Evidence: placeholders `+52 55 1234 5678` (`Resident.tsx:208,366`) and `+525512345678` (`Attendant.tsx:469`) bake in Mexico for every tenant; `new Date(w.at).toLocaleString()` (`Queue.tsx:27`) and `toLocaleTimeString()` (`Attendant.tsx:594`) use the device timezone; `Rates.tsx:28-29` fixed dates (UI-44); `'…'` Suspense fallback (`Attendant.tsx:60`).
- Fix: placeholder from `Intl`/country (`libphonenumber`-free: use tenant country dial code constant table); all dates through `useFormat(site.timezone)`; localized `t('common.loading')`.

### UI-60 · High · Plate keypad keys are about 29 px wide on a 360 px phone (R-03, touch targets)
- Evidence: `.keyrow { grid-template-columns: repeat(10, minmax(0, 1fr)); gap: 4px }` (`styles.css:162`), keys `min-block-size: var(--tap)` (48 px high, `:163`) but no min width; content width at 360 px viewport = 360 - 2x16 (`.att` padding, `:155`) = 328; (328 - 9x4) / 10 = 29.2 px per key in every row (the last row is 7 letters + a double-width Delete + Clear = 10 columns). The bottom sheet variant (`.sheet`, `:206`) uses the same keypad inside padding, so slightly less. Attendants wear gloves and use one thumb in a garage.
- Fix: (a) prefer the native keyboard for typing plates: `PlateInput` with `inputMode="text" autoCapitalize="characters" autoCorrect="off" spellCheck={false} enterKeyHint="next"` is the primary path, with the custom keypad as an optional "Keypad" toggle (UI-62); (b) for the custom keypad, remove inter-key dead zones: `gap-0` with each key's visual inset done by an inner `span` (`p-0.5`), so the hit width is the full 32.8 px; key height 56 px; split into letters (7 columns x 4 rows, hit width 46 px) and a digits row (10 x 1 as a separate collapsible "123" panel or 5 x 2 at 60 px); pressed-state callout bubble; hold-to-repeat on Delete; (c) validate on a device (gloved thumb test) before shipping; record the decision in `DESIGN.md`. Do not ship the current geometry.

### UI-61 · High · Hand-rolled listbox/combobox with invalid ARIA (R-32)
- Evidence: `<ul role="listbox"><li role="option"><Button/></li></ul>` in `HostControl` (`Attendant.tsx:457-463`), `SlotPicker` (`:491-497`), `PlateAutocomplete` (`:676-683`): `option` elements may not contain interactive descendants (the `Button`); `aria-selected={false}` is hard-coded (`:460`); the host input declares `role="combobox"` (`:451`) but `PlateInput` in `PlateAutocomplete` sets `aria-autocomplete`/`aria-activedescendant` without `role="combobox"` (`:671`); keyboard handling is partial (arrows and Enter in the plate autocomplete only; none for host or slot); each `.btn row between` list item is a full-width 48 px button, fine for touch but wrong semantics.
- Fix: replace all three with shadcn `Combobox` (Base UI `Combobox`: input + popup list, roving highlight, typeahead, `onValueChange`), with custom item rendering (`PlateChip` + slot + duration in the check-out autocomplete; unit code + name in the host picker; free slot + zone in the slot picker). "Other (name + phone)" in `HostControl` is a second `Tabs`-free `Field` revealed by a `Switch`, and the `Combobox` list shows an "Other..." last item. On touch devices the list opens as a full-width popup anchored under the input (Base UI handles collision); verify with the on-screen keyboard (UI-62).

### UI-62 · High · The custom keyboard sheet opens on focus, on top of the native keyboard, with no focus management
- Evidence: `PlateAutocomplete` sets `onFocus={() => setSheet(true)}` (`Attendant.tsx:672`) and renders `BottomSheetKeypad` (`:630-646,686`) at `z-index: 20` (`styles.css:206`): on a phone the native keyboard also opens, the two stack and hide the results list and the fixed tab bar; the sheet is `role="dialog" aria-modal="false"` with a global `keydown` listener for Esc (`:632-636`), no focus trap/return, no `aria-labelledby`; the "close" label is `✕` (`:641`, UI-18).
- Fix: replace with an explicit toggle: `InputGroup` with an `InputGroupButton` (`Keyboard` icon, `aria-pressed`, label "On-screen keypad") next to the plate input; when active, set `inputMode="none"` on the input (suppresses the native keyboard) and show the keypad in a non-modal `Drawer` anchored bottom (shadcn `drawer`, `modal={false}`), pushing page content up (`padding-bottom` = drawer height) instead of covering it; focus stays in the input; Esc and a visible "Done" `Button` close it; focus returns to the input.

### UI-63 · Medium · Hand-rolled tab/toggle controls instead of shadcn `Tabs`/`ToggleGroup`
- Evidence: `Tabs` function (`Attendant.tsx:48-56`) built from `Button aria-pressed` plus `.tabs/.tab/.active` (`styles.css:173-175`), the comment (`:43-47`) says ARIA tabs were avoided to not "half-implement" roving focus; `Bulk.tsx:44-48` repeats the idea for entities; `components/ui/tabs.tsx` (Base UI) provides roving focus, `aria-selected`, panels and RTL-aware arrows but its list is `h-8` (`tabs.tsx:27`), below the 44 px target.
- Fix: use shadcn `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent` with a touch size (`TabsList className="h-12 w-full"`, `TabsTrigger className="h-full flex-1 text-base"`, add a `size` variant to `tabs.tsx`); camera and manual panels as `TabsContent`. Bulk entities become route-driven (`/bulk/:entity`, UI-48) with `TabsTrigger render={<Link/>}`.

### UI-64 · Medium · Payment method and similar single-choice controls signal selection by color only
- Evidence: `Attendant.tsx:773`: three `Button`s toggled by className `primary` with no `aria-pressed`, no role; the "Camera/Manual" buttons do have `aria-pressed` (`:52`). WCAG 1.4.1 and screen-reader state are both missing.
- Fix: `ToggleGroup type="single" variant="outline" size="lg"` (or `RadioGroup` rendered as cards) with icons (`Banknote`, `CreditCard`, `Building2`) and text; selected state has `data-state=on` styling plus a `Check` icon; arrow-key navigation comes with the primitive; min 56 px.

### UI-65 · Medium · Check-in flow state is memory-only, with no step cue and inconsistent back navigation
- Evidence: `Flow` provider is `useState(emptyFlow(...))` (`Attendant.tsx:79-93`); a reload on `/a/checkin/confirm` or an iOS PWA eviction mid-flow loses plate, pass and vehicle details; three different "back" affordances: "Edit plate" button (`:613`), a text `Link` on check-out (`:815`), none on review; no indication of step (capture, review, confirm).
- Fix: UI: a `FlowHeader` with `ArrowLeft` back `Button` (aria-label "Back to capture"), title, and a 3-segment step indicator (`1 Capture · 2 Review · 3 Confirm`, `aria-label="Step 2 of 3"`); persist `FlowState` to `sessionStorage` (hand-off to offline track for exact shape) and show a "Resumed unsaved check-in" `Alert` with Discard. Route guards redirect to capture when the flow is empty (today `Confirm` renders `needPlate`).

### UI-66 · Medium · Confirm screen: long single column, primary action at the bottom
- Evidence: `CheckInConfirm` (`Attendant.tsx:566-615`) stacks plate chip, plate input, confidence, host heading and control, vehicle (5 inputs in 2 rows), slot picker, up to 5 conditional alerts, then Confirm; at 360x640 the Confirm button is 2-3 screens below; several alerts are stacked above it (`:592-611`) and rely on `role="alert"` ordering.
- Fix: header = plate chip (hero) + editable plate (collapsed behind "Edit" `Button` when read from camera with high confidence); required block = Host and Slot; "Vehicle details (optional)" in a `Collapsible` (closed by default, saves ~220 px); a sticky action bar `sticky bottom-[calc(env(safe-area-inset-bottom)+3.5rem)]` (above the tab bar) holding `Confirm check-in` (`size="touch"`); single consolidated `Alert` region at the top for blocking issues, with the first one focused. Slot defaults to the suggestion and shows as "Slot B-14 (suggested)" with a `Change` button.

### UI-67 · Medium · Touch targets under 44 px on attendant screens (R-03)
- Evidence: `Checkbox` is `size-4` (16 px; hit area extended by `after:-inset-y-2` to about 32 px, `checkbox.tsx`) in `HostControl` "Other" (`Attendant.tsx:454`) and "Lost ticket" (`:772`); both sit in `label.row` whose height is one text line (about 23 px); `Tabs` list `h-8` (UI-63); `.slot` tiles in the attendant-facing Slots view; `SidebarTrigger` is correctly `size-11` (`Shell.tsx:30`).
- Fix: attendant checkbox rows become `Field orientation="horizontal"` with `min-h-12`, checkbox `size-6`, or `Switch` (`h-8 w-14` track in a 48 px row); add a `touch` size to `Checkbox`/`Switch`; run an automated check in Playwright (bounding box ≥ 44x44 for every `button, a, input, [role=checkbox]` under `/a/*` at 360x640) in WP-7.

### UI-68 · Medium · Check-out finder: duplicated inputs and unclear primary path
- Evidence: `CheckOut` (`Attendant.tsx:692-818`) has a "Camera" tab that contains: a "Scan QR" button, a ticket text field, an "or plate" label, a plate input and a Find button (`:785-799`), and a "Manual entry" tab that contains the autocomplete (`:801`); typed inputs live under the Camera tab; "Find" requires choosing between ticket and plate; `Link to={b}` Back (`:815`) is an unstyled text link while everything else is a button.
- Fix: two tabs named for the task: Scan (camera: reads QR ticket or plate and finds automatically) and Search (the plate `Combobox` over open stays, longest stay first, shows slot and duration); the ticket code field moves into a "Lost the ticket? Enter its code" `Collapsible` under Search. Result view is a summary `Card` (plate chip xl, slot, entry, duration) + fee breakdown `Table`/definition list + payment `ToggleGroup` (UI-64) + sticky `Confirm leaving · $48.00` action. Back is the `FlowHeader` back button.

### UI-69 · Medium · AttendantHome: hierarchy and hidden activity
- Evidence: two equal-height big buttons, then a "free now" tile with inline `fontSize: '3rem'` (`Attendant.tsx:221`), the capacity bar, and "Recent activity" inside a `Collapsible` closed by default (`:223`) so the attendant's last cars are one extra tap away; `ActivityRow` is a `Card row between` (`:162`) with an inline Check-out `Button`.
- Fix: order: capacity summary first (free now as the hero `text-6xl`, `CapacityBar`), then Check in (primary, `size="touch"`) and Check out (secondary), then "Recent" as an open list (last 5 stays as `Item`s with `PlateChip`, slot, time and a quick "Check out" action) with "See all" to `/sessions`-lite; sort/search controls (`:187-197`) move into the full recent view, not the home.

### UI-70 · Medium · Camera UI: no reticle, status as muted text, raw error handling
- Evidence: `LiveCamera.tsx:73-80` renders the `<video>` plus a centered muted `div` carrying readiness/error text and a Capture button; no overlay (README gap), no visual state for "model loading" vs "ready" vs "no plate found"; `setError(String(e))` stores a raw exception message (`:31`) though only a translated string is displayed; `QrScanner.tsx:52-58` repeats the structure; Camera permission denied has no recovery action; `.video` background `#000` (`styles.css:168`).
- Fix: a `CameraFrame` component: `aspect-[4/3] overflow-hidden rounded-xl bg-black` with a corner-bracket reticle overlay (decorative, `aria-hidden`; pure CSS borders using logical corners), a status `Badge` at the top (`Spinner` Loading reader, `Check` Reader ready (works offline), `TriangleAlert` Camera blocked), a shutter `Button size="touch"` below; denied/unavailable states use `Alert variant="warning"` with actions "Type the plate instead" (switches tab) and "How to allow the camera" (`Popover`). Show model readiness from the ALPR track's cache state (hand-off) so "scanning works offline" is visible.

### UI-71 · Low · Attendant miscellany
- `Suspense fallback={<div className="muted">…</div>}` (`Attendant.tsx:60`): use `Skeleton`/`Spinner` plus localized text.
- The offline-queue action button label is `t('att.queued')` = "Saved offline" (`:814`), which names a result, not an action; rename key use to `att.saveOffline` ("Save for later") and show it as a primary action in the offline `Alert`.
- Review candidates show `⚠` for invalid format (`:401`); use `Badge variant="warning"` with `TriangleAlert` and the word "Check format".
- Two near-identical disclosure components: `Collapsible` wrapper `Attendant.tsx:28-41` and `Resident.tsx:56-69`; use shadcn `Collapsible` directly once (or `Accordion`), with the `Chevron*` icon that mirrors (UI-16). Delete the `.disclosure`, `.collapsible*` CSS (`styles.css:176-178,229-232`).
- `Ticket` (`:416`) is a one-line wrapper over `QrCode`; inline it.

---

## 9. Auth, public pages, shared package

### UI-72 · Medium · Auth: language list is inconsistent with the product's two-language surface; plain card with no brand
- Evidence: `Auth.tsx:22-24` lists `[...LOCALES]` (7 locales: en, es-MX, es-ES, pt-BR, fr, de, ar) while the app menu uses `SELECTABLE_LOCALES = ['es-MX','en']` (`AppMenu.tsx:181-184`, `i18n.tsx:14`) and ARCHITECTURE states the other catalogs are not user-selectable; `LangPick` is a bare `NativeSelect` floating above the card title; the page has no product mark though `/icon.svg` exists; heading hierarchy is fine (`h1` per card).
- Fix: use `SELECTABLE_LOCALES`; place a compact language `Select` top-end of the page (not inside the card); add the app mark (`/icon.svg`) and product name above the `h1` (existing asset only, R-23); `Card` with `CardHeader` (`CardTitle`, `CardDescription`) and `CardFooter` for the secondary links; the "closed preview" state (`:82-89`) as an `Empty`-style card with the sign-in `Button render={<Link/>}`.

### UI-73 · Low · Auth form details
- Evidence: link styled as button through inline `style` (`Auth.tsx:86`); password uses two controls for one state: eye `Button` and a "Show password" `Checkbox` (`PasswordInput.tsx:18-35`, `.pwd`, `.showpw`, `styles.css:144-150`); `aria-describedby` missing for the password hint (`Auth.tsx:112`); org/country fields lack `autoComplete`; form-level error only.
- Fix: `Button render={<Link/>}` with variants (no inline style); `PasswordInput` = `InputGroup` + `InputGroupButton` (Eye/EyeOff, `aria-pressed`, `aria-label`), remove the checkbox and `.pwd*` CSS; `Field`/`FieldDescription` for the hint; `autoComplete="organization"`/`"country"`; inline field errors via `FieldError` (UI-42).

### UI-74 · Low · Guest pass (public) page
- Evidence: `GuestPass.tsx:31,39` `Alert variant="destructive" className="banner warn"` conflicting styles; the page reuses `.att` (560 px column) without the brand or a language control, though a guest may not read the host's language; countdown `feetotal` class and `aria-live="off"` (fine for a ticking timer) at `:45`.
- Fix: warning/destructive variants from UI-04; language `Select` (SELECTABLE_LOCALES) top-end; QR in a white `Card` with the property/unit/guest in `CardDescription`; large code (`spaceCode`) in `font-mono text-3xl`; expired state as `Alert variant="warning"` with "Ask {host} for a new pass".

### UI-75 · Low · `packages/ui` is a stylesheet plus one component, not aligned with shadcn/Tailwind
- Evidence: `plate.css:2-15` hard-codes `#111`, `#fff`, `#1d4ea8` and `border-radius: 6px` (intentional plate look, but the blue region badge color is a one-off, not a token), `PlateChip.tsx:3-17` accepts `style` but not `className`, no `aria-label` (the region code rendered via CSS `content: attr(data-region)` is invisible to assistive tech), no `forwardRef`, sizes only `md|lg|xl`; `Sessions.tsx:48` nests it inside a ghost `Button`.
- Fix: keep the CSS (the marketing site uses it and cannot use Tailwind), add `className`, `ref`, `size: 'sm'|'md'|'lg'|'xl'`, `aria-label={`${plate}${region ? `, ${region}` : ''}`}`, render the region as a real `<span aria-hidden>` instead of `::before`, and expose `--plate-region` as a token. Export `tokens.css` as the single token source (UI-07). `check:css` already covers this package (`check-logical-css.mjs:8`).

### UI-76 · Medium · Tests and e2e are coupled to legacy class names, which blocks the migration
- Evidence: `test/attendant-confirm-focus.test.tsx:88`, `attendant-screen.test.tsx:82,94` query `.banner.bad[role="alert"]`; `attendant-camera.test.tsx:70`, `attendant-screen.test.tsx:71` use `.platebox`; `crud-roles.test.tsx:215` uses `button.danger`; many tests find controls by raw `select`/`input[name=...]`; e2e: `e2e/crud.mjs:96` (`.pill.warn`), `e2e/polling.mjs:12` (`.pill`), `e2e/audit-flows.mjs:75-78` (`.btn.primary.big`).
- Fix (WP-7, executed before the bulk class deletion): switch queries to roles and accessible names (`getByRole('alert')`, `getByRole('button', {name})`, `getByLabelText`) and add `data-testid` only for structural anchors that have no role (plate display `data-testid="plate-display"`); replace `.btn.primary.big` in e2e with `getByRole('button', {name: /confirm/i})`. Add Playwright checks: 360x640 touch-target audit on `/a/*`, `ar` RTL smoke, dark-mode smoke, offline emulation indicator (`context.setOffline(true)` then expect "Offline" status, back online then expect "Syncing" then "Online").

### Findings by severity (section 9 tally)

Counts (computed with `grep -cE '^### UI-[0-9]+ · <Severity> ·' audit-ui.md`):

| Severity | Count | IDs |
| --- | --- | --- |
| Critical | 0 | none (no data-loss or security defect found in the UI layer; the closest are UI-38 and UI-57) |
| High | 16 | 01, 02, 03, 06, 19, 20, 29, 30, 37, 38, 39, 40, 57, 60, 61, 62 |
| Medium | 44 | 04, 05, 07, 08, 10, 11, 12, 16, 17, 18, 21, 22, 23, 24, 25, 27, 31, 32, 33, 34, 35, 41, 42, 43, 44, 45, 48, 50, 51, 53, 54, 55, 56, 59, 63, 64, 65, 66, 67, 68, 69, 70, 72, 76 |
| Low | 16 | 09, 13, 14, 15, 26, 28, 36, 46, 47, 49, 52, 58, 71, 73, 74, 75 |
| Total | 76 | |

---

## 10. shadcn components to add

Style is `base-nova` (Base UI), Tailwind v4, `iconLibrary: lucide`, `rtl: true`, from `apps/web` (where `components.json` lives). Registry names verified with `pnpm exec shadcn search @shadcn` (221 items): all of the following exist.

```bash
cd apps/web
pnpm dlx shadcn@latest add alert-dialog breadcrumb combobox command select field input-group \
  sonner switch toggle-group pagination popover progress scroll-area drawer item kbd \
  button-group direction
```

Why each:
- `alert-dialog`: every destructive confirm (UI-38). `sonner`: toasts (UI-27). `breadcrumb`: PageHeader (UI-21). `field`, `input-group`: forms, money/phone/search/copy inputs, password (UI-42, UI-43, UI-45, UI-73). `select`, `combobox`: replace most `NativeSelect` and the three hand-rolled listboxes (UI-50, UI-61). `command`: command palette (UI-28; the `combobox` already covers pickers). `switch`, `toggle-group`: settings, payment method, filters, roles (UI-46, UI-64). `pagination`: DataTable (UI-29). `popover`: ConnectionStatus details, help popovers (UI-19, UI-70). `progress`: stacked capacity bar for large n (UI-53). `scroll-area`: preview tables, long lists inside Sheets. `drawer` (vaul): attendant bottom keypad and mobile detail views (UI-62, UI-55). `item`: list rows replacing `Card row between` and `<br/>` stacks (UI-33, UI-37, UI-58, UI-69). `kbd`: shortcut hints in the command palette and keypad. `button-group`: grouped actions in toolbars. `direction`: Base UI `DirectionProvider` so popups/menus/sliders honor `dir=rtl` (components.json already has `rtl: true`; wire `<DirectionProvider direction={dir}>` in `main.tsx` using `useI18n().dir`).
- Already installed and to be USED (currently 0 importing screens): `dialog`, `sheet`, `tabs`, `dropdown-menu`, `empty`, `skeleton`, `spinner`, `label`, `separator`, `tooltip` (1 file), `avatar` incl. `AvatarBadge`.
- Not recommended now: `form` (react-hook-form + zod; see UI-42), `data-table` is a docs pattern not a registry item, so add `@tanstack/react-table` as one exact-pinned dependency (`pnpm --filter @openpark/web add -E @tanstack/react-table`), `navigation-menu`, `menubar`, `carousel`, `chart` (no chart need; revisit for occupancy trends).
- Customize after add (do not overwrite blindly): `button.tsx` (variants, `touch`/density sizes, `loading`; UI-02, UI-10), `badge.tsx` (semantic variants, UI-05), `alert.tsx` (variants, role, icons; UI-04), `tabs.tsx` (touch size; UI-63), `checkbox.tsx`/`switch.tsx` (touch size; UI-67), `sonner.tsx` (remove `next-themes`; UI-27), `native-select.tsx` (density; UI-10). Run a `cn` import codemod first (UI-13) so generated files match.

New shared components (live in `src/components/`, no shadcn equivalent): `PageHeader`, `DataTable` (+ `SortableHead`, `TableState`), `ViewState`, `ConfirmDialog`/`useConfirm`, `SecretDialog`, `ConnectionStatus`, `StatusBadge`, `MoneyInput`/`NumberField`/`PhoneField`, `CountrySelect`/`TimezoneCombobox`, `ImportWizard`, `CapacityBar`, `CameraFrame`, `FlowHeader`, `ThemeProvider`, `BootSplash`, `TenantSwitcher`/`NavUser`.

---

## 11. Work packages (parallelizable by file ownership)

Dependencies: WP-0 first (blocking, contracts below); WP-1 through WP-6 are disjoint in file ownership and can run in parallel after WP-0 step 1 and 2 land; WP-7 last (or continuously for tests). Each package runs the gate: `pnpm --filter @openpark/core build && pnpm typecheck && pnpm test && pnpm --filter @openpark/web check:css`, plus visual checks at 360x640, 768, 1280, `ar` (RTL), dark mode.

Shared edit rules to avoid collisions: `App.tsx` route blocks are edited only by the owner of that subtree (WP-1 shell/ops routes, WP-3 admin routes, WP-5 attendant routes, WP-6 resident/auth routes); locale files get keys appended in a package-prefixed block (`sync.*`, `state.*`, `confirm.*`, ...) and WP-7 reconciles all 8 files and regenerates `en-XA.json`; no WP edits another WP's screen files.

### WP-0 · Foundation (single owner, blocking)
Findings: UI-01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 12, 13, 14, 15, 17, 75 (shared package), 54 (provide the `DisabledReason` tooltip pattern), plus creation of shared components.
Owns: `src/styles.css`, `packages/ui/**`, `src/components/ui/**`, new `src/components/{page-header,data-table,table-state,view-state,confirm-dialog,secret-dialog,status-badge,money-input,number-field,phone-field,country-select,timezone-combobox,theme-provider}.tsx`, `src/lib/{countries,timezones}.ts`, `main.tsx` (providers: `ThemeProvider`, `DirectionProvider`, `Toaster`), `components.json` (only if needed).
Steps: 1) confirm cascade in DevTools, wrap legacy CSS in `@layer components`, run the app, fix the worst regressions in `ui/*` (not screens); 2) `shadcn add` list (section 10), `cn` codemod, theme provider, token consolidation (UI-07), Button/Badge/Alert/Tabs/Checkbox changes; 3) build shared components with the contracts below; 4) leave legacy classes in place for screens still migrating (they keep working inside the layer).
Contracts (code against these before they land):
```ts
<PageHeader title string, description?, breadcrumbs?: {label:string; to?:string}[], actions?: ReactNode />
<DataTable<T> columns, data, getRowId, isLoading, error, onRetry, empty:{title,body,action?}, sort?, onSortChange?, pagination?:{page,size,total,onChange}, toolbar?: ReactNode, mobileRow?: (row:T)=>ReactNode />
<TableState loading error onRetry empty emptyTitle emptyBody emptyAction colSpan />   // table body
<ViewState loading error onRetry empty emptyTitle emptyBody emptyAction />          // non-table
const confirm = useConfirm(); await confirm({ title, description, confirmLabel, destructive?:true, requireText?:string }) // boolean
<SecretDialog open title description secret onClose />
<StatusBadge kind="session|slot|pass|key|hook" value />
<Button loading size="default|sm|touch|icon" />, Badge variant success|warning|info|destructive|neutral, Alert variant info|success|warning|destructive
```
Acceptance: `styles.css` ≤ 80 lines for remaining non-shadcn blocks at end of WP-7; dark mode switchable and correct; no new `className="btn..."`.

### WP-1 · Shell, navigation, connection status, boot
Findings: UI-19 (UI half), 20, 21 (shell part), 22, 23, 24, 25 (header and tab bar), 26, 27 (Toaster wiring with WP-0), 28, 16 (shell carets).
Owns: `src/components/{Shell,AppMenu,SyncBadge→ConnectionStatus,Invitations}.tsx`, `src/menu.ts`, `src/app-context.tsx` (bootstrap UI only: splash/offline states), `src/App.tsx` (shell and ops routes), `index.html`, `public/manifest.webmanifest` (no change expected).
Depends on: WP-0 steps 1-2 (`Popover`, `DropdownMenu`, `Breadcrumb`, Toaster). Hand-offs: `SyncProvider` engine and cached bootstrap to the offline track (this WP defines `useSync()` UI contract, UI-19).
Acceptance: connection indicator shows online/syncing/offline/pending/conflicts in e2e with `setOffline`; only one flush loop mounted; attendant layout has no sidebar and ≤ 48 + 56 px chrome; skip link and titles present.

### WP-2 · Operations screens: Dashboard, Sessions, Slots, Guest passes, Queue
Findings: UI-29 (consumers), 31 (consumers), 32, 33, 34, 35, 37, 36 (n/a here), 16 (arrows), 18.
Owns: `src/screens/{Dashboard,Sessions,Slots,GuestPasses,Queue}.tsx`; new `src/screens/sessions/SessionSheet.tsx`, `src/components/capacity-bar.tsx` (shared with WP-5; WP-2 builds it, WP-5 consumes), `components/hooks.ts` (`useApi` `isOffline`, `useLiveEvents` returns `{live, updatedAt, mode}`; coordinate: hooks.ts is also WP-0-adjacent, WP-2 owns it).
Note: GuestPasses policy form findings UI-43/46 are WP-3c's; this WP does the list half. To avoid a conflict, split the file: `screens/passes/PassesList.tsx` (WP-2) and `screens/passes/PassPolicy.tsx` (WP-3c) behind the route `/passes` and `/passes/policy`.
Acceptance: filters/pagination in URL; row detail is a routed Sheet; Queue has labelled Tabs, Item rows, site-timezone times, confirmed discard.

### WP-3a · Parking (sites, zones, slots, community)
Findings: UI-38 (zones/slots/sites), 39, 40, 41, 42, 47, 50 (timezone/zone), 54.
Owns: `src/screens/Parking.tsx` → `src/screens/parking/{SitesList,SiteForm,SiteOverview,ZonesTab,ZoneSheet,SlotsTab,SlotSheet,CommunitySettings}.tsx`; route block `/parking/**`, `/settings/community`.
Depends on: WP-0 contracts, `useIdempotentForm()` (created here in `src/components/hooks-form.ts`; WP-3b/3c reuse, so land it first in this WP).

### WP-3b · People (Units, Users, invites)
Findings: UI-30, 38 (unit/user/invite), 40, 41, 42, 45 (temp passwords), 50 (unit select), 51, 52 (roles fieldset), 54, 16.
Owns: `src/screens/People.tsx` → `src/screens/people/{UnitsList,UnitForm,UsersList,UserForm,InviteForm,RoleFields}.tsx`; routes `/units/**`, `/users/**`. The units import block (`People.tsx:142-192`) is removed when WP-4's `ImportWizard` lands; until then leave it in a separate `UnitsImport.tsx` file so WP-4 deletes it cleanly.

### WP-3c · Integrations, Platform, Settings, Rates, Pass policy
Findings: UI-36, 38 (keys/webhooks/tenant/pass cancel), 41, 42, 43, 44, 45 (secrets), 46, 47, 31 (`String(e)` sites in these files).
Owns: `src/screens/{Integrations,Platform,Settings,Rates}.tsx` → `integrations/{KeysList,KeyForm,WebhooksList,WebhookForm}.tsx`, `platform/*`, `settings/AiSettings.tsx`, `rates/{PlansList,PlanForm,Simulator}.tsx`, `passes/PassPolicy.tsx`; routes `/integrations/**`, `/rates/**`, `/settings/ai`, `/platform/**`, `/passes/policy`.

### WP-4 · Bulk import/export wizard
Findings: UI-48, 49, 52 (file input), 38 (replace-apply confirm, rollback confirm).
Owns: `src/screens/{Bulk,Inventory}.tsx` → `src/screens/bulk/{BulkPage,ImportWizard,DiffTable,Dropzone}.tsx`; routes `/bulk/:entity`, redirect `/inventory`. Deletes `Inventory.tsx`; then edits `screens/people/UnitsImport.tsx` (delete) and the `UnitsList` page header to link to `/bulk/units`.
Sequence: starts after WP-0 step 2; can merge before or after WP-3b (touches only the one isolated file in People).

### WP-5 · Attendant flow
Findings: UI-25 (attendant layout and tab bar; coordinate with WP-1 who removes the old `AttendantLayout` from `Shell.tsx`), 53, 55, 59 (attendant strings), 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 18, 16.
Owns: `src/screens/Attendant.tsx` → `src/screens/attendant/{AttendantLayout,Home,CheckInCapture,CheckInReview,CheckInConfirm,CheckOut,Keypad,HostCombobox,SlotCombobox,PlateCombobox,FlowHeader,FlowContext}.tsx`; `src/components/{LiveCamera,QrScanner,QrCode,PlateInput,CameraFrame,capacity-bar}.tsx`; routes `/a/**` in `App.tsx`; attendant-only i18n block (`att.*`).
Hand-offs: persistence shape of `FlowState` and the camera/model readiness API to the offline/ALPR tracks. This is the largest package; it can be split into 5a (layout, home, check-out, results) and 5b (capture, keypad, camera, comboboxes) if two agents are available (5b owns `Keypad`, `PlateInput`, `LiveCamera`, `QrScanner`, `CameraFrame`; 5a owns the rest; they meet at `FlowContext`).
Acceptance: Playwright 360x640 touch audit (every interactive ≥ 44x44), keypad hit width ≥ 32 px with zero dead zone and 56 px height, no `role=option` containing buttons (axe), Esc and focus return on the keypad drawer.

### WP-6 · Resident, Guest pass, Auth, Onboarding
Findings: UI-56, 57, 58, 59 (resident strings), 72, 73, 74, 38 (pass cancel confirm), 16, 18.
Owns: `src/screens/{Resident,GuestPass,Auth}.tsx` → `src/screens/resident/{Home,NewPass,PassDetail,PassHistory,Profile,SharePass}.tsx`, `screens/auth/*`, `src/components/{PasswordInput,PhoneInput,Invitations?}`: `Invitations.tsx` is WP-1; routes `/r/**`, `/login`, `/signup`, `/forgot`, `/reset`, `/onboarding`, `/pass`; `src/lib/image.ts`.

### WP-7 · Tests, locales, guards, cleanup (last)
Findings: UI-76, 15 (script), 11/12 (final deletion), 14, locale parity.
Owns: `apps/web/test/**`, `e2e/**` (UI-related scripts only), `scripts/check-logical-css.mjs`, `src/locales/*.json` (reconcile keys across the 8 files, regenerate `en-XA.json` via `scripts/pseudo.mjs`), final removal of legacy rules from `styles.css`, a grep gate in CI (`! grep -rnE 'className="[^"]*\b(btn|pill|banner|tablewrap|card)\b' apps/web/src`).
Acceptance: `pnpm typecheck && pnpm test && pnpm --filter @openpark/web check:css && pnpm --filter @openpark/web build` green; e2e scripts updated; RTL, dark and offline-indicator Playwright checks added.

### Cross-track hand-offs (not owned here)
- Sync/offline track: `SyncProvider` (single flush loop), cached bootstrap snapshot (UI-20), `FlowState` persistence (UI-65), conflict payload shape for the compare view (UI-37), microsecond timestamps display (use `Intl.DateTimeFormat` with `fractionalSecondDigits` only in the conflict detail).
- CRUD/URL track: section 6 route table; `/inventory`, `/ai` redirects.
- ALPR offline track: model readiness signal for `CameraFrame` (UI-70).
- Code-quality track: `resizeToWebP` extraction (UI-58), `useSubmitKey` consolidation (UI-39), `Number(e.target.value)` helpers (UI-43), duplicated `COUNTRIES`/`timezones` (UI-47).

---

## 12. Verification notes for whoever executes this

- This file was produced without running the app. Before WP-0 step 1 lands, run `pnpm dev:api` + `pnpm dev:web`, open DevTools on `/t/:slug/sessions`, and confirm that `.btn`/`table`/`th, td` rules (unlayered) win over `bg-primary`/`p-2` (UI-01). If the layer claim is wrong for the installed Tailwind version, UI-01's mechanism changes but UI-02..UI-05 stand (class stacking is visible in the TSX).
- Re-measure UI-60 on a real phone; the CSS math is a lower bound on what a thumb can hit, not a usability test.
- The severity tally in section 9 was produced with grep over the finding headings and cross-checked against the ID lists; re-count with `grep -cE '^### UI-[0-9]+ · High ·' audit-ui.md` (and Medium, Low).
- Numbers in this report that came from tools: contrast ratios (Python over token hex values), class-usage counts (grep -o over `src/screens` and `src/components/*.tsx`), shadcn registry names (`shadcn search @shadcn`), `check:css` pass. Everything else is read from source at the cited lines.
