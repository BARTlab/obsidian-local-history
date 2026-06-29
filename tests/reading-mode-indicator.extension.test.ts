/**
 * @jest-environment jsdom
 */

/**
 * Tests for ReadingModeIndicatorService post-processor behavior.
 *
 * Covers the four acceptance criteria that are NOT covered by the unit-test file
 * (tests/reading-mode-indicator.test.ts), which owns clearAll/unregister and
 * resolveBlockChangeType unit tests:
 *
 * AC1: A block whose source lines contain changes is decorated with
 *      lct-rm-indicator and data-lct-type = highest-priority change type.
 * AC2: A block with no tracked changes is left untouched.
 * AC3: After decorating blocks, the clearAll() cleanup sweep
 *      removes class and attribute from every decorated element.
 * AC4: When the readingModeIndicator setting is off, init() registers no
 *      post-processor.
 */

import 'reflect-metadata';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ChangeType } from '@/consts';
import { ReadingModeIndicatorService } from '@/services/reading-mode-indicator.service';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { MarkdownPostProcessorContext } from 'obsidian';

// MarkdownPreviewRenderer is referenced at module load time by the import of
// the extension. Stub it so the module resolves without the real Obsidian
// runtime. MarkdownView is used in clearAll() for the view cast.
jest.mock('obsidian', () => ({
  MarkdownPreviewRenderer: {
    unregisterPostProcessor: jest.fn(),
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
// Testable subclass - exposes protected methods without re-testing them.
// ---------------------------------------------------------------------------

class TestableService extends ReadingModeIndicatorService {
  /**
   * Calls the protected decorate() method directly so tests can exercise the
   * post-processor logic without going through the MarkdownPreviewRenderer
   * registration path.
   */
  public exposeDecorate(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    this.decorate(el, ctx);
  }

  public exposeClearAll(): void {
    this.clearAll();
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
    getSectionInfo: jest.fn((_el: HTMLElement) => sectionInfo),
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
  registerMarkdownPostProcessor: ReturnType<typeof jest.fn>;
} {
  const registerMarkdownPostProcessor = jest.fn();

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
    get: jest.fn((token: unknown) => {
      // Resolve DI tokens used by ReadingModeIndicatorService.
      // TOKENS is a symbol registry; we match by the token object reference
      // that the service injects via @Inject(TOKENS.settings) and
      // @Inject(TOKENS.snapshots). We can't import TOKENS here without
      // risking circular issues, so we intercept via plugin.get call order:
      // the @Inject decorator calls plugin.get(token) once per field at
      // class instantiation. Instead, export TOKENS normally and use them.
      void token;

      return undefined;
    }),
  };

  // Override get() to return real service stubs keyed by TOKENS.
  // Lazily import TOKENS inside the mock to avoid hoisting issues.
  const { TOKENS } = jest.requireActual<{ TOKENS: Record<string, symbol> }>(
    '@/services/tokens',
  );

  (plugin.get as ReturnType<typeof jest.fn>).mockImplementation((token: unknown) => {
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
// AC1: decorated block with changes
// ---------------------------------------------------------------------------

describe('ReadingModeIndicatorService.decorate - block with changes', () => {
  let service: TestableService;
  let registerMarkdownPostProcessor: ReturnType<typeof jest.fn>;

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
// AC2: block with no tracked changes is left untouched
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
// AC3: clearAll regression - decorated blocks are cleaned up by sweep
// ---------------------------------------------------------------------------

describe('ReadingModeIndicatorService clearAll sweep', () => {
  it('removes lct-rm-indicator and data-lct-type from all decorated elements in a leaf', () => {
    const container = document.createElement('div');

    const added = document.createElement('p');

    added.classList.add('lct-rm-indicator');
    added.setAttribute('data-lct-type', 'added');
    container.appendChild(added);

    const changed = document.createElement('p');

    changed.classList.add('lct-rm-indicator');
    changed.setAttribute('data-lct-type', 'changed');
    container.appendChild(changed);

    // One element without the class - must not be modified.
    const clean = document.createElement('span');

    clean.textContent = 'untouched';
    container.appendChild(clean);

    const { plugin } = makePlugin({
      leaves: [{ previewMode: { containerEl: container } }],
    });

    const service = new TestableService(plugin as never);

    service.exposeClearAll();

    expect(added.classList.contains('lct-rm-indicator')).toBe(false);
    expect(added.hasAttribute('data-lct-type')).toBe(false);
    expect(changed.classList.contains('lct-rm-indicator')).toBe(false);
    expect(changed.hasAttribute('data-lct-type')).toBe(false);
    expect(clean.textContent).toBe('untouched');
  });

  it('handles multiple open leaves in the workspace', () => {
    const container1 = document.createElement('div');
    const el1 = document.createElement('p');

    el1.classList.add('lct-rm-indicator');
    el1.setAttribute('data-lct-type', 'restored');
    container1.appendChild(el1);

    const container2 = document.createElement('div');
    const el2 = document.createElement('p');

    el2.classList.add('lct-rm-indicator');
    el2.setAttribute('data-lct-type', 'whitespace');
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

  it('does not throw when a leaf has no previewMode container', () => {
    const { plugin } = makePlugin({ leaves: [{ previewMode: null }] });
    const service = new TestableService(plugin as never);

    expect(() => service.exposeClearAll()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC4: setting off - init() does not register a post-processor
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
