// Class-file purity check.
//
// Convention: a source file that declares a class holds nothing else at the top
// level. Only import declarations, the class itself (including `export class`
// and `export default class`), and bare re-export statements are allowed beside
// it. Any interface, type alias, enum, const/let/var, function, namespace or a
// second class is a violation.
//
// No stock eslint rule expresses this, so we parse each file with the installed
// TypeScript compiler API (zero extra dependencies) and inspect its top-level
// statements. Prints `path:line kind` for every violation and exits 1 when any
// is found, so the lint chain fails on regression.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(rootDir, 'src');

const ALLOWED_NEIGHBOURS = new Set([
  ts.SyntaxKind.ImportDeclaration,
  ts.SyntaxKind.ImportEqualsDeclaration,
  ts.SyntaxKind.ExportDeclaration,
  ts.SyntaxKind.ExportAssignment,
]);

function collectSourceFiles(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

function variableKeyword(statement) {
  const flags = statement.declarationList.flags;
  if (flags & ts.NodeFlags.Const) return 'const';
  if (flags & ts.NodeFlags.Let) return 'let';
  return 'var';
}

function violationKind(statement) {
  switch (statement.kind) {
    case ts.SyntaxKind.InterfaceDeclaration:
      return 'interface';
    case ts.SyntaxKind.TypeAliasDeclaration:
      return 'type alias';
    case ts.SyntaxKind.EnumDeclaration:
      return 'enum';
    case ts.SyntaxKind.VariableStatement:
      return variableKeyword(statement);
    case ts.SyntaxKind.FunctionDeclaration:
      return 'function';
    case ts.SyntaxKind.ModuleDeclaration:
      return 'namespace';
    default:
      return ts.SyntaxKind[statement.kind];
  }
}

function findViolations(file) {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    false,
  );

  const declaresClass = source.statements.some(
    (statement) => statement.kind === ts.SyntaxKind.ClassDeclaration,
  );
  if (!declaresClass) return [];

  const violations = [];
  let classSeen = 0;
  for (const statement of source.statements) {
    if (statement.kind === ts.SyntaxKind.ClassDeclaration) {
      if (classSeen++ === 0) continue;
      violations.push({ statement, kind: 'second class' });
      continue;
    }
    if (ALLOWED_NEIGHBOURS.has(statement.kind)) continue;
    violations.push({ statement, kind: violationKind(statement) });
  }

  return violations.map(({ statement, kind }) => {
    const { line } = source.getLineAndCharacterOfPosition(statement.getStart(source));
    return { file: path.relative(rootDir, file), line: line + 1, kind };
  });
}

const files = collectSourceFiles(srcDir, []);
const violations = files.flatMap(findViolations);

if (violations.length > 0) {
  for (const { file, line, kind } of violations) {
    console.error(`${file}:${line} ${kind}`);
  }
  console.error(`\nclass-file purity: ${violations.length} violation(s)`);
  process.exit(1);
}

console.log(`class-file purity: clean (${files.length} files scanned)`);
