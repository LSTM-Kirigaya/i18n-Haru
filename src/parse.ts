import * as vscode from 'vscode';
import { parseTree } from 'jsonc-parser';
import * as YAML from 'js-yaml';
import * as fs from 'fs';
import * as ts from 'typescript';

function cleanQuote(text: string): string {
    if (text.startsWith('"') || text.startsWith('\'')) {
        text = text.slice(1);
    }
    if (text.endsWith('"') || text.endsWith('\'')) {
        text = text.slice(0, -1);
    }
    return text;
}

/**
 * 递归收集嵌套对象，扁平为 dot key（如 route.dashboard），叶子为 object 则继续下钻，为 array 则跳过。
 */
function collectJsonI18nEntries(
    objectNode: any,
    jsonContent: string,
    document: vscode.TextDocument,
    keyPrefix: string,
    content: Record<string, string>,
    keyRanges: Map<string, vscode.Range>
): void {
    if (!objectNode.children) {
        return;
    }
    for (const property of objectNode.children) {
        if (property.type !== 'property') {
            continue;
        }
        const keyNode = property.children[0];
        const valueNode = property.children[1];

        let key = jsonContent.substring(keyNode.offset, keyNode.offset + keyNode.length);
        key = cleanQuote(key);
        const flatKey = keyPrefix.length > 0 ? `${keyPrefix}.${key}` : key;

        if (valueNode.type === 'object') {
            collectJsonI18nEntries(valueNode, jsonContent, document, flatKey, content, keyRanges);
        } else if (valueNode.type === 'array') {
            continue;
        } else {
            let value = jsonContent.substring(valueNode.offset, valueNode.offset + valueNode.length);
            value = cleanQuote(value);
            content[flatKey] = value;
            const startOffset = keyNode.offset as number;
            const startLength = keyNode.length as number;
            const startPos = document.positionAt(startOffset);
            const endPos = document.positionAt(startOffset + startLength);
            keyRanges.set(flatKey, new vscode.Range(startPos, endPos));
        }
    }
}

export interface ParseResult {
    content: Record<string, string>,
    keyRanges: Map<string, vscode.Range>
}

export async function parseJson(filepath: string): Promise<ParseResult> {
    const content: Record<string, string> = {};
    const keyRanges = new Map<string, vscode.Range>();
    // 构造 每一个 key 的 range，基于 vscode 的 API
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filepath));
    const jsonContent = document.getText();

    const jsonTree = parseTree(jsonContent);
    if (!jsonTree || jsonTree.type !== 'object') {
        vscode.window.showErrorMessage('Failed to parse JSON file or JSON is not a top-level object.');
        return { content, keyRanges };
    }

    collectJsonI18nEntries(jsonTree, jsonContent, document, '', content, keyRanges);

    return { content, keyRanges };
}

export async function parseYaml(filepath: string): Promise<ParseResult> {
    const filecontent = fs.readFileSync(filepath, { encoding: 'utf-8' });
    const content = YAML.load(filecontent) as Record<string, string>;
    const keyRanges = new Map<string, vscode.Range>();
    
    return { content, keyRanges };
}

function scriptKindForPath(filePath: string): ts.ScriptKind {
    const lower = filePath.toLowerCase();
    if (lower.endsWith('.tsx')) {
        return ts.ScriptKind.TSX;
    }
    if (lower.endsWith('.jsx')) {
        return ts.ScriptKind.JSX;
    }
    if (lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts')) {
        return ts.ScriptKind.TS;
    }
    return ts.ScriptKind.JS;
}

function unwrapToObjectLiteral(expr: ts.Expression): ts.ObjectLiteralExpression | undefined {
    let e: ts.Expression = expr;
    for (;;) {
        if (ts.isParenthesizedExpression(e)) {
            e = e.expression;
            continue;
        }
        if (ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) {
            e = e.expression;
            continue;
        }
        if (ts.isTypeAssertionExpression(e)) {
            e = e.expression;
            continue;
        }
        if (ts.isObjectLiteralExpression(e)) {
            return e;
        }
        return undefined;
    }
}

