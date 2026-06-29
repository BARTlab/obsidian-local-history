/**
 * @jest-environment jsdom
 */

/**
 * Regression tests for ReadingModeIndicatorService.
 *
 * Covers two behaviours:
 *
 * 1. clearAll() sweeps all open markdown leaves and removes `lct-rm-indicator`
 *    class and `data-lct-type` from every decorated element.
 * 2. unregister() calls clearAll() so toggling the setting off or unloading
 *    the plugin cleans residual markup immediately without a re-render.
 * 3. resolveBlockChangeType() returns the highest-priority ChangeType found in
 *    a line range, or null when the range has no recorded changes.
 *
 * Visual verification (the indicator visibly disappears from an open reading-
 * mode pane) is beyond the Jest boundary and requires a live Obsidian instance;
 * see docs/qa/render-protocol.md.
 */

import 'reflect-metadata';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ChangeType } from '@/consts';
import { ReadingModeIndicatorService } from '@/services/reading-mode-indicator.service';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { MarkdownPostProcessorContext } from 'obsidian';

// MarkdownPreviewRenderer is used at module load for its static method. Stub
// it so the module can be imported without the real Obsidian runtime.
jest.mock('obsidian', () => ({
  MarkdownPreviewRenderer: {
    unregisterPostProcessor: jest.fn(),
  },
  MarkdownView: class MarkdownView {},
}));

// ---------------------------------------------------------------------------
// Minimal type aliases so test helpers stay readable without casting.
// ---------------------------------------------------------------------------

type ChangeMap = Map<number, Set<ChangeType>>;

// ---------------------------------------------------------------------------
// Exposed subclass - makes protected methods accessible in tests.
// ---------------------------------------------------------------------------

class TestableService extends ReadingModeIndicatorService {
  public exposeResolveBlockChangeType(
    snapshot: FileSnapshot,
    lineStart: number,
    lineEnd: number,
  ): ChangeType | null {
    return this.resolveBlockChangeType(snapshot, lineStart, lineEnd);
  }

  public exposeClearAll(): void {
    return this.clearAll();
  }

  /** Directly set the processor reference so unregister() sees it. */
  public setProcessor(fn: MarkdownPostProcessorContext | undefined): void {
    // Cast through unknown to bypass the protected accessor without triggering
    // the @Inject setter guard (which only applies to injected fields, not
    // this.processor).
    (this as unknown as { processor: unknown }).processor = fn;
  }

  public getProcessor(): unknown {
    return (this as unknown as { processor: unknown }).processor;
  }
}

// ---------------------------------------------------------------------------
// Minimal mock snapshot factory.
// ---------------------------------------------------------------------------

/**
 * Builds a minimal FileSnapshot-like object whose getChanges() returns a Map
 * keyed by line number, each entry being a Set of ChangeType values present on
 * that line.
 */
function makeSnapshot(changeMap: ChangeMap): FileSnapshot {
  return {
    content: {
      getChanges: (): { get: (line: number) => Set<ChangeType> | undefined } => ({
        get: (line: number): Set<ChangeType> | undefined => changeMap.get(line),
      }),
    },
  } as unknown as FileSnapshot;
}

// ---------------------------------------------------------------------------
// Plugin mock factory.
// ---------------------------------------------------------------------------

function makeMockPlugin(leaves: { previewMode?: { containerEl: HTMLElement } | null }[]): unknown {
  return {
    app: {
      workspace: {
        getLeavesOfType: (_type: string) =>
          leaves.map((leaf) => ({
            view: {
              previewMode: leaf.previewMode ?? null,
            },
          })),
      },
    },
    get: jest.fn(),
    registerMarkdownPostProcessor: jest.fn(),
  };
}

// ---------------------------------------------------------------------------
// resolveBlockChangeType
// ---------------------------------------------------------------------------

describe('ReadingModeIndicatorService.resolveBlockChangeType', () => {
  let service: TestableService;

  beforeEach(() => {
    const plugin = makeMockPlugin([]);

    service = new TestableService(plugin as never);
  });

  it('returns null when the change map is empty', () => {
    const snapshot = makeSnapshot(new Map());

    expect(service.exposeResolveBlockChangeType(snapshot, 0, 5)).toBeNull();
  });

  it('returns null when no lines in the range have changes', () => {
    const snapshot = makeSnapshot(new Map([[10, new Set([ChangeType.added])]]));

    expect(service.exposeResolveBlockChangeType(snapshot, 0, 5)).toBeNull();
  });

  it('returns the change type when a single line in range is changed', () => {
    const snapshot = makeSnapshot(new Map([[2, new Set([ChangeType.changed])]]));

    expect(service.exposeResolveBlockChangeType(snapshot, 0, 4)).toBe(ChangeType.changed);
  });

  it('returns added over changed (priority order)', () => {
    const changeMap: ChangeMap = new Map();

    changeMap.set(1, new Set([ChangeType.changed]));
    changeMap.set(2, new Set([ChangeType.added]));
    const snapshot = makeSnapshot(changeMap);

    expect(service.exposeResolveBlockChangeType(snapshot, 0, 4)).toBe(ChangeType.added);
  });

  it('returns changed over whitespace', () => {
    const changeMap: ChangeMap = new Map();

    changeMap.set(0, new Set([ChangeType.whitespace]));
    changeMap.set(1, new Set([ChangeType.changed]));
    const snapshot = makeSnapshot(changeMap);

    expect(service.exposeResolveBlockChangeType(snapshot, 0, 2)).toBe(ChangeType.changed);
  });

  it('returns whitespace over restored', () => {
    const changeMap: ChangeMap = new Map();

    changeMap.set(0, new Set([ChangeType.restored]));
    changeMap.set(1, new Set([ChangeType.whitespace]));
    const snapshot = makeSnapshot(changeMap);

    expect(service.exposeResolveBlockChangeType(snapshot, 0, 2)).toBe(ChangeType.whitespace);
  });

  it('returns restored when it is the only change in range', () => {
    const snapshot = makeSnapshot(new Map([[3, new Set([ChangeType.restored])]]));

    expect(service.exposeResolveBlockChangeType(snapshot, 3, 3)).toBe(ChangeType.restored);
  });

  it('short-circuits after finding added (highest priority)', () => {
    // Line 0 has added - the loop should break early without inspecting line 1.
    const changeMap: ChangeMap = new Map();

    changeMap.set(0, new Set([ChangeType.added]));
    changeMap.set(1, new Set([ChangeType.changed]));
    const snapshot = makeSnapshot(changeMap);

    expect(service.exposeResolveBlockChangeType(snapshot, 0, 1)).toBe(ChangeType.added);
  });
});

