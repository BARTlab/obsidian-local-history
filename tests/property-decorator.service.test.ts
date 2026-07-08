/** @vitest-environment jsdom */

/**
 * Tests for {@link PropertyDecoratorService}.
 *
 * These tests exercise the decoration and ghost-row logic directly via a thin
 * test subclass that exposes the protected `decorate` and `injectGhosts` methods.
 * This avoids driving the full `apply()` path (which requires DI, a live
 * MarkdownView, and Obsidian workspace events) while still verifying every
 * acceptance item from the task spec.
 *
 * The jsdom environment provides real HTMLElement / document APIs so DOM
 * queries, class mutations, and element insertion run against an actual tree.
 */

import 'reflect-metadata';
import { beforeEach, describe, expect, it } from 'vitest';
import { PropertyDecoratorService } from '@/services/property-decorator.service';
import type { FrontmatterChange } from '@/helpers/frontmatter-diff.helper';
import type LineChangeTrackerPlugin from '@/main';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Exposes the protected `decorate` and `injectGhosts` methods for direct
 * testing, bypassing the `apply()` DI path. Also exposes `ghostMap` for
 * idempotency assertions.
 */
class TestPropertyDecoratorService extends PropertyDecoratorService {
  public callDecorate(
    editor: HTMLElement,
    rows: HTMLElement[],
    changes: FrontmatterChange,
    snapshotKeyOrder: string[],
  ): void {
    this.decorate(editor, rows, changes, snapshotKeyOrder);
  }

  public get testGhostMap(): Map<string, HTMLElement> {
    return this.ghostMap;
  }

}

/** Minimal plugin stub - only what the constructor stores. */
const makePlugin = (): LineChangeTrackerPlugin =>
  ({} as unknown as LineChangeTrackerPlugin);

/** No-change sentinel for clarity. */
const EMPTY: FrontmatterChange = { added: [], modified: [], removed: [] };

/**
 * Builds a minimal `.metadata-property` row element with the given
 * `data-property-key` attribute and a `.metadata-property-key` child cell.
 */
const makeRow = (key: string): HTMLElement => {
  const row = document.createElement('div');
  row.classList.add('metadata-property');
  row.setAttribute('data-property-key', key);

  const keyCell = document.createElement('div');
  keyCell.classList.add('metadata-property-key');
  keyCell.textContent = key;
  row.appendChild(keyCell);

  return row;
};

/**
 * Builds a `.metadata-editor` element, populates it with property rows for
 * each of the given keys, and attaches it to `document.body` so that
 * `HTMLElement.isConnected` returns true for all children. This is required
 * for the ghost-row idempotency guard in `injectGhosts` to work correctly
 * (jsdom sets `isConnected` only when the element is in the document tree).
 *
 * Returns both the editor and the row array.
 */
const makeEditor = (keys: string[]): { editor: HTMLElement; rows: HTMLElement[] } => {
  const editor = document.createElement('div');
  editor.classList.add('metadata-editor');

  const rows = keys.map((k) => {
    const row = makeRow(k);
    editor.appendChild(row);

    return row;
  });

  document.body.appendChild(editor);

  return { editor, rows };
};

// ---------------------------------------------------------------------------
// AC2 - modified row gets lct-prop-modified; other rows get neither
// ---------------------------------------------------------------------------

