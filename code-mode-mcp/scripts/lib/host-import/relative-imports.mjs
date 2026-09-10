import { parse } from "@babel/parser";

function literalValue(node) {
  if (node?.type === "StringLiteral") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0]?.value.cooked;
  return null;
}

/** Read literal JavaScript/TypeScript imports without evaluating source code. */
export function relativeImports(source) {
  let ast;
  // JSX and angle-bracket TypeScript assertions are ambiguous; try both grammars.
  for (const plugins of [["typescript", "jsx", "decorators-legacy"], ["typescript", "decorators-legacy"]]) {
    try {
      ast = parse(source, {
        sourceType: "unambiguous", plugins, attachComment: false,
        createImportExpressions: true, errorRecovery: true,
        allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true,
      });
      break;
    } catch { /* try the other grammar; incomplete/unsupported source stays unprobed */ }
  }
  if (!ast) return [];
  const imports = [];
  const pending = [ast.program];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== "object" || typeof node.type !== "string") continue;
    let value;
    let commonjs = false;
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) && node.importKind !== "type" && node.exportKind !== "type") {
      value = literalValue(node.source);
    } else if (node.type === "ImportExpression") {
      value = literalValue(node.source);
    } else if (["CallExpression", "OptionalCallExpression"].includes(node.type) && node.callee?.type === "Identifier" && node.callee.name === "require") {
      value = literalValue(node.arguments[0]);
      commonjs = true;
    } else if (node.type === "TSImportEqualsDeclaration" && node.importKind !== "type" && node.moduleReference?.type === "TSExternalModuleReference") {
      value = literalValue(node.moduleReference.expression);
      commonjs = true;
    }
    if (typeof value === "string" && (value === "." || value === ".." || value.startsWith("./") || value.startsWith("../"))) {
      imports.push({ specifier: value, commonjs, start: node.start });
    }
    for (const [key, value] of Object.entries(node)) {
      if (["loc", "extra", "comments", "errors", "tokens"].includes(key)) continue;
      if (Array.isArray(value)) for (const child of value) pending.push(child);
      else if (value && typeof value === "object") pending.push(value);
    }
  }
  return imports.sort((a, b) => a.start - b.start).slice(0, 16);
}
