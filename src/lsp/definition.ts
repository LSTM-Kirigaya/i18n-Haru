import * as vscode from 'vscode';
import { defaultRange, getDefaultI18nItem, GlobalConfig, I18nMapper, lspLangSelectors } from '../global';
import { isValidT } from '../util';
import { findTI18nCallAtColumn, spanToKeyWithQuotesRange } from './tCallParse';

class I18nProvider implements vscode.DefinitionProvider {
    public provideDefinition(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Definition | vscode.DefinitionLink[]> {
        const lineText = document.lineAt(position.line).text;
        const span = findTI18nCallAtColumn(lineText, position.character);
        if (!span) {
            return [];
        }
        const tPos = new vscode.Position(position.line, span.tCharOffset);
        const tRange = new vscode.Range(tPos, tPos);
        if (!isValidT(tRange, document)) {
            return [];
        }

        const targetI18nKey = span.key;
        const links: vscode.DefinitionLink[] = [];
        const i18nItem = getDefaultI18nItem(GlobalConfig, I18nMapper);
        if (!i18nItem) {
            return links;
        }

        const originSelectionRange = spanToKeyWithQuotesRange(position.line, span);

        const link: vscode.DefinitionLink = {
            originSelectionRange,
            targetUri: vscode.Uri.file(i18nItem.file),
            targetRange: i18nItem.keyRanges.get(targetI18nKey) || defaultRange
        };

        links.push(link);
        return links;
    }
}

export function registerDefinition(context: vscode.ExtensionContext) {
    const provider = new I18nProvider();
    vscode.languages.registerDefinitionProvider(lspLangSelectors, provider);
}