# Changelog

All notable user-facing changes to this plugin are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/), and the project  follows [Semantic Versioning](https://semver.org/).

## [2.0.0] - 2026-07-08

First release published to the Obsidian community plugin directory. Since the last public release (1.0.1) the plugin grew from a live line-change highlighter into a full on-disk local-history system: a per-file version timeline, a four-view diff, restore and revert, folder history, and recovery of deleted, moved, and externally changed files.

### Added

- **On-disk history.** Tracked file history is saved to disk and survives an Obsidian restart.
- **Version timeline.** Intermediate versions are captured as you edit, gated by an edit count and a time interval, so you can diff against any point in between, not just the original.
- **Four diff views.** The history modal offers side-by-side, line-by-line, word-level inline highlighting, and a clean zero-context patch you can copy.
- **Version rail with search.** Pick any captured version as the diff base and filter the rail by content. Each version shows what it did (Created, Modified, Cleared) with line-level deltas.
- **Restore and revert.** Restore the whole file to any version or to its original state, delete a single version, or revert one changed block straight from the editor gutter.
- **Gutter hover panel.** Hover a change marker in the editor gutter to open a panel with the previous version of that line, then revert the change, copy the old text, or open the file history from it. The panel widens to fit the previous version up to the editor width, shows a muted placeholder for a blank or whitespace-only change, and stays closed on a marker whose line is already back to its original content. Enabled by default; toggle it with the "Show hover panel on change markers" setting.
- **Custom labels.** Pin any version with a label; pinned versions are exempt from retention eviction.
- **Recent changes panel.** A right-sidebar panel lists the active file's timeline with action, date, and line deltas inline, with restore/delete/label actions on each row.
- **Folder history.** Open history for a whole folder to see which files changed since any point in time, with a timeline rail and a changes-only file tree.
- **Deleted and moved files are recoverable.** Deleting a file keeps its final state and timeline as a tombstone; moving a file across folders carries its history to the destination and leaves a tombstone behind.
- **External change capture.** Changes the editor never saw (git pull, sync, an external editor) are detected and captured as their own versions, marked with an inline badge.
- **Reading-mode change indicators.** In reading mode, blocks whose source lines changed show a colored left border matching the editor's change colors. Off by default; enable it in settings.
- **File explorer and tab highlight.** File-explorer rows (with their parent folders) and open tab headers are tinted by whether the file changed in the current session. Toggle it in settings.
- **Context submenu** on the editor, files, and folders (Show History, Show History for Selection, Put label, Recent changes).
- **Gutter context toggle.** Right-click the editor gutter to show or hide all change indicators.
- **Change navigation commands.** Go to next change and go to previous change.
- **Path exclusion.** A case-insensitive regular expression excludes files from tracking (defaults to Templates folders and Excalidraw drawings).
- **Localization** following Obsidian's UI language, with bundled catalogs and an English fallback for every supported language code.
- **Retention controls.** Independent caps for live-file history (count and age), deleted-file tombstones (count and age), and per-file timeline versions (count and age). Any cap can be set to 0 to disable it.

### Changed

- **Line change bar renders in the editor gutter.** The line-style change indicator renders in its own gutter column instead of as a stripe in the line's own margin, so adjacent changed lines read as one continuous vertical bar.
- **Dot gutter defaults to diff-style glyphs.** The character indicator now defaults to `+` added, `−` removed, `~` changed, and `↺` restored, so each marker reads at a glance instead of using abstract arrows. Every glyph stays configurable in settings.
- Indicators are session-scoped: the gutter shows what changed since you opened the file in the current app run, while the on-disk history remembers changes across sessions, so long-lived notes no longer drift toward "all changed".
- The history modal uses a three-pane layout (version rail, icon toolbar, diff pane) with next/previous difference navigation and a toggle to hide versions identical to the current content.
- The diff base for the modal's baseline entry compares the current document against the latest captured version instead of the original.
- Minimum supported Obsidian version is 1.11.0.

### Fixed

- **The plugin never tracks its own data directory.** History shards, `data.json`, and anything else inside the plugin folder are excluded from change tracking, so the plugin can no longer capture its own output and compound a history-of-its-own-history that would balloon the store save over save.
- **Service resolution in the released build.** The bundled plugin could fail to resolve its own services, surfacing as repeated `Service 'SnapshotsService' not registered` errors and silently breaking change indicators, history capture, and the editor gutter. Services now resolve through stable symbol tokens, so minifying the bundle can no longer rename a class and break resolution, and lifecycle guards keep a stale editor extension or event from touching services after unload.
- **Sharded history storage.** History is stored as one self-describing shard file per note under a `history/` folder instead of a single `history.json`, so a corrupt or lost shard costs one note's history rather than the entire base, and a save rewrites only the shards that changed. Each shard keeps its own atomic write plus `.bak`/`.tmp` read fallback; global retention is preserved and reconciled to disk; an existing `history.json` migrates into shards once on first load.
- **Data safety.** All on-disk history writes are serialized through a single queue and committed atomically (temp file + rename) with a `.bak` of the prior contents; plugin unload waits for the queue to drain, so concurrent scheduled saves, unload, and restore no longer race or truncate a shard.
- **Crash-proof load.** A corrupt or truncated history file no longer crashes the plugin: every `fromJSON` boundary guards each field, and load skips malformed entries instead of dropping the whole store. On-disk history is kept out of version control so note content cannot leak into the repo.
- **Load integrity.** A failing service `init` or `load` no longer leaves a half-loaded plugin: each service step is isolated, and successfully initialized services are torn down in reverse order on a fatal step.
- **Render.** Change indicators in code blocks and tables now share one document-relative coordinate frame, so the bars stop drifting on scroll.
- **Modify hot path.** Editor and external modifications are debounced per path and guarded by an in-flight set plus an `mtime`/`size` precheck, removing redundant reads and double-captures under sync or git storms.
- **External-change capture.** External-change equality compares the actual line array instead of relying on a 32-bit hash, so a hash collision can no longer drop a real external version.
- **Async robustness.** Event handlers are wrapped in try/catch with a logged failure, so a throwing or rejecting handler no longer surfaces as an unhandled rejection or silently breaks the dispatch loop.
- **CRLF correctness.** Content is normalized at the read boundary so diff rendering, change detection, and selection history no longer carry a stray `\r`, and diff hunk headers report line counts rather than character counts.
- **Editor and modal correctness.** The history modal's scroll-sync setup no longer leaks listeners across rapid mode switches; tombstone restore surfaces a distinct error when the destination path is already occupied; the version timeline's edit-cadence gate survives a restart.
- **Change bars in quote blocks.** A change bar on a line inside a quote block in Live Preview no longer merges with the blockquote marker and paints over it; it is drawn as a separate bar, the same as on any other line.
- **Live Preview quote blocks.** A newly added line inside a quote block shows its added-line indicator in Live Preview instead of rendering without one.
- **Table cells no longer track or mark changes.** Obsidian mounts a small editor inside every Live Preview table cell and runs plugin extensions in it; the plugin treated each cell's one-line document as the whole note. Typing in a table cell no longer phantom-marks line 1 of the note, gutter markers no longer appear inside table cells, and a bogus one-line "version" of a single cell can no longer be captured into the note's history.
- **Auto-save no longer repaints the whole note as added.** When the tracked model lagged the editor by one missed update, the next auto-save was captured as an external rewrite and replaced the entire tracked state, so every line lit up as new after a single inserted line. The capture now applies a minimal per-line resync, keeping the markers of untouched lines.
- **The removed-line marker survives new text typed in its place.** A new line entered at a deleted line's position no longer silently revives the deleted line as a "changed" one, which erased the removal record; the new line is marked as added and the removal marker stays. Undo and pasting the line back exactly as it was still clear the marker cleanly.
- **Multi-line block replacements** are mapped correctly as a delete plus insert.
- **Snapshots on rename and delete.** Snapshots are re-keyed on file rename and handled correctly on delete.
- **No duplicate captures.** Identical or no-op version captures are skipped, so the timeline no longer stores duplicate points.
- **Low-severity hardening.** Observable maps snapshot their listeners before dispatch (re-entry safe); the path-exclude regex is cached and guarded against ReDoS on extreme inputs; the settings tab validates the exclude pattern before saving; small registry and lifecycle guards prevent duplicate event instances, null stylesheet writes, and event payload array-wrapping.
- **Unfocused-file capture.** Line-break style is detected correctly when a file is captured without ever being focused in the editor, so background and synced changes no longer carry a mismatched line ending.
- **Localized gutter revert.** The editor gutter's revert-block confirmation follows the UI language instead of being English-only.
- **Quieter exclude-pattern input.** Typing an incomplete or invalid path-exclude pattern in settings no longer spams repeated notifications.
- **Reading-mode indicator cleanup.** Turning change indicators off clears the indicators already drawn in reading mode instead of leaving them until the next reload.
- **Mid-line split and join tracking.** Pressing Enter in the middle of a line (or pasting/deleting a multi-line block mid-line) no longer marks every line below the edit as changed. The change detector now adds or removes a tracker for the extra line created or swallowed by a mid-line split or join, so the lines after the edit keep their real change state.
- **Block revert phantoms.** Reverting a block from the history modal back to its original content no longer leaves phantom added/removed markers when the block's line count changed (for example, reverting a line that was split in two). A reverted line whose content matches the original folds back onto its own tracker instead of being counted as a removal plus an addition.
- **Continuous gutter bar.** Consecutive changed lines in the gutter bar column now merge into one continuous vertical bar. Each line's bar used to render as its own rounded segment, leaving a micro-gap at every line boundary.
- **Last-line revert without a trailing newline.** Reverting the deletion of a file's last line from the gutter now works when the file has no trailing newline. The revert affordance rendered but did nothing, because a last-line deletion produced an irregular diff hunk that the revert path could not match.
- **Batched multi-edit actions.** Making several edits in a single action (for example inserting a line at the top of a note while deleting other lines lower down, or an undo that replays several changes at once) no longer records the wrong lines as removed or marks an untouched line as changed. Each edit in the batch is now mapped against the line positions the earlier edits in the same batch already shifted.
- **Mixed CRLF/LF baselines.** A note that mixes Windows (CRLF) and Unix (LF) line endings no longer loses change tracking on some lines. The baseline is now split into lines the same way the editor sees them, so an edited line stays tracked and an untouched line is never marked as changed by mistake.
- Various change-tracking correctness fixes for added, removed, and restored line detection.
## [1.0.1] - 2025-07-24

### Changed

- Unified the create/update logic in the DOM helper and reworked the diff modal rendering.
- Updated the author URL in the manifest.

## [1.0.0] - 2025-07-24

### Added

- Initial release: live highlighting of changed, added, removed, and restored lines with line or gutter indicators, a built-in side-by-side and line-by-line diff modal, patch export, and configurable appearance and history settings.

[2.0.0]: https://github.com/bartlab/obsidian-local-history/compare/1.0.1...2.0.0
[1.0.1]: https://github.com/bartlab/obsidian-local-history/compare/1.0.0...1.0.1
[1.0.0]: https://github.com/bartlab/obsidian-local-history/releases/tag/1.0.0
