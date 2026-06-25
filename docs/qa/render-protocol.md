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

Last verified: 2026-06-05 on Obsidian 1.12.7, plugin commit 2451e57.

## Folder-history modal

The folder modal (`src/modals/folder-history.modal.ts`) renders a three-column
shell inside `.lct-folder-history-modal`: a left timeline rail
(`.lct-modal-rail.lct-folder-modal-rail` wrapping `.lct-versions`), a middle
column (`.lct-folder-modal-tree`) stacking a name-filter box
(`.lct-folder-tree-search`, also `.lct-rail-search`) over a scrollable changed-file
tree (`.lct-folder-tree-scroll`, rendered by `FolderTreeComponent`), and a right
main column (`.lct-modal-main`) holding a toolbar (`.lct-modal-toolbar`) over the
diff block (`.lct-diff-block` containing `.diff-container`). The rail is
synthesised once from `FolderTimelineHelper.synthesize` (every per-file capture /
delete / move-in under the root, grouped by day, newest first); picking a
timeline point T re-colours the tree via `FolderDeltaHelper.compareAt`
(`O(files)` per pick). Each tree file row carries a status token
(`lct-tree-added` / `lct-tree-modified` / `lct-tree-deleted`) and the selected
row carries `is-active`. The modal opens on side-by-side mode and selects the
newest timeline point's T. It is opened from the file explorer: right-click a
**folder**, then **Local history -> Show History**
(`menu.local-history.show-history`), which routes through
`ModalsService.openFolderHistory`.

### Scenario F1 - Cold open, folder with changes

- **Setup:** Pick a folder that contains several tracked notes with captured
  history (edit a few notes inside it, letting the save debounce fire, so the
  subtree has captures across more than one file). Close any open history modal.
  Open DevTools and clear the console.
- **Action:** Right-click the folder in the file explorer, open
  **Local history -> Show History**, timing the open per the `Performance.now()`
  convention from the Conventions section (the documented marker is the body of
  `FolderHistoryModal.onOpen`, which runs `makeUI()`,
  `timelineRenderer.render()`, `refreshTree()`, and `refreshDiff()`
  synchronously).
- **Pass:** The modal opens to the three-column shell: the left rail lists the
  folder timeline points grouped by day (newest first, the newest point
  highlighted with `is-active`), the middle tree shows the changed files under
  the folder (each row coloured by its status token, folders expanded by
  default), and the right pane shows a side-by-side diff for the first selected
  file. The measured `onOpen` cost is under 600 ms. Console stays clean.
- **Fail:** Open cost exceeds 600 ms; any of the three columns is missing or
  unstyled; the tree is empty while changed files exist in the subtree; no
  timeline point is highlighted; the diff pane is blank while the selected file
  differs; or a console error is thrown.

### Scenario F2 - Name-filter typing

- **Setup:** Open the folder modal on a folder whose tree shows at least a
  half-dozen files spread across one or more subfolders. Confirm the name-filter
  box (`.lct-folder-tree-search`, placeholder "Filter files by name") sits above
  the tree.
- **Action:** Type a short query (3-5 characters) that matches the names of some
  but not all files in the tree, character by character at normal typing speed.
- **Pass:** The tree re-filters live as you type, keeping only files whose name
  contains the query and the ancestor folders needed to reach them (every folder
  is force-expanded while the filter is active). The timeline rail, the selected
  timeline point T, and the diff pane do not change while typing. A query that
  matches nothing collapses the tree to the single empty-state hint
  ("No changes in this folder for the selected point."). The list updates within
  one keystroke with no perceptible lag. Console stays clean.
- **Fail:** The tree lags visibly behind the typed characters; filtering changes
  the selected T or the diff pane; a non-matching query leaves stale rows or a
  blank tree instead of the empty-state hint; matched files lose their ancestor
  folders; or a console error is thrown.

### Scenario F3 - Expand and collapse a tree node

- **Setup:** Open the folder modal on a folder with at least one subfolder that
  itself contains changed files, so the tree renders a collapsible folder row
  (`.lct-folder-tree-folder` with a chevron). Clear the name filter so the
  user's collapse choices are honoured.
- **Action:** Click the folder row to collapse it, then click it again to
  expand it.
- **Pass:** Collapsing hides that folder's child rows and flips the chevron to
  the collapsed glyph; expanding restores the children and the open glyph. The
  selected file row keeps its `is-active` highlight when it is still visible, and
  the diff pane and the selected timeline point T are untouched by the toggle.
  Each toggle is immediate with no visible reflow jank. Console stays clean.
- **Fail:** Clicking the folder does not toggle its children or does not flip the
  chevron; the toggle clears or moves the file selection; the diff pane re-renders
  or blanks on a pure expand/collapse; or a console error is thrown.

### Scenario F4 - Timeline point pick and rail scroll

- **Setup:** Open the folder modal on a folder with many timeline points across
  several days, enough that the rail (`.lct-folder-modal-rail`) scrolls. Note the
  currently highlighted point and the tree colours.
- **Action:** Scroll the rail to an older day, then click a timeline point well
  down the rail to re-pin T.
