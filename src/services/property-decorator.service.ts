import { PluginEvent } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { On } from '@/decorators/on.decorator';
import {
  getPropertyKey,
  queryMetadataEditor,
  queryPropertyRows,
} from '@/helpers/properties-panel.adapter';
import { diffFrontmatter, type FrontmatterChange } from '@/helpers/frontmatter-diff.helper';
import type LineChangeTrackerPlugin from '@/main';
import type { SettingsService } from '@/services/settings.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import { TOKENS } from '@/services/tokens';
import type { Service } from '@/types';
import { parseYaml, type MarkdownView } from 'obsidian';
import type { FileSnapshot } from '@/snapshots/file.snapshot';

/**
 * Service that adds visual change indicators to the Obsidian Properties panel
 * (.metadata-editor) for frontmatter key-level diffs.
 *
 * It mirrors {@link TreeTabDecoratorService} exactly: a MutationObserver on
 * `view.contentEl` handles the lazy render of `.metadata-editor`, a 100 ms
 * debounce collapses keystroke bursts, and the same four workspace events
 * (layout-change, active-leaf-change, file-open, snapshotsUpdate) keep the
 * indicators in sync.  Decoration of added/modified rows (left border + icon)
 * is handled by {@link decorate}; ghost-row injection for removed keys is
 * handled by {@link injectGhosts}.
 *
 * @implements {Service}
 */
export class PropertyDecoratorService implements Service {
  /**
   * Service for reading plugin settings, used to gate decoration behind the
   * `propertiesHighlight` toggle (mirrors the `treeHighlight` gate in
   * {@link TreeTabDecoratorService}).
   */
  @Inject(TOKENS.settings)
  protected settingsService!: SettingsService;

  /**
   * Service for reading the current set of file snapshots, from which the
   * frontmatter baseline lines and the current state lines are sourced.
   */
  @Inject(TOKENS.snapshots)
  protected snapshotsService!: SnapshotsService;

  /**
   * Debounce window (ms) for scheduling an apply sweep. Matches the value
   * used by TreeTabDecoratorService so the two decorators stay in lockstep.
   */
  protected static readonly debounceMs: number = 100;

  /**
   * The pending debounce timer, or undefined when none is in flight.
   * Cleared on unload so no sweep fires after teardown.
   */
  protected timer: ReturnType<typeof setTimeout> | undefined = undefined;

  /**
   * The MutationObserver watching `view.contentEl` for the lazy render of
   * .metadata-editor, or undefined when not currently observing.
   *
   * Observes `{ childList: true, subtree: true }` only - never `attributes`,
   * so the decorator's own class flips on property rows never re-trigger it
   * (no feedback loop, matching the TreeTabDecoratorService pattern).
   */
  protected observer: MutationObserver | undefined = undefined;

  /**
   * The `contentEl` element the observer is currently attached to, kept so
   * the observer is only re-wired when the element actually changes across
   * a layout rebuild.  Cleared on unload.
   */
  protected observed: HTMLElement | undefined = undefined;

  /**
   * Live registry of injected ghost rows keyed by the removed property key.
   * Entries are created in {@link injectGhosts} and deleted when the key is no
   * longer in `changes.removed` on the next apply sweep.
   */
  protected ghostMap: Map<string, HTMLElement> = new Map();

  /**
   * Creates a new instance of PropertyDecoratorService.
   *
   * @param {LineChangeTrackerPlugin} plugin - The plugin instance
   */
  public constructor(
    protected plugin: LineChangeTrackerPlugin,
  ) {
  }

  /**
   * Wires the refresh triggers and schedules the initial decoration.
   *
   * The three workspace events that carry no plugin event (layout-change,
   * active-leaf-change, file-open) can all change which MarkdownView is active
   * or cause the properties panel to be (re)rendered, so each schedules a
   * debounced apply.  All registrations go through `plugin.registerEvent` so
   * their refs release on plugin unload automatically.
   */
  public load(): void {
    this.plugin.registerEvent(
      this.plugin.app.workspace.on('layout-change', (): void => {
        this.schedule();
      }),
    );

    this.plugin.registerEvent(
      this.plugin.app.workspace.on('active-leaf-change', (): void => {
        this.schedule();
      }),
    );

    this.plugin.registerEvent(
      this.plugin.app.workspace.on('file-open', (): void => {
        this.schedule();
      }),
    );

    this.schedule();
  }

  /**
   * Re-applies indicators on every snapshot change.  Debounced so a burst of
   * keystrokes collapses into a single trailing sweep.
   */
  @On(PluginEvent.snapshotsUpdate)
  public refresh(): void {
    this.schedule();
  }