function findDefaultExportObjectLiteral(sourceFile: ts.SourceFile): ts.ObjectLiteralExpression | undefined {
    for (const stmt of sourceFile.statements) {
        if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
            return unwrapToObjectLiteral(stmt.expression);
        }
    }
    return undefined;
}

function getPropertyAssignmentKeyName(prop: ts.PropertyAssignment): string | undefined {
    const name = prop.name;
    if (ts.isIdentifier(name)) {
        return name.text;
    }
    if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
        return name.text;
    }
    if (ts.isComputedPropertyName(name)) {
        const expr = name.expression;
        if (ts.isStringLiteral(expr) || ts.isNumericLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
            return expr.text;
        }
        return undefined;
    }
    return undefined;
}

function initializerToLeafString(node: ts.Expression): string | undefined {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        return node.text;
    }
    if (ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)) {
        return node.text;
    }
    if (node.kind === ts.SyntaxKind.TrueKeyword) {
        return 'true';
    }
    if (node.kind === ts.SyntaxKind.FalseKeyword) {
        return 'false';
    }
    if (node.kind === ts.SyntaxKind.NullKeyword) {
        return 'null';
    }
    return undefined;
}

function tsNodeToVscodeRange(sourceFile: ts.SourceFile, node: ts.Node): vscode.Range {
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
    return new vscode.Range(
        new vscode.Position(start.line, start.character),
        new vscode.Position(end.line, end.character)
    );
}

function collectJsI18nEntries(
    obj: ts.ObjectLiteralExpression,
    sourceFile: ts.SourceFile,
    keyPrefix: string,
    content: Record<string, string>,
    keyRanges: Map<string, vscode.Range>
): void {
    for (const prop of obj.properties) {
        if (!ts.isPropertyAssignment(prop)) {
            continue;
        }
        const keyName = getPropertyAssignmentKeyName(prop);
        if (keyName === undefined) {
            continue;
        }
        const flatKey = keyPrefix.length > 0 ? `${keyPrefix}.${keyName}` : keyName;
        const init = prop.initializer;

        if (ts.isObjectLiteralExpression(init)) {
            collectJsI18nEntries(init, sourceFile, flatKey, content, keyRanges);
        } else if (ts.isArrayLiteralExpression(init)) {
            continue;
        } else {
            const value = initializerToLeafString(init);
            if (value === undefined) {
                continue;
            }
            content[flatKey] = value;
            keyRanges.set(flatKey, tsNodeToVscodeRange(sourceFile, prop.name));
        }
    }
}

/**
 * 解析 `export default { ... }` 的 JS/TS 模块，嵌套对象扁平为 dot key（如 route.dashboard）。
 * 仅支持字面量对象；动态表达式、非字面量叶子值会被跳过。
 */
export async function parseJsModule(filepath: string): Promise<ParseResult> {
    const content: Record<string, string> = {};
    const keyRanges = new Map<string, vscode.Range>();
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filepath));
    const text = document.getText();

    const sourceFile = ts.createSourceFile(filepath, text, ts.ScriptTarget.Latest, true, scriptKindForPath(filepath));
    const rootObj = findDefaultExportObjectLiteral(sourceFile);
    if (!rootObj) {
        vscode.window.showErrorMessage('Failed to parse JS module: no `export default { ... }` object literal found.');
        return { content, keyRanges };
    }

    collectJsI18nEntries(rootObj, sourceFile, '', content, keyRanges);
    return { content, keyRanges };
}

// 对于特殊字符的转义
export function saveJsonReplacer(key: string, value: any): any {
    if (typeof value === 'string') {
        return value
            .replace(/\\"/g, '"') // 将 \" 替换为 "
            .replace(/\\\\n/g, '\\n') // 将 \\n 替换为 \n
            .replace(/\\\\t/g, '\\t') // 将 \\t 替换为 \t
            .replace(/\\\\r/g, '\\r') // 将 \\r 替换为 \r
            .replace(/\\\\f/g, '\\f') // 将 \\f 替换为 \f
            .replace(/\\\\b/g, '\\b'); // 将 \\b 替换为 \b
    }
    return value;   
}