- **Pass:** The rail scrolls smoothly with no per-frame jank. Clicking a point
  moves the `is-active` highlight to it, re-colours the tree to the per-file
  delta at the new T (`FolderDeltaHelper.compareAt`), preserves the user's
  expand/collapse state, and re-renders the diff for the still-selected file at
  the new T. The pick completes within about 300 ms with no lingering empty diff
  pane. Console stays clean.
- **Fail:** The rail stutters while scrolling; clicking a point does not move the
  highlight or does not re-colour the tree; the expand/collapse state resets on a
  pick; the diff pane stays blank for a file that differs at the new T; the pick
  takes noticeably longer than ~300 ms; or a console error is thrown.

Last verified: 2026-06-05 on Obsidian 1.12.7, plugin commit 2451e57.

## Recent-changes view

The recent-changes view (`src/views/recent-changes.view.ts`) is a right-sidebar
`ItemView` (`.lct-recent-changes-view`) holding a single list
(`.lct-recent-changes-list`) of rows (`.lct-recent-changes-item`), one per
captured version of the active file, newest first. Each row shows the action or
custom label (`.lct-recent-changes-label`), the capture date-time
(`.lct-recent-changes-meta`), and the `+A -B` line delta
(`.lct-recent-changes-delta`). The view reacts to `active-leaf-change` and to the
plugin's internal snapshots-update event, so switching the active file or
capturing a version re-renders it. With no active file or no snapshot it shows a
single muted hint (`.lct-recent-changes-empty`, "No version history for the
active file."). Double-clicking a row opens the history modal in rail-less mode
focused on that version; right-clicking a row opens a context menu
(`view.recent-changes.menu.*`). It has no command-palette entry: reveal it from
the file explorer by right-clicking a file or folder, then
**Local history -> Recent changes** (`menu.local-history.recent-changes`), which
calls `plugin.revealRecentChanges()`.

### Scenario R1 - Open in the side panel and react to the active file

- **Setup:** Have at least two tracked notes with captured history. Open DevTools
  and clear the console. Make sure the recent-changes panel is not already open.
- **Action:** Right-click one tracked file in the file explorer, open
  **Local history -> Recent changes** to reveal the panel, then click the other
  tracked note in the file explorer to switch the active file.
- **Pass:** The panel appears in the right sidebar titled "Recent changes" with
  the version list for the first file (newest first, each row showing label,
  date-time, and `+A -B` delta). Switching the active file re-renders the list
  against the newly active file's timeline. A second reveal focuses the existing
  panel rather than spawning a duplicate leaf. Console stays clean.
- **Fail:** The panel does not appear or appears empty while the file has
  versions; switching the active file leaves the previous file's rows; a second
  reveal opens a duplicate panel; or a console error is thrown.

### Scenario R2 - Large file history

- **Setup:** Open the recent-changes panel on a tracked note with 30 or more
  captured versions (a long note edited repeatedly). Clear the console.
- **Action:** Scroll the version list from top to bottom and back.
- **Pass:** The full version list renders (one `.lct-recent-changes-item` per
  version, newest first) and scrolls smoothly inside the panel with no visible
  per-frame jank. Every row shows its label, capture date-time, and delta without
  layout overflow clipping the text. Console stays clean.
- **Fail:** The list is truncated or unscrollable; rows render without their
  label, date-time, or delta; scrolling visibly stutters; row text is clipped or
  overlaps; or a console error is thrown.

### Scenario R3 - Empty-state reaction

- **Setup:** Open the recent-changes panel with a tracked file active so the
  version list is visible. Clear the console.
- **Action:** Switch the active file to a never-edited note that has no captured
  history (or close all editors so there is no active file).
- **Pass:** The list is replaced by the single muted hint
  ("No version history for the active file.") with no stale rows from the
  previous file left behind. Switching back to a tracked file restores its
  version list. Console stays clean.
- **Fail:** The previous file's rows linger after switching to an untracked file;
  the panel shows a blank list instead of the hint; switching back does not
  restore the list; or a console error is thrown.

Last verified: 2026-06-05 on Obsidian 1.12.7, plugin commit 2451e57.

## Gutter markers

The change gutter is two CodeMirror extensions registered per editor:
`GutterCommonExtension` (`src/extensions/gutter-common.extension.ts`) paints a dot
(`.lct-gutter`) on every added / changed / restored line, and
`GutterRemovedExtension` (`src/extensions/gutter-removed.extension.ts`) paints a
removed-line marker at the first current line that follows a deleted run. Markers
are recomputed from the active snapshot's change map on every change-detector
pass, so they refresh as you type. The dot affordance reverts a single changed
block: clicking it recomputes the hunks against live content
(`HunkHelper.diff`), confirms through a "Revert change" dialog, and applies only
that block via `SnapshotsService.applyContent`, leaving other changes intact.
Which marker types render is governed by the `show.changed` / `show.restored` /
`show.added` / `show.removed` settings; the gutter's own right-click menu offers
a single **Show changes** toggle (`menu.show-changes`).

### Scenario G1 - Markers appear and refresh on edit

- **Setup:** Open a tracked note in the editor with the dot indicator type and
  the change types enabled in settings. Confirm the file has a baseline (it has
  captured history). Clear the console.
- **Action:** Edit a few separate lines in the note body (change one line, add a
  new line, delete a line), pausing between edits.
- **Pass:** A dot marker appears in the gutter beside each added or changed line,
  and a removed-line marker appears at the line that now follows each deleted run.
  The markers refresh as you type, tracking the changed lines without a stale dot
  on a line that no longer differs and without a missing dot on a line that does.
  Console stays clean.
- **Fail:** No markers appear on changed lines; markers persist on lines that no
  longer differ from the baseline; the gutter does not refresh until the editor
  is reloaded; markers land on the wrong lines; or a console error is thrown.

### Scenario G2 - Revert a hunk from the gutter

- **Setup:** Open a tracked note that has at least two separate changed blocks
  relative to its baseline, each carrying a gutter dot. Clear the console.
- **Action:** Click the gutter dot on one changed block and confirm the
  **Revert change** dialog.
- **Pass:** Only the clicked block reverts to its baseline content; the other
  changed block keeps its content and its gutter dot. After the write the gutter
  re-renders so the reverted block's dot is gone while the untouched block's dot
  remains. Dismissing the confirm dialog instead leaves all content and markers
  unchanged. Console stays clean.
- **Fail:** Reverting the block touches or clears the other block; the reverted
  block's gutter dot lingers; the confirm dialog does not appear, or dismissing
  it still writes; the wrong block reverts; or a console error is thrown.

### Scenario G3 - Removed-line marker placement after deletion

- **Setup:** Open a tracked note with `show.removed` enabled and the dot
  indicator type. Clear the console.
- **Action:** Delete one or more contiguous lines from the middle of the note,
  then delete a separate single line elsewhere.
- **Pass:** A single removed-line marker appears at the current line that
  immediately follows each deleted run (one marker per run, not one per deleted
  line), and no removed marker appears for a run whose preceding line is itself
  removed. Adding the deleted text back removes the marker. Console stays clean.
- **Fail:** A removed marker appears on every deleted line instead of once per
  run; the marker lands on the wrong line (not the line after the deletion);
  restoring the deleted text leaves the marker behind; or a console error is
  thrown.

Last verified: 2026-06-05 on Obsidian 1.12.7, plugin commit 2451e57.

## External-change badge

External writes to a tracked file (git pull, sync, an editor outside Obsidian)
fire Obsidian's `vault.modify` event, which `VaultModifyEvent`
(`src/events/vault/modify.event.ts`) routes to
`SnapshotsService.scheduleExternalCapture` (a 150 ms per-path debounce). The
resulting `FileVersion` is flagged external, and every render surface marks it
with the same badge: `.lct-version-external-badge` (a `download-cloud` glyph plus
the text from `version.badge.external`, "external"). The badge must appear on all
three surfaces that show versions, so each gets its own scenario: the history
modal rail, the recent-changes panel, and the folder tree.

### Scenario X1 - Badge in the history modal rail

- **Setup:** Open a tracked note in Obsidian and let it settle. Keep DevTools open
  and the console clear. Have a way to write the same file from outside the
  Obsidian editor (e.g. edit and save it in a second text editor, or run a
  `git pull` / sync that touches it).
- **Action:** Modify the file's content from outside the Obsidian editor and wait
  for the external capture to settle (past the ~150 ms debounce). Then open the
  history modal for that file via the command palette and look at the newest row
  in the left rail (`.lct-versions`).
- **Pass:** The newest version row in the rail carries the external badge (the
  `download-cloud` glyph and the "external" label) alongside its action label.
  Hovering the badge shows the "external" tooltip. Versions captured from in-app
  edits carry no badge. Console stays clean.
- **Fail:** The external write produces no new version, or a version without the
  badge; an in-app edit's version wrongly shows the badge; the badge renders
  without its glyph or label; or a console error is thrown.

### Scenario X2 - Badge in the recent-changes panel

- **Setup:** Reveal the recent-changes panel
  (**Local history -> Recent changes**) on the tracked file from X1 so its
  version list is visible. Clear the console.
- **Action:** Modify the same file from outside the Obsidian editor and wait for
  the external capture to settle (past the ~150 ms debounce), keeping the panel
  open and the file active.
- **Pass:** A new row appears at the top of the panel list carrying the same
  external badge (`download-cloud` glyph plus the "external" label), without any
  manual refresh of the panel: the snapshots-update event re-renders it. The
  badge text and glyph match the rail's badge exactly. Console stays clean.
- **Fail:** The panel does not gain a new row, or the new row lacks the badge; the
  panel needs a manual reopen to show the external version; the badge differs in
  glyph or text from the rail; or a console error is thrown.

### Scenario X3 - Badge in the folder tree

- **Setup:** Open the folder modal (**Local history -> Show History** on a
  folder) for a folder containing the tracked file, with that file's row visible
  in the tree. Note the rail timeline. Clear the console.
- **Action:** Modify that file from outside the Obsidian editor, wait for the
  external capture to settle, then reopen the folder modal for the same folder
  (the folder modal snapshots the subtree at open time, so a fresh open reflects
  the new external capture).
- **Pass:** The newest rail timeline point for that file carries the external
  badge, and when its T is the selected point the file's row in the tree carries
  the external badge too (it follows the version closest to T). The badge glyph
  and "external" text match the rail and panel badges. Folder rows never carry
  the badge, only file rows. Console stays clean.
- **Fail:** The external capture does not surface a badged timeline point; the
  tree row for the externally-changed file at its capture T lacks the badge; an
  ancestor folder row wrongly shows the badge; the badge differs in glyph or text
  from the other surfaces; or a console error is thrown.

Last verified: 2026-06-05 on Obsidian 1.12.7, plugin commit 2451e57.

## Native tree + tab highlight

The tree/tab decorator (`TreeTabDecoratorService`,
`src/services/tree-tab-decorator.service.ts`) tints Obsidian's OWN file-explorer
rows and workspace tab headers by what changed this session, so "what I touched
this run" is legible from the native surfaces, not only from inside the editor
(gutter) or the plugin's modals. It owns no DOM: it adds and removes the shared
status classes `lct-tree-added` and `lct-tree-modified` on rows Obsidian renders
(`fileItems[path].selfEl`) and on the tab headers of open files
(`leaf.tabHeaderEl`), and never re-renders the explorer. Native surfaces
carry only `added` and `modified`, never `lct-tree-deleted`: a deleted file
has no row or tab to paint, so deletes stay in the diff modal. Session status is
the same notion the gutter uses: a file created this session resolves to
`added`, a file whose marker baseline differs now
(`getChangesLinesCount() > 0`) resolves to `modified`. The two colours come from
the shared `--lct-status-*` palette: `added` is green (`--color-green`),
`modified` is amber (`--text-warning`), so a tree row, a tab, and the modal tree
can never disagree. Ancestor folders of any changed file are tinted the single
`modified` (amber) token. Applies are debounced (100 ms) and diff-based, so
a burst of keystrokes collapses into one trailing sweep that touches only rows
whose status changed. A `MutationObserver` on the explorer container catches
lazily-rendered rows from expand/collapse or drag. The whole decorator is
gated by the `setting.tree-highlight` toggle (default on): off clears every
applied class live and on re-applies without a reload.

For these scenarios, in DevTools you can confirm a class on a row by inspecting
the `.nav-file-title` / `.nav-folder-title` element (the title node carries
`lct-tree-added` or `lct-tree-modified`) and a tab by inspecting the
`.workspace-tab-header` element; this is the same DevTools inspection the other
sections already rely on, no source instrumentation. "This session" means since
the current Obsidian launch: a fresh reload resets the `added` flag (it is
transient, not persisted), so build the preconditions without reloading mid
scenario.

### Scenario N1 - Modified file row tints amber

- **Setup:** Have the native file explorer open with the `setting.tree-highlight`
  toggle on (the default). Pick a tracked note that already has captured history
  and is currently unchanged relative to its session baseline (its row shows no
  status colour). Open DevTools and clear the console.
- **Action:** Open that note and edit a line so its content differs from the
  baseline (so the gutter would show a change marker), then look at the file's row
  in the explorer.
- **Pass:** The file's row in the explorer turns amber (the `.nav-file-title`
  carries `lct-tree-modified`, painted from `--lct-status-modified`), matching the
  gutter's notion of "changed now". Reverting the edit back to the baseline content
  clears the amber within a debounce window (the `lct-tree-modified` class is
  removed). Console stays clean.
