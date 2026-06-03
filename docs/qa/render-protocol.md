# Manual render QA protocol

The perf suite (`tests/perf/**.perf.ts`, see `docs/qa/perf-baseline.md`) gates
the plugin's pure compute hot paths with deterministic microbenchmarks. It does
not, and cannot, gate what the user actually sees: real Obsidian Modal stacking,
real CSS layout, real scroll behaviour, CodeMirror gutter painting, and paint
timings. jsdom does not model any of those faithfully, and the plugin has no
headless e2e harness (Obsidian ships no official test API). This document is the
manual counterpart: a scripted, reproducible QA pass over the DOM-bound surfaces,
run by a human in a real Obsidian window before a release that touches rendering.

Each scenario is a self-contained block with four fixed fields:

- **Setup** - the exact precondition to reach before acting.
- **Action** - the single interaction to perform.
- **Pass** - the observable, binary criterion. If it holds, the scenario passes.
- **Fail** - what a regression looks like, so a failure is recorded, not judged.

Run the whole protocol once per release candidate and once after any change that
touches a render path. Record pass/fail per scenario; a single fail blocks the
release until explained.

## Conventions

These apply to every scenario below.

- **Real Obsidian.** Run a development build (`npm run build`, then reload the
  vault) in a real Obsidian window, not a test runner. Open the developer tools
  with `Ctrl+Shift+I` (`Cmd+Opt+I` on macOS).
- **Opening the history modal.** Three equivalent entry points open the same
  `HistoryModal` for the active file (`src/modals/history.modal.ts`):
  - Command palette: run **"Show all changes of current document"**
    (`command.show-diff`, command id `tracker-show-diff`).
  - File explorer: right-click the file, then **Local history -> Show History**
    (`menu.local-history.show-history`).
  - Editor context menu: right-click in the note body, then
    **Local history -> Show History**.
  The command and the menu entries are only available when the file has tracked
  history (a snapshot exists); on a never-edited file they are hidden or show
  the "no saved history" notice. Make at least one edit and let the save debounce
  fire before expecting the entry.
- **Timing via `Performance.now()`, not a stopwatch.** "Open time" and
  "latency" criteria are measured in the DevTools console, never by eye. The
  documented marker for the modal open is the body of `HistoryModal.onOpen`
  (`src/modals/history.modal.ts`), which runs `getInitialBaseId()`, `makeUI()`,
  and the initial `renderDiff()` synchronously. To measure it without editing
  source, paste this into the DevTools console before triggering the open, then
  trigger it once:

  ```js
  // The installed plugin id is "local-history" (see manifest.json).
  // Simplest reliable measurement: mark a start, trigger the open, read the gap.
  const t0 = performance.now();
  // ...trigger the open via the command palette or menu now...
  // then, immediately after the modal has appeared, run:
  performance.now() - t0;
  ```

  When a local dev build is available, the precise and preferred marker is a
  `performance.mark('lct-modal-open-start')` at the top of `onOpen` and a
  `performance.measure` at the end of it; read the measure from the Performance
  panel. The thresholds below are deliberately generous so a slower machine
  still passes a healthy render; they exist to catch an order-of-magnitude
  regression, not to benchmark hardware.
- **No console errors.** Every scenario implicitly requires the DevTools console
  to stay clean: any uncaught exception or plugin-thrown error during the action
  is a fail regardless of the visible result.
- **No detached-node leak.** For the open/close scenarios, a heap snapshot taken
  in the DevTools Memory panel after closing the modal must not retain a growing
  set of detached `lct-*` DOM nodes across repeated open/close cycles.

## History modal

The modal renders a three-pane shell: a left rail with a content-search box
(`.lct-rail-search`) above a version timeline (`.lct-versions`), and a right
column stacking a toolbar (`.lct-modal-toolbar`) over the diff block
(`.lct-diff-block` containing `.diff-container`). The version list render is
`O(versions)`; search filters `O(versions x content)`; the diff recomputes on
every base pick and every mode toggle. The modal opens on side-by-side mode by
default and selects the latest captured version as the diff base.

### Scenario H1 - Cold open, small file

- **Setup:** Pick a tracked note of roughly 20-100 lines that has between 3 and
  10 captured versions (edit it a few times, letting the save debounce fire
  between edits, to build the timeline). Close any open history modal. Open
  DevTools and clear the console.
