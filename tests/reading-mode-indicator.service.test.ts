/**
 * @vitest-environment jsdom
 */

/**
 * Tests for ReadingModeIndicatorService, the reading-mode block indicator.
 *
 * One suite covers the whole service surface:
 * - resolveBlockChangeType: the highest-priority change type over a line range;
 * - decorate: the post-processor callback (block with / without changes, guards);
 * - clearAll: the residual-markup sweep across open preview leaves;
 * - unregister (via unload) and init: registration behind the setting toggle.
 *
 * The unit-level and decorate-path checks previously lived in two files that
 * duplicated an identical obsidian mock and a testable subclass; they are merged
 * here so the scaffolding exists once and no assertion is re-run across files.
 * Visual verification (the indicator visibly appearing / disappearing in an open
 * reading-mode pane) is beyond the vitest boundary and requires a live Obsidian
 * instance; see docs/qa/render-protocol.md.
 */

import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangeType } from '@/consts';
import { ReadingModeIndicatorService } from '@/services/reading-mode-indicator.service';
import { TOKENS } from '@/services/tokens';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { MarkdownPostProcessorContext } from 'obsidian';

// MarkdownPreviewRenderer is referenced at module load time. Stub obsidian so
// the service module resolves without the real Obsidian runtime. MarkdownView is
// used in clearAll() for the view cast.
vi.mock('obsidian', () => ({
  MarkdownPreviewRenderer: {
    unregisterPostProcessor: vi.fn(),
  },
  MarkdownView: class MarkdownView {},
}));

// ---------------------------------------------------------------------------
// Type aliases
// ---------------------------------------------------------------------------

type ChangeMap = Map<number, Set<ChangeType>>;

/** Helper so literal Map constructors are typed without casts. */
function cm(entries: [number, Set<ChangeType>][]): ChangeMap {
  return new Map(entries);
}

// ---------------------------------------------------------------------------
// Testable subclass - exposes the protected surface without re-testing it.
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
    this.clearAll();
  }

  /**
   * Calls the protected decorate() method directly so tests can exercise the
   * post-processor logic without going through the MarkdownPreviewRenderer
   * registration path.
   */
  public exposeDecorate(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    this.decorate(el, ctx);
  }

  /** Directly set the processor reference so unregister() sees it. */
  public setProcessor(fn: MarkdownPostProcessorContext | undefined): void {
    // Cast through unknown to bypass the protected accessor without triggering
    // the @Inject setter guard (which only applies to injected fields, not
    // this.processor).
    (this as unknown as { processor: unknown }).processor = fn;
  }

  /** Returns the processor stored by register(), or undefined when not set. */
  public getProcessor(): unknown {
    return (this as unknown as { processor: unknown }).processor;
  }
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

/**
 * Builds a minimal FileSnapshot whose getChanges().get(line) returns the
 * corresponding Set from changeMap, or undefined when the line is absent.
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

/**
 * Builds a minimal MarkdownPostProcessorContext whose getSectionInfo returns
 * the given section info object (or null to simulate an embed/synthetic block).
 */
function makeCtx(
  sourcePath: string,
  sectionInfo: { lineStart: number; lineEnd: number; text: string } | null,
): MarkdownPostProcessorContext {
  return {
    sourcePath,
    getSectionInfo: vi.fn((_el: HTMLElement) => sectionInfo),
  } as unknown as MarkdownPostProcessorContext;
}

/**
 * Builds a minimal plugin mock whose container resolves:
 *   TOKENS.settings   -> settingsService with a configurable readingModeIndicator value
 *   TOKENS.snapshots  -> snapshotsService with a configurable per-path snapshot
 *   app.vault         -> getFileByPath returns a stub TFile (truthy) for any path
 *   app.workspace     -> getLeavesOfType returns the given leaves
 *   isReady           -> returns the given readyFlag (default true)
 */