- **Fail:** The row never turns amber while the file differs from its baseline; the
  amber persists after the content is reverted to baseline; the row turns green
  instead of amber; or a console error is thrown.

### Scenario N2 - Created file row tints green

- **Setup:** Have the file explorer open with the toggle on. Open DevTools and
  clear the console. Do not reload the vault during this scenario.
- **Action:** Create a brand new note this session (e.g. via "New note" in the file
  explorer), give it a name, and look at its row in the explorer.
- **Pass:** The new file's row tints green (the `.nav-file-title` carries
  `lct-tree-added`, painted from `--lct-status-added`), distinct from the amber a
  mere edit would produce. Editing the new file further keeps it green (created
  outranks modified). Console stays clean.
- **Fail:** A file created this session shows no colour or shows amber instead of
  green; an unmodified pre-existing file wrongly shows green; or a console error is
  thrown.

### Scenario N3 - Ancestor folders tint amber

- **Setup:** Have the file explorer open with the toggle on and a tracked note
  nested at least one folder deep (e.g. `Notes/Sub/file.md`). Confirm the
  containing folders are visible (expanded) in the explorer. Clear the console.
- **Action:** Edit the nested note so it differs from its baseline (per N1), then
  look at every ancestor folder row up to, but not including, the vault root.
- **Pass:** Each ancestor folder row of the changed file tints amber (each
  `.nav-folder-title` carries `lct-tree-modified`, the single `modified` token used
  for folders regardless of whether the descendant change was an add or a modify). Reverting the file to baseline clears the folder tint once no descendant
  still differs. Console stays clean.
