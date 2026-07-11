/**
 * Precompiles the custom diff2html templates from scripts/diff2html-templates/
 * into src/vendor/diff2html-templates.gen.ts.
 *
 * Why: hogan's runtime compiler (Hogan.compile) builds templates via
 * `new Function`, which the Obsidian plugin scan flags as dynamic code
 * execution. Precompiling at build-authoring time lets the bundle carry only
 * hogan's render-only Template runtime; the compiler is stubbed out of the
 * bundle entirely (see src/vendor/hogan.stub.ts and esbuild.config.mjs).
 *
 * The generic-wrapper source carries a __MODE__ token that expands to the
 * `line` and `side` variants, matching the interpolation the raw template
 * used to do at render time.
 *
 * Run after editing any .mustache source: node scripts/compile-diff2html-templates.mjs
 * The script self-checks by rendering a sample diff through diff2html with
 * the raw sources (runtime compiler) and with the precompiled templates and
 * asserting the outputs are byte-identical for both output formats.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Hogan = require('@profoundlogic/hogan');
const Diff2Html = require('diff2html');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = resolve(root, 'scripts/diff2html-templates');
const outFile = resolve(root, 'src/vendor/diff2html-templates.gen.ts');

const readSource = (name) => readFileSync(resolve(sourceDir, `${name}.mustache`), 'utf8');

const wrapperSource = readSource('generic-wrapper');

if (!wrapperSource.includes('__MODE__')) {
  throw new Error('generic-wrapper.mustache must carry the __MODE__ token');
}

/** Template sources keyed by the identifier used in the generated module. */
const sources = {
  lineByLineFileDiff: readSource('line-by-line-file-diff'),
  sideBySideFileDiff: readSource('side-by-side-file-diff'),
  genericWrapperLine: wrapperSource.replaceAll('__MODE__', 'line'),
  genericWrapperSide: wrapperSource.replaceAll('__MODE__', 'side'),
  genericBlockHeader: readSource('generic-block-header'),
  genericLine: readSource('generic-line'),
};

/** Compiles a template to its codeObj source text (no `new Function` in it). */
const compileToSource = (text) => Hogan.compile(text, { asString: true });

const compiled = Object.fromEntries(
  Object.entries(sources).map(([name, text]) => [name, compileToSource(text)]),
);

/**
 * Self-check: the precompiled templates must render byte-identically to the
 * raw sources compiled at runtime, for both output formats. The eval below
 * runs only inside this authoring script, never in the shipped bundle.
 */
const sampleDiff = [
  '--- a/note.md',
  '+++ b/note.md',
  '@@ -1,3 +1,3 @@',
  ' first line',
  '-second line',
  '+second line changed',
  ' third line',
  '@@ -10,2 +10,3 @@',
  ' tenth line',
  '+',
  ' eleventh line',
  '',
].join('\n');

const instantiate = (codeSource) => new Hogan.Template((0, eval)(`(${codeSource})`));

for (const format of ['line-by-line', 'side-by-side']) {
  const shared = {
    drawFileList: false,
    matching: 'lines',
    outputFormat: format,
    renderNothingWhenEmpty: true,
  };
  const wrapper = format === 'line-by-line' ? 'Line' : 'Side';
  const expected = Diff2Html.html(sampleDiff, {
    ...shared,
    rawTemplates: {
      'line-by-line-file-diff': sources.lineByLineFileDiff,
      'side-by-side-file-diff': sources.sideBySideFileDiff,
      'generic-wrapper': sources[`genericWrapper${wrapper}`],
      'generic-block-header': sources.genericBlockHeader,
      'generic-line': sources.genericLine,
    },
  });
  const actual = Diff2Html.html(sampleDiff, {
    ...shared,
    compiledTemplates: {
      'line-by-line-file-diff': instantiate(compiled.lineByLineFileDiff),
      'side-by-side-file-diff': instantiate(compiled.sideBySideFileDiff),
      'generic-wrapper': instantiate(compiled[`genericWrapper${wrapper}`]),
      'generic-block-header': instantiate(compiled.genericBlockHeader),
      'generic-line': instantiate(compiled.genericLine),
    },
  });
  if (actual !== expected) {
    throw new Error(`self-check failed: ${format} output differs from the raw-template render`);
  }
}

const generated = `// @ts-nocheck
/**
 * GENERATED FILE - DO NOT EDIT.
 *
 * Precompiled diff2html templates. Sources live in
 * scripts/diff2html-templates/*.mustache; regenerate with:
 *   node scripts/compile-diff2html-templates.mjs
 *
 * Precompilation keeps hogan's \`new Function\`-based compiler out of the
 * bundle (see src/vendor/hogan.stub.ts); only the render-only Template
 * runtime ships.
 */
import { Template } from '@profoundlogic/hogan/lib/template.js';

const lineByLineFileDiff = new Template(${compiled.lineByLineFileDiff});
const sideBySideFileDiff = new Template(${compiled.sideBySideFileDiff});
const genericWrapperLine = new Template(${compiled.genericWrapperLine});
const genericWrapperSide = new Template(${compiled.genericWrapperSide});
const genericBlockHeader = new Template(${compiled.genericBlockHeader});
const genericLine = new Template(${compiled.genericLine});

/** The custom templates for the line-by-line diff2html output format. */
export const DIFF2HTML_TEMPLATES_LINE: Record<string, Template> = {
  'line-by-line-file-diff': lineByLineFileDiff,
  'generic-wrapper': genericWrapperLine,
  'generic-block-header': genericBlockHeader,
  'generic-line': genericLine,
};

/** The custom templates for the side-by-side diff2html output format. */
export const DIFF2HTML_TEMPLATES_SIDE: Record<string, Template> = {
  'side-by-side-file-diff': sideBySideFileDiff,
  'generic-wrapper': genericWrapperSide,
  'generic-block-header': genericBlockHeader,
  'generic-line': genericLine,
};
`;

writeFileSync(outFile, generated);
console.log(`self-check passed; wrote ${outFile}`);