function makePlugin(opts: {
  readingModeIndicator?: boolean;
  snapshot?: FileSnapshot | null;
  leaves?: { previewMode?: { containerEl: HTMLElement } | null }[];
  ready?: boolean;
}): {
  plugin: unknown;
  registerMarkdownPostProcessor: ReturnType<typeof vi.fn>;
} {
  const registerMarkdownPostProcessor = vi.fn();

  const plugin = {
    isReady: (): boolean => opts.ready ?? true,
    registerMarkdownPostProcessor,
    app: {
      vault: {
        getFileByPath: (_path: string): unknown => ({ path: _path }),
      },
      workspace: {
        getLeavesOfType: (_type: string) =>
          (opts.leaves ?? []).map((leaf) => ({
            view: {
              previewMode: leaf.previewMode ?? null,
            },
          })),
      },
    },
    get: vi.fn((token: unknown) => {
      // Overridden below with a TOKENS-aware implementation; the placeholder
      // keeps the field a vi.fn so mockImplementation can replace it.
      void token;

      return undefined;
    }),
  };

  // Resolve real service stubs keyed by TOKENS. tokens.ts is type-only over
  // obsidian, so a static import is safe under the hoisted obsidian mock above.
  (plugin.get as ReturnType<typeof vi.fn>).mockImplementation((token: unknown) => {
    if (token === TOKENS.settings) {
      return {
        value: (_key: string): boolean => opts.readingModeIndicator ?? true,
      };
    }

    if (token === TOKENS.snapshots) {
      return {
        getOne: (_file: unknown): FileSnapshot | null => opts.snapshot ?? null,
      };
    }

    return undefined;
  });

  return { plugin, registerMarkdownPostProcessor };
}

// ---------------------------------------------------------------------------
// resolveBlockChangeType
// ---------------------------------------------------------------------------

