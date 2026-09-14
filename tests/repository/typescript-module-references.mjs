import fs from "node:fs";
import ts from "typescript";

export function collectLiteralModuleReferences(filePath, content = fs.readFileSync(filePath, "utf8")) {
    const source = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
    const references = [];
    const addLiteral = (node, location = node) => {
        if (node === undefined || !ts.isStringLiteralLike(node)) return;
        references.push({
            specifier: node.text,
            line: source.getLineAndCharacterOfPosition(location.getStart(source)).line + 1,
        });
    };
    for (const reference of source.typeReferenceDirectives) {
        references.push({
            specifier: reference.fileName,
            line: source.getLineAndCharacterOfPosition(reference.pos).line + 1,
        });
    }
    const visit = (node) => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
            addLiteral(node.moduleSpecifier, node);
        } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
            addLiteral(node.argument.literal, node);
        } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
            addLiteral(node.moduleReference.expression, node);
        } else if (ts.isCallExpression(node)) {
            const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
            const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
            const isRequireResolve =
                ts.isPropertyAccessExpression(node.expression) &&
                ts.isIdentifier(node.expression.expression) &&
                node.expression.expression.text === "require" &&
                node.expression.name.text === "resolve";
            if (isRequire || isDynamicImport || isRequireResolve) {
                const argument = node.arguments[0];
                if (argument === undefined || !ts.isStringLiteralLike(argument)) {
                    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
                    throw new Error(`${filePath}:${line}: direct runtime module references must use a string literal`);
                }
                addLiteral(argument, node);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return Object.freeze(references);
}
