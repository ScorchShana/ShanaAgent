import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

function imports(text: string): string[] {
  const source = ts.createSourceFile("boundary.ts", text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      found.push(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument)) found.push(argument.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

function sources(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sources(file) : entry.name.endsWith(".ts") ? [file] : [];
  });
}

it("checks static imports, reexports, dynamic imports and require", () => {
  expect(
    imports(
      `import type { TUI } from '../tui/framework/index.js'; export * from 'ink'; const view = import('react'); require('shana-tui');`,
    ),
  ).toEqual(["../tui/framework/index.js", "ink", "react", "shana-tui"]);
});

it("all Core modules remain independent of application and embedded TUI", () => {
  for (const file of sources(path.resolve("src/core"))) {
    const forbidden = imports(fs.readFileSync(file, "utf8")).filter((specifier) =>
      /^(?:react|ink|shana-tui)(?:\/|$)|(?:^|\/)tui(?:\/|$)/.test(specifier),
    );
    expect(forbidden, file).toEqual([]);
  }
});

it("embedded framework does not import application business modules", () => {
  for (const file of sources(path.resolve("src/tui/framework"))) {
    const forbidden = imports(fs.readFileSync(file, "utf8")).filter((specifier) =>
      /(?:^|\/)(?:core|sessions|llm|tools|security)(?:\/|$)/.test(specifier),
    );
    expect(forbidden, file).toEqual([]);
  }
});

it("application runtime stays independent of TUI and the TUI entry", () => {
  const file = path.resolve("src/application.ts");
  const forbidden = imports(fs.readFileSync(file, "utf8")).filter((specifier) =>
    /^(?:react|ink|shana-tui)(?:\/|$)|(?:^|\/)tui(?:\/|$)|(?:^|\/)main(?:\.js)?$/.test(specifier),
  );
  expect(forbidden, file).toEqual([]);
});