  /**
   * Tears down the observer and cancels any pending timer without leaving
   * any state behind.  Workspace event refs are cleaned up automatically by
   * `plugin.registerEvent`, so only the manually-held resources need explicit
   * cleanup here.
   */
  public unload(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    if (this.observer) {
      this.observer.disconnect();
      this.observer = undefined;
    }

    this.observed = undefined;
  }

  /**
   * Removes all property-diff decorations from the active MarkdownView and
   * purges all ghost rows, WITHOUT tearing down the refresh wiring.  Called
   * when the `propertiesHighlight` toggle is turned off so the panel clears
   * live yet remains ready to re-decorate the moment it is turned back on.
   * Idempotent: a second call is a no-op when the maps are already empty and
   * no decorated rows remain.
   */
  protected clearAll(): void {
    // Remove all injected ghost rows from the DOM and clear the registry.
    for (const ghostEl of this.ghostMap.values()) {
      ghostEl.remove();
    }

    this.ghostMap.clear();

    // Strip lct-prop-* classes from all live property rows in the active view.
    const view: MarkdownView | null = this.plugin.getActiveViewOfType();

    if (!view) {
      return;
    }

    const editor: HTMLElement | null = queryMetadataEditor(view.contentEl);

    if (!editor) {
      return;
    }

    for (const row of queryPropertyRows(editor)) {
      row.classList.remove(
        PropertyDecoratorService.CLASS_ADDED,
        PropertyDecoratorService.CLASS_MODIFIED,
        PropertyDecoratorService.CLASS_REMOVED,
      );
      row.removeAttribute('title');
    }
  }

  /**
   * Schedules a debounced apply sweep.  A pending timer is reset on each call
   * so a burst of triggers resolves to a single trailing {@link apply}.
   */
  protected schedule(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout((): void => {
      this.timer = undefined;
      this.apply();
    }, PropertyDecoratorService.debounceMs);
  }

  /**
   * Core sweep that computes the frontmatter diff for the active file and
   * exposes the result for decoration.
   *
   * Guard branches (degrading silently):
   * - plugin not ready: return early
   * - no active MarkdownView: return early
   * - no .metadata-editor in DOM: (re)attach observer and return early
   * - no snapshot for the current file: clear all decorations and return
   *
   * When a snapshot is found, {@link diffFrontmatter} is called with
   * `snapshot.lines` (baseline) and `snapshot.state` (current).  The result
   * together with the baseline key order is passed to {@link decorate}.
   */
  protected apply(): void {
    if (!this.plugin.isReady()) {
      return;
    }

    if (!this.settingsService.value('propertiesHighlight')) {
      this.clearAll();

      return;
    }

    const view: MarkdownView | null = this.plugin.getActiveViewOfType();

    if (!view) {
      return;
    }

    this.syncObserver(view.contentEl);

    const editor: HTMLElement | null = queryMetadataEditor(view.contentEl);

    if (!editor) {
      return;
    }

    const rows: HTMLElement[] = queryPropertyRows(editor);
    const snapshot: FileSnapshot | null = this.snapshotsService.getOne(view.file);

    if (!snapshot) {
      // Clear any stale decorations from a previous file and return.
      this.decorate(editor, rows, { added: [], modified: [], removed: [] }, []);

      return;
    }

    const changes: FrontmatterChange = diffFrontmatter(snapshot.lines, snapshot.state);
    const snapshotKeyOrder: string[] = PropertyDecoratorService.extractKeyOrder(snapshot.lines);

    this.decorate(editor, rows, changes, snapshotKeyOrder);
  }

  /** CSS class applied to the row element for an added property. */
  protected static readonly CLASS_ADDED = 'lct-prop-added';

  /** CSS class applied to the row element for a modified property. */
  protected static readonly CLASS_MODIFIED = 'lct-prop-modified';

  /** CSS class applied to the row element for a removed (ghost) property. */
  protected static readonly CLASS_REMOVED = 'lct-prop-removed';

  /** CSS class applied to synthetic ghost rows injected for removed properties. */
  protected static readonly CLASS_GHOST = 'lct-prop-ghost';

