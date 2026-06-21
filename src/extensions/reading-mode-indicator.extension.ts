import { ChangeType, PluginEvent } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { On } from '@/decorators/on.decorator';
import type LineChangeTrackerPlugin from '@/main';
import type { SettingsService } from '@/services/settings.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import { TOKENS } from '@/services/tokens';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { Service } from '@/types';
import {
  MarkdownPreviewRenderer,
  type MarkdownPostProcessor,
  type MarkdownPostProcessorContext,
} from 'obsidian';

/**
 * CSS class applied to a reading-mode block when any of its source lines are
 * decorated. The data-lct-type attribute carries the highest-priority change
 * type so CSS can color the indicator without extra classes.
 */
const CLASS_INDICATOR = 'lct-rm-indicator';

/**
 * Priority order for picking a representative change type when multiple types
 * appear in the same block. Lower index = higher priority (added > changed >
 * whitespace > restored). Removed lines are never present as HTML blocks in
 * reading mode, so they are excluded here.
 */
const TYPE_PRIORITY: ChangeType[] = [
  ChangeType.added,
  ChangeType.changed,
  ChangeType.whitespace,
  ChangeType.restored,
];

/**
 * Service that registers a MarkdownPostProcessor to show block-level change
 * indicators in Obsidian's reading mode.
 *
 * When enabled (via the `readingModeIndicator` setting toggle), it registers a
 * global post-processor with {@link MarkdownPreviewRenderer} that fires for every
 * rendered block in every reading-mode view. For each block the processor:
 *
 * 1. Calls {@link MarkdownPostProcessorContext.getSectionInfo} to obtain the
 *    source-line range `[lineStart, lineEnd]` for that block.
 * 2. Looks up the snapshot for `ctx.sourcePath` via {@link SnapshotsService}.
 * 3. Checks whether any line in the range has a recorded change.
 * 4. If so, adds {@link CLASS_INDICATOR} and a `data-lct-type` attribute
 *    matching the change type; if not, removes those attributes.
 *
 * The processor never writes back to the source markdown (AC: read-only
 * decoration of rendered HTML only). Registration is conditional on the setting
 * so there is no post-processor overhead when the feature is disabled. When the
 * toggle changes at runtime, the old processor is unregistered and a new one is
 * registered (or not, if newly disabled), keeping Obsidian's renderer in sync.
 *
 * @implements {Service}
 */
export class ReadingModeIndicatorService implements Service {
  /**
   * Service for reading plugin settings, used to gate post-processor
   * registration behind the `readingModeIndicator` toggle.
   */
  @Inject(TOKENS.settings)
  protected settingsService: SettingsService;

  /**
   * Service for reading file snapshots, from which the change map is sourced.
   */
  @Inject(TOKENS.snapshots)
  protected snapshotsService: SnapshotsService;

  /**
   * Reference to the currently registered post-processor function, or undefined
   * when the feature is disabled. Kept so the same function reference can be
   * passed to {@link MarkdownPreviewRenderer.unregisterPostProcessor}.
   */
  protected processor: MarkdownPostProcessor | undefined = undefined;

  /**
   * Creates a new instance of ReadingModeIndicatorService.
   *
   * @param {LineChangeTrackerPlugin} plugin - The plugin instance
   */
  public constructor(
    protected plugin: LineChangeTrackerPlugin,
  ) {
  }

  /**
   * Initializes the service. Registers the post-processor when the feature is
   * enabled at load time.
   */
  public init(): void {
    if (this.settingsService.value('readingModeIndicator')) {
      this.register();
    }
  }

  /**
   * Reacts to settings changes. Re-evaluates the `readingModeIndicator` toggle
   * and registers or unregisters the post-processor accordingly so the feature
   * can be switched on/off at runtime without a plugin reload.
   */
  @On(PluginEvent.settingsUpdate)
  public onSettingsUpdate(): void {
    const enabled: boolean = this.settingsService.value('readingModeIndicator');

    if (enabled && !this.processor) {
      this.register();
    } else if (!enabled && this.processor) {
      this.unregister();
    }
  }