- **Fail:** No ancestor folder tints while a descendant file differs; a folder with
  no changed descendant wrongly tints; the vault-root row itself is tinted; the
  folder tint lingers after the only changed descendant is reverted; or a console
  error is thrown.

### Scenario N4 - Tab header of an open changed file tints

- **Setup:** Have the toggle on. Open a tracked note in a tab so its tab header is
  visible in the tab bar. Clear the console.
- **Action:** Edit the open note so it differs from its baseline (per N1) and look
  at its tab header.
- **Pass:** The tab header for the changed file tints by status (the
  `.workspace-tab-header` carries `lct-tree-modified` for an edit, or
  `lct-tree-added` for a file created this session), matching that file's row in
  the explorer. Reverting to baseline clears the tab tint. A second tab opened on
  the same file tints the same way (tabs are tracked per leaf). Console stays
  clean.
- **Fail:** The tab header never tints while the open file differs from its
  baseline; the tab tint disagrees with the file's explorer row; the tint lingers
  after the content is reverted; or a console error is thrown.

### Scenario N5 - Lazy rows decorate on expand

- **Setup:** Have the toggle on and a changed (amber or green) note that lives
  inside a folder which is currently COLLAPSED in the explorer, so the file's row
  is not yet rendered. Clear the console.
- **Action:** Expand the collapsed folder so the file's row mounts for the first
  time.
