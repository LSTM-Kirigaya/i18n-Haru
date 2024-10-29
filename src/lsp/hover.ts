import * as vscode from 'vscode';
import { defaultRange, getDefaultI18nItem, lspLangSelectors } from '../global';
import { makeI18nKeyProfile } from './completion';

class I18nProvider implements vscode.HoverProvider {
    public provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Hover> {
        const range = document.getWordRangeAtPosition(position, /t\(["'][^"']*["']\)/);
        if (range === undefined) {
            return undefined;
        }
        const targetExpression = document.getText(range);
        const match = /t\(["']([^"']*)["']\)/.exec(targetExpression);

        const links: vscode.DefinitionLink[] = [];
        if (match && match[1] !== undefined) {
            const targetI18nKey = match[1];
            
            const i18nItem = getDefaultI18nItem();
            if (!i18nItem) {
                return undefined;
            }
            const originSelectionRange = document.getWordRangeAtPosition(position, /["'][^"']*["']/);

            const profile = makeI18nKeyProfile(targetI18nKey);
            const markdown = new vscode.MarkdownString(profile, true);
            const hover = new vscode.Hover(markdown, originSelectionRange);
            return hover;
        }

        return undefined;
    }
}

export function registerHover(context: vscode.ExtensionContext) {
    const provider = new I18nProvider();
    vscode.languages.registerHoverProvider(lspLangSelectors, provider);
}