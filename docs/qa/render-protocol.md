# Manual render QA protocol

The perf suite (`tests/perf/**.perf.ts`, see `docs/qa/perf-baseline.md`) gates
the plugin's pure compute hot paths, not what the user sees: Modal stacking, CSS
layout, scroll behaviour, CodeMirror gutter painting, paint timings. jsdom does
not model those and Obsidian ships no headless test API, so this document is the
manual counterpart: a scripted pass over the DOM-bound surfaces, run by a human
in a real Obsidian window before a release that touches rendering.

Each scenario has three fixed fields: **Setup** (precondition), **Action** (the
single interaction), **Pass** (the observable, binary criterion). Run the whole
protocol once per release candidate and once after any change to a render path;
a single fail blocks the release until explained.

## Conventions

These apply to every scenario, so no scenario repeats them.

- **Fail = the negation of Pass.** A scenario fails when its Pass criterion does
  not hold, which is why each scenario records only Setup / Action / Pass.
- **Console clean.** Every scenario requires the DevTools console to stay clean;
  any uncaught exception during the action is a fail. Open DevTools before a run.
- **No detached-node leak.** For open/close scenarios, a heap snapshot after
  closing must not retain a growing set of detached `lct-*` nodes across cycles.
- **Real Obsidian.** Run a development build (`npm run build`, reload the vault)
  in a real window, not a test runner; DevTools open with `Ctrl+Shift+I`.
- **Opening the history modal.** Three equivalent entry points open the same
  `HistoryModal` (`src/modals/history.modal.ts`) for the active file: the command
  palette entry **"Show all changes of current document"** (`command.show-diff`),
  the file-explorer file menu **Local history -> Show History**
  (`menu.local-history.show-history`), and the editor context menu of the same
  name. All stay hidden until the file has a snapshot, so make an edit and let the
  save debounce fire first.
- **Timing via `Performance.now()`.** Open-time and latency criteria are read in
  the DevTools console. The marker for the open is `HistoryModal.onOpen`, which
  runs `getInitialBaseId()`, `makeUI()`, and the initial `diffPresenter.refresh(...)`
  synchronously. Mark a start, trigger the open, read the gap; thresholds are
  generous by design, to catch an order-of-magnitude regression, not hardware.

  ```js
  const t0 = performance.now();
  // ...trigger the open via the command palette or menu now...
  performance.now() - t0; // read immediately after the modal appears
  ```

## History modal

Three-pane shell: a left rail with a content-search box (`.lct-rail-search`) over
a version timeline (`.lct-versions`), and a right column stacking a toolbar
(`.lct-modal-toolbar`) over the diff block (`.lct-diff-block` wrapping
`.diff-container`). Opens on side-by-side mode at the latest captured version.

### Scenario H1 - Cold open, small file
- **Setup:** A tracked note of ~20-100 lines with 3-10 captured versions; no modal open.
- **Action:** Open the history modal via the command palette, timing the open.
- **Pass:** Three-pane shell, newest version `is-active`, side-by-side diff, toolbar visible; `onOpen` under 150 ms.

### Scenario H2 - Cold open, large file
- **Setup:** A tracked note of ~1000+ lines with 30 or more versions; no modal open.
- **Action:** Open the history modal, timing the open.
- **Pass:** Full timeline scrollable (grouped by day, newest first), side-by-side diff rendered; `onOpen` under 600 ms; list scrolls with no per-frame jank.

### Scenario H3 - Search typing latency
- **Setup:** History modal open on the H2 file; search box (`.lct-rail-search`, "Search versions") at the rail top.
- **Action:** Type a 3-5 character query matching some but not all versions.
- **Pass:** List re-filters live within one keystroke to versions whose content matches; the selected base and diff pane do not change; a no-match query shows the "No versions match the search" hint.