  /**
   * Decorates existing property rows for added and modified states, clears
   * decorations from rows that are no longer in any change set, and delegates
   * ghost-row management for removed properties to {@link injectGhosts}.
   *
   * Visual signal is applied purely via CSS classes on the row element:
   * the `.metadata-property-icon` child is tinted through CSS `color` so the
   * property-type icon reflects the change status.  No child nodes are injected,
   * so the MutationObserver (watching childList) is never triggered by this pass.
   *
   * @param {HTMLElement} editor - The .metadata-properties root element
   * @param {HTMLElement[]} rows - The .metadata-property row elements
   * @param {FrontmatterChange} changes - The key-level frontmatter diff
   * @param {string[]} snapshotKeyOrder - All keys in the baseline snapshot, in order
   */
  protected decorate(
    editor: HTMLElement, rows: HTMLElement[], changes: FrontmatterChange, snapshotKeyOrder: string[],
  ): void {
    const addedSet = new Set(changes.added);
    const modifiedSet = new Set(changes.modified);

    for (const row of rows) {
      if (row.classList.contains(PropertyDecoratorService.CLASS_GHOST)) {
        continue;
      }

      const key: string | null = getPropertyKey(row);

      if (key === null) {
        continue;
      }

      if (addedSet.has(key)) {
        if (!row.classList.contains(PropertyDecoratorService.CLASS_ADDED)) {
          row.classList.remove(PropertyDecoratorService.CLASS_MODIFIED);
          row.classList.add(PropertyDecoratorService.CLASS_ADDED);
          row.setAttribute('title', `property "${key}" added`);
        }
      } else if (modifiedSet.has(key)) {
        if (!row.classList.contains(PropertyDecoratorService.CLASS_MODIFIED)) {
          row.classList.remove(PropertyDecoratorService.CLASS_ADDED);
          row.classList.add(PropertyDecoratorService.CLASS_MODIFIED);
          row.setAttribute('title', `property "${key}" modified`);
        }
      } else if (
        row.classList.contains(PropertyDecoratorService.CLASS_ADDED) ||
        row.classList.contains(PropertyDecoratorService.CLASS_MODIFIED)
      ) {
        row.classList.remove(PropertyDecoratorService.CLASS_ADDED, PropertyDecoratorService.CLASS_MODIFIED);
        row.removeAttribute('title');
      }
    }

    this.injectGhosts(editor, rows, changes, snapshotKeyOrder);
  }

  /**
   * Reconciles ghost rows for removed properties inside `editor`.
   *
   * Algorithm:
   * 1. Build a set of keys that are currently removed.
   * 2. Remove ghost rows whose keys are no longer in the removed set (the user
   *    re-added that property or the snapshot changed).
   * 3. For each key still in `removed`, skip if a ghost row already exists in
   *    the DOM and is still connected (idempotent).
   * 4. Create a new ghost row element and insert it at the correct position:
   *    - Find the surviving-neighbor: the first key that comes after the removed
   *      key in `snapshotKeyOrder` and still has a real live row present.
   *      Insert the ghost before that neighbor row.
   *    - If no surviving neighbor is found, append to the editor.
   *
   * @param {HTMLElement} editor - The .metadata-editor root element
   * @param {HTMLElement[]} rows - The live .metadata-property row elements
   * @param {FrontmatterChange} changes - The key-level frontmatter diff
   * @param {string[]} snapshotKeyOrder - All keys in the baseline snapshot, in order
   */
  protected injectGhosts(
    editor: HTMLElement, rows: HTMLElement[], changes: FrontmatterChange, snapshotKeyOrder: string[],
  ): void {
    const removedSet = new Set(changes.removed);

    // Step 1: remove stale ghost rows for keys no longer in the removed set.
    for (const [key, ghostEl] of this.ghostMap) {
      if (!removedSet.has(key)) {
        ghostEl.remove();
        this.ghostMap.delete(key);
      }
    }

    if (removedSet.size === 0) {
      return;
    }

    // Build a quick lookup from property key to its live row element.
    const liveRowByKey = new Map<string, HTMLElement>();

    for (const row of rows) {
      const k = getPropertyKey(row);

      if (k !== null) {
        liveRowByKey.set(k, row);
      }
    }

    // Step 2: for each removed key, ensure exactly one ghost row exists.
    for (const removedKey of removedSet) {
      // Idempotent: skip if a ghost is already in the DOM and connected.
      if (this.ghostMap.has(removedKey)) {
        const existing = this.ghostMap.get(removedKey)!;

        if (existing.isConnected) {
          continue;
        }

        // Ghost was detached (e.g., Obsidian re-rendered the panel) - remove
        // stale entry so a fresh one is created below.
        this.ghostMap.delete(removedKey);
      }

      const ghost = PropertyDecoratorService.buildGhostRow(removedKey);
      this.ghostMap.set(removedKey, ghost);

      // Find the first live row whose key comes after removedKey in snapshot
      // order (surviving-neighbor strategy from PLAN.md risk #4).
      const neighborRow = PropertyDecoratorService.findNeighborRow(
        removedKey,
        snapshotKeyOrder,
        liveRowByKey,
      );

      if (neighborRow) {
        editor.insertBefore(ghost, neighborRow);
      } else {
        editor.appendChild(ghost);
      }
    }
  }

