import * as vscode from 'vscode';
import { getDisplayI18nItem, GlobalConfig, I18nMapper, I18nTextItem, lspLangSelectors } from '../global';
import { makeI18nKeyProfile } from './completion';
import { isValidT } from '../util';
import { t } from '../i18n';
import { parseTI18nCallsInLine } from './tCallParse';

class I18nProvider implements vscode.InlayHintsProvider {
    public provideInlayHints(document: vscode.TextDocument, range: vscode.Range, token: vscode.CancellationToken): vscode.ProviderResult<vscode.InlayHint[]> {
        // 优化一下，直接解析激活视图可见区域的部分
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor || activeEditor.document.uri.fsPath !== document.uri.fsPath) {
            return undefined;
        }
        
        const visibleRange = activeEditor.visibleRanges[0];
        const inlayHints: vscode.InlayHint[] = [];
        const i18nItem = getDisplayI18nItem(GlobalConfig, I18nMapper);
        
        if (!i18nItem) {
            return undefined;
        }
        
        // -+ visibleMargin 稍微优化一下加载
        const visibleMargin = 10;
        const lineStart = Math.max(visibleRange.start.line - visibleMargin, 0);
        const lineEnd = Math.min(visibleRange.end.line + visibleMargin, document.lineCount - 1); 
        const maxHintLength = vscode.workspace.getConfiguration('i18n-haru').get<number>('line-hint-max-length') || 10;

        for (let line = lineStart; line <= lineEnd; ++ line) {            
            const lineText = document.lineAt(line).text;

            if (lineText.trim().length === 0) {
                continue;
            }
            const hints = makeLineTextHint(document, line, lineText, i18nItem, maxHintLength);
            if (hints.length > 0) {
                inlayHints.push(...hints);                    
            }
        }
                
        return inlayHints;
    }
}


interface MatchResult {
    match: string;
    column: number;
}

function findMatchingStrings(
    document: vscode.TextDocument,
    line: number,
    lineText: string
): MatchResult[] {
    const matches: MatchResult[] = [];
    for (const span of parseTI18nCallsInLine(lineText)) {
        const tPos = new vscode.Position(line, span.tCharOffset);
        const range = new vscode.Range(tPos, tPos);
        if (!isValidT(range, document)) {
            continue;
        }
        matches.push({ match: span.key, column: span.keyQuoteClose + 1 });
    }
    return matches;
}

function makeLineTextHint(
    document: vscode.TextDocument,
    line: number,
    lineText: string,
    i18nItem: I18nTextItem,
    maxHintLength: number
): vscode.InlayHint[] {
    const hints: vscode.InlayHint[] = [];
    const matches = findMatchingStrings(document, line, lineText);
    
    for (const match of matches) {
        const targetI18nKey = match.match;
        let content = i18nItem.content[targetI18nKey];        
        
        if (content === undefined) {
            content = t('info.lsp.common.undefined');
        } else if (content.trim().length === 0) {
            content = t('info.lsp.common.empty');
        } else {
            content = content.trim();
        }        

        if (content.length > maxHintLength) {
            content = content.slice(0, maxHintLength) + '...';
        }

        const pos = new vscode.Position(line, match.column);
        const hint = new vscode.InlayHint(pos, content, vscode.InlayHintKind.Type);

        const targetContent = i18nItem.content[targetI18nKey];
        const profile = targetContent === undefined ? content : makeI18nKeyProfile(targetI18nKey, targetContent);
        const markdown = new vscode.MarkdownString(profile, true);
        hint.tooltip = markdown;
        hint.paddingLeft = true;
        hint.paddingRight = true;        
        hints.push(hint);
    }
    
    return hints;
}


export function registerInlayHints(context: vscode.ExtensionContext) {
    const provider = new I18nProvider();
    vscode.languages.registerInlayHintsProvider(lspLangSelectors, provider);
}