describe('ReadingModeIndicatorService.resolveBlockChangeType', () => {
  let service: TestableService;

  beforeEach(() => {
    const { plugin } = makePlugin({});

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
// decorate - block with changes
// ---------------------------------------------------------------------------

describe('ReadingModeIndicatorService.decorate - block with changes', () => {
  let service: TestableService;
  let registerMarkdownPostProcessor: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const result = makePlugin({
      readingModeIndicator: true,
      snapshot: makeSnapshot(
        cm([
          [1, new Set([ChangeType.changed])],
          [2, new Set([ChangeType.added])],
        ]),
      ),
    });

    registerMarkdownPostProcessor = result.registerMarkdownPostProcessor;
    service = new TestableService(result.plugin as never);
  });

  it('adds lct-rm-indicator class when block lines contain changes', () => {
    const el = document.createElement('p');
    const ctx = makeCtx('note.md', { lineStart: 1, lineEnd: 2, text: 'content' });

    service.exposeDecorate(el, ctx);

    expect(el.classList.contains('lct-rm-indicator')).toBe(true);
  });

  it('sets data-lct-type to the highest-priority change type (added over changed)', () => {
    const el = document.createElement('p');
    // Lines 1..2 have changed and added; added wins (higher priority).
    const ctx = makeCtx('note.md', { lineStart: 1, lineEnd: 2, text: 'content' });

    service.exposeDecorate(el, ctx);

    expect(el.getAttribute('data-lct-type')).toBe(ChangeType.added);
  });

  it('sets data-lct-type to changed when only changed lines are present', () => {
    const snapshot = makeSnapshot(new Map([[0, new Set([ChangeType.changed])]]));
    const { plugin } = makePlugin({ snapshot });
    const svc = new TestableService(plugin as never);
    const el = document.createElement('div');
    const ctx = makeCtx('other.md', { lineStart: 0, lineEnd: 0, text: 'x' });

    svc.exposeDecorate(el, ctx);

    expect(el.getAttribute('data-lct-type')).toBe(ChangeType.changed);
  });

  it('registers a post-processor via plugin.registerMarkdownPostProcessor on init()', () => {
    service.init();

    expect(registerMarkdownPostProcessor).toHaveBeenCalledTimes(1);
    expect(typeof (registerMarkdownPostProcessor.mock.calls[0] as unknown[])[0]).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// decorate - block with no changes
// ---------------------------------------------------------------------------

describe('ReadingModeIndicatorService.decorate - block with no changes', () => {
  it('leaves the element untouched when no changes exist in the line range', () => {
    const snapshot = makeSnapshot(
      new Map([[10, new Set([ChangeType.added])]]),
    );

    const { plugin } = makePlugin({ snapshot });
    const service = new TestableService(plugin as never);

    const el = document.createElement('p');
    // Range 0..3 has no changes; line 10 is outside the range.
    const ctx = makeCtx('note.md', { lineStart: 0, lineEnd: 3, text: 'text' });

    service.exposeDecorate(el, ctx);

    expect(el.classList.contains('lct-rm-indicator')).toBe(false);
    expect(el.hasAttribute('data-lct-type')).toBe(false);
  });

  it('removes stale indicator when block no longer has matching changes', () => {
    // Simulate a block that was previously decorated but now has no changes.
    const snapshot = makeSnapshot(new Map());
    const { plugin } = makePlugin({ snapshot });
    const service = new TestableService(plugin as never);

    const el = document.createElement('p');

    el.classList.add('lct-rm-indicator');
    el.setAttribute('data-lct-type', 'added');

    const ctx = makeCtx('note.md', { lineStart: 0, lineEnd: 2, text: 'x' });

    service.exposeDecorate(el, ctx);

    expect(el.classList.contains('lct-rm-indicator')).toBe(false);
    expect(el.hasAttribute('data-lct-type')).toBe(false);
  });

  it('returns early without touching element when getSectionInfo returns null', () => {
    const { plugin } = makePlugin({ snapshot: makeSnapshot(new Map()) });
    const service = new TestableService(plugin as never);

    const el = document.createElement('p');
    const ctx = makeCtx('note.md', null);

    // Must not throw and must not add the indicator.
    expect(() => service.exposeDecorate(el, ctx)).not.toThrow();
    expect(el.classList.contains('lct-rm-indicator')).toBe(false);
  });

  it('removes stale indicator and returns when no snapshot exists for the file', () => {
    const { plugin } = makePlugin({ snapshot: null });
    const service = new TestableService(plugin as never);

    const el = document.createElement('div');

    el.classList.add('lct-rm-indicator');
    el.setAttribute('data-lct-type', 'changed');

    const ctx = makeCtx('missing.md', { lineStart: 0, lineEnd: 0, text: '' });

    service.exposeDecorate(el, ctx);

    expect(el.classList.contains('lct-rm-indicator')).toBe(false);
    expect(el.hasAttribute('data-lct-type')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// clearAll - residual-markup sweep across open preview leaves
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

    const { plugin } = makePlugin({ leaves: [{ previewMode: { containerEl: container } }] });
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
    const { plugin } = makePlugin({ leaves: [{ previewMode: null }] });
    const service = new TestableService(plugin as never);

    expect(() => service.exposeClearAll()).not.toThrow();
  });

  it('handles an empty workspace (no leaves) without error', () => {
    const { plugin } = makePlugin({});
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

    const { plugin } = makePlugin({
      leaves: [
        { previewMode: { containerEl: container1 } },
        { previewMode: { containerEl: container2 } },
      ],
    });

    const service = new TestableService(plugin as never);

    service.exposeClearAll();

    expect(el1.classList.contains('lct-rm-indicator')).toBe(false);
    expect(el2.classList.contains('lct-rm-indicator')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// unregister triggers clearAll (via unload)
// ---------------------------------------------------------------------------

describe('ReadingModeIndicatorService.unregister (via unload)', () => {
  it('calls clearAll when unloading with an active processor', () => {
    const container = document.createElement('div');
    const block = document.createElement('div');

    block.classList.add('lct-rm-indicator');
    block.setAttribute('data-lct-type', 'changed');
    container.appendChild(block);

    const { plugin } = makePlugin({ leaves: [{ previewMode: { containerEl: container } }] });
    const service = new TestableService(plugin as never);

    // Simulate a registered processor so unregister() does not bail early.
    service.setProcessor({ getSectionInfo: vi.fn() } as unknown as MarkdownPostProcessorContext);
    service.unload();

    expect(block.classList.contains('lct-rm-indicator')).toBe(false);
    expect(block.hasAttribute('data-lct-type')).toBe(false);
    expect(service.getProcessor()).toBeUndefined();
  });

  it('does not throw when unloading with no active processor', () => {
    const { plugin } = makePlugin({});
    const service = new TestableService(plugin as never);

    expect(() => service.unload()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// init - readingModeIndicator setting gates registration
// ---------------------------------------------------------------------------

describe('ReadingModeIndicatorService.init - readingModeIndicator off', () => {
  it('does not call registerMarkdownPostProcessor when the setting is disabled', () => {
    const { plugin, registerMarkdownPostProcessor } = makePlugin({
      readingModeIndicator: false,
    });

    const service = new TestableService(plugin as never);

    service.init();

    expect(registerMarkdownPostProcessor).not.toHaveBeenCalled();
  });

  it('does not store a processor reference when the setting is disabled', () => {
    const { plugin } = makePlugin({ readingModeIndicator: false });
    const service = new TestableService(plugin as never);

    service.init();

    expect(service.getProcessor()).toBeUndefined();
  });

  it('registers a post-processor when the setting is enabled', () => {
    const { plugin, registerMarkdownPostProcessor } = makePlugin({
      readingModeIndicator: true,
    });

    const service = new TestableService(plugin as never);

    service.init();

    expect(registerMarkdownPostProcessor).toHaveBeenCalledTimes(1);
  });
});
