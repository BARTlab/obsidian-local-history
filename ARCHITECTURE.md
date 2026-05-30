# Architecture notes

This document records the architectural decisions that are not obvious from the
code ("why it is this way, not the other way") and the invariants that a comment
in one file cannot express because they span several. It is intentionally short:
it captures rationale and traps, not a tour of the codebase.

The plugin uses a small service-oriented core (a DI container in `main.ts` holds
the services; `@Inject` / `@On` decorators wire dependencies and Obsidian
events). The data model centers on `FileSnapshot`, one per tracked file, holding
the baselines, the live tracker, and the version timeline. The rest of this
document assumes that shape.

## Decision records

### ADR-1: Two baselines per file, marker (session) vs history (persisted)

Each `FileSnapshot` carries two origin points:

- `lines` is the **marker baseline**: the file content at the moment it was
  opened in the current app run. The gutter highlights and the change detector
  measure against this. It is reset every session and is never persisted.
- `historyLines` is the **history baseline**: the persisted original that the
  diff modal and the "restore original" action compare against. It survives
  restarts.

On a fresh capture the two are equal (`historyLines` is seeded from `lines`).
They diverge only at restore: when persisted history is adopted into a snapshot
that already exists for this session, the marker baseline, tracker, and live
state are kept untouched and only the history baseline plus the timeline are
adopted.

**Why:** notes live for weeks. A single baseline forces a bad choice. If the one
baseline is the persisted original, the gutter slowly marks the entire file as
"changed" across sessions. If it is the session origin, history cannot persist.
Splitting the origin into two fields on one model is the smallest change that
keeps a single source of truth for the document while letting the gutter stay
"what changed this session" and the history stay "what changed since the file
was born".

**Rejected:** one shared baseline (forces the trade-off above); a second parallel
snapshot object per file (duplicates the entire tracker/state machinery and
doubles the keystroke-path work).

### ADR-2: Version semantics are a persisted label plus a derived action

A timeline version stores its content, its timestamp, and an optional
user-supplied `label`. It does **not** store a `kind`/action enum. The action
shown in the UI (Created / Modified / Cleared, with line deltas) is derived at
render time by diffing the version against its previous neighbour.

**Why:** the action is fully derivable from content already stored, so persisting
it would be redundant and could go stale if a neighbour is deleted. A custom
label, by contrast, is genuine new information the user supplies, so that is the
only thing worth storing.

A labeled version is **pinned**: it is exempt from age/count eviction and is
captured even when its content duplicates the latest version, because a label is
an intentional marker that must not silently vanish.

**Rejected:** storing a `kind` field per version (redundant, stale-prone);
treating labeled versions like cadence versions (the label could be evicted or
never form).

### ADR-3: Deleted and moved files become tombstones, not a separate store

Vault delete does not drop the snapshot. It sets `deletedTimestamp` and keeps the
final state, the history baseline, and the timeline so the file stays
recoverable; only the session-only marker baseline and live tracker are cleared
(they have meaning only against a live editor view). A cross-directory move
leaves a tombstone at the old path and re-keys the live snapshot to the new path,
stamping `movedIntoAt`; the timeline travels with the file. A rename **within**
the same directory stays a pure re-key with no tombstone.

**Why:** a deleted file is the most valuable history to keep, because you cannot
recover it from anywhere else. Reusing the existing snapshot record avoids a
parallel "deleted snapshots" store that would have to mirror every
retention/serialize/restore rule the live store already makes. The
tombstone-in-source / added-in-destination split gives each folder a locally
correct view, matching JetBrains-style Local History.

**Rejected:** a separate `DeletedSnapshotsStore` (parallel structure, duplicated
rules); a `pathHistory` chain on the snapshot (re-introduces the cross-reference
that the dual-view model deliberately avoids).

### ADR-4: Folder history is synthesized on demand, not stored

There is no folder-level event log. `FolderTimelineHelper.synthesize` takes every
snapshot under a folder prefix (live ones plus tombstones) and derives an ordered
list of points from per-file facts already on disk: version timestamps
(`capture`), `deletedTimestamp` (`delete`), and `movedIntoAt` (`move-in`). When a
point T is picked, the file tree colours each file by comparing its state at T to
its state **now** (delta-since-then), not to T-1.

**Why:** every fact the folder view needs is already a byproduct of per-file
capture/delete/move, so a persisted folder log would duplicate truth and raise a
"which one is right after a restart" question. Computing newest-first on demand is
cheap (one sort over at most a few hundred points). Delta-since-then answers the
useful question ("what changed in this folder since this moment") instead of "what
happened at this exact instant", which usually touches a single file.

**Rejected:** a `FolderHistory` store (parallel source of truth, new write paths,
new retention to tune); pairwise T vs T-1 deltas (rarely tells a story).

### ADR-5: External changes are captured via `vault.modify` guarded by a content-equality check

