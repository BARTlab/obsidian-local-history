# Architecture notes

Non-obvious decisions ("why this way, not the other") and invariants that span several
files. Rationale and traps, not a code tour.

The core is service-oriented: a `ServiceContainer` (`src/services/container.ts`), composed
in `main.ts`, holds the service singletons and runs their lifecycle. `@Inject` / `@On`
decorators wire dependencies and Obsidian events; injection resolves by a stable symbol
token (`src/services/tokens.ts`), never by class name. `FileSnapshot`, one per tracked
file, is a façade over sub-objects that own the baselines, tracker, and version timeline.

## Decision records

### ADR-1: Two baselines per file, marker (session) vs history (persisted)

`content.lines` is the session **marker baseline** (never persisted, reset each run); the
persisted **history baseline** `content.historyLines` is what the diff modal compares
against. One baseline cannot be both session-scoped and persistable; restore adopts only
history plus the timeline, keeping the live marker baseline. **Rejected:** one shared baseline; a parallel snapshot per file (double machinery).

### ADR-2: Version semantics are a persisted label plus a derived action

A version stores content, timestamp, and optional user `label`, but no `kind`: the action
(Created / Modified / Cleared with line deltas) is derived at render time by diffing against
the previous neighbour. A labeled version is **pinned** (exempt from eviction, always
captured) because it is user input that must not vanish. **Rejected:** a per-version `kind` field; treating labeled versions like cadence ones.

### ADR-3: Deleted and moved files become tombstones, not a separate store

Vault delete keeps the snapshot: it sets `deletedTimestamp` and preserves the final state,
history baseline and timeline (clearing only the session marker baseline and tracker). A
cross-directory move leaves a source tombstone and re-keys the live snapshot with
`movedIntoAt`; an in-directory rename is a pure re-key. Reusing the record avoids a parallel
store mirroring every live rule. **Rejected:** a separate `DeletedSnapshotsStore`; a `pathHistory` chain on the snapshot.

### ADR-4: Folder history is synthesized on demand, not stored

There is no folder event log: `synthesize` (`src/helpers/folder-timeline.helper.ts`) derives
an ordered point list from per-file facts on disk (version timestamps, `deletedTimestamp`,
`movedIntoAt`) for every snapshot under a prefix, colouring each file by its state at the
picked T vs now. Those facts already exist per file, so a folder log would duplicate truth. **Rejected:** a `FolderHistory` store (parallel truth); pairwise T vs T-1 deltas.

### ADR-5: External changes are captured via `vault.modify` guarded by a content check

`ExternalChangeCapture` reads the modified file and compares it via
`FileSnapshot.isContentChanged`: the 32-bit `lastHash` pre-filters, but a match falls through
to a line compare against `state`, so a collision cannot mask a rewrite. A real mismatch
becomes a forced version flagged `external` (drives a UI badge, does **not** pin). **Rejected:** gating on "not the active file"; a debounce with no content check; a crypto
hash (probabilistic, more hot-path cost).

### ADR-6: Plugin-owned localization with English fallback

Localization ships `lang/<code>.json` catalogs selected by the `localStorage` language, with
English as the universal per-key fallback. Obsidian's own internal i18next is not read (it is
minified, unstable across releases, and holds no plugin strings), and every code resolves to
its catalog or, per key, to English, so no raw key ever shows. **Rejected:** reading Obsidian's internal i18next; an empty catalog per code (bloat, breaks
the catalog-parity test).

### ADR-7: A separate folder modal plus a shared pure diff renderer

Folder history is a separate `FolderHistoryModal` class, not a `mode` flag on the
already-large `HistoryModal`, so no `mode` branch spreads through every method. The two share
only diff rendering via the stateless `render` function (`src/helpers/diff-render.helper.ts`);
scroll sync and per-hunk revert stay file-mode specific (ADR-11 collaborators). **Rejected:** a `mode` parameter on `HistoryModal`; a folder subclass extending it.

### ADR-8: `FileSnapshot` is a façade over data-owning sub-objects

`FileSnapshot` is a thin façade over three data-owning sub-objects (all `src/snapshots/`):
`content` (`SnapshotState`: baselines, live state, hash, change map, line break), `trackers`
(`TrackerEditor`: the tracker array and its position index), and `timeline`
(`VersionTimeline`: ordered versions plus cadence and eviction). Callers read through the
sub-object (`snapshot.content.lines`); each concern owns and invalidates its own state, and
the façade only rewires composite operations (build, serialize, adopt). **Rejected:** stateless operators taking the arrays as arguments (mismatched-array hazard); a
monolith with comment banners.

### ADR-9: The version timeline is persisted as a keyframe + delta chain

`versions[]` is the only super-linear on-disk growth driver. The stateless `VersionCodec`
(`src/snapshots/version-codec.ts`) encodes the materialized `FileVersion[]` at the
serialization boundary: version `i` is a **keyframe** when `i % VERSION_KEYFRAME_INTERVAL ===
0`, else a **delta** (unified-diff against `i-1`). Encode is pure and recomputed each save;
the in-memory timeline stays materialized, and the format is a strict superset of v1, so old
files decode with no migration. **Rejected:** deltas in memory (infects every consumer); incremental on-disk maintenance;
a migration pass; base64/gzip (opaque).

### ADR-10: History is one self-describing shard per snapshot, no index file