### Scenario H4 - Version switch latency
- **Setup:** History modal open on the H2 file; note the `is-active` row and diff.
- **Action:** Click a different row down the timeline (or press Down with the list focused) to switch to an older base.
- **Pass:** The highlight moves and the diff re-renders for the new base within ~200 ms with no lingering empty pane; the restore/remove/label toolbar buttons update their enabled state.

### Scenario H5 - Diff mode toggle
- **Setup:** History modal open on the H1 file with a differing base; toolbar holds **Show patch**, **Inline**, **Line by line**, **Side by side**.
- **Action:** Click each mode button in turn, pausing on each.
- **Pass:** Each click re-renders with only the clicked button `is-active`: patch a plain text block, inline word-level highlights, line-by-line one numbered column, side-by-side two scroll-synced columns (base left, current right); each toggle under ~300 ms with no leftover DOM.

## Folder-history modal

Three columns inside `.lct-folder-history-modal`: a left rail
(`.lct-folder-modal-rail` wrapping `.lct-versions`), a middle
`.lct-folder-modal-tree` stacking a name filter (`.lct-folder-tree-search`) over a
changed-file tree (`.lct-folder-tree-scroll`), and a right `.lct-modal-main` with a
toolbar over `.lct-diff-block`. The rail is synthesised from
`FolderTimelineHelper.synthesize`; a point T re-colours the tree via
`FolderDeltaHelper.compareAt`. File rows carry a status token (`lct-tree-added` /
`lct-tree-modified` / `lct-tree-deleted`), the selected row `is-active`. Opens
side-by-side at the newest T via right-click a **folder** ->
**Local history -> Show History** (`ModalsService.openFolderHistory`).

### Scenario F1 - Cold open, folder with changes
- **Setup:** A folder with several tracked notes that have history across more than one file; no modal open.
- **Action:** Right-click the folder, **Local history -> Show History**, timing `FolderHistoryModal.onOpen` (`makeUI()`, `timelineRenderer.render()`, `refreshTree()`, `refreshDiff()`).
- **Pass:** Three-column shell: rail points by day (newest `is-active`), tree of changed files coloured by status token (folders expanded), side-by-side diff for the first file; `onOpen` under 600 ms.

### Scenario F2 - Name-filter typing
- **Setup:** Folder modal open on a folder with a half-dozen files across subfolders; filter box (`.lct-folder-tree-search`, "Filter files by name") above the tree.
- **Action:** Type a 3-5 character query matching some but not all file names.
- **Pass:** Tree re-filters live to matching files plus the ancestor folders to reach them (all force-expanded); the rail, selected T, and diff pane do not change; a no-match query collapses to the "No changes in this folder for the selected point." hint.

### Scenario F3 - Expand and collapse a tree node
- **Setup:** Folder modal open where a subfolder holds changed files, so the tree renders a collapsible row (`.lct-folder-tree-folder` with a chevron); filter cleared.
- **Action:** Click the folder row to collapse it, then again to expand.
- **Pass:** Collapsing hides the children and flips the chevron; expanding restores them; the selected file row keeps `is-active` while visible, and the diff pane and selected T are untouched.

### Scenario F4 - Timeline point pick and rail scroll
- **Setup:** Folder modal open on a folder with many points across days, enough that the rail scrolls; note the highlighted point and tree colours.
- **Action:** Scroll the rail to an older day, then click a point down the rail to re-pin T.
- **Pass:** Rail scrolls with no jank; clicking moves `is-active`, re-colours the tree to the delta at the new T, preserves expand/collapse state, and re-renders the diff for the selected file within ~300 ms.

## Recent-changes view

The recent-changes view (`src/views/recent-changes.view.ts`) is a right-sidebar
`ItemView` (`.lct-recent-changes-view`) holding one list (`.lct-recent-changes-list`)
of rows (`.lct-recent-changes-item`), one per captured version of the active file,
newest first. Each row shows the label (`.lct-recent-changes-label`), the capture
date-time (`.lct-recent-changes-meta`), and the `+A -B` delta
(`.lct-recent-changes-delta`); with no active file or snapshot it shows a single
muted hint (`.lct-recent-changes-empty`). It reacts to `active-leaf-change` and the
internal snapshots-update event. Double-click opens the history modal on that
version; right-click opens a context menu. No command entry: reveal it from
**Local history -> Recent changes** (`plugin.revealRecentChanges()`).