The Obsidian `modify` event fires for every write: editor flushes, the plugin's
own revert writes, and genuine external changes (git pull, sync, an external
editor). The handler reads the file from disk and compares its actual content
to the snapshot's known state via `FileSnapshot.isContentChanged`: the 32-bit
`lastHash` is a cheap pre-filter, but a hash match falls through to a
line-by-line compare against `state` so a collision cannot mask a genuine
external rewrite. A match is a no-op; a mismatch is a change the editor never
saw, captured as a forced version flagged `external`. The flag drives a UI
badge but does **not** pin the version (it obeys normal retention).

**Why:** the handler has already read the full file, so an authoritative
content compare costs one extra line walk on the rare hash-match path and
removes the silent data-loss risk of a hash-only check; the hash still wins
the common case as a fast pre-filter. The guard cleanly separates the three
write sources without fragile "is this the active editor" heuristics (a git
pull can rewrite the open file too). External changes are discrete events
worth recording in full, but a chatty sync could produce many of them, so
pinning them would bloat history with un-evictable entries. A distinct
`external` flag (rather than a reserved label value) keeps system markers
from colliding with user labels.

**Rejected:** gating on "not the active file" (misses external rewrites of
the open file); a debounce with no content check (cannot tell our own writes
from external ones); a wider or crypto hash (still probabilistic, more cost
on the hot path, and the file content is already in hand).

### ADR-6: Plugin-owned localization with English fallback

Localization ships `lang/<code>.json` catalogs selected by the language Obsidian
writes to `localStorage`, with English as the universal fallback resolved per
key. Obsidian's own internal i18next catalog is not read.

**Why:** Obsidian exposes no public i18n API; its `window.i18next` is internal,
minified, has unstable keys across releases, and contains no plugin strings, so
reusing it is fragile. A plugin-owned dictionary keyed by the localStorage
language is the community-standard approach. Every Obsidian language code resolves
either to its own catalog or, per key, to English, so the UI never shows a raw
key. Empty per-code stub catalogs are deliberately not shipped (they would bloat
the bundle and break the catalog-parity test).

**Rejected:** reading Obsidian's internal i18next at runtime (breaks on any
update); shipping an empty catalog per language code (bundle bloat, no gain).

### ADR-7: A separate folder modal plus a shared pure diff renderer

Folder history is a separate `FolderHistoryModal` class, not a `mode` flag on the
already-large file `HistoryModal`. The two modals share only the diff rendering,
extracted into a stateless `DiffRenderHelper` that takes
`{baseLines, currentLines, lineBreak, mode, container}` and returns hunk metadata.
Scroll sync and per-hunk revert stay in the file modal because they are file-mode
specific (revert needs a single owning file to write back).

**Why:** the file modal is already at the edge of "too many concerns in one
class"; a `mode` branch in every method (toolbar, rail, search, key handlers,
restore semantics) would make both modes harder to read. A separate class costs
one wrapper file but keeps each modal flat. The diff renderer is the only piece
both need verbatim, so it is the only thing extracted.

**Rejected:** a `mode` parameter on `HistoryModal` (compounds existing
complexity); a folder subclass extending `HistoryModal` (inheritance where the
surfaces differ enough that overriding becomes the dominant pattern).

### ADR-8: `FileSnapshot` is a façade over stateless collaborators

`FileSnapshot` was decomposed into focused collaborators (version timeline,
snapshot state, tracker index/editor, timestamps) under `src/snapshots/`, but it
keeps its full public method and field surface. The collaborators are stateless
operators: they take the snapshot's own arrays/maps as explicit arguments and
return results; they never hold a private copy of a public field.

**Why:** external code does not just read the snapshot's public fields, it assigns
and mutates them in place (`snapshot.tracker = []`, `snapshot.versions.push(...)`,
`snapshot.changes.clear()`). Getters proxying a collaborator's private copy would
desync on the next external assignment. A façade over shared state keeps every
external read, assignment, and in-place mutation working byte-identically while
the logic lives in small testable units.

**Rejected:** state-owning collaborators with getters (break external assignment
and in-place mutation); leaving the class monolithic with comment banners (the
decomposition goal was real units, not cosmetic grouping).

### ADR-9: The version timeline is persisted as a keyframe + delta chain

A note edited over weeks accrues many timeline versions, and the only
super-linear growth driver on disk is `versions[]`: storing each version's full
`lines` costs O(versions x file size). The stateless `VersionCodec` under
`src/snapshots/` encodes the materialized `FileVersion[]` into a keyframe + delta
chain at the serialization boundary. Version `i` is a **keyframe** (full `lines`)
when `i % VERSION_KEYFRAME_INTERVAL === 0`, otherwise a **delta**: a unified-diff
string (the existing `diff` dependency, context 0) against version `i-1`. Encode
is a pure function of `versions[]`, recomputed in full on every save; decode
seeds from a keyframe and applies each following delta to rebuild the materialized
array. The in-memory `FileVersion` / `VersionTimeline` and every consumer
(`getLines`/`getContent`, the diff modal, restore, search) stay fully
materialized and untouched: this is purely a serialization-boundary concern.