  /**
   * Returns the first live row element whose property key comes after
   * `removedKey` in `snapshotKeyOrder`.
   *
   * This is the surviving-neighbor strategy from PLAN.md risk #4: scan forward
   * through the baseline key order starting from the position after `removedKey`
   * and return the first entry that has a live row in `liveRowByKey`.
   *
   * When all keys after `removedKey` are also removed, returns null so the
   * ghost is appended at the end.
   *
   * @param {string} removedKey - The key whose position to anchor
   * @param {string[]} snapshotKeyOrder - All keys in the baseline snapshot, in order
   * @param {Map<string, HTMLElement>} liveRowByKey - Live rows indexed by key
   * @returns {HTMLElement | null} The neighbor row to insert before, or null
   */
  protected static findNeighborRow(
    removedKey: string,
    snapshotKeyOrder: string[],
    liveRowByKey: Map<string, HTMLElement>,
  ): HTMLElement | null {
    const idx = snapshotKeyOrder.indexOf(removedKey);

    if (idx === -1) {
      return null;
    }

    for (let i = idx + 1; i < snapshotKeyOrder.length; i++) {
      const candidateKey = snapshotKeyOrder[i];
      const liveRow = liveRowByKey.get(candidateKey);

      if (liveRow) {
        return liveRow;
      }
    }

    return null;
  }

  /**
   * Builds a synthetic ghost row element representing a deleted property key.
   *
   * The element mimics the structure of a real `.metadata-property` row
   * (same class, same `data-property-key` attribute) so the CSS rules in
   * `.lct-prop-ghost` and `.lct-prop-removed` apply automatically.
   *
   * @param {string} key - The property key name to display
   * @returns {HTMLElement} The ghost row element (not yet inserted into DOM)
   */
  protected static buildGhostRow(key: string): HTMLElement {
    const ghost = document.createElement('div');
    ghost.classList.add(
      'metadata-property',
      PropertyDecoratorService.CLASS_GHOST,
      PropertyDecoratorService.CLASS_REMOVED,
    );
    ghost.setAttribute('data-property-key', key);
    ghost.setAttribute('title', `property "${key}" removed`);

    const keyCell = document.createElement('div');
    keyCell.classList.add('metadata-property-key');
    keyCell.textContent = key;
    ghost.appendChild(keyCell);

    return ghost;
  }

  /**
   * (Re)attaches the MutationObserver to `contentEl` when the element changes.
   *
   * Observes `{ childList: true, subtree: true }` (never `attributes`) so the
   * decorator's own class mutations on `.metadata-property` rows never
   * re-trigger it.  When `.metadata-editor` is not yet in the DOM at apply
   * time, the observer fires once it is lazily rendered, scheduling a new
   * apply that will find it.
   *
   * NOTE: MutationObserver is used because Obsidian provides no stable public
   * hook for properties-panel render events. This coupling is intentional and
   * accepted until Obsidian ships an official properties API hook. When such an
   * API is available, replace this observer with the official hook.
   *
   * @param {HTMLElement} contentEl - The MarkdownView.contentEl to observe
   */
  protected syncObserver(contentEl: HTMLElement): void {
    if (this.observed === contentEl && this.observer) {
      return;
    }

    if (this.observer) {
      this.observer.disconnect();
    }

    this.observer = new MutationObserver((): void => {
      this.schedule();
    });

    this.observer.observe(contentEl, { childList: true, subtree: true });
    this.observed = contentEl;
  }

  /**
   * Extracts the top-level key names from the frontmatter block of `lines` in
   * their declaration order.  Returns an empty array when no frontmatter block
   * is present or the block cannot be parsed.
   *
   * This is used by {@link apply} to obtain the baseline key order that
   * {@link injectGhosts} needs for the surviving-neighbor insertion strategy.
   *
   * @param {string[]} lines - File content split into lines (baseline snapshot)
   * @returns {string[]} Top-level YAML key names in declaration order
   */
  protected static extractKeyOrder(lines: string[]): string[] {
    if (!lines.length || lines[0].trim() !== '---') {
      return [];
    }

    const closeIdx = lines.indexOf('---', 1);

    if (closeIdx === -1) {
      return [];
    }

    const yaml = lines.slice(1, closeIdx).join('\n');

    try {
      const parsed: unknown = parseYaml(yaml);

      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return Object.keys(parsed as Record<string, unknown>);
      }
    } catch {
      // Malformed YAML - degrade gracefully.
    }

    return [];
  }
}