### Scenario R1 - Open in the side panel and react to the active file
- **Setup:** Two tracked notes with history; the panel not already open.
- **Action:** Right-click one tracked file, **Local history -> Recent changes**, then click the other note to switch the active file.
- **Pass:** Panel appears in the right sidebar titled "Recent changes" with the first file's versions (newest first, label + date-time + `+A -B` delta); switching re-renders against the new file; a second reveal focuses the existing panel, not a duplicate leaf.

### Scenario R2 - Large file history
- **Setup:** The panel open on a tracked note with 30 or more versions.
- **Action:** Scroll the list top to bottom and back.
- **Pass:** Full list renders (one `.lct-recent-changes-item` per version, newest first) and scrolls smoothly with no jank; every row shows its label, date-time, and delta without overflow clipping.

### Scenario R3 - Empty-state reaction
- **Setup:** The panel open with a tracked file active so the list is visible.
- **Action:** Switch to a never-edited note with no history (or close all editors).
- **Pass:** The list is replaced by the single muted hint ("No version history for the active file.") with no stale rows; switching back to a tracked file restores its list.

## Vault-changes view

The vault-changes view (`src/views/vault-changes.view.ts`) is a right-sidebar
`ItemView` (`.lct-vault-changes-view`) listing every file that still differs from
its history origin across the whole vault: modified files, files added under
tracking, and deleted files (tombstones, struck through). It is rendered by the
shared `FolderTreeComponent` in either a nested tree or a flat list
(`.lct-folder-tree-flat`, each file's containing path shown inline). A header
(`.lct-vault-changes-header`) holds a name filter and the tree/flat toggle
(`.lct-vault-changes-layout-button`, the active one carries `is-active`). It
reacts to the internal snapshots-update event. Clicking a live file opens it; a
deleted file shows a notice. The panel auto-docks into the right sidebar once on
first load; reopen it from the **Open vault changes panel** command
(`plugin.revealVaultChanges()`).

### Scenario V1 - Whole-vault listing and status colours
- **Setup:** A vault with at least one modified, one newly added, and one deleted tracked file.
- **Action:** Open the panel (command palette -> Open vault changes panel).
- **Pass:** Every changed file shows with its status colour (added, modified, deleted struck through); unchanged tracked files do not appear; the leading file/folder glyph is vertically centred on the name, not riding above it.

### Scenario V2 - Tree/flat toggle and path display
- **Setup:** The panel open with changed files in nested folders.
- **Action:** Click the flat-list toggle in the header, then the tree toggle.
- **Pass:** Flat mode lists every file on one line with its muted containing path truncated by an ellipsis (hover reveals the full path); tree mode restores the nested folders; the active toggle is highlighted and the choice survives reopening the panel.

### Scenario V3 - Status-bar clearance and deleted file
- **Setup:** The panel open with more rows than fit the sidebar height, including a deleted file.
- **Action:** Scroll to the bottom, then click the deleted file.
- **Pass:** The last row scrolls clear of the floating status bar (not hidden behind it); clicking the deleted file shows the "file was deleted" notice rather than opening a blank editor.

## Gutter markers

The change gutter is CodeMirror gutter extensions per editor. In dot mode
`GutterCommonExtension` (`src/extensions/gutter-common.extension.ts`) paints a dot
(`.lct-gutter`) on each added / changed / restored line and `GutterRemovedExtension`
(`src/extensions/gutter-removed.extension.ts`) marks the first current line after a
deleted run; in line mode `GutterBarExtension`
(`src/extensions/gutter-bar.extension.ts`) paints a `.lct-gutter-bar` in its own
`.lct-gutter-bar-col` column. Markers recompute on every change-detector pass. The
dot affordance reverts one block: it recomputes hunks against live content
(`HunkHelper.diff`), confirms through a "Revert this change" dialog, and applies that
block via `SnapshotsService.applyContent`. Rendering is gated by the `show.*`
settings; the gutter right-click menu offers one **Show changes** toggle
(`menu.show-changes`).

### Scenario G1 - Markers appear and refresh on edit
- **Setup:** A tracked note open, dot indicator type, change types enabled, captured baseline.
- **Action:** Edit a few separate lines (change one, add one, delete one).
- **Pass:** A dot appears beside each added or changed line and a removed marker at the line following each deleted run; markers track edits, with no stale dot on an unchanged line and no missing dot on a changed one.

### Scenario G2 - Revert a hunk from the gutter
- **Setup:** A tracked note with two separate changed blocks, each with a gutter dot.
- **Action:** Click the dot on one block and confirm the **Revert this change** dialog.
- **Pass:** Only the clicked block reverts to baseline; the other keeps its content and dot; after the write the reverted dot is gone and the untouched one remains; dismissing the dialog changes nothing.

### Scenario G3 - Removed-line marker placement after deletion
- **Setup:** A tracked note with `show.removed` enabled and the dot indicator type.
- **Action:** Delete contiguous lines from the middle, then a separate single line elsewhere.
- **Pass:** One removed marker at the current line following each deleted run (one per run, not per line), none for a run whose preceding line is itself removed; adding the text back removes the marker.

## External-change badge

External writes to a tracked file (git pull, sync, an outside editor) fire
`vault.modify`, which `VaultModifyEvent` (`src/events/vault/modify.event.ts`) routes
to `SnapshotsService.scheduleExternalCapture` (150 ms per-path debounce). The
resulting `FileVersion` is flagged external and every version surface marks it with
the same badge, `.lct-version-external-badge` (a `download-cloud` glyph plus the
"external" label). Each of the three surfaces gets a scenario.

### Scenario X1 - Badge in the history modal rail
- **Setup:** A tracked note open and settled; a way to write the same file from outside the editor.
- **Action:** Modify the file from outside, wait past the ~150 ms debounce, open the history modal, look at the newest rail row (`.lct-versions`).
- **Pass:** The newest row carries the external badge (glyph plus "external") beside its label; hover shows the "external" tooltip; in-app versions carry no badge.

### Scenario X2 - Badge in the recent-changes panel
- **Setup:** The recent-changes panel revealed on the X1 file so its list is visible.
- **Action:** Modify the file from outside, wait past the debounce, panel open and file active.
- **Pass:** A new row appears at the top with the same badge without a manual refresh (snapshots-update re-renders it), matching the rail's glyph and text.

### Scenario X3 - Badge in the folder tree
- **Setup:** The folder modal open for a folder containing the tracked file, its row visible; note the rail timeline.
- **Action:** Modify the file from outside, wait past the debounce, reopen the folder modal (it snapshots the subtree at open time).
- **Pass:** The newest rail point for that file carries the badge, and at its T the file's tree row carries it too, matching the other surfaces; folder rows never carry the badge, only file rows.

## Native tree + tab highlight

The tree/tab decorator (`TreeTabDecoratorService`,
`src/services/tree-tab-decorator.service.ts`) tints Obsidian's own file-explorer
rows (`.nav-file-title` / `.nav-folder-title`) and workspace tab headers
(`.workspace-tab-header`) by session status, owning no DOM: it only adds and
removes the shared classes `lct-tree-added` and `lct-tree-modified`. Native surfaces
carry added / modified only, never `lct-tree-deleted` (a deleted file has no row).
Status matches the gutter by construction: created-this-session is `added`
(orange, `--lct-status-added`), a differing marker baseline
(`getChangesLinesCount() > 0`) is `modified` (blue, `--lct-status-modified`);
ancestor folders tint the single `modified` token. Applies are
debounced (100 ms); a `MutationObserver` catches lazily-rendered rows. Gated by
`setting.tree-highlight` (default on); confirm a class by inspecting the title or
tab element in DevTools.

### Scenario N1 - Modified file row tints blue
- **Setup:** Explorer open, toggle on; a tracked note with history, currently unchanged (no status colour).
- **Action:** Open the note and edit a line so it differs from baseline.
- **Pass:** The `.nav-file-title` gains `lct-tree-modified` (blue); reverting to baseline clears it within a debounce window.

### Scenario N2 - Created file row tints orange
- **Setup:** Explorer open, toggle on; do not reload the vault during the scenario.
- **Action:** Create a brand new note this session and look at its row.
- **Pass:** The `.nav-file-title` gains `lct-tree-added` (orange), distinct from an edit's blue; editing it further keeps it orange (created outranks modified).

### Scenario N3 - Ancestor folders tint blue
- **Setup:** Explorer open, toggle on; a tracked note nested at least one folder deep with the folders expanded.
- **Action:** Edit the nested note so it differs from baseline (per N1); look at each ancestor folder up to but not including the vault root.
- **Pass:** Each ancestor `.nav-folder-title` gains `lct-tree-modified` (the single folder token regardless of add/modify); reverting clears the tint once no descendant differs.

### Scenario N4 - Tab header of an open changed file tints
- **Setup:** Toggle on; a tracked note open in a tab with its header visible.
- **Action:** Edit the open note so it differs from baseline (per N1); look at its tab header.
- **Pass:** The `.workspace-tab-header` tints by status (`lct-tree-modified` for an edit, `lct-tree-added` for a file created this session), matching the file's row; reverting clears it; a second tab on the same file tints the same way.

### Scenario N5 - Lazy rows decorate on expand
- **Setup:** Toggle on; a changed note inside a folder currently collapsed so its row is not yet rendered.
- **Action:** Expand the collapsed folder so the row mounts for the first time.
- **Pass:** The newly mounted row already carries its status colour (the `MutationObserver` schedules a debounced re-apply), with no edit or reload; collapsing and re-expanding keeps it.

### Scenario N6 - Debounced under rapid edits
- **Setup:** Toggle on; a tracked note open with its row visible.
- **Action:** Type continuously for a few seconds, then stop.
- **Pass:** The row and tab settle to blue and typing stays smooth: no per-keystroke repaint (one trailing sweep ~100 ms after typing stops), no stutter attributable to tree repainting.

### Scenario N7 - Toggle off clears, on restores
- **Setup:** A state with a tinted row, tinted ancestor folders, and a tinted tab (run N1, N3, N4); settings open at the **"Highlight changes in file tree and tabs"** toggle (`setting.tree-highlight`).
- **Action:** Switch the toggle off, observe, then back on.
- **Pass:** Off clears every `lct-tree-added` / `lct-tree-modified` class from rows, folders, and tabs within a debounce window, no reload; on re-paints the same surfaces to current statuses, again no reload.

### Scenario N8 - Full clear on plugin disable
- **Setup:** A state with several tinted rows, tinted ancestor folders, and a tinted tab (run N1, N3, N4).
- **Action:** Disable the plugin from Community plugins (or reload the vault), leaving the explorer and tabs open.
- **Pass:** Every class the decorator added is removed from all rows, folders, and tabs (its `unload` clears them symmetrically), leaving Obsidian's DOM as found with no lingering tint.

## Block-type render matrix

A systematic sweep over every block type Obsidian renders, crossed with both
indicator columns and every representable change kind. It was added after three
block-specific render fixes (tables, properties panel, quotes) to catch render gaps
before release.

The two Live Preview columns share ONE gutter path: both the dot
(`GutterCommonExtension` plus `GutterRemovedExtension`) and the bar
(`GutterBarExtension`) are CodeMirror gutter markers keyed on the snapshot's changed
doc-line positions, so a marker lands at the block's gutter line whether the block
is a plain `.cm-line` or a replace-decoration widget (table, callout, embed, math,
image, frontmatter). With no per-line `.cm-line` decoration and no widget-geometry
layer, LP dot and LP bar cover every block type the same. The reading-mode column
(`ReadingModeIndicatorService`) decorates via `getSectionInfo()`, so its exceptions
are blocks that report no section.

### How to read the matrix

Each cell lists the change kinds representable in that column: `a` added, `c`
changed, `r` removed, `s` restored. A `*` flags a code-derived caveat in the
exceptions list. The matrix encodes the structure derived from source; pass/fail
requires a live run recorded below.

### Preconditions

1. Build and reload the plugin (`npm run build`, reload vault).
2. Enable all four change kinds and the reading-mode indicator toggle.
3. Run the matrix once with indicator type **dot**, then once with **line**.
4. Per row, create a note whose content is only that block type, capture a baseline,
   then edit its source lines to produce the change kind under test; switch to
   reading mode with `Ctrl+E` for the RM cell.
5. Record each cell `pass`, `fail: <symptom>`, or `N/A (<reason>)`.

### Matrix

| Block type                | LP dot  | LP bar  | RM indicator |
|---------------------------|---------|---------|--------------|
| Paragraph                 | a c r s | a c r s | a c s        |
| Heading (H1-H6)           | a c r s | a c r s | a c s        |
| Bullet list               | a c r s | a c r s | a c s        |
| Numbered list             | a c r s | a c r s | a c s        |
| Quote block               | a c r s | a c r s | a c s        |
| Callout (collapsed)       | a c r s | a c r s | a c s        |
| Callout (expanded)        | a c r s | a c r s | a c s        |
| Table                     | a c r s | a c r s | a c s        |
| Fenced code block         | a c r s | a c r s | a c s        |
| Math block                | a c r s | a c r s | a c s *      |
| Embed / transclusion      | a c r s | a c r s | N/A *        |
| Image                     | a c r s | a c r s | a c s *      |
| Frontmatter / properties  | a c r s | a c r s | N/A *        |
| Horizontal rule           | a r s   | a r s   | a s          |
| Footnote definition       | a c r s | a c r s | a c s        |

### N/A and exceptions

- **Removed is Live Preview only.** No `r` in any RM cell: a removed line has no
  rendered HTML block in reading mode. In Live Preview the removed marker is the
  dot's `RemovedMarker` or the bar's short dash.
- **Removed anchor placement.** The removed marker sits at the first current line
  after a deleted run, not on the deleted content, and is suppressed when the
  preceding line is itself removed (one per run). For a widget the anchor is the
  first current line following it.
- **Horizontal rule `changed`.** A rule is a single constant line (`---`); editing
  it to other text destroys the rule, so no column has a changed-rule to mark; it
  stays representable for added, removed, restored.
- **Embed / transclusion (RM N/A `*`).** `ReadingModeIndicatorService.decorate`
  returns early when `getSectionInfo()` is null, which Obsidian returns for
  synthetic blocks such as embeds; the LP gutter still marks the source line.
- **Frontmatter / properties panel (RM N/A `*`).** Obsidian renders it outside the
  markdown content tree, so `getSectionInfo()` is null and no block is decorated;
  the LP gutter marks the frontmatter source lines.
- **Math block and Image (RM `*`).** Decoration depends on `getSectionInfo()`
  returning a non-null range; confirm in the live run and record the RM cell N/A
  with that reason if it returns null.

### Execution record

Fill this in after running the matrix in a real vault. Record the Obsidian version,
plugin commit, and date, and for each failing cell copy the one-line symptom.

```
Date: PENDING
Obsidian version: PENDING
Plugin commit: PENDING
Indicator type (dot pass): PENDING
Indicator type (line pass): PENDING
Failing cells: PENDING
  (list each as "<block type> / <column> / <change kind>: <symptom>")
```
