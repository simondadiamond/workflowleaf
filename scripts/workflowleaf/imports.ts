/**
 * Pure import-boundary rules.
 *
 * `findImportViolations` takes already-read files so the same rules can run over
 * fixture text in tests and over the real tree in CI. It matches `import`,
 * `export ... from`, dynamic `import()` and `require()`, because a type-only
 * re-export leaks a dependency just as effectively as a value import.
 */

import type { ImportBoundary } from "./ownership.ts";

export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

export interface ImportViolation {
  readonly boundaryId: string;
  readonly path: string;
  readonly line: number;
  readonly offender: string;
  readonly message: string;
}

const SPECIFIER_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']/g,
  /\brequire\s*\(\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
];

export function extractSpecifiers(text: string): { specifier: string; line: number }[] {
  const found: { specifier: string; line: number }[] = [];

  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      const line = text.slice(0, match.index).split("\n").length;
      found.push({ specifier, line });
    }
  }

  return found.sort((left, right) => left.line - right.line);
}

function isTestFile(path: string): boolean {
  return path.endsWith(".test.ts") || path.includes("/test/") || path.includes("/fixtures/");
}

function isExempt(boundary: ImportBoundary, path: string): boolean {
  return (boundary.exemptPrefixes ?? []).some((prefix) => path.startsWith(prefix));
}

export function findImportViolations(
  boundaries: readonly ImportBoundary[],
  files: readonly SourceFile[],
): ImportViolation[] {
  const violations: ImportViolation[] = [];

  for (const boundary of boundaries) {
    const always = boundary.forbid ?? [];
    const sourceOnly = boundary.forbidInSource ?? [];
    const symbolsOnly = boundary.forbidSymbolsInSource ?? [];

    for (const file of files) {
      if (!file.path.startsWith(boundary.root)) continue;
      if (isExempt(boundary, file.path)) continue;

      const forbidden = isTestFile(file.path) ? always : [...always, ...sourceOnly];

      const allowed = new Set(boundary.allowSpecifiers ?? []);

      for (const { specifier, line } of extractSpecifiers(file.text)) {
        if (allowed.has(specifier)) continue;
        const offender = forbidden.find((needle) => specifier.startsWith(needle));
        if (offender === undefined) continue;
        violations.push({
          boundaryId: boundary.id,
          path: file.path,
          line,
          offender: specifier,
          message: boundary.reason,
        });
      }

      if (isTestFile(file.path)) continue;

      for (const symbol of symbolsOnly) {
        let index = file.text.indexOf(symbol);
        while (index !== -1) {
          violations.push({
            boundaryId: boundary.id,
            path: file.path,
            line: file.text.slice(0, index).split("\n").length,
            offender: symbol,
            message: boundary.reason,
          });
          index = file.text.indexOf(symbol, index + symbol.length);
        }
      }
    }
  }

  return violations;
}

export function formatImportReport(violations: readonly ImportViolation[]): string {
  if (violations.length === 0) return "workflowleaf imports: clean";
  const lines = violations.map(
    (violation) =>
      `  ${violation.path}:${violation.line}  ${violation.offender}  [${violation.boundaryId}]\n      ${violation.message}`,
  );
  return [`workflowleaf imports: ${violations.length} violation(s)`, ...lines].join("\n");
}
