import 'reflect-metadata';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { type ChangeSpec, EditorState } from '@codemirror/state';
import { ChangeDetectorExtension } from '@/extensions/change-detector.extension';

// GutterRemovedExtension calls new RemovedMarker(...) during markers().
// RemovedMarker extends GutterMarker from @codemirror/view; stub the view
// module so both classes load under the Node test environment without a DOM.
// ChangeDetectorExtension reads Decoration.none at field-init time, so that
// must be included in the stub too.
jest.mock('@codemirror/view', () => ({
  GutterMarker: class {
    public eq(_other: unknown): boolean { return false; }
  },
  Decoration: { none: {}, line: (): unknown => ({}) },
}));

import { editorInfoField } from 'obsidian';
import type { StateField } from '@codemirror/state';
import { IndicatorType } from '@/consts';
import { GutterRemovedExtension } from '@/extensions/gutter-removed.extension';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import { TOKENS } from '@/services/tokens';
import type { RemovedMarker } from '@/markers/removed.marker';
import type { EditorView } from '@codemirror/view';
import type { RangeSet } from '@codemirror/state';
import type { TFile } from 'obsidian';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

type ExtCtor = typeof GutterRemovedExtension;
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
 */
const makePlugin = (overrides: {
  snapshotOverride?: FileSnapshot | null;
  confirmResult?: boolean;
  applyContent?: jest.Mock;
  indicatorType?: IndicatorType;
  showRemoved?: boolean;
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
    showRemoved = true,
  } = overrides;

  const settingsService = {
    value: (path: string): unknown => {
      if (path === 'type') return indicatorType;
      if (path === 'show.removed') return showRemoved;
      if (path === 'gutter.removed') return '-';

      return undefined;
    },
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
 * string, exposing state and doc the extension reads during markers(). The
 * inert `dom` satisfies the nested-editor guard's DOM fallback (reads as a
 * root editor); `nested: true` initializes `editorInfoField` with a foreign
 * outer view so the guard classifies the view as a table-cell sub-editor.
 */
const makeView = (doc: string, nested: boolean = false): EditorView => {
  // The runtime field is the jest stub (StateField<unknown>); retype the real
  // obsidian declaration to match so init can return a plain test double.
  const infoField = editorInfoField as unknown as StateField<unknown>;
  const view = { dom: { closest: (): Element | null => null } } as unknown as EditorView;
  const extensions = nested
    ? [infoField.init((): unknown => ({ editor: { cm: {} } }))]
    : [];

  Object.assign(view, { state: EditorState.create({ doc, extensions }) });

  return view;
};

/**
 * Collects every {from, line} pair from a RangeSet<RemovedMarker> into a
 * flat array ordered by position. Uses the @codemirror/state cursor API.
 */
const collectMarkers = (rs: RangeSet<RemovedMarker>): { from: number }[] => {
  const result: { from: number }[] = [];
  const cursor = rs.iter();

  while (cursor.value !== null) {
    result.push({ from: cursor.from });
    cursor.next();
  }

  return result;
};

/**
 * Applies one editor transaction to a FileSnapshot using the ChangeDetector
 * harness pattern (real EditorState + snapshot state update). Returns the new
 * document string so subsequent steps can thread off it.
 */
const applyEdit = (snapshot: FileSnapshot, currentDoc: string, changes: ChangeSpec): string => {
  const start = EditorState.create({ doc: currentDoc });
  const tr = start.update({ changes });
  const newDoc = tr.state.doc.toString();

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
 * Returns the byte offset of the start of 1-based line N in a doc string.
 */
const lineFrom = (doc: string, n: number): number => EditorState.create({ doc }).doc.line(n).from;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GutterRemovedExtension markers - removed lines produce anchors', () => {
  let snapshot: FileSnapshot;

  beforeEach((): void => {
    // Use a doc where the lines of interest start at byte offset > 0 (line 2+)
    // to avoid a CodeMirror RangeSet.iter() skip at position 0.
    snapshot = new FileSnapshot('a\nb\nc\nd');
  });

  it('places a RemovedMarker on the first line after a single-line deletion', () => {
    const doc = 'a\nb\nc\nd';
    // Delete line 2 ("b"): a, c, d remain; marker should anchor at line 2 (after "a").
    const newDoc = applyEdit(snapshot, doc, {
      from: lineFrom(doc, 1) + 1,
      to: lineFrom(doc, 2) + 1,
      insert: '',
    });

    const { plugin } = makePlugin({ snapshotOverride: snapshot });
    const ext = new GutterRemovedExtension(null as unknown as ViewArg, plugin);
    const rs = ext.markers(makeView(newDoc));
    const markers = collectMarkers(rs);

    // Exactly one removed-line anchor is produced.
    expect(markers).toHaveLength(1);
    // The anchor sits at the byte offset of the first surviving line after the
    // deletion gap (line 2 in the new doc "a\nc\nd").
    expect(markers[0].from).toBe(lineFrom(newDoc, 2));
  });

  it('places a single RemovedMarker for a contiguous multi-line deletion', () => {
    const doc = 'a\nb\nc\nd';
    // Delete lines 2 and 3 ("b" and "c"): a, d remain.
    // Contiguous deletion -> one anchor at the first line after the gap.
    const newDoc = applyEdit(snapshot, doc, {
      from: lineFrom(doc, 1) + 1,
      to: lineFrom(doc, 3) + 1,
      insert: '',
    });

    const { plugin } = makePlugin({ snapshotOverride: snapshot });
    const ext = new GutterRemovedExtension(null as unknown as ViewArg, plugin);
    const rs = ext.markers(makeView(newDoc));
    const markers = collectMarkers(rs);

    // A contiguous block of removed lines produces one marker (at the block head).
    expect(markers).toHaveLength(1);
    expect(markers[0].from).toBe(lineFrom(newDoc, 2));
  });

  it('does not place a marker on untouched lines', () => {
    const doc = 'a\nb\nc\nd';
    const newDoc = applyEdit(snapshot, doc, {
      from: lineFrom(doc, 1) + 1,
      to: lineFrom(doc, 2) + 1,
      insert: '',
    });

    const { plugin } = makePlugin({ snapshotOverride: snapshot });
    const ext = new GutterRemovedExtension(null as unknown as ViewArg, plugin);
    const rs = ext.markers(makeView(newDoc));
    const markers = collectMarkers(rs);

    // Only one marker exists; "a" (line 1) and "d" (line 3) have no markers.
    const untouchedOffsets = [lineFrom(newDoc, 1), lineFrom(newDoc, 3)];

    for (const offset of untouchedOffsets) {
      expect(markers.find((m) => m.from === offset)).toBeUndefined();
    }
  });
});

