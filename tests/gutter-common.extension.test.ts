import 'reflect-metadata';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { type ChangeSpec, EditorState } from '@codemirror/state';
import { ChangeDetectorExtension } from '@/extensions/change-detector.extension';

// GutterCommonExtension calls new DotMarker(...) during markers(). DotMarker
// extends GutterMarker from @codemirror/view; stub the view module so both
// classes load under the Node test environment without a DOM. applyEdit also
// instantiates ChangeDetectorExtension which reads Decoration.none at field-init
// time, so that must be stubbed too.
jest.mock('@codemirror/view', () => ({
  GutterMarker: class {
    public eq(_other: unknown): boolean { return false; }
  },
  Decoration: { none: {}, line: (): unknown => ({}) },
}));

import { ChangeType, DEFAULT_SETTINGS, IndicatorType } from '@/consts';
import { GutterCommonExtension } from '@/extensions/gutter-common.extension';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import { TOKENS } from '@/services/tokens';
import type { DotMarker } from '@/markers/char.marker';
import type { EditorView } from '@codemirror/view';
import type { RangeSet } from '@codemirror/state';
import type { TFile } from 'obsidian';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

type AnyRecord = Record<string, unknown>;
type ExtCtor = typeof GutterCommonExtension;
type ViewArg = ConstructorParameters<ExtCtor>[0];
type PluginArg = ConstructorParameters<ExtCtor>[1];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a fake plugin whose container resolves the three injected services:
 *   TOKENS.settings  -> settingsService stub
 *   TOKENS.snapshots -> snapshotsService stub
 *   TOKENS.modals    -> modalsService stub
 *
 * Each stub is exposed for direct manipulation in tests.
 */
const makePlugin = (overrides: {
  snapshotOverride?: FileSnapshot | null;
  confirmResult?: boolean;
  applyContent?: jest.Mock;
  indicatorType?: IndicatorType;
  showChanged?: boolean;
  showRestored?: boolean;
  showAdded?: boolean;
}): {
  plugin: PluginArg;
  snapshotsService: { getOne: () => FileSnapshot | null; applyContent: jest.Mock; forceUpdate: jest.Mock };
  modalsService: { confirm: jest.Mock };
} => {
  const {
    snapshotOverride = null,
    confirmResult = true,
    applyContent = jest.fn(() => Promise.resolve()),
    indicatorType = IndicatorType.dot,
    showChanged = true,
    showRestored = true,
    showAdded = true,
  } = overrides;

  const settingsService = {
    value: (path: string): unknown => {
      // Override the indicator type and show flags for extension gating.
      if (path === 'type') return indicatorType;
      if (path === 'show.changed') return showChanged;
      if (path === 'show.restored') return showRestored;
      if (path === 'show.added') return showAdded;

      // Fall through to DEFAULT_SETTINGS for gutter char paths (gutter.changed etc).
      return path.split('.').reduce<unknown>((acc, part) => (acc as AnyRecord)?.[part], DEFAULT_SETTINGS);
    },
    isShowChangesEnabled: (): boolean => true,
    toggleShowChanges: (): void => undefined,
    // Mirrors SettingsService.getEnabledTypes for the dot gutter: it always
    // reports 'removed' as enabled so the extension's own removed-filter is
    // exercised (the dot gutter draws removed lines in a separate column).
    getEnabledTypes: (): ChangeType[] => [
      ...(showChanged ? [ChangeType.changed, ChangeType.whitespace] : []),
      ...(showRestored ? [ChangeType.restored] : []),
      ...(showAdded ? [ChangeType.added] : []),
      ChangeType.removed,
    ],
  };

  const snapshotsService = {
    getOne: (): FileSnapshot | null => snapshotOverride,
    applyContent,
    forceUpdate: jest.fn(),
  };

  const modalsService = {
    confirm: jest.fn(() => Promise.resolve(confirmResult)),
  };

  const services: Map<unknown, unknown> = new Map<unknown, unknown>([
    [TOKENS.settings, settingsService],
    [TOKENS.snapshots, snapshotsService],
    [TOKENS.modals, modalsService],
    [TOKENS.i18n, { t: (key: string): string => key }],
  ]);

  const plugin = {
    get: (key: unknown): unknown => services.get(key),
    t: (key: string): string => key,
  };

  return { plugin: plugin as unknown as PluginArg, snapshotsService, modalsService };
};

/**
 * Builds a fake EditorView backed by a real EditorState for the given document
 * string, exposing the state and doc the extension reads during markers().
 */
const makeView = (doc: string): EditorView => {
  const state = EditorState.create({ doc });

  return { state } as unknown as EditorView;
};