- **Pass:** The newly mounted file row already carries its status colour the moment
  it appears (the `MutationObserver` on the explorer container schedules a debounced
  re-apply that decorates the lazily-rendered row), without any edit or reload to
  prompt it. Collapsing and re-expanding the folder keeps the colour. Console stays
  clean.
- **Fail:** The freshly expanded row appears uncoloured while the file is changed
  and only colours after an unrelated edit or a reload; expanding a folder throws;
  or a console error is thrown.

### Scenario N6 - Debounced under rapid edits

- **Setup:** Have the toggle on with a tracked note open and its row visible in the
  explorer. Open DevTools and clear the console.
- **Action:** Type continuously in the note for a few seconds (a steady stream of
  keystrokes), then stop.
- **Pass:** The explorer row and the tab settle to amber and the typing stays
  smooth: the decorator does not repaint the tree on every keystroke (a single
  trailing sweep runs about 100 ms after typing stops). The editor shows no
  per-keystroke stutter attributable to tree repainting. Console stays clean.
- **Fail:** Typing visibly stutters in step with tree repaints; the row flickers on
  every keystroke; the row fails to reach amber after typing stops; or a console
  error is thrown.

### Scenario N7 - Toggle off clears, on restores

- **Setup:** Reach a state with at least one amber or green file row, its tinted
  ancestor folders, and a tinted tab (run N1 plus N3 plus N4 first). Open the
  plugin settings tab and locate the **"Highlight changes in file tree and tabs"**
  toggle (`setting.tree-highlight`). Clear the console.
- **Action:** Switch the toggle OFF, observe the explorer and tabs, then switch it
  back ON.
- **Pass:** Turning the toggle off clears every status colour live, with no reload:
  the file rows, the ancestor folder rows, and the tab headers all lose their
  `lct-tree-added` / `lct-tree-modified` classes within a debounce window. Turning
  it back on re-paints the same rows, folders, and tabs to their current statuses,
  again without a reload. Console stays clean.
- **Fail:** Turning the toggle off leaves any row, folder, or tab still tinted;
  turning it back on fails to restore the tints, or requires a reload to do so; or a
  console error is thrown.

### Scenario N8 - Full clear on plugin disable

- **Setup:** Reach a state with several tinted file rows, tinted ancestor folders,
  and at least one tinted tab (run N1 plus N3 plus N4). Open DevTools and clear the
  console.
- **Action:** Disable the plugin from Community plugins (or reload the vault),
  leaving the file explorer and the same tabs open.
- **Pass:** Every `lct-tree-added` / `lct-tree-modified` class added by the
  decorator is removed from all explorer rows, ancestor folders, and tab headers, so
  Obsidian's own DOM is left exactly as found (the decorator's `unload` clears all
  its classes symmetrically). No detached or orphaned tint lingers on any native
  surface. Console stays clean.
- **Fail:** A status colour remains on any file row, folder row, or tab header after
  the plugin is disabled; disabling throws; or a console error is thrown.

Last verified: 2026-06-05 on Obsidian 1.12.7, plugin commit 2451e57.

## Block-type render matrix

This section is a systematic sweep over every block type Obsidian can render,
crossed with both editor modes, both indicator families, and every representable
change kind. It was added after three block-specific render fixes landed
independently (tables, properties panel, quotes) to prevent further one-off
discoveries before the 1.1.0 release.

### How to read this matrix

The matrix is a checklist for a human executing the protocol in a real Obsidian
window. Each row is one (block type, mode, indicator, change kind) combination.
Before running, set the indicator type in the plugin settings (dot or line) and
enable all change kinds (added, changed, removed, restored) so every cell is
observable. Where a cell is structurally impossible, the cell says `N/A` and the
reason is given in parentheses.