History is one `{ version, snapshot }` shard per snapshot under `<plugindir>/history/`; the
directory listing is the source of truth, with no manifest or index file. A shard is named by
a synchronous >=64-bit hash of the vault-relative path (16 hex + `.json`), and the path inside
is the read-time identity. `HistoryShardStore` (`src/persistence/history-shard-store.ts`) owns
the IO; `PersistenceService` keeps policy (the `AsyncSaveQueue` write queue, `RetentionPolicy`
math, the dirty index, the enabled gate); `MonolithMigrator`
(`src/persistence/monolith-migrator.ts`) owns the one-time legacy split. A single
`history.json` would be one point of failure (a corrupt file costs the whole base); sharding
makes a lost shard cost one note, and the shard `version` reads through from serialization, so
ADR-9's format bump flows through untouched. **Rejected:** the monolith; a manifest/index file; reversible path encoding; async WebCrypto
naming; rewriting all shards per save.

### ADR-11: Mega-files decompose into host-owned plain collaborators, not DI services

The largest files (`HistoryModal`, `FolderHistoryModal`, `SnapshotsService`, `types.ts`) were
split into single-concern units on the façade shape of ADR-8: **plain objects owned by their
host**, not DI services, each reading its host through a narrow per-collaborator host port
(lazy accessors plus callbacks), so the host keeps owning shared state.

- `HistoryModal` (`src/modals/`) owns `DiffScrollSync`, `DiffViewState`, `GutterRevertHandler`,
  `DiffPresenter`, `DiffHeaderController`, `KeyboardController`, plus the `VersionList` rail
  (`src/components/version-list.component.ts`).
- `FolderHistoryModal` (`src/modals/`) owns `FolderSelectionModel`, `FolderTimelineRenderer`,
  `FolderDiffRenderer`, `FolderActionHandler`, reusing `DiffViewState` and `FolderTreeComponent`
  (`src/components/`). Both build their chrome through the shared `HistoryModalShell` and
  `ToolbarBuilder`.
- `SnapshotsService` owns `SnapshotRegistry` (map + bookkeeping), `HistorySerializer`
  (serialize/restore/reconcile), `ExternalChangeCapture`, `IgnoreListManager`,
  `EditorOperations` (all `src/snapshots/`), keeping the CRUD delegates and capture gating.
  `SnapshotCodec` (`src/snapshots/snapshot-codec.ts`) owns a snapshot's on-disk encode/decode,
  calling `VersionCodec` for the timeline.
- `types.ts` became a barrel'd `src/types/` directory; `../types` importers resolve against
  the barrel with no churn.

**Why plain collaborators, not DI:** the container resolves services by stable symbol tokens
(`src/services/tokens.ts`), so class names minify freely and the build ships no `keepNames`
(`esbuild.config.mjs`); it is reserved for the long-lived singletons whose registration order
in `main.ts` is a load-bearing contract (see below). Short-lived host-owned collaborators gain
no wiring value from `@Inject`, and the host-port seam keeps the host's protected fields
protected. **Rejected:** registering each as a DI service; state-owning collaborators the host
mutates in place (the ADR-8 trap); passing the raw host in; rewriting `../types` imports.

## Invariants and gotchas

### Service and event ordering

- **`SnapshotsService` registers before `PersistenceService`** in `main.ts`: session capture
  must precede the deferred restore, else restore overwrites the marker baseline (ADR-1).
- **`I18nService` registers before `CommandsService`:** command `name` fields call `plugin.t()`
  at construction, and the container runs `init` in insertion order.
- **Vault events register only at `onLayoutReady`:** the startup scan emits `modify` events, so
  earlier would produce phantom external captures (ADR-5).

### Persistence

- **One shard per snapshot; the directory listing (no index/manifest) is authoritative** (ADR-10).
- **Saves are dirty-only, and a lost shard recovers itself, never the whole base** (ADR-10).
- **The marker baseline is never persisted** (`SnapshotCodec.encode` writes `historyLines` as
  `lines`), and on-disk history needs `keep = app` (ADR-1).
- **Optional fields (`label`, `external`, `deletedTimestamp`, `movedIntoAt`) are omitted when
  unset** so old files round-trip.
- **The version codec touches only serialization; the in-memory timeline stays materialized**
  (ADR-9).

### Enum values are wire/UI contracts

- Several string-enum **values are byte-significant**: they are interpolated into translation
  keys (`modal.mode.${mode}`, `modal.version.action.${kind}`, `modal.folder.timeline.${kind}`)
  and deep-compared in tests. Never make them numeric or rename their values: `DiffViewMode`,
  `VersionAction`, `FolderTimelinePointKind`, `FolderDeltaStatus`, `WordDiffLineType`, and the
  navigation/selection direction enums.

### Timeline and retention

- **Version eviction happens at capture only**, never in decode or on restore.
- **The count cap counts only unlabeled versions** (pinned are exempt); order is age first,
  then count, and a cap of `0` disables that dimension (ADR-2).
- **Putting a label forces the cadence `enabled` gate**, else a deliberate pin would no-op.

### Diff modal

- **The gutter revert base is the original baseline,** so reverting a block reverts exactly what
  the gutter shows.
- The synthetic `ORIGINAL_BASE_ID` rail entry has **no version id**, so it is not
  `VersionActionsService`'s concern; the modal restores it locally.

### Tooling

- **`//noinspection`, `// eslint-disable-*`, and `@ts-ignore` must stay `//` line comments:**
  suppression works only on a line comment directly above the target, and a JSDoc block breaks
  it. The "no `//` comments" rule targets prose, not these.
- The catalog-parity test asserts every `lang/*.json` has the **exact** key set of `en.json`
  with no empty values, so a new key in `en.json` must be added to every catalog.