/**
 * Collects every {from, marker} pair from a RangeSet<DotMarker> into a
 * flat array ordered by position. Uses the @codemirror/state cursor API which
 * starts positioned at the first element (value !== null at entry).
 */
const collectMarkers = (rs: RangeSet<DotMarker>): { from: number; type: ChangeType }[] => {
  const result: { from: number; type: ChangeType }[] = [];
  const cursor = rs.iter();

  while (cursor.value !== null) {
    result.push({ from: cursor.from, type: cursor.value.getChangeType() });
    cursor.next();
  }

  return result;
};

/**
 * Applies one editor transaction to a FileSnapshot using the ChangeDetector
 * harness pattern (real EditorState + snapshot state update). Returns the new
 * document string so subsequent steps can thread off it.
 *
 * This is deliberately NOT re-importing ChangeDetectorExtension to avoid
 * circular harness coupling; instead it calls snapshot internals directly,
 * mirroring what the detector does at a functional level.
 */
const applyEdit = (snapshot: FileSnapshot, currentDoc: string, changes: ChangeSpec): string => {
  const start = EditorState.create({ doc: currentDoc });
  const tr = start.update({ changes });
  const newDoc = tr.state.doc.toString();

  // Feed the change through the snapshot's incremental-change mechanism by
  // re-using the ChangeDetectorExtension harness pattern from change-detector.test.ts.
  type UpdateArg = Parameters<InstanceType<typeof ChangeDetectorExtension>['update']>[0];
  type DetViewArg = ConstructorParameters<typeof ChangeDetectorExtension>[0];

  const snapshotsService = { getOne: (): FileSnapshot => snapshot, forceUpdate: (): void => undefined };
  const settingsService = { value: (): unknown => false };
  const detectorPlugin = {
    get: (key: unknown): unknown => (key === TOKENS.settings ? settingsService : snapshotsService),
  };

  const ext = new ChangeDetectorExtension(
    { state: tr.state } as unknown as DetViewArg,
    detectorPlugin as unknown as PluginArg,
  );

  ext.update({
    docChanged: true,
    changes: tr.changes,
    startState: tr.startState,
    state: tr.state,
  } as unknown as UpdateArg);

  return newDoc;
};

/**
 * Computes the byte offset of the start of 1-based line N in a doc string.
 */
const lineFrom = (doc: string, n: number): number => EditorState.create({ doc }).doc.line(n).from;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GutterCommonExtension markers - known changed/added/restored lines', () => {
  let snapshot: FileSnapshot;

  beforeEach((): void => {
    snapshot = new FileSnapshot('a\nb\nc\nd');
  });

  it('places a changed marker on the edited line', () => {
    const doc = 'a\nb\nc\nd';
    // Edit line 2 ("b" -> "B").
    applyEdit(snapshot, doc, {
      from: lineFrom(doc, 2),
      to: lineFrom(doc, 2) + 1,
      insert: 'B',
    });

    const { plugin } = makePlugin({ snapshotOverride: snapshot });
    const ext = new GutterCommonExtension(null as unknown as ViewArg, plugin);
    const rs = ext.markers(makeView('a\nB\nc\nd'));
    const markers = collectMarkers(rs);

    // Exactly one marker on the changed line (line 2 is 0-based index 1).
    // from is the byte offset of the start of line 2 in "a\nB\nc\nd" = 2.
    expect(markers).toHaveLength(1);
    expect(markers[0].type).toBe(ChangeType.changed);
    expect(markers[0].from).toBe(lineFrom('a\nB\nc\nd', 2));
  });

  it('places added markers on new lines after a paste', () => {
    const doc = 'a\nb';
    // Re-build the snapshot for the pasted doc.
    const newSnap = new FileSnapshot(doc);

    applyEdit(newSnap, doc, { from: lineFrom(doc, 1) + 1, insert: '\nX\nY' });

    const { plugin: p2 } = makePlugin({ snapshotOverride: newSnap });
    const ext = new GutterCommonExtension(null as unknown as ViewArg, p2);
    const rs = ext.markers(makeView('a\nX\nY\nb'));
    const markers = collectMarkers(rs);
    const types = markers.map((m) => m.type).sort();

    expect(types.filter((t) => t === ChangeType.added)).toHaveLength(2);
  });

  it('places a restored marker when a line returns to the original content', () => {
    const doc = 'a\nb\nc';
    const snap = new FileSnapshot(doc);

    // Edit then restore line 2.
    const afterEdit = applyEdit(snap, doc, {
      from: lineFrom(doc, 2),
      to: lineFrom(doc, 2) + 1,
      insert: 'B',
    });

    applyEdit(snap, afterEdit, {
      from: lineFrom(afterEdit, 2),
      to: lineFrom(afterEdit, 2) + 1,
      insert: 'b',
    });

    const { plugin } = makePlugin({ snapshotOverride: snap });
    const ext = new GutterCommonExtension(null as unknown as ViewArg, plugin);
    const rs = ext.markers(makeView(doc));
    const markers = collectMarkers(rs);

    expect(markers).toHaveLength(1);
    expect(markers[0].type).toBe(ChangeType.restored);
  });
});