describe('GutterRemovedExtension markers - early-return paths (no markers)', () => {
  it('yields no markers when the snapshot has no removed lines', () => {
    const doc = 'a\nb\nc';
    const snap = new FileSnapshot(doc);
    // Edit a line (not a deletion) - no removed changes.
    applyEdit(snap, doc, {
      from: lineFrom(doc, 2),
      to: lineFrom(doc, 2) + 1,
      insert: 'B',
    });

    const { plugin } = makePlugin({ snapshotOverride: snap });
    const ext = new GutterRemovedExtension(null as unknown as ViewArg, plugin);
    const rs = ext.markers(makeView('a\nB\nc'));
    const markers = collectMarkers(rs);

    expect(markers).toHaveLength(0);
  });

  it('yields no markers when the snapshot is null', () => {
    const { plugin } = makePlugin({ snapshotOverride: null });
    const ext = new GutterRemovedExtension(null as unknown as ViewArg, plugin);
    const rs = ext.markers(makeView('a\nb\nc'));
    const markers = collectMarkers(rs);

    expect(markers).toHaveLength(0);
  });

  it('yields no markers when indicator type is line (not dot)', () => {
    const doc = 'a\nb\nc\nd';
    const snap = new FileSnapshot(doc);
    const newDoc = applyEdit(snap, doc, {
      from: lineFrom(doc, 1) + 1,
      to: lineFrom(doc, 2) + 1,
      insert: '',
    });

    const { plugin } = makePlugin({
      snapshotOverride: snap,
      indicatorType: IndicatorType.line,
    });

    const ext = new GutterRemovedExtension(null as unknown as ViewArg, plugin);
    const rs = ext.markers(makeView(newDoc));
    const markers = collectMarkers(rs);

    expect(markers).toHaveLength(0);
  });

  it('yields no markers when show.removed is false', () => {
    const doc = 'a\nb\nc\nd';
    const snap = new FileSnapshot(doc);
    const newDoc = applyEdit(snap, doc, {
      from: lineFrom(doc, 1) + 1,
      to: lineFrom(doc, 2) + 1,
      insert: '',
    });

    const { plugin } = makePlugin({
      snapshotOverride: snap,
      showRemoved: false,
    });

    const ext = new GutterRemovedExtension(null as unknown as ViewArg, plugin);
    const rs = ext.markers(makeView(newDoc));
    const markers = collectMarkers(rs);

    expect(markers).toHaveLength(0);
  });
});