describe('PropertyDecoratorService - modified row', () => {
  let service: TestPropertyDecoratorService;
  let editor: HTMLElement;
  let rows: HTMLElement[];

  beforeEach(() => {
    document.body.innerHTML = '';
    service = new TestPropertyDecoratorService(makePlugin());
    ({ editor, rows } = makeEditor(['title', 'status']));
  });

  it('adds lct-prop-modified to the modified row', () => {
    service.callDecorate(editor, rows, { added: [], modified: ['title'], removed: [] }, ['title', 'status']);

    expect(rows[0].classList.contains('lct-prop-modified')).toBe(true);
  });

  it('leaves the unchanged row without any lct-prop-* class', () => {
    service.callDecorate(editor, rows, { added: [], modified: ['title'], removed: [] }, ['title', 'status']);

    expect(rows[1].classList.contains('lct-prop-modified')).toBe(false);
    expect(rows[1].classList.contains('lct-prop-added')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC3 - added row gets lct-prop-added
// ---------------------------------------------------------------------------

describe('PropertyDecoratorService - added row', () => {
  let service: TestPropertyDecoratorService;
  let editor: HTMLElement;
  let rows: HTMLElement[];

  beforeEach(() => {
    document.body.innerHTML = '';
    service = new TestPropertyDecoratorService(makePlugin());
    ({ editor, rows } = makeEditor(['title', 'status']));
  });

  it('adds lct-prop-added to the added row', () => {
    service.callDecorate(editor, rows, { added: ['status'], modified: [], removed: [] }, ['title', 'status']);

    expect(rows[1].classList.contains('lct-prop-added')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC4 - clearing: when no changes remain, all lct-prop-* classes are absent
//        after a second call
// ---------------------------------------------------------------------------

describe('PropertyDecoratorService - clearing decorations', () => {
  let service: TestPropertyDecoratorService;
  let editor: HTMLElement;
  let rows: HTMLElement[];

  beforeEach(() => {
    document.body.innerHTML = '';
    service = new TestPropertyDecoratorService(makePlugin());
    ({ editor, rows } = makeEditor(['title', 'status']));
  });

  it('removes lct-prop-modified when changes are cleared', () => {
    service.callDecorate(editor, rows, { added: [], modified: ['title'], removed: [] }, ['title', 'status']);
    expect(rows[0].classList.contains('lct-prop-modified')).toBe(true);

    service.callDecorate(editor, rows, EMPTY, ['title', 'status']);

    expect(rows[0].classList.contains('lct-prop-modified')).toBe(false);
    expect(rows[0].classList.contains('lct-prop-added')).toBe(false);
  });

  it('removes lct-prop-added when changes are cleared', () => {
    service.callDecorate(editor, rows, { added: ['status'], modified: [], removed: [] }, ['title', 'status']);
    service.callDecorate(editor, rows, EMPTY, ['title', 'status']);

    expect(rows[1].classList.contains('lct-prop-added')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC5 - ghost row injected for a removed key
// ---------------------------------------------------------------------------

describe('PropertyDecoratorService - ghost row for removed key', () => {
  let service: TestPropertyDecoratorService;
  let editor: HTMLElement;
  let rows: HTMLElement[];

  beforeEach(() => {
    document.body.innerHTML = '';
    service = new TestPropertyDecoratorService(makePlugin());
    // 'aliases' was in the snapshot but is no longer a live row.
    ({ editor, rows } = makeEditor(['title']));
  });

  it('injects a .lct-prop-ghost element when a key is removed', () => {
    service.callDecorate(
      editor, rows, { added: [], modified: [], removed: ['aliases'] }, ['title', 'aliases'],
    );

    expect(editor.querySelector('.lct-prop-ghost')).not.toBeNull();
  });

  it('ghost element contains the removed key name', () => {
    service.callDecorate(
      editor, rows, { added: [], modified: [], removed: ['aliases'] }, ['title', 'aliases'],
    );

    const ghost = editor.querySelector('.lct-prop-ghost');
    expect(ghost?.textContent).toContain('aliases');
  });

  it('ghost row has lct-prop-removed class', () => {
    service.callDecorate(
      editor, rows, { added: [], modified: [], removed: ['aliases'] }, ['title', 'aliases'],
    );

    const ghost = editor.querySelector('.lct-prop-ghost');
    expect(ghost?.classList.contains('lct-prop-removed')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC6 - ghost row removed when key is no longer in the removed set
// ---------------------------------------------------------------------------

describe('PropertyDecoratorService - ghost row removal', () => {
  let service: TestPropertyDecoratorService;
  let editor: HTMLElement;
  let rows: HTMLElement[];

  beforeEach(() => {
    document.body.innerHTML = '';
    service = new TestPropertyDecoratorService(makePlugin());
    ({ editor, rows } = makeEditor(['title']));
  });

  it('removes the ghost row when the key is no longer removed', () => {
    // First pass: 'aliases' removed - ghost appears.
    service.callDecorate(
      editor, rows, { added: [], modified: [], removed: ['aliases'] }, ['title', 'aliases'],
    );
    expect(editor.querySelector('.lct-prop-ghost')).not.toBeNull();

    // Second pass: no removals - ghost must be gone.
    service.callDecorate(editor, rows, EMPTY, ['title', 'aliases']);

    expect(editor.querySelector('.lct-prop-ghost')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC7 - idempotency: calling apply() twice with same input must not duplicate
//        classes or ghost rows
// ---------------------------------------------------------------------------

describe('PropertyDecoratorService - idempotency', () => {
  let service: TestPropertyDecoratorService;
  let editor: HTMLElement;
  let rows: HTMLElement[];

  beforeEach(() => {
    document.body.innerHTML = '';
    service = new TestPropertyDecoratorService(makePlugin());
    ({ editor, rows } = makeEditor(['title', 'status']));
  });

  it('class is present exactly once on double call', () => {
    const changes: FrontmatterChange = { added: [], modified: ['title'], removed: [] };
    const keyOrder = ['title', 'status'];

    service.callDecorate(editor, rows, changes, keyOrder);
    service.callDecorate(editor, rows, changes, keyOrder);

    // Countable form: exactly the one modified row carries the class, and the
    // second pass added it nowhere else.
    expect(editor.querySelectorAll('.lct-prop-modified')).toHaveLength(1);
    expect(rows[0].classList.contains('lct-prop-modified')).toBe(true);
  });

  it('produces exactly one ghost row per removed key on double call', () => {
    const changes: FrontmatterChange = { added: [], modified: [], removed: ['aliases'] };
    const keyOrder = ['title', 'aliases', 'status'];

    // 'aliases' is gone; only title and status remain as live rows.
    service.callDecorate(editor, rows, changes, keyOrder);
    service.callDecorate(editor, rows, changes, keyOrder);

    const ghosts = editor.querySelectorAll('.lct-prop-ghost');
    expect(ghosts).toHaveLength(1);
  });
});