describe('GutterCommonExtension markers - early-return paths (no markers)', () => {
  it('yields no markers when the snapshot has no changes', () => {
    const snap = new FileSnapshot('a\nb\nc');
    const { plugin } = makePlugin({ snapshotOverride: snap });
    const ext = new GutterCommonExtension(null as unknown as ViewArg, plugin);
    const rs = ext.markers(makeView('a\nb\nc'));
    const markers = collectMarkers(rs);

    expect(markers).toHaveLength(0);
  });

  it('yields no markers when the snapshot is null', () => {
    const { plugin } = makePlugin({ snapshotOverride: null });
    const ext = new GutterCommonExtension(null as unknown as ViewArg, plugin);
    const rs = ext.markers(makeView('a\nb'));
    const markers = collectMarkers(rs);

    expect(markers).toHaveLength(0);
  });

  it('yields no markers when the indicator type is line (not dot)', () => {
    const doc = 'a\nb\nc';
    const snap = new FileSnapshot(doc);

    applyEdit(snap, doc, {
      from: lineFrom(doc, 2),
      to: lineFrom(doc, 2) + 1,
      insert: 'B',
    });

    const { plugin } = makePlugin({
      snapshotOverride: snap,
      indicatorType: IndicatorType.line,
    });

    const ext = new GutterCommonExtension(null as unknown as ViewArg, plugin);
    const rs = ext.markers(makeView('a\nB\nc'));
    const markers = collectMarkers(rs);

    expect(markers).toHaveLength(0);
  });
});

describe('GutterCommonExtension revertBlockAt', () => {
  /**
   * Exposes the protected revertBlockAt method for testing.
   */
  const callRevertBlockAt = (ext: GutterCommonExtension, line: number): Promise<void> =>
    (ext as unknown as { revertBlockAt: (line: number) => Promise<void> }).revertBlockAt(line);

  it('calls applyContent with the hunk-reverted lines after confirm', async () => {
    const doc = 'a\nb\nc';
    const snap = new FileSnapshot(doc);

    snap.file = { path: 'note.md' } as unknown as TFile;
    // Edit line 2: "b" -> "B", making line index 1 (0-based) changed.
    applyEdit(snap, doc, {
      from: lineFrom(doc, 2),
      to: lineFrom(doc, 2) + 1,
      insert: 'B',
    });

    const applyContent = jest.fn(() => Promise.resolve());
    const { plugin } = makePlugin({
      snapshotOverride: snap,
      confirmResult: true,
      applyContent,
    });

    const ext = new GutterCommonExtension(null as unknown as ViewArg, plugin);

    // Line index 1 is the changed line.
    await callRevertBlockAt(ext, 1);

    expect(applyContent).toHaveBeenCalledTimes(1);

    const [, revertedLines] = applyContent.mock.calls[0] as unknown as [unknown, string[], unknown];

    // After reverting index 1 the content should be back to the original.
    expect(revertedLines).toEqual(['a', 'b', 'c']);
  });

  it('does not call applyContent when the user declines the confirm', async () => {
    const doc = 'a\nb\nc';
    const snap = new FileSnapshot(doc);

    snap.file = { path: 'note.md' } as unknown as TFile;
    applyEdit(snap, doc, {
      from: lineFrom(doc, 2),
      to: lineFrom(doc, 2) + 1,
      insert: 'B',
    });

    const applyContent = jest.fn(() => Promise.resolve());
    const { plugin } = makePlugin({
      snapshotOverride: snap,
      confirmResult: false,
      applyContent,
    });

    const ext = new GutterCommonExtension(null as unknown as ViewArg, plugin);

    await callRevertBlockAt(ext, 1);

    expect(applyContent).not.toHaveBeenCalled();
  });

  it('does nothing when there is no snapshot or no file', async () => {
    const applyContent = jest.fn(() => Promise.resolve());
    const { plugin } = makePlugin({ snapshotOverride: null, applyContent });
    const ext = new GutterCommonExtension(null as unknown as ViewArg, plugin);

    await callRevertBlockAt(ext, 0);

    expect(applyContent).not.toHaveBeenCalled();
  });
});