  /**
   * Unloads the service. Removes the post-processor if one is registered so
   * the renderer is left clean after unload.
   */
  public unload(): void {
    this.unregister();
  }

  /**
   * Creates and registers the post-processor with
   * {@link MarkdownPreviewRenderer}. The function reference is stored in
   * {@link processor} so it can be removed by exact reference later.
   */
  protected register(): void {
    const fn: MarkdownPostProcessor = (
      el: HTMLElement,
      ctx: MarkdownPostProcessorContext,
    ): void => {
      this.decorate(el, ctx);
    };

    this.processor = fn;
    this.plugin.registerMarkdownPostProcessor(fn);
  }

  /**
   * Unregisters the current post-processor from
   * {@link MarkdownPreviewRenderer} and clears the stored reference.
   */
  protected unregister(): void {
    if (!this.processor) {
      return;
    }

    MarkdownPreviewRenderer.unregisterPostProcessor(this.processor);
    this.processor = undefined;
  }

  /**
   * Core post-processor callback. Decorates a single rendered block element
   * when its source-line range overlaps with any recorded change in the
   * snapshot for the file at `ctx.sourcePath`.
   *
   * Guard branches (degrade silently):
   * - plugin not ready: return early without touching the element
   * - no section info available: return early (Obsidian returns null for some
   *   synthetic blocks such as embeds)
   * - no snapshot for this path: remove any stale indicator and return
   * - snapshot has no changes: remove any stale indicator and return
   *
   * The element is never mutated beyond adding/removing the indicator class and
   * its `data-lct-type` attribute; source markdown is never read or written.
   *
   * @param {HTMLElement} el - The rendered block element
   * @param {MarkdownPostProcessorContext} ctx - The post-processor context
   */
  protected decorate(
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext,
  ): void {
    if (!this.plugin.isReady()) {
      return;
    }

    const info = ctx.getSectionInfo(el);

    if (!info) {
      return;
    }

    const snapshot: FileSnapshot | null = this.snapshotsService.getOne(
      this.plugin.app.vault.getFileByPath(ctx.sourcePath),
    );

    if (!snapshot) {
      el.classList.remove(CLASS_INDICATOR);
      el.removeAttribute('data-lct-type');

      return;
    }

    const changeType: ChangeType | null = this.resolveBlockChangeType(
      snapshot,
      info.lineStart,
      info.lineEnd,
    );

    if (changeType === null) {
      el.classList.remove(CLASS_INDICATOR);
      el.removeAttribute('data-lct-type');
    } else {
      el.classList.add(CLASS_INDICATOR);
      el.setAttribute('data-lct-type', changeType);
    }
  }

  /**
   * Scans the change map for the given snapshot over the line range
   * `[lineStart, lineEnd]` (both inclusive, 0-based) and returns the
   * highest-priority change type found, or null when no line in the range is
   * changed.
   *
   * Priority is defined by {@link TYPE_PRIORITY}: `added` beats `changed`, which
   * beats `whitespace`, which beats `restored`. Removed lines are excluded because
   * they have no corresponding HTML block in reading mode.
   *
   * @param {FileSnapshot} snapshot - The snapshot for the current file
   * @param {number} lineStart - The first source line of the block (0-based)
   * @param {number} lineEnd - The last source line of the block (0-based, inclusive)
   * @return {ChangeType | null} The dominant change type, or null if no change found
   */
  protected resolveBlockChangeType(
    snapshot: FileSnapshot,
    lineStart: number,
    lineEnd: number,
  ): ChangeType | null {
    let best: ChangeType | null = null;
    let bestPriority: number = TYPE_PRIORITY.length;

    for (let line = lineStart; line <= lineEnd; line++) {
      const changeLine = snapshot.getChanges().get(line);

      if (!changeLine) {
        continue;
      }

      for (const type of TYPE_PRIORITY) {
        const priority: number = TYPE_PRIORITY.indexOf(type);

        if (priority < bestPriority && changeLine.has(type)) {
          best = type;
          bestPriority = priority;
          break;
        }
      }

      if (bestPriority === 0) {
        break;
      }
    }

    return best;
  }
}
