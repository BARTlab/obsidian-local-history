import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { type ChangeSpec, EditorState } from '@codemirror/state';
import { ChangeDetectorExtension } from '@/extensions/change-detector.extension';

// GutterBarExtension calls new BarMarker(...) during markers(). BarMarker
// extends GutterMarker from @codemirror/view; stub the view module so both
// classes load under the Node test environment without a DOM (same pattern as
// gutter-bar.extension.test.ts).
vi.mock('@codemirror/view', async () => {
  const { RangeValue } = await vi.importActual<{ RangeValue: unknown }>('@codemirror/state');

  return {
    GutterMarker: class extends (RangeValue as new () => object) {
      public eq(_other: unknown): boolean { return false; }
    },
    Decoration: { none: {}, line: (): unknown => ({}) },
  };
});

import type { GutterHoverPanelResolution } from '@/components/gutter-hover-panel.types';
import { ChangeType, IndicatorType } from '@/consts';
import { GutterBarExtension } from '@/extensions/gutter-bar.extension';
import * as HunkHelper from '@/helpers/hunk.helper';
import { TOKENS } from '@/services/tokens';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import type { BarMarker } from '@/markers/bar.marker';
import type { RangeSet } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

/**
 * Regression tests for the gutter hover panel's marker-content alignment: the
 * panel is sourced from the tracker (the same per-line model the markers are
 * drawn from), so every marker must resolve to its own line's previous version.
 *
 * The bug locked down here: the panel used to resolve the hovered line against
 * a fresh base-vs-state line diff. That LCS alignment merged rewritten regions
 * into one hunk (every marker in the region showed the same block content) and
 * drifted off the tracker on repetitive lines (added/removed markers resolved
 * to no content, an empty panel).
 */

type ExtCtor = typeof GutterBarExtension;
type ViewArg = ConstructorParameters<ExtCtor>[0];
type PluginArg = ConstructorParameters<ExtCtor>[1];

/** Access shim for the protected host resolution under test. */
type HoverHost = { resolveHover(line: number): GutterHoverPanelResolution | null };

const makePlugin = (snapshot: FileSnapshot): PluginArg => {
  const settingsService = {
    getEnabledTypes: (): ChangeType[] => [
      ChangeType.changed, ChangeType.added, ChangeType.removed, ChangeType.restored, ChangeType.whitespace,
    ],
    value: (key: string): unknown => (key === 'type' ? IndicatorType.line : true),
  };

  const snapshotsService = { getOne: (): FileSnapshot => snapshot, forceUpdate: (): void => undefined };

  return {
    get: (key: unknown): unknown => (key === TOKENS.settings ? settingsService : snapshotsService),
  } as unknown as PluginArg;
};

const makeView = (doc: string): EditorView =>
  ({ state: EditorState.create({ doc }), dom: { closest: (): null => null } }) as unknown as EditorView;

