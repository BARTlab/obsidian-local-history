import { PathExcludeHelper } from '@/helpers/path-exclude.helper';
import type { ExcludePatternsEditorHost } from '@/settings/exclude-patterns-editor.types';
import type { ExtraButtonComponent, Setting, SettingGroup, TextComponent } from 'obsidian';

/**
 * The excluded-paths pattern editor, extracted from the settings tab
 * host-pattern style like the modal collaborators (per ADR-11: deep
 * collaborators, not DI services). It owns the dynamic pattern rows inside the
 * "Excluded paths" group: the empty-state hint, one display row per pattern with
 * ghost edit/remove icon-buttons, and the inline editor (a text field spanning
 * the free row width with save/cancel icon-buttons, Enter saves, Escape
 * cancels). An invalid pattern surfaces an inline error under the field and the
 * row stays in edit mode, so a typo is never persisted. After a persisted
 * mutation only the pattern rows rebuild in place; the rest of the tab keeps its
 * DOM.
 *
 * The settings tab keeps the section wiring - the group, its "+" button, the
 * description row, and the case-sensitivity toggle that doubles as the
 * row-insertion anchor (see {@link setAnchor} and {@link placeRow}).
 */
export class ExcludePatternsEditor {
  /**
   * The "Excluded paths" group, kept so a persisted pattern mutation can rebuild
   * the pattern rows in place without re-rendering the whole tab.
   */
  private group?: SettingGroup;

  /**
   * Every dynamic row currently in the excluded-paths group (the empty-state
   * hint, pattern rows, and the unsaved new-pattern row). Tracked so
   * {@link refreshRows} can remove exactly the rows this editor owns, leaving the
   * group header, its "+" button, and the static rows intact.
   */
  private rows: Setting[] = [];

  /**
   * The empty-state hint row, present only while the pattern list is empty.
   * Hidden in place while an unsaved new-pattern row is open.
   */
  private hint?: Setting;

  /**
   * The unsaved new-pattern row, if the user is currently adding one. Guards the
   * "+" button against stacking multiple unsaved rows.
   */
  private newRow?: Setting;

  /** The text component of the unsaved new-pattern row, for re-focus. */
  private newInput?: TextComponent;

  /**
   * The case-sensitivity toggle row, the last static row of the excluded-paths
   * group. Dynamic pattern rows must render above it, but the group can only
   * append, so {@link placeRow} uses this row as the insertion anchor when
   * rebuilding rows after the initial render.
   */
  private anchor?: Setting;

  /**
   * @param {ExcludePatternsEditorHost} host - The tab-side operations the editor
   *   delegates to (read, persist, translate).
   */
  public constructor(private readonly host: ExcludePatternsEditorHost) {}

  /**
   * Renders the dynamic pattern rows into the group and remembers the group so a
   * later persisted mutation can rebuild them in place. Resets the insertion
   * anchor first, since the case-sensitivity toggle that sets it is appended by
   * the tab only after this call.
   *
   * @param {SettingGroup} group - The "Excluded paths" native setting group
   */
  public render(group: SettingGroup): void {
    this.group = group;
    this.anchor = undefined;
    this.renderRows(group, [...this.host.getPatterns()]);
  }

  /**
   * Records the row above which refreshed pattern rows are inserted (the
   * case-sensitivity toggle, appended last by the tab). Until it is set the rows
   * stay where the group appended them.
   *
   * @param {Setting} setting - The insertion-anchor row
   */
  public setAnchor(setting: Setting): void {
    this.anchor = setting;
  }

  /**
   * Appends a new unsaved pattern row already in edit mode. When such a row is
   * already open, re-focuses it instead of stacking another. The empty-state
   * hint hides while the unsaved row is open and returns on cancel; a successful
   * save persists and rebuilds the pattern rows in place.
   */
  public startAdd(): void {
    const group: SettingGroup | undefined = this.group;

    if (!group) {
      return;
    }

    if (this.newRow) {
      this.newInput?.inputEl.focus();

      return;
    }

    this.hint?.settingEl.addClass('lct-row-hidden');

    group.addSetting((setting: Setting): void => {
      this.placeRow(setting);
      this.newRow = setting;
      this.newInput = this.renderEditor(
        setting,
        '',
        (value: string): string | null => this.append(value),
        (): void => {
          setting.settingEl.remove();
          this.rows = this.rows.filter((row: Setting): boolean => row !== setting);
          this.newRow = undefined;
          this.newInput = undefined;
          this.hint?.settingEl.removeClass('lct-row-hidden');
        }
      );
    });
  }

