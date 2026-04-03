import * as vscode from 'vscode';
import { getDefaultI18nItem, GlobalConfig, I18nMapper, lspLangSelectors } from '../global';
import { makeI18nKeyProfile } from './completion';
import { isValidT } from '../util';
import { findTI18nCallAtColumn, spanToKeyWithQuotesRange } from './tCallParse';

class I18nProvider implements vscode.HoverProvider {
    public provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Hover> {
        const lineText = document.lineAt(position.line).text;
        const span = findTI18nCallAtColumn(lineText, position.character);
        if (!span) {
            return undefined;
        }
        const tPos = new vscode.Position(position.line, span.tCharOffset);
        const tRange = new vscode.Range(tPos, tPos);
        if (!isValidT(tRange, document)) {
            return undefined;
        }

        const targetI18nKey = span.key;
            
        const i18nItem = getDefaultI18nItem(GlobalConfig, I18nMapper);
        if (!i18nItem) {
            return undefined;
        }
        const originSelectionRange = spanToKeyWithQuotesRange(position.line, span);

        const targetContent = i18nItem.content[targetI18nKey];
        const profile = makeI18nKeyProfile(targetI18nKey, targetContent);
        const markdown = new vscode.MarkdownString(profile, true);
        const hover = new vscode.Hover(markdown, originSelectionRange);
        return hover;
    }
}

export function registerHover(context: vscode.ExtensionContext) {
    const provider = new I18nProvider();
    vscode.languages.registerHoverProvider(lspLangSelectors, provider);
}