Indicator families:

- **dot** - the dot gutter marker rendered by `GutterCommonExtension` (Live
  Preview, source mode) and the `lct-rm-indicator` block badge rendered by
  `ReadingModeIndicatorService` (reading mode).
- **bar** - the `::before` left-margin bar on `.cm-line.lct-line` elements
  rendered by `EditorCommonExtension` (plain source lines in Live Preview), and
  the geometry bar drawn by `ChangeLayerExtension` (block widgets in Live
  Preview). Reading mode has no bar: the block badge is the only indicator.

Change kinds per mode:

- **Live Preview**: added, changed, removed, restored all representable.
  `removed` is dot-only (gutter marker after a deleted run); the bar never
  shows a removed indicator because `ChangeLayerExtension` drops the removed
  type when building class names.
- **Reading mode**: added, changed, restored only. Removed lines have no HTML
  block in reading mode, so the `removed` cell is always `N/A` there.

### Preconditions

1. Build and reload the plugin (`npm run build`, reload vault).
2. Open the plugin settings. Set indicator type to **dot** first, then re-run
   the matrix with **line** to cover both bar columns.
3. Enable all four change kinds: added, changed, removed, restored.
4. Enable the **reading-mode indicator** toggle.
5. For each block-type row, create a note whose content is ONLY that block type
   (or a clearly isolated section). Make a baseline capture (let the save
   debounce fire). Then edit the source lines of that block to produce the
   change kind under test before switching to the target mode.
6. For reading mode cells, switch to reading mode with `Ctrl+E` after the edit
   and observe the block-level badge (`lct-rm-indicator` class, colored left
   border on the rendered block).
7. For Live Preview cells, stay in Live Preview and observe the gutter dot or
   margin bar beside the rendered block.
8. Record each cell as `pass`, `fail`, or `N/A`. A fail must include a one-line
   symptom. Record every failing cell in the
   format: `src/<file or ext>: <symptom>`.

### Matrix

This matrix has not yet been executed in a live Obsidian instance. All cells
are `pending` until the owner runs the protocol and records results. The matrix
structure (which cells are N/A and why) is derived from the source code and is
authoritative; the pass/fail values require a live vault.

**Legend:** `pending` = not yet run | `pass` | `fail: <symptom>` | `N/A (<reason>)`

#### Paragraph

| Change kind | LP dot | LP bar | RM indicator |
|-------------|--------|--------|--------------|
| added       | pending | pending | pending |
| changed     | pending | pending | pending |
| removed     | pending | pending | N/A (no HTML block for removed lines in reading mode) |
| restored    | pending | pending | pending |

Notes: Plain `.cm-line` in Live Preview; `EditorCommonExtension` decorates the
line class, `GutterCommonExtension` dots the gutter. In reading mode
`getSectionInfo()` returns the paragraph's line range and
`ReadingModeIndicatorService` decorates the `<p>` element.

#### Heading (H1-H6)

| Change kind | LP dot | LP bar | RM indicator |
|-------------|--------|--------|--------------|
| added       | pending | pending | pending |
| changed     | pending | pending | pending |
| removed     | pending | pending | N/A (no HTML block for removed lines in reading mode) |
| restored    | pending | pending | pending |

Notes: In Live Preview headings render as `.HyperMD-header` plain `.cm-line`
elements (the source line is always visible regardless of cursor position); same
decoration path as paragraph. In reading mode the `<h1>`-`<h6>` element is the
decorated block.

#### Bullet list (flat and nested)

| Change kind | LP dot | LP bar | RM indicator |
|-------------|--------|--------|--------------|
| added       | pending | pending | pending |
| changed     | pending | pending | pending |
| removed     | pending | pending | N/A (no HTML block for removed lines in reading mode) |
| restored    | pending | pending | pending |

Notes: In Live Preview bullet list items are plain `.cm-line` elements (no
replace decoration for individual items). In reading mode the whole list is one
`<ul>` block; `getSectionInfo()` spans all list lines. Test both a flat item
and a nested sub-item to confirm the line-range mapping covers nested levels.

#### Numbered list (flat and nested)

| Change kind | LP dot | LP bar | RM indicator |
|-------------|--------|--------|--------------|
| added       | pending | pending | pending |
| changed     | pending | pending | pending |
| removed     | pending | pending | N/A (no HTML block for removed lines in reading mode) |
| restored    | pending | pending | pending |

Notes: Same rendering path as bullet list in Live Preview. In reading mode the
whole list is one `<ol>` block.

#### Quote block

| Change kind | LP dot | LP bar | RM indicator |
|-------------|--------|--------|--------------|
| added       | pending | pending | pending |
| changed     | pending | pending | pending |
| removed     | pending | pending | N/A (no HTML block for removed lines in reading mode) |
| restored    | pending | pending | pending |

Notes: Quote lines are `.HyperMD-quote-N` plain `.cm-line` elements in Live
Preview (no replace decoration). The dot path iterates all doc lines and is
unaffected by quote nesting. In Live Preview bar mode a quote line draws NO
plugin bar: Obsidian's own quote marker (`.HyperMD-quote:before`, painted with
`--blockquote-border-color`) is recoloured to the change colour instead, so a
changed quote shows a single tinted quote border rather than a double line.
Source mode keeps the plugin bar (no quote marker exists there). In reading
mode the section wrapper of the `<blockquote>` is the decorated block; the
indicator border is likewise dropped and the quote's own border is recoloured
via the same variable. Expected: quote border colour = change colour, no
second vertical line in either surface. Test with a single-line quote, a
multi-line quote, and a nested quote (all nested level borders take the
change colour).

#### Callout (collapsed)

| Change kind | LP dot | LP bar | RM indicator |
|-------------|--------|--------|--------------|
| added       | pending | pending | pending |
| changed     | pending | pending | pending |
| removed     | N/A (collapsed widget hides source lines; the removed-line gutter marker sits at the first line after the widget, outside it) | N/A (ChangeLayerExtension paints a block bar but the removed type carries no color in the layer classNamesFor()) | N/A (no HTML block for removed lines in reading mode) |
| restored    | pending | pending | pending |

Notes: A collapsed callout in Live Preview is a replace-decoration block
widget. `GutterCommonExtension` iterates all doc lines so the dot should appear
at the gutter position beside the collapsed widget. `ChangeLayerExtension`
should paint a bar over the collapsed widget's geometry. In reading mode the
callout renders as a `.callout` element; when collapsed the body is hidden but
the header element is still present as the decorated block. Test: collapse the
callout, edit a source line inside its body, check for dot/bar on the collapsed
widget; then expand and re-check.

#### Callout (expanded)

| Change kind | LP dot | LP bar | RM indicator |
|-------------|--------|--------|--------------|
| added       | pending | pending | pending |
| changed     | pending | pending | pending |
| removed     | pending | pending | N/A (no HTML block for removed lines in reading mode) |
| restored    | pending | pending | pending |

Notes: An expanded callout in Live Preview may expose its inner `.cm-line`
elements (when the cursor is inside the callout body) or keep them as a block
widget (when the cursor is outside). Test with the cursor both inside and
outside the callout body. In reading mode the `.callout` element is the
decorated block.

#### Table

| Change kind | LP dot | LP bar (per-row) | RM indicator |
|-------------|--------|-----------------|--------------|
| added       | pending | pending | pending |
| changed     | pending | pending | pending |
| removed     | N/A (table widget replaces source lines; the removed-line marker sits at the first current line after the widget) | N/A (ChangeLayerExtension paints a block bar but the removed type carries no color in the layer) | N/A (no HTML block for removed lines in reading mode) |
| restored    | pending | pending | pending |

