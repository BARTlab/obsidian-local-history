# Local History - Line Change Tracker

[![GitHub release (latest SemVer)](https://img.shields.io/github/v/release/bartlab/obsidian-local-history?style=for-the-badge&sort=semver)](https://github.com/bartlab/obsidian-local-history/releases/latest)
[![GitHub All Releases](https://img.shields.io/github/downloads/bartlab/obsidian-local-history/total?style=for-the-badge)](https://github.com/bartlab/obsidian-local-history/releases)

An Obsidian plugin that tracks and visually highlights changed lines in your documents, giving you real-time feedback on your editing progress with unobtrusive visual indicators.

## Philosophy

The plugin is built around minimal interference and maximum informativeness. It follows the principle of "show, but don't interfere": it surfaces useful information about your changes while staying out of the way and not disrupting your usual workflow.

## Why use it

During long editing sessions or while working with large documents, it is easy to lose track of what exactly has changed. This is especially helpful when:

- Refactoring large notes, where you restructure content without losing important details.
- Reviewing contributions, where several people edit a document and you want to see what changed.
- Experimenting with text, where you try different wordings and want to return to a previous version.
- Running long editing sessions, where many small changes accumulate over hours of work.

## How it compares to Obsidian Sync version history

Obsidian Sync provides a built-in [version history](https://obsidian.md/help/sync/version-history) feature. The two solutions solve different problems and can be used together:

| Aspect | Local History (this plugin) | Obsidian Sync version history |
| --- | --- | --- |
| Cost | Free, no account | Paid, part of Obsidian Sync |
| Scope | Live, in-editor session tracking | Periodic server-side snapshots |
| Granularity | Per-line highlighting as you type | Per-snapshot file versions |
| Diff view | Built-in side-by-side, line-by-line and patch | Version contents, no line-level diff |
| Storage | In memory for the current session | Cloud, retained for 1 to 12 months by plan |
| Network | Fully local, no network access | Requires sync to Obsidian servers |

In short, this plugin focuses on immediate, in-session visual feedback while you edit, whereas Sync version history is a long-term cloud backup of file versions.

## Features

### Change detection

- Activates in Source mode for precise tracking.
- Works with previously saved files and can ignore newly created ones.
- Monitors changes as you type using the CodeMirror 6 API.

### Visual indicators

- Highlights changed lines with customizable colored markers.
- Optional gutter mode with character indicators instead of line markers.
- Markers disappear automatically when a line returns to its original state.
- Separate styles for changed, added, removed and restored lines.

### History and diff

- Preserves the original file state for accurate comparison.
- Built-in diff modal with side-by-side and line-by-line views.
- Clean patch export with zero context that you can copy to the clipboard.
- Restore the file back to its original state from the diff modal.

## Screenshots

[<img src="screenshots/editor-lines.png" alt="editor-lines" width="300">](screenshots/editor-lines.png)
[<img src="screenshots/editor-gutters.png" alt="editor-gutters" width="300">](screenshots/editor-gutters.png)

The plugin highlighting changed lines in the editor.

[<img src="screenshots/diff-line-by-line.png" alt="diff-line-by-line" width="300">](screenshots/diff-line-by-line.png)
[<img src="screenshots/diff-side-by-side.png" alt="diff-side-by-side" width="300">](screenshots/diff-side-by-side.png)
[<img src="screenshots/diff-patch.png" alt="diff-patch" width="300">](screenshots/diff-patch.png)

The built-in diff viewer showing changes.

[<img src="screenshots/settings.png" alt="settings" width="300">](screenshots/settings.png)

Settings for the different indicator types.

## Installation

### From Community Plugins

1. Open Obsidian.
2. Go to Settings, then Community plugins.
3. Turn off Restricted mode if it is enabled.
4. Click Browse and search for "Local history".
5. Click Install, then Enable.

### Manual installation

1. Download the latest release from the [releases page](https://github.com/bartlab/obsidian-local-history/releases).
2. Copy `main.js`, `manifest.json` and `styles.css` into `VaultFolder/.obsidian/plugins/local-history/`.
3. Reload Obsidian.
4. Enable the plugin in Settings, then Community plugins.

## Usage

1. Open an existing file in Source mode. The plugin captures the original state automatically.
2. Start editing. Changed lines are highlighted as you type:
   - Changed lines use the blue indicator.
   - Added lines use the orange indicator.
   - Removed lines use the base indicator.
   - Restored lines use the faint indicator.
3. Open the diff modal to review all changes for the current file.

### Opening the diff view

- Click the "lines changed" item in the status bar.
- Right-click in the editor or on a file and choose "Local history".
- Run the "Show all changes of current document" command from the command palette.

### Commands

- Show all changes of current document.
- Reset lines tracker snapshot of current document.
- Reset all lines tracker snapshots.

### Diff view

- Side-by-side view to compare the original and current versions.
- Line-by-line unified view.
- Patch export with zero context that you can copy to the clipboard.
- Synchronized scrolling for both panels in side-by-side mode.

## Configuration

Open Settings, then Community plugins, then the Local history options.

### Display

- Indicator type: a vertical line or a character in the gutter.
- Toggle indicators per change type: changed, added, removed and restored.

### History

- Allowed file extensions: a comma-separated list of extensions to track.
- Keep history until: clear tracking data when the app closes or when the file closes.
- Ignore new files: do not track files created after tracking has started.

### Appearance

- Line width: the width of the vertical line indicator.
- Gutter characters: the characters used in gutter mode.
- Colors: override indicator colors with a CSS snippet.

#### Custom CSS example

```css
.lct-line.lct-changed:not(.mk-placeholder)::before {
    background-color: #ff6b35;
}

.lct-line.lct-added:not(.mk-placeholder)::before {
    background-color: #4ecdc4;
}

.lct-line.lct-restored:not(.mk-placeholder)::after {
    background-color: #fcdb89;
}

.lct-line.lct-removed:not(.mk-placeholder)::after {
    background-color: #b6b6b6;
}
```

## Privacy

This plugin runs entirely on your device. It does not connect to the network, does not collect telemetry, and does not require an account. Tracked changes are kept in memory for the current session and are cleared according to the "Keep history until" setting. The plugin reads file contents from your vault only to compute diffs and never sends them anywhere.

## Compatibility

- Minimum Obsidian version: 0.15.0.
- Platforms: desktop and mobile.
- File types: plain text files such as `.md`, `.txt`, `.csv`, `.json` and `.yaml`.

## Support

If you find this plugin useful, you can support its development:

[![Buy Me A Coffee](https://img.shields.io/badge/buy%20me%20a%20coffee-donate-yellow.svg?style=for-the-badge&logo=buy-me-a-coffee)](https://coff.ee/bartlaba)

## Issues and feedback

Found a bug or have a feature request? Open an issue on [GitHub](https://github.com/bartlab/obsidian-local-history/issues) and include:

- A clear description of the problem.
- Steps to reproduce.
- Your Obsidian version and operating system.
- Screenshots if applicable.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

## For developers

### Prerequisites

- Node.js 18 or higher.
- npm.
- Git.

### Getting started

```bash
git clone https://github.com/bartlab/obsidian-local-history.git
cd obsidian-local-history
npm install
npm run dev
```

Build for production:

```bash
npm run build
```

### Available scripts

- `npm run dev`: build in watch mode.
- `npm run build`: type-check and build for production.
- `npm run lint`: run ESLint over the source.
- `npm run type-check`: run the TypeScript compiler without emitting output.

### Project structure

```
obsidian-local-history/
├── src/
│   ├── commands/      # Command palette integrations
│   ├── decorators/    # Inject and event decorators
│   ├── events/        # Workspace and vault event handlers
│   ├── extensions/    # CodeMirror 6 editor and gutter extensions
│   ├── helpers/       # DOM and text utilities
│   ├── lines/         # Line tracking model
│   ├── maps/          # Data structures
│   ├── modals/        # Diff and confirmation modals
│   ├── services/      # Core services
│   ├── settings/      # Settings tab
│   ├── snapshots/     # File snapshot model
│   ├── main.ts        # Plugin entry point
│   └── types.ts       # Shared type definitions
├── styles.scss        # Plugin styles source
├── manifest.json      # Plugin manifest
└── esbuild.config.mjs # Build configuration
```

### Architecture

The plugin uses a service-oriented architecture with a small dependency injection container:

- Services hold the core functionality such as snapshots, settings and events.
- Extensions integrate with CodeMirror 6 for editor decorations and gutters.
- Commands expose actions through the command palette.
- Modals render the diff and confirmation dialogs.
- Helpers provide DOM and text utilities.

### Key technologies

- TypeScript.
- CodeMirror 6 for editor integration and decorations.
- `diff` for text comparison and patch generation.
- `diff2html` for diff rendering.
- The Obsidian plugin API.

### Localization

The plugin follows Obsidian's own UI language. It ships a built-in dictionary per
language under `lang/<code>.json`, selected by the `language` value Obsidian
stores in `localStorage`. English (`lang/en.json`) is the universal fallback:
every key is guaranteed to exist there, so any language without its own catalog,
or a catalog missing a key, resolves to the English string rather than a raw key.
All of Obsidian's default UI languages ship with a complete catalog; the few
remaining codes Obsidian can be set to are supported through the English fallback
until a catalog is added.

#### Adding a translation

1. Copy `lang/en.json` to `lang/<code>.json`, where `<code>` is the Obsidian
   language code (for example `de`, `fr`, `pt-BR`, `zh`). Use the exact code from
   Obsidian's [translations list](https://github.com/obsidianmd/obsidian-translations);
   it is the value Obsidian writes to the `language` key in `localStorage`.
2. Translate every value, keeping the keys and any `{name}` placeholders (such as
   `{number}`, `{line}`, `{start}`, `{end}`) unchanged so interpolation still
   works.
3. Register the new catalog in `src/services/i18n.service.ts`: import the file and
   add it to `BUNDLED_CATALOGS` (esbuild only bundles what `main.ts` imports, so a
   static import is required for the catalog to ship in `main.js`).
4. Add the catalog to `tests/i18n-catalog-parity.test.ts` and run `npm test`. The
   parity check enforces that a listed catalog has the exact same key set as
   `en.json` with no empty values, so it fails if a key is missing, extra, or
   blank.

The set of language codes Obsidian can select lives in `OBSIDIAN_LANGUAGES` in
`src/services/i18n.service.ts`.

### Releasing

1. Update the version in `manifest.json` and `package.json`.
2. Add the new version to `versions.json` with its minimum app version.
3. Create a git tag that matches the version, for example `1.0.1`.
4. Push the tag. The release workflow builds and publishes the release.
