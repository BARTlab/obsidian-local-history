import 'reflect-metadata';
import { describe, expect, it, vi, type Mock, type MockInstance } from 'vitest';

import { GoToPreviousChangeCommand } from '@/commands/go-to-previous-change.command';
import { ChangeType } from '@/consts';
import type { SettingsService } from '@/services/settings.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import { TOKENS } from '@/services/tokens';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { Editor } from 'obsidian';
import * as obsidian from 'obsidian';

type PluginArg = ConstructorParameters<typeof GoToPreviousChangeCommand>[0];

const ENABLED_TYPES: ChangeType[] = [ChangeType.added, ChangeType.changed];

/**
 * Spies on the obsidian Notice constructor with an inert implementation, so
 * `new Notice(...)` is counted without standing up a real toast (spying on an
 * ES6 class without a mock implementation throws on `new`).
 */
const spyNotice = (): MockInstance<typeof obsidian.Notice> =>
  vi.spyOn(obsidian, 'Notice').mockImplementation(
    (function(this: unknown): void {
      // Inert: record the construction only.
    }) as unknown as (message?: string | DocumentFragment) => obsidian.Notice,
  );

/**
 * Builds an Editor double that reports a fixed cursor line and records every
 * line the command moves the cursor to (see the next-change suite for the
 * clamp-avoiding lastLine/getLine answers).
 */
const makeEditor = (
  cursorLine: number,
): { editor: Editor; movedTo: number[] } => {
  const movedTo: number[] = [];
  const editor = {
    getCursor: (): { line: number; ch: number } => ({ line: cursorLine, ch: 0 }),
    lastLine: (): number => 1000,
    getLine: (): string => '',
    setCursor: (pos: { line: number; ch: number }): void => {
      movedTo.push(pos.line);
    },
    scrollIntoView: (): void => {},
  } as unknown as Editor;

  return { editor, movedTo };
};

/**
 * Builds a GoToPreviousChangeCommand over a container-shaped plugin stub whose
 * @Inject fields resolve to a snapshots mock (whose sole snapshot reports the
 * given changed positions) and a settings mock returning ENABLED_TYPES.
 */
const makeContext = (
  positions: number[] | null,
): {
  command: GoToPreviousChangeCommand;
  getChangedPositions: Mock<(types: ChangeType[]) => number[]>;
} => {
  const getChangedPositions = vi.fn<(types: ChangeType[]) => number[]>()
    .mockReturnValue(positions ?? []);

  const snapshot: FileSnapshot | null = positions === null
    ? null
    : ({ content: { getChangedPositions } } as unknown as FileSnapshot);

  const snapshots = { getOne: vi.fn().mockReturnValue(snapshot) };
  const settings = { getEnabledTypes: vi.fn().mockReturnValue(ENABLED_TYPES) };

  const container: Map<unknown, unknown> = new Map<unknown, unknown>([
    [TOKENS.snapshots, snapshots as unknown as SnapshotsService],
    [TOKENS.settings, settings as unknown as SettingsService],
  ]);

  const plugin = {
    get: (key: unknown): unknown => container.get(key),
    t: (key: string): string => key,
  } as unknown as PluginArg;

  return { command: new GoToPreviousChangeCommand(plugin), getChangedPositions };
};

describe('GoToPreviousChangeCommand', () => {
  it('declares its command id and localized name (registration metadata)', () => {
    const { command } = makeContext([]);

    expect(command.id).toBe('tracker-go-to-previous-change');
    expect(command.name).toBe('command.go-to-previous-change');
  });

  it('queries the snapshot with exactly the settings-enabled change types', () => {
    const { command, getChangedPositions } = makeContext([1, 5, 9]);
    const { editor } = makeEditor(6);

    command.editorCallback(editor);

    expect(getChangedPositions).toHaveBeenCalledTimes(1);
    expect(getChangedPositions).toHaveBeenCalledWith(ENABLED_TYPES);
  });

  it('moves the cursor to the last change strictly before the cursor line', () => {
    const { command } = makeContext([1, 5, 9]);
    const { editor, movedTo } = makeEditor(6);

    command.editorCallback(editor);

    expect(movedTo).toEqual([5]);
  });

  it('wraps to the last change when the cursor sits before the first change', () => {
    const { command } = makeContext([3, 7]);
    const { editor, movedTo } = makeEditor(1);

    command.editorCallback(editor);

    expect(movedTo).toEqual([7]);
  });

  it('shows a notice and does not move when the document has no tracked changes', () => {
    const notice = spyNotice();
    const { command } = makeContext([]);
    const { editor, movedTo } = makeEditor(0);

    command.editorCallback(editor);

    expect(notice).toHaveBeenCalledWith('notice.no-changes-to-navigate');
    expect(movedTo).toEqual([]);

    notice.mockRestore();
  });

  it('shows a notice and does not move when the active file has no snapshot', () => {
    const notice = spyNotice();
    const { command } = makeContext(null);
    const { editor, movedTo } = makeEditor(0);

    command.editorCallback(editor);

    expect(notice).toHaveBeenCalledWith('notice.no-changes-to-navigate');
    expect(movedTo).toEqual([]);

    notice.mockRestore();
  });
});