Notes: In Live Preview a table is a replace-decoration widget
(`.cm-table-widget`). `ChangeLayerExtension.tableRowRects()` matches each
changed source row to its rendered `<tr>` bounding rect, painting one bar per
changed row. Verify that only the changed row's bar lights, not the whole table
block. `GutterCommonExtension` iterates doc lines so the dot should appear
at the gutter line of the table widget. In reading mode the `<table>` element
is the decorated block. Test with a changed header row, a changed data row, and
two changed rows simultaneously (only the changed rows' bars should light).

#### Fenced code block

| Change kind | LP dot | LP bar | RM indicator |
|-------------|--------|--------|--------------|
| added       | pending | pending | pending |
| changed     | pending | pending | pending |
| removed     | pending | pending | N/A (no HTML block for removed lines in reading mode) |
| restored    | pending | pending | pending |

Notes: In Live Preview a fenced code block renders as a replace-decoration
widget when the cursor is outside it, and as visible source `.cm-line` elements
when the cursor is inside it. Test with cursor outside (widget path via
`ChangeLayerExtension`) and cursor inside (plain line path via
`EditorCommonExtension`). The dot should appear in either case. In reading mode
the `<pre><code>` element is the decorated block.

#### Math block

| Change kind | LP dot | LP bar | RM indicator |
|-------------|--------|--------|--------------|
| added       | pending | pending | pending |
| changed     | pending | pending | pending |
| removed     | N/A (math widget replaces source; the removed-line marker sits at the first current line after the widget) | N/A (ChangeLayerExtension paints a block bar but the removed type carries no color in the layer) | N/A (no HTML block for removed lines in reading mode) |
| restored    | pending | pending | pending |

Notes: Math blocks (`$$...$$`) render as replace-decoration widgets in Live
Preview. `ChangeLayerExtension` should paint a bar over the whole widget block.
`GutterCommonExtension` should dot the gutter line at the widget position. In
reading mode the rendered math element (MathJax container) is the decorated
block. Verify that `getSectionInfo()` returns a non-null range for the math
block; if null, the RM cells are N/A by the same rule as embeds.

#### Embed / transclusion

| Change kind | LP dot | LP bar | RM indicator |
|-------------|--------|--------|--------------|
| added       | pending | pending | N/A (getSectionInfo() returns null for embed blocks in reading mode per ReadingModeIndicatorService source comment; processor returns early) |
| changed     | pending | pending | N/A (same) |
| removed     | pending | pending | N/A (no HTML block for removed lines in reading mode; getSectionInfo() also null) |
| restored    | pending | pending | N/A (same as added) |

Notes: Embed lines (`![[Note]]`) are replace-decoration block widgets in Live
Preview. `ChangeLayerExtension` should detect the hidden source position and
paint a bar over the embed widget. `GutterCommonExtension` iterates all doc
lines so the dot should appear at the gutter line of the embed. In reading mode
the `ReadingModeIndicatorService` source comment explicitly notes that
`getSectionInfo()` returns null for synthetic blocks such as embeds; all RM
cells are N/A by design (not a bug to fix).

#### Image

| Change kind | LP dot | LP bar | RM indicator |
|-------------|--------|--------|--------------|
| added       | pending | pending | pending |
| changed     | pending | pending | pending |
| removed     | N/A (image widget replaces source; the removed-line marker sits at the first current line after the widget) | N/A (ChangeLayerExtension paints a block bar but the removed type carries no color in the layer) | N/A (no HTML block for removed lines in reading mode) |
| restored    | pending | pending | pending |

Notes: An inline image reference (`![[image.png]]` or `![alt](url)`) renders as
a replace-decoration widget in Live Preview. Expected behavior mirrors embed:
`ChangeLayerExtension` bar over the widget, dot from `GutterCommonExtension`. In
reading mode the `<img>` element (inside a `<p>` wrapper) is the decorated block.
Verify that `getSectionInfo()` returns a non-null range (images are not synthetic
in the same way embeds are). If null, mark RM cells N/A with that reason.

#### Frontmatter / properties panel

| Change kind | LP dot | LP bar | RM indicator |
|-------------|--------|--------|--------------|
| added       | pending | pending | N/A (the properties panel is not a markdown block; getSectionInfo() is expected to return null) |
| changed     | pending | pending | N/A (same) |
| removed     | N/A (frontmatter is a block widget; the removed-line marker sits at the first line after the frontmatter block) | N/A (ChangeLayerExtension paints a block bar but the removed type carries no color in the layer) | N/A (no HTML block for removed lines in reading mode) |
| restored    | pending | pending | N/A (same as added) |

Notes: Frontmatter in Live Preview is rendered by Obsidian's properties panel
as a replace-decoration block widget. `ChangeLayerExtension` is expected to
paint a bar over it when a frontmatter line is changed. Whether
`GutterCommonExtension` dots the gutter at frontmatter lines depends on whether
Obsidian exposes those lines in the doc (frontmatter lines are part of the
document in CodeMirror even when the widget replaces them visually). In reading
mode the properties panel is rendered outside the markdown content tree and
`getSectionInfo()` is expected to return null; all RM cells are N/A by design.
Confirm the LP dot assumption in the live run; if frontmatter lines are not
in the doc, record both dot and bar as N/A with that reason.

#### Horizontal rule

| Change kind | LP dot | LP bar | RM indicator |
|-------------|--------|--------|--------------|
| added       | pending | pending | pending |
| changed     | N/A (a horizontal rule is a single-character constant line; editing it to something else destroys the HR itself and the line is no longer a rule) | N/A (same) | N/A (same) |
| removed     | pending | pending | N/A (no HTML block for removed lines in reading mode) |
| restored    | pending | pending | pending |

Notes: A horizontal rule (`---` on its own line) renders as a replace-decoration
widget in Live Preview when the cursor is not on the line. The dot path iterates
all doc lines; a dot should appear at the gutter line of the HR widget.
`ChangeLayerExtension` should paint a bar over the widget geometry. In reading
mode the `<hr>` element is the decorated block.

#### Footnote definition

| Change kind | LP dot | LP bar | RM indicator |
|-------------|--------|--------|--------------|
| added       | pending | pending | pending |
| changed     | pending | pending | pending |
| removed     | pending | pending | N/A (no HTML block for removed lines in reading mode) |
| restored    | pending | pending | pending |

Notes: Footnote definitions (`[^1]: text`) are plain `.cm-line` elements in
Live Preview (not replace decorations); same path as paragraph. In reading mode
footnotes render at the bottom of the document inside a `<section
class="footnotes">` or similar element. Verify that `getSectionInfo()` returns
a non-null range for the footnote definition block. Test by editing the
definition line (not the inline `[^1]` reference).

### Execution record

Owner must fill in this section after running the matrix in a real Obsidian
vault. Record the Obsidian version, plugin commit, and date. For each failing
cell copy the one-line symptom from the matrix table and record it.

```
Date: PENDING
Obsidian version: PENDING
Plugin commit: PENDING
Indicator type (dot pass): PENDING
Indicator type (bar pass): PENDING
Failing cells: PENDING
  (list each as "<block type> / <mode> / <indicator> / <change kind>: <symptom>")
```

All cells above are `pending`. The matrix structure and N/A reasoning are
derived from the source code and are author-time deliverables; the pass/fail
values require the owner to run the protocol manually in a live Obsidian vault.