  /**
   * Tracks a dynamic pattern row and keeps it above the case-sensitivity toggle.
   * On the initial render the toggle does not exist yet, so rows stay where the
   * group appended them (right after the description); on an in-place refresh or
   * an added row the group appends to its end, which is below the toggle, so the
   * row's element is moved up before the anchor.
   *
   * @param {Setting} setting - The freshly appended dynamic row
   */
  private placeRow(setting: Setting): void {
    this.rows.push(setting);

    this.anchor?.settingEl.before(setting.settingEl);
  }

  /**
   * Renders the dynamic pattern rows into the group: a hint row while the list
   * is empty, otherwise one display-mode row per pattern. Resets the
   * row-tracking state first, so the call is also the second half of an in-place
   * refresh.
   *
   * @param {SettingGroup} group - The "Excluded paths" native setting group
   * @param {string[]} patterns - The pattern list to render rows for
   */
  private renderRows(group: SettingGroup, patterns: string[]): void {
    this.hint = undefined;
    this.newRow = undefined;
    this.newInput = undefined;
    this.rows = [];

    if (patterns.length === 0) {
      group.addSetting((setting: Setting): void => {
        this.placeRow(setting);
        this.hint = setting.setDesc(this.host.t('setting.exclude-paths.empty'));
      });
    }

    patterns.forEach((pattern: string, index: number): void => {
      group.addSetting((setting: Setting): void => {
        this.placeRow(setting);
        this.renderDisplay(setting, pattern, index);
      });
    });
  }

  /**
   * Rebuilds the pattern rows in place after a persisted mutation: removes every
   * dynamic row this editor added to the group (the header, its "+" button, and
   * the static rows stay) and renders fresh rows from the given list. No-ops when
   * the group has not rendered yet.
   *
   * @param {string[]} patterns - The persisted pattern list the rows must match
   */
  private refreshRows(patterns: string[]): void {
    const group: SettingGroup | undefined = this.group;

    if (!group) {
      return;
    }

    for (const row of this.rows) {
      row.settingEl.remove();
    }

    this.renderRows(group, patterns);
  }

  /**
   * Renders (or restores) a pattern row's display mode: the pattern as the row
   * name plus ghost edit and remove icon-buttons. Edit swaps the same row into
   * edit mode in place; remove persists the shortened list.
   *
   * @param {Setting} setting - The row to render into (cleared first)
   * @param {string} pattern - The pattern this row shows
   * @param {number} index - The index of the pattern in the list
   */
  private renderDisplay(setting: Setting, pattern: string, index: number): void {
    setting.clear();
    setting.controlEl.empty();
    setting.settingEl.removeClass('lct-exclude-edit');
    setting.setName(pattern);

    setting.addExtraButton((button: ExtraButtonComponent): ExtraButtonComponent =>
      button
        .setIcon('pencil')
        .setTooltip(this.host.t('setting.exclude-paths.edit'))
        .onClick((): void => {
          this.renderEditor(
            setting,
            pattern,
            (value: string): string | null => this.replace(index, value),
            (): void => {
              this.renderDisplay(setting, pattern, index);
            }
          );
        })
    );

    setting.addExtraButton((button: ExtraButtonComponent): ExtraButtonComponent =>
      button
        .setIcon('trash')
        .setTooltip(this.host.t('setting.exclude-paths.remove'))
        .onClick((): void => {
          this.remove(index);
        })
    );
  }