- **Action:** Open the history modal for that file via the command palette
  ("Show all changes of current document"), timing the open per the
  `Performance.now()` convention above.
- **Pass:** The modal opens to the three-pane shell with the left rail showing
  the version list (newest version selected and highlighted with `is-active`),
  the right pane showing a side-by-side diff, and the toolbar visible. The
  measured `onOpen` cost is under 150 ms. Console stays clean.
- **Fail:** Open cost exceeds 150 ms; the rail, toolbar, or diff is missing or
  unstyled; no version is highlighted; or a console error is thrown.

### Scenario H2 - Cold open, large file

- **Setup:** Pick or build a tracked note of roughly 1000+ lines with 30 or more
  captured versions (a long note edited repeatedly). Close any open history
  modal. Open DevTools and clear the console.
- **Action:** Open the history modal for that file, timing the open per the
  `Performance.now()` convention.
- **Pass:** The modal opens with the full version timeline scrollable in the
  left rail (grouped by day, newest first) and the side-by-side diff rendered in
  the right pane. The measured `onOpen` cost is under 600 ms. The list scrolls
  smoothly with no visible per-frame jank. Console stays clean.
- **Fail:** Open cost exceeds 600 ms; the rail list is truncated or unscrollable;
  the diff pane is blank while versions exist and differ; scrolling the version
  list visibly stutters; or a console error is thrown.

### Scenario H3 - Search typing latency

- **Setup:** Open the history modal on the large file from H2 (30+ versions).
  Confirm the content-search box (`.lct-rail-search`, placeholder
  "Search versions") is visible at the top of the left rail.
- **Action:** Type a short query (3-5 characters) that matches the captured
  content of some but not all versions, character by character at normal typing
  speed.
- **Pass:** The version list re-filters live as you type, keeping only versions
  whose captured content contains the query (the selected diff base and the diff
  pane do not change). The list updates within one keystroke with no perceptible
  lag, and a query matching nothing shows the single "No versions match the
  search" hint. Console stays clean.
- **Fail:** The list lags visibly behind the typed characters; the diff pane or
  the selected base changes while typing; a non-matching query leaves the full
  list or a blank rail instead of the no-results hint; or a console error is
  thrown.

### Scenario H4 - Version switch latency

- **Setup:** Open the history modal on the large file from H2. Note which version
  is selected (the highlighted `is-active` row at the top of the rail) and the
  diff currently shown in the right pane.
- **Action:** Click a different version row well down the timeline (or press the
  Down arrow several times while the version list has focus) to switch the diff
  base to an older version.
- **Pass:** The clicked row becomes the highlighted selection, the previous
  selection loses its highlight, and the right pane re-renders the diff between
  the newly selected base and the current content. The switch completes within
  about 200 ms with no flash of an empty pane that lingers, and the toolbar
  buttons (restore/remove/label) update their enabled state to match the new
  selection. Console stays clean.
- **Fail:** Selecting a row does not move the highlight or does not redraw the
  diff; the diff pane stays blank for the selected base when the contents differ;
  the switch takes noticeably longer than ~200 ms; the toolbar enabled states do
  not track the selection; or a console error is thrown.

### Scenario H5 - Diff mode toggle (patch / inline / line-by-line / side-by-side)

- **Setup:** Open the history modal on the small file from H1 with a base
  selected that genuinely differs from the current content (so the diff is
  non-empty). The toolbar's right-hand mode group holds four toggles:
  **Show patch**, **Inline**, **Line by line**, **Side by side**.
- **Action:** Click each of the four mode buttons in turn (patch, then inline,
  then line by line, then side by side), pausing on each to observe the render.
- **Pass:** Each click re-renders the diff in that mode and the clicked button
  carries the active highlight (`is-active`) while the other three do not. Patch
  shows a single plain text block; inline shows word-level highlights within
  changed lines; line-by-line shows a single-column numbered diff; side-by-side
  shows two columns with the column header naming the base (left) and current
  (right). Switching to side-by-side keeps the two columns scroll-synchronised.
  Each toggle completes within about 300 ms on this small file with no leftover
  DOM from the previous mode. Console stays clean.
- **Fail:** A mode button does not change the rendered diff or leaves a previous
  mode's markup behind; more than one mode button shows the active highlight, or
  none does; the side-by-side columns do not scroll together; a toggle takes
  noticeably longer than ~300 ms on the small file; or a console error is thrown.