**Why:** all consumers already read through `FileVersion.getLines()`, eviction
already runs in-memory before serialize, and the codec self-anchors on its own
keyframes, so a stateless re-encode each save buys the disk win with zero change
to the hot read path and no incremental-delta bookkeeping. The format is a strict
superset of the prior one (a v1 `{ timestamp, lines }` entry is already a valid
keyframe), so existing `history.json` files decode with no migration code and no
data loss; `SerializedHistory.version` is bumped to 2 only as a signal that
deltas may be present, never as a decode branch.

**Rejected:** deltas in the in-memory model (infects every consumer with
materialization, trades disk for CPU on the read path); incremental on-disk delta
maintenance on capture/eviction (fragile re-keyframing when the oldest entry is
evicted); a one-shot migration pass over old files (needless code for an
already-superset format); base64/gzip of the versions blob (opaque, kills the
readable JSON; file-level gzip is an orthogonal concern).

## Invariants and gotchas

These are the load-bearing assumptions that are easy to break from a distance.

### Service and event ordering

- **`SnapshotsService` must be registered before `PersistenceService`** in
  `main.ts`. The session capture has to run before the deferred restore, or the
  restore overwrites the live marker baseline (the bug ADR-1 fixes).
- **`I18nService` must be registered before `CommandsService`.** Command `name`
  fields call `plugin.t()` at construction; the catalogs must be registered
  first. The container runs `init` in insertion order, so order is the contract.
- **Vault event registration is deferred to `onLayoutReady`.** The startup file
  scan emits `modify` events; registering earlier would produce phantom external
  captures (ADR-5) for files that did not actually change externally.

### Persistence

- **The marker baseline is never persisted.** `toJSON` writes `historyLines` as
  its `lines` field; the session marker baseline is re-derived from the file on
  the next open (ADR-1).
- **Persist requires `keep = app`.** On-disk history is only read or written when
  the persist flag is on and retention keeps history beyond a file close.
- **Optional serialized fields are omitted when unset** (`label`, `external`,
  `deletedTimestamp`, `movedIntoAt`) so older history files round-trip unchanged.
  The on-disk format is versioned (`SerializedHistory.version`) for the same
  reason.
- **The version codec touches only serialization; in-memory stays materialized.**
  `versions[]` is encoded as a keyframe + delta chain on disk (ADR-9), but the
  in-memory `FileVersion[]` is always fully materialized, so no consumer ever
  sees a delta. The encode is recomputed in full from the materialized array on
  every save.
- **The keyframe + delta format is a strict superset of v1, so old files need no
  migration.** Decode dispatches per entry on `lines` vs `delta`; a v1 full-text
  entry is just a keyframe. The version bump to 2 is a signal only, never a decode
  branch.
- **Decode is resilient and resyncs at keyframes.** A delta with no preceding
  keyframe, or one that fails to apply, is skipped rather than thrown (ADR-08-B);
  the chain resyncs at the next keyframe, so one corrupt delta loses at most the
  segment up to that keyframe, never the whole load.
- **Deltas transport lines joined on `\n` regardless of the file `lineBreak`.** A
  tracked line is the split product of the file's `lineBreak` (`\n` or `\r\n`) and
  so never contains a bare `\n`, which makes `\n`-join a lossless patch transport
  even for CRLF files (the `diff` lib normalizes on `\n`).

### Enum values are wire/UI contracts

- Several string-enum member **values are byte-significant** and must not change:
  they are interpolated into translation keys (`modal.mode.${mode}`,
  `modal.version.action.${kind}`, `modal.folder.timeline.${kind}`) and are
  deep-compared in tests. Never convert these to numeric enums or rename their
  literal values: `DiffViewMode`, `VersionAction`, `FolderTimelinePointKind`,
  `FolderDeltaStatus`, `WordDiffLineType`, and the navigation/selection direction
  enums.

### Timeline and retention

- **Version eviction happens at capture only**, never in `fromJSON` or on restore.
  A restored snapshot with stale versions trims them on the next capture; whole-
  snapshot age retention on read bounds them until then.
- **The `maxVersions` count cap counts only unlabeled versions.** Labeled
  (pinned) versions are exempt, so pinning never silently pushes out adjacent
  cadence history (ADR-2).
- Eviction order is **age first, then count** (the JetBrains model: keep the
  newest set within the time window, count is the safety cap). A cap of `0`
  disables that dimension.
- **`putLabel` forces the cadence `enabled` gate.** A user can disable automatic
  capture but still drop a deliberate pin; honouring `enabled = false` would make
  "Put label" a silent no-op.

### Diff modal

- **The gutter revert base is the original baseline**, because the gutter
  highlights are computed against the original, so reverting a block reverts
  exactly what the gutter shows.
- The synthetic `ORIGINAL_BASE_ID` rail entry has **no version id**, so it is not
  the concern of `VersionActionsService`; the modal handles its restore on a
  small local path.

### Tooling

- **`//noinspection`, `// eslint-disable-*`, and `@ts-ignore` must stay `//` line
  comments.** Their suppression only works on a line comment directly above the
  target; a JSDoc block silently breaks them. The repo's "no `//` comments" rule
  targets descriptive prose, not these directives.
- The catalog-parity test asserts every bundled `lang/*.json` has the **exact**
  key set of `en.json` with no empty values, so adding a key to `en.json` means
  adding it to every catalog.
