# Changelog

All notable user-facing changes to this plugin are documented here. The format
is based on [Keep a Changelog](https://keepachangelog.com/), and the project
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- **Data safety.** All on-disk history writes are now serialized through a
  single queue and committed atomically (temp file + rename) with a `.bak` of
  the prior contents; plugin unload waits for the queue to drain, so concurrent
  scheduled saves, unload, and restore no longer race or truncate
  `history.json`.
- **Crash-proof load.** A corrupt or truncated `history.json` no longer crashes
  the plugin: every `fromJSON` boundary guards each field, and `readDisk` skips
  malformed entries instead of dropping the whole store. `history.json` is now
  gitignored so note content cannot leak into the repo.
- **Load integrity.** A failing service `init` or `load` no longer leaves a
  half-loaded plugin: each service step is isolated, and successfully
  initialized services are torn down in reverse order on a fatal step.
- **Render.** Change indicators in code blocks and tables now share one
  document-relative coordinate frame, so the bars stop drifting on scroll.
- **Modify hot path.** Editor and external modifications are now debounced per
  path and guarded by an in-flight set plus an `mtime`/`size` precheck, removing
  redundant reads and double-captures under sync or git storms.
- **External-change capture.** External-change equality now compares the actual
  line array instead of relying on a 32-bit hash, so a hash collision can no
  longer drop a real external version.
- **Async robustness.** Event handlers are wrapped in try/catch with a logged
  failure, so a throwing or rejecting handler no longer surfaces as an
  unhandled rejection or silently breaks the dispatch loop.
- **CRLF correctness.** Content is normalized at the read boundary so diff
  rendering, change detection, and selection history no longer carry a stray
  `\r`, and diff hunk headers report line counts rather than character counts.
- **Editor and modal correctness.** The history modal's scroll-sync setup no
  longer leaks listeners across rapid mode switches; tombstone restore now
  surfaces a distinct error when the destination path is already occupied; the
  version timeline's edit-cadence gate now survives a restart.
- **Low-severity hardening.** Observable maps snapshot their listeners before
  dispatch (re-entry safe); the path-exclude regex is cached and guarded
  against ReDoS on extreme inputs; the settings tab validates the exclude
  pattern before saving; small registry and lifecycle guards prevent
  duplicate event instances, null stylesheet writes, and event payload
  array-wrapping.

## [1.0.2] - 2026-06-03

This is a large update that turns the plugin from a live line-change highlighter
into a full local history system for your vault.

### Added

- **On-disk history.** Tracked file history is now saved to disk and survives an
  Obsidian restart.
- **Version timeline.** The plugin captures intermediate versions as you edit,
  gated by an edit count and a time interval, so you can diff against any point
  in between, not just the original.
- **Four diff views.** The history modal now offers side-by-side, line-by-line,
  word-level inline highlighting, and a clean zero-context patch you can copy.
- **Version rail with search.** Pick any captured version as the diff base, and
  filter the rail by content. Each version shows what it did (Created, Modified,
  Cleared) with line-level deltas.
- **Restore and revert.** Restore the whole file to any version or to its
  original state, delete a single version, or revert one changed block straight
  from the editor gutter.
- **Custom labels.** Pin any version with a label; pinned versions are exempt
  from retention eviction.
- **Recent changes panel.** A right-sidebar panel lists the active file's
  timeline with action, date, and line deltas inline, with restore/delete/label
  actions on each row.
- **Folder history.** Open history for a whole folder to see which files changed
  since any point in time, with a timeline rail and a changes-only file tree.
- **Deleted and moved files are recoverable.** Deleting a file keeps its final
  state and timeline as a tombstone; moving a file across folders carries its
  history to the destination and leaves a tombstone behind.
- **External change capture.** Changes the editor never saw (git pull, sync, an
  external editor) are detected and captured as their own versions, marked with
  an inline badge.
- **PhpStorm-style context submenu** on the editor, files, and folders
  (Show History, Show History for Selection, Put label, Recent changes).
- **Gutter context toggle.** Right-click the editor gutter to show or hide all
  change indicators.
- **Change navigation commands.** Go to next change and go to previous change.
- **Word-level inline diff** highlighting inside changed lines.
- **Path exclusion.** A case-insensitive regular expression excludes files from
  tracking (defaults to Templates folders and Excalidraw drawings).
- **Localization** following Obsidian's UI language, with bundled catalogs and an
  English fallback for every supported language code.
- **Retention controls.** Independent caps for live-file history (count and age),
  deleted-file tombstones (count and age), and per-file timeline versions
  (count and age). Any cap can be set to 0 to disable it.

### Changed

- Indicators are now session-scoped: the gutter shows what changed since you
  opened the file in the current app run, while the on-disk history remembers
  changes across sessions, so long-lived notes no longer drift toward
  "all changed".
- The history modal was redesigned into a three-pane layout (version rail,
  icon toolbar, diff pane) with next/previous difference navigation and a toggle
  to hide versions identical to the current content.
- The diff base for the modal's baseline entry now compares the current document
  against the latest captured version instead of the original.
- Minimum supported Obsidian version raised to 1.5.0.

### Fixed

- Multi-line block replacements are now mapped correctly as a delete plus insert.
- Snapshots are re-keyed on file rename and handled correctly on delete.
- Identical or no-op version captures are skipped, so the timeline no longer
  stores duplicate points.
- Various change-tracking correctness fixes for added, removed, and restored
  line detection.

## [1.0.1] - 2025-07-24

### Changed

- Unified the create/update logic in the DOM helper and reworked the diff modal
  rendering.
- Updated the author URL in the manifest.

## [1.0.0] - 2025-07-24

### Added

- Initial release: live highlighting of changed, added, removed, and restored
  lines with line or gutter indicators, a built-in side-by-side and line-by-line
  diff modal, patch export, and configurable appearance and history settings.

[Unreleased]: https://github.com/bartlab/obsidian-local-history/compare/1.0.2...HEAD
[1.0.2]: https://github.com/bartlab/obsidian-local-history/compare/1.0.1...1.0.2
[1.0.1]: https://github.com/bartlab/obsidian-local-history/compare/1.0.0...1.0.1
[1.0.0]: https://github.com/bartlab/obsidian-local-history/releases/tag/1.0.0
