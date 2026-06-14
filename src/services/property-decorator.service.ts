import { PluginEvent } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { On } from '@/decorators/on.decorator';
import {
  queryMetadataEditor,
  queryPropertyRows,
} from '@/helpers/properties-panel.adapter';
import { diffFrontmatter, type FrontmatterChange } from '@/helpers/frontmatter-diff.helper';
import type LineChangeTrackerPlugin from '@/main';
import type { SnapshotsService } from '@/services/snapshots.service';
import { TOKENS } from '@/services/tokens';
import type { Service } from '@/types';
import { type MarkdownView } from 'obsidian';
import type { FileSnapshot } from '@/snapshots/file.snapshot';

/**
 * Service that adds visual change indicators to the Obsidian Properties panel
 * (.metadata-editor) for frontmatter key-level diffs (epic 16).
 *
 * It mirrors {@link TreeTabDecoratorService} exactly: a MutationObserver on
 * `view.contentEl` handles the lazy render of `.metadata-editor`, a 100 ms
 * debounce collapses keystroke bursts, and the same four workspace events
 * (layout-change, active-leaf-change, file-open, snapshotsUpdate) keep the
 * indicators in sync.  Decoration of individual rows and ghost-row injection
 * for removed keys are handled in later tasks (T06, T07); this skeleton only
 * computes the diff and makes it available to the (no-op) apply body.
 *
 * @implements {Service}
 */
export class PropertyDecoratorService implements Service {
  /**
   * Service for reading the current set of file snapshots, from which the
   * frontmatter baseline lines and the current state lines are sourced.
   */
  @Inject(TOKENS.snapshots)
  protected snapshotsService: SnapshotsService;

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
   * Guard branches (degrading silently per D8):
   * - plugin not ready: return early
   * - no active MarkdownView: return early
   * - no .metadata-editor in DOM: (re)attach observer and return early
   * - no snapshot for the current file: return early
   *
   * When a snapshot is found, {@link diffFrontmatter} is called with
   * `snapshot.lines` (baseline) and `snapshot.state` (current).  The result
   * is passed to {@link decorate}, which is a no-op stub in this task (T06
   * and T07 will fill it in).
   */
  protected apply(): void {
    if (!this.plugin.isReady()) {
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

    const snapshot: FileSnapshot | null = this.snapshotsService.getOne(view.file);

    if (!snapshot) {
      return;
    }

    const rows: HTMLElement[] = queryPropertyRows(editor);
    const changes: FrontmatterChange = diffFrontmatter(snapshot.lines, snapshot.state);

    this.decorate(editor, rows, changes);
  }

  /**
   * No-op stub for the decoration pass.  T06 (added/modified borders + icons)
   * and T07 (ghost rows for removed keys) will replace this body.
   *
   * @param {HTMLElement} _editor - The .metadata-editor root element
   * @param {HTMLElement[]} _rows - The .metadata-property row elements
   * @param {FrontmatterChange} _changes - The key-level frontmatter diff
   */
  protected decorate(_editor: HTMLElement, _rows: HTMLElement[], _changes: FrontmatterChange): void {
    // Decoration is implemented in T06 and T07.
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
}