describe('GutterRemovedExtension revertRemovedAt - revert affordance', () => {
  /**
   * Exposes the protected revertRemovedAt method for direct testing.
   */
  const callRevertRemovedAt = (ext: GutterRemovedExtension, line: number): Promise<void> =>
    (ext as unknown as { revertRemovedAt: (line: number) => Promise<void> }).revertRemovedAt(line);

  it('calls applyContent with the restored lines after confirm', async () => {
    const doc = 'a\nb\nc\nd';
    const snap = new FileSnapshot(doc);

    snap.file = { path: 'note.md' } as unknown as TFile;
    // Delete line 2 ("b"): results in a\nc\nd. The removed-line marker sits on
    // the line at 0-based index 1 in the new document (line "c" = line.number 2,
    // currentLine = line.number - 1 = 1). The hunk has newLines === 0 and
    // newStart === 2, which equals currentLine + 1 = 2.
    applyEdit(snap, doc, {
      from: lineFrom(doc, 1) + 1,
      to: lineFrom(doc, 2) + 1,
      insert: '',
    });

    const applyContent = jest.fn(() => Promise.resolve());
    const { plugin } = makePlugin({
      snapshotOverride: snap,
      confirmResult: true,
      applyContent,
    });

    const ext = new GutterRemovedExtension(null as unknown as ViewArg, plugin);

    // currentLine 1 is the 0-based index of the first surviving line after "b"
    // was removed (line "c" is now at index 1).
    await callRevertRemovedAt(ext, 1);

    expect(applyContent).toHaveBeenCalledTimes(1);

    const [, revertedLines] = applyContent.mock.calls[0] as unknown as [unknown, string[], unknown];

    // Reverting the deletion of "b" restores the original four-line document.
    expect(revertedLines).toEqual(['a', 'b', 'c', 'd']);
  });

  it('does not call applyContent when the user declines the confirm', async () => {
    const doc = 'a\nb\nc\nd';
    const snap = new FileSnapshot(doc);

    snap.file = { path: 'note.md' } as unknown as TFile;
    applyEdit(snap, doc, {
      from: lineFrom(doc, 1) + 1,
      to: lineFrom(doc, 2) + 1,
      insert: '',
    });

    const applyContent = jest.fn(() => Promise.resolve());
    const { plugin } = makePlugin({
      snapshotOverride: snap,
      confirmResult: false,
      applyContent,
    });

    const ext = new GutterRemovedExtension(null as unknown as ViewArg, plugin);

    await callRevertRemovedAt(ext, 1);

    expect(applyContent).not.toHaveBeenCalled();
  });

  it('does nothing when there is no snapshot or no file', async () => {
    const applyContent = jest.fn(() => Promise.resolve());
    const { plugin } = makePlugin({ snapshotOverride: null, applyContent });
    const ext = new GutterRemovedExtension(null as unknown as ViewArg, plugin);

    await callRevertRemovedAt(ext, 0);

    expect(applyContent).not.toHaveBeenCalled();
  });

  it('does nothing when there is no matching pure-deletion hunk', async () => {
    // Provide a snapshot that has a changed line (not a deletion); there is no
    // pure-deletion hunk, so revertRemovedAt should be a no-op.
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
      confirmResult: true,
      applyContent,
    });

    const ext = new GutterRemovedExtension(null as unknown as ViewArg, plugin);

    // Pass line index 1 (the changed line); there is no pure-deletion hunk so
    // applyContent must not be called.
    await callRevertRemovedAt(ext, 1);

    expect(applyContent).not.toHaveBeenCalled();
  });
});

describe('GutterRemovedExtension nested cell editors', () => {
  // Obsidian instantiates the gutter inside every Live Preview table cell
  // editor; a removed anchor whose position fits the cell's tiny doc must not
  // paint the cell, only the root editor.
  it('renders no removed anchors inside a nested cell editor', () => {
    const doc = 'a\nb\nc\nd';
    const snapshot = new FileSnapshot(doc);
    // Delete line 2 ("b"): the anchor lands at position 1.
    applyEdit(snapshot, doc, {
      from: lineFrom(doc, 1) + 1,
      to: lineFrom(doc, 2) + 1,
      insert: '',
    });

    const { plugin } = makePlugin({ snapshotOverride: snapshot });
    const ext = new GutterRemovedExtension(null as unknown as ViewArg, plugin);
    const cellDoc = 'x\ny';

    // The same two-line doc renders the anchor in a root editor...
    expect(collectMarkers(ext.markers(makeView(cellDoc)))).toHaveLength(1);
    // ...and nothing in a nested cell sub-editor.
    expect(collectMarkers(ext.markers(makeView(cellDoc, true)))).toHaveLength(0);
  });
});