const collectMarkers = (rs: RangeSet<BarMarker>): { from: number; type: ChangeType }[] => {
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

/** Resolves the hover through the real extension host, as the panel does. */
const hoverAt = (snapshot: FileSnapshot, line: number): GutterHoverPanelResolution | null => {
  // resolveHover guards on a real file target; the tests only read content.
  snapshot.file = snapshot.file ?? ({ path: 'note.md' } as NonNullable<FileSnapshot['file']>);

  return (new GutterBarExtension(null as unknown as ViewArg, makePlugin(snapshot)) as unknown as HoverHost)
    .resolveHover(line);
};

/** Joins a resolution's rendered rows into one comparable string. */
const contentText = (resolution: GutterHoverPanelResolution | null): string | null =>
  resolution === null
    ? null
    : resolution.content.lines.map((row) => row.map((seg) => seg.text).join('')).join('|');

/** Marker 0-based lines for a doc, through the real extension. */
const markerLines = (snapshot: FileSnapshot, doc: string): { line: number; type: ChangeType }[] => {
  const ext = new GutterBarExtension(null as unknown as ViewArg, makePlugin(snapshot));
  const state = EditorState.create({ doc });

  return collectMarkers(ext.markers(makeView(doc))).map((m) => ({
    line: state.doc.lineAt(m.from).number - 1,
    type: m.type,
  }));
};

const lineFrom = (doc: string, n: number): number => EditorState.create({ doc }).doc.line(n).from;

describe('gutter hover marker-content alignment', () => {
  it('separated edits resolve each marker to its own previous version', (): void => {
    const doc = Array.from({ length: 14 }, (_, i) => `line ${i} text`).join('\n');
    const snapshot = new FileSnapshot(doc);

    let cur = doc;

    cur = applyEdit(snapshot, cur, { from: lineFrom(cur, 3), to: lineFrom(cur, 3) + 11, insert: 'CHANGED 2' });
    cur = applyEdit(snapshot, cur, { from: lineFrom(cur, 7), to: lineFrom(cur, 7) + 11, insert: 'CHANGED 6' });
    cur = applyEdit(snapshot, cur, { from: lineFrom(cur, 12), to: lineFrom(cur, 12) + 12, insert: 'CHANGED 11' });

    const markers = markerLines(snapshot, cur);

    expect(markers.map((m) => m.line)).toEqual([2, 6, 11]);

    // Each marker shows its own line's previous version, never a shared block.
    const resolutions = markers.map((m) => hoverAt(snapshot, m.line));

    expect(resolutions.map((r) => r?.baseText)).toEqual(['line 2 text', 'line 6 text', 'line 11 text']);
    expect(new Set(resolutions.map(contentText)).size).toBe(3);
  });

  it('an inserted paragraph next to an edited one keeps the two marker runs distinct', (): void => {
    const doc = ['# Title', '', 'paragraph alpha text', '', 'paragraph beta text', ''].join('\n');
    const snapshot = new FileSnapshot(doc);

    let cur = doc;

    cur = applyEdit(snapshot, cur, {
      from: lineFrom(cur, 3) + 'paragraph alpha text'.length,
      insert: '\n\nNEW inserted paragraph',
    });
    applyEdit(snapshot, cur, {
      from: lineFrom(cur, 7),
      to: lineFrom(cur, 7) + 'paragraph beta text'.length,
      insert: 'paragraph beta EDITED',
    });

    const added = hoverAt(snapshot, 4);
    const changed = hoverAt(snapshot, 6);

    expect(contentText(added)).toBe('NEW inserted paragraph');
    expect(changed?.baseText).toBe('paragraph beta text');
    expect(contentText(added)).not.toBe(contentText(changed));
  });

  it('a mid-file block deletion shows the deleted lines and reverts them back in place', (): void => {
    const doc = ['a', 'b1', 'b2', 'c'].join('\n');
    const snapshot = new FileSnapshot(doc);
    // Delete the b1-b2 block; the dash anchors on "c" (now line 1).
    const cur = applyEdit(snapshot, doc, { from: lineFrom(doc, 2), to: lineFrom(doc, 4) });

    expect(markerLines(snapshot, cur)).toEqual([{ line: 1, type: ChangeType.removed }]);

    const resolution = hoverAt(snapshot, 1);

    expect(resolution?.baseText).toBe('b1\nb2');
    expect(HunkHelper.revertHunk(['a', 'c'], resolution?.hunk as NonNullable<typeof resolution>['hunk']))
      .toEqual(['a', 'b1', 'b2', 'c']);
  });

  it('a last-line deletion clamps onto the new last line and reverts after it', (): void => {
    const doc = ['a', 'b', 'c'].join('\n');
    const snapshot = new FileSnapshot(doc);
    // Delete the trailing "c"; the anchor clamps onto "b" (now the last line).
    const cur = applyEdit(snapshot, doc, { from: lineFrom(doc, 2) + 1, to: doc.length });

    expect(markerLines(snapshot, cur)).toEqual([{ line: 1, type: ChangeType.removed }]);

    const resolution = hoverAt(snapshot, 1);

    expect(resolution?.baseText).toBe('c');
    expect(HunkHelper.revertHunk(['a', 'b'], resolution?.hunk as NonNullable<typeof resolution>['hunk']))
      .toEqual(['a', 'b', 'c']);
  });

  it('random edit sessions on repetitive content resolve every marker to its own line', (): void => {
    const failures: string[] = [];

    // Deterministic PRNG so the loop is reproducible.
    let seed = 42;

    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;

      return seed / 2147483648;
    };

    const pick = (n: number): number => Math.floor(rand() * n);

    // A small alphabet of repeating markdown-ish lines maximizes LCS alignment
    // ambiguity, the shape (blank lines, repeated headings, bullets) that made
    // the old diff-based resolver drift off the markers.
    const ALPHABET: string[] = ['', '### Added', '- bullet point', 'plain text row', '---'];

    for (let session = 0; session < 300; session++) {
      const doc = Array.from({ length: 24 }, () => ALPHABET[pick(ALPHABET.length)]).join('\n');
      const snapshot = new FileSnapshot(doc);

      let cur = doc;
      const editCount = 2 + pick(6);

      for (let e = 0; e < editCount; e++) {
        const state = EditorState.create({ doc: cur });
        const line = state.doc.line(1 + pick(state.doc.lines));
        const kind = pick(3);

        if (kind === 0) {
          cur = applyEdit(snapshot, cur, { from: line.from, to: line.to, insert: `edited ${session}-${e}` });
        } else if (kind === 1) {
          const chunk = Array.from({ length: 1 + pick(3) }, () => ALPHABET[pick(ALPHABET.length)]);

          cur = applyEdit(snapshot, cur, { from: line.to, insert: `\n${chunk.join('\n')}` });
        } else if (state.doc.lines > 2) {
          cur = applyEdit(snapshot, cur, { from: line.from, to: Math.min(line.to + 1, state.doc.length) });
        }
      }

      const currentLines = snapshot.content.getLastStateLines();

      for (const marker of markerLines(snapshot, cur)) {
        if (marker.type === ChangeType.restored) {
          continue;
        }

        const resolution = hoverAt(snapshot, marker.line);

        if (resolution === null) {
          failures.push(`session ${session}: marker ${marker.line}(${marker.type}) resolved to null`);
          continue;
        }

        // The shown previous version must be the hovered line's own tracker
        // baseline, and the current side must be the hovered line itself.
        const tracker = snapshot.trackers.findCurrentLine(marker.line);

        if (marker.type === ChangeType.changed || marker.type === ChangeType.whitespace) {
          if (resolution.baseText !== tracker?.original) {
            failures.push(`session ${session}: marker ${marker.line} baseText mismatch`);
          }
        }

        if (marker.type === ChangeType.added && contentText(resolution) !== currentLines[marker.line]) {
          failures.push(`session ${session}: added marker ${marker.line} does not show its own line`);
        }
      }

      if (failures.length > 5) {
        break;
      }
    }

    expect(failures, failures.join('\n')).toEqual([]);
  });
});