  /**
   * Swaps a pattern row into edit mode: a text field spanning the free row width
   * plus save/cancel icon-buttons. Enter saves, Escape cancels. A failed save
   * surfaces the validation message inline under the field and keeps the row in
   * edit mode; a successful save persists, which rebuilds the pattern rows in
   * place.
   *
   * @param {Setting} setting - The row to render into (cleared first)
   * @param {string} initial - The initial field value (the current pattern, or
   *   empty for a new row)
   * @param {(value: string) => string | null} commit - Persists the entered
   *   value; returns an error message to surface inline, or null on success
   * @param {() => void} cancel - Restores the row (or removes it, for an unsaved
   *   new row)
   * @return {TextComponent | undefined} The text component, for re-focus
   */
  private renderEditor(
    setting: Setting,
    initial: string,
    commit: (value: string) => string | null,
    cancel: () => void
  ): TextComponent | undefined {
    setting.clear();
    setting.controlEl.empty();
    setting.setName('');
    setting.settingEl.addClass('lct-exclude-edit');

    /**
     * The inline error line: a flex child that wraps to its own full-width line
     * after the field and buttons (see `.lct-exclude-edit` in styles).
     */
    const errorEl: HTMLElement = setting.controlEl.createDiv({ cls: 'lct-setting-error' });

    let input: TextComponent | undefined;

    const save = (): void => {
      const message: string | null = commit(input?.getValue() ?? '');

      errorEl.setText(message ?? '');
    };

    setting.addText((text: TextComponent): void => {
      input = text;
      text.setPlaceholder(this.host.t('setting.exclude-paths.placeholder')).setValue(initial);
      text.inputEl.addEventListener('keydown', (event: KeyboardEvent): void => {
        if (event.key === 'Enter') {
          event.preventDefault();
          save();

          return;
        }

        if (event.key === 'Escape') {
          event.preventDefault();
          cancel();
        }
      });
    });

    setting.addExtraButton((button: ExtraButtonComponent): ExtraButtonComponent =>
      button
        .setIcon('check')
        .setTooltip(this.host.t('setting.exclude-paths.save'))
        .onClick((): void => {
          save();
        })
    );

    setting.addExtraButton((button: ExtraButtonComponent): ExtraButtonComponent =>
      button
        .setIcon('x')
        .setTooltip(this.host.t('setting.exclude-paths.cancel'))
        .onClick((): void => {
          cancel();
        })
    );

    input?.inputEl.focus();

    return input;
  }

  /**
   * Validates a candidate exclude pattern: it must be non-blank and compile as a
   * regular expression. Blank entries are rejected here even though the matcher
   * tolerates them, because a stored blank row is dead weight the user would have
   * to clean up by hand.
   *
   * @param {string} value - The trimmed candidate pattern
   * @return {string | null} An error message, or null when the pattern is valid
   */
  private validate(value: string): string | null {
    if (value === '' || !PathExcludeHelper.isValid(value)) {
      return this.host.t('setting.exclude-paths.error');
    }

    return null;
  }

  /**
   * Validates and persists a replacement for the pattern at `index`. The list is
   * re-read from the host at invocation time so edits made since the rows
   * rendered are preserved.
   *
   * @param {number} index - The index of the pattern being edited
   * @param {string} value - The raw field value
   * @return {string | null} An error message to surface inline, or null once
   *   persisted
   */
  private replace(index: number, value: string): string | null {
    const trimmed: string = value.trim();
    const message: string | null = this.validate(trimmed);

    if (message !== null) {
      return message;
    }

    const next: string[] = [...this.host.getPatterns()];

    next[index] = trimmed;
    this.commit(next);

    return null;
  }

  /**
   * Validates and persists a new pattern appended to the list. The list is
   * re-read from the host at invocation time so edits made since the rows
   * rendered are preserved.
   *
   * @param {string} value - The raw field value
   * @return {string | null} An error message to surface inline, or null once
   *   persisted
   */
  private append(value: string): string | null {
    const trimmed: string = value.trim();
    const message: string | null = this.validate(trimmed);

    if (message !== null) {
      return message;
    }

    this.commit([...this.host.getPatterns(), trimmed]);

    return null;
  }

  /**
   * Removes the pattern at `index` and rebuilds the pattern rows in place.
   *
   * @param {number} index - The index of the pattern to remove
   */
  private remove(index: number): void {
    const next: string[] = this.host
      .getPatterns()
      .filter((_pattern: string, at: number): boolean => at !== index);

    this.commit(next);
  }

  /**
   * Persists a replacement pattern list through the host and rebuilds the
   * pattern rows in place so they match it. Only the dynamic rows are touched:
   * the rest of the tab keeps its DOM and focus.
   *
   * @param {string[]} patterns - The full replacement pattern list
   */
  private commit(patterns: string[]): void {
    this.host.persist(patterns);
    this.refreshRows(patterns);
  }
}