// ---------------------------------------------------------------------------
// clearAll
// ---------------------------------------------------------------------------

describe('ReadingModeIndicatorService.clearAll', () => {
  it('removes lct-rm-indicator class and data-lct-type from decorated elements', () => {
    const container = document.createElement('div');

    // Two decorated blocks in the preview container.
    const block1 = document.createElement('div');

    block1.classList.add('lct-rm-indicator');
    block1.setAttribute('data-lct-type', 'added');
    container.appendChild(block1);

    const block2 = document.createElement('div');

    block2.classList.add('lct-rm-indicator');
    block2.setAttribute('data-lct-type', 'changed');
    container.appendChild(block2);

    // One block without the indicator class - must be left untouched.
    const clean = document.createElement('div');

    clean.textContent = 'clean';
    container.appendChild(clean);

    const plugin = makeMockPlugin([{ previewMode: { containerEl: container } }]);
    const service = new TestableService(plugin as never);

    service.exposeClearAll();

    expect(block1.classList.contains('lct-rm-indicator')).toBe(false);
    expect(block1.hasAttribute('data-lct-type')).toBe(false);
    expect(block2.classList.contains('lct-rm-indicator')).toBe(false);
    expect(block2.hasAttribute('data-lct-type')).toBe(false);
    expect(clean.textContent).toBe('clean');
  });

  it('skips leaves whose previewMode.containerEl is absent', () => {
    // A leaf with no previewMode - must not throw.
    const plugin = makeMockPlugin([{ previewMode: null }]);
    const service = new TestableService(plugin as never);

    expect(() => service.exposeClearAll()).not.toThrow();
  });

  it('handles an empty workspace (no leaves) without error', () => {
    const plugin = makeMockPlugin([]);
    const service = new TestableService(plugin as never);

    expect(() => service.exposeClearAll()).not.toThrow();
  });

  it('clears decorated elements across multiple open leaves', () => {
    const container1 = document.createElement('div');
    const el1 = document.createElement('p');

    el1.classList.add('lct-rm-indicator');
    el1.setAttribute('data-lct-type', 'added');
    container1.appendChild(el1);

    const container2 = document.createElement('div');
    const el2 = document.createElement('p');

    el2.classList.add('lct-rm-indicator');
    el2.setAttribute('data-lct-type', 'restored');
    container2.appendChild(el2);

    const plugin = makeMockPlugin([
      { previewMode: { containerEl: container1 } },
      { previewMode: { containerEl: container2 } },
    ]);

    const service = new TestableService(plugin as never);

    service.exposeClearAll();

    expect(el1.classList.contains('lct-rm-indicator')).toBe(false);
    expect(el2.classList.contains('lct-rm-indicator')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// unregister triggers clearAll
// ---------------------------------------------------------------------------

describe('ReadingModeIndicatorService.unregister (via unload)', () => {
  it('calls clearAll when unloading with an active processor', () => {
    const container = document.createElement('div');
    const block = document.createElement('div');

    block.classList.add('lct-rm-indicator');
    block.setAttribute('data-lct-type', 'changed');
    container.appendChild(block);

    const plugin = makeMockPlugin([{ previewMode: { containerEl: container } }]);
    const service = new TestableService(plugin as never);

    // Simulate a registered processor so unregister() does not bail early.
    service.setProcessor({ getSectionInfo: jest.fn() } as unknown as MarkdownPostProcessorContext);
    service.unload();

    expect(block.classList.contains('lct-rm-indicator')).toBe(false);
    expect(block.hasAttribute('data-lct-type')).toBe(false);
    expect(service.getProcessor()).toBeUndefined();
  });

  it('does not throw when unloading with no active processor', () => {
    const plugin = makeMockPlugin([]);
    const service = new TestableService(plugin as never);

    expect(() => service.unload()).not.toThrow();
  });
});
