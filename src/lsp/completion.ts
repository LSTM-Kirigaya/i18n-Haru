import * as vscode from 'vscode';
import { defaultRange, getDefaultI18nItem, GlobalConfig, I18nMapper, lspLangSelectors } from '../global';
import { isValidT, parseMessageParameters } from '../util';
import { t } from '../i18n';
import { findTI18nCallAtColumn } from './tCallParse';

class I18nProvider implements vscode.CompletionItemProvider {
    public provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList<vscode.CompletionItem>> {
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

        const items: vscode.CompletionItem[] = [];
        const targetI18nKey = span.key;
        const i18nItem = getDefaultI18nItem(GlobalConfig, I18nMapper);
        if (!i18nItem) {
            return items;
        }

        const insertRange = new vscode.Range(
            new vscode.Position(position.line, span.keyQuoteOpen + 1),
            new vscode.Position(position.line, span.keyQuoteClose)
        );

        for (const i18nKey of Object.keys(i18nItem.content)) {
            if (!i18nKey.startsWith(targetI18nKey)) {
                continue;
            }

            const targetContent = i18nItem.content[i18nKey];
            const profile = makeI18nKeyProfile(i18nKey, targetContent);
            const markdown = new vscode.MarkdownString(profile, true);

            const completionItem: vscode.CompletionItem = {
                label: i18nKey,
                kind: vscode.CompletionItemKind.Value,
                detail: t('info.lsp.detail.key'),
                documentation: markdown,
                range: insertRange
            };
            items.push(completionItem);
        }

        return items;
    }
}


class I18nAllProvider implements vscode.CompletionItemProvider {
    public provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList<vscode.CompletionItem>> {
        const range = document.getWordRangeAtPosition(position, /t\(*\)/);
        if (!isValidT(range, document)) {
            return [];
        }

        const items: vscode.CompletionItem[] = [];
        
        const targetI18nKey = '';
        const i18nItem = getDefaultI18nItem(GlobalConfig, I18nMapper);
        if (!i18nItem) {
            return items;
        }
        
        for (const i18nKey of Object.keys(i18nItem.content)) {
            if (!i18nKey.startsWith(targetI18nKey)) {
                continue;
            }
            const targetContent = i18nItem.content[i18nKey];
            const profile = makeI18nKeyProfile(i18nKey, targetContent);
            const markdown = new vscode.MarkdownString(profile, true);
            const completionItem: vscode.CompletionItem = {
                label: '"' + i18nKey + '"',
                kind: vscode.CompletionItemKind.Value,
                detail: t('info.lsp.detail.key'),
                documentation: markdown
            };
            items.push(completionItem);
        }

        return items;
    }
}

export function makeI18nKeyProfile(i18nKey: string, targetContent: string): string {
    let profileContent = '';

    for (const [langCode, item] of I18nMapper.entries()) {
        let content = item.content[i18nKey];
        const uri = vscode.Uri.file(item.file);
        const range = item.keyRanges.get(i18nKey) || defaultRange;
        let gotoDefinition = `[${t('info.lsp.common.goto-definition')}](${uri}#L${range.start.line + 1}:${range.start.character + 1})`;
        if (content === undefined) {
            content = t('info.lsp.common.undefined');
        } else if (content.trim().length === 0) {
            content = t('info.lsp.common.empty');
        } else {
            content = '```plaintext\n' + content.trim() + '\n```';
        }

        profileContent += `$(globe) ${langCode} \t $(search) ${gotoDefinition}\n${content}\n`;
    }

    /// 支持含参数的 i18n 提醒
    /// 文档：https://document.kirigaya.cn/docs/i18n-haru/introduction.message.html#%E6%97%A0%E5%90%8D%E5%8F%82%E6%95%B0%E5%92%8C%E5%85%B7%E5%90%8D%E5%8F%82%E6%95%B0
    /// 无名参数 i18n
    /// "nice-dinner": "今天我们去了 {0} 吃了 {1} 这道菜，味道好极了"
    /// 调用方式： t("nice-dinner", name, mealName);
    /// 具名参数 i18n
    /// "nice-dinner": "今天我们去了 {name} 吃了 {mealName} 这道菜，味道好极了"
    /// 调用方式： t("nice-dinner", { name, mealName });
    /// 混合使用也是可以的：具体要看 i18n 框架是如何支持的
    let profile = '### I18n Key\n';
    const regex = /\{(.*?)\}/g;
    const { namedParamters, unamedParameters } = parseMessageParameters(targetContent);

    if (unamedParameters.length === 0 && namedParamters.length === 0) {
        profile += '```js\nt("' + i18nKey + '")\n```\n\n---\n\n';
    } else {
        const tList: string[] = ['"' + i18nKey + '"'];
        unamedParameters.forEach(param => tList.push('arg' + param.id));
        if (namedParamters.length > 0) {
            const nameParamString = `{ ${namedParamters.map(param => param.name).join(', ')} }`
            tList.push(nameParamString);
        }
        profile += '```js\nt(' + tList.join(', ') + ')\n```\n';
        profile += t('info.lsp.common.params-contain-info', unamedParameters.length.toString(), namedParamters.length.toString()) + '\n\n---\n\n';
    }

    return profile + profileContent;
}

export function registerCompletions(context: vscode.ExtensionContext) {
    const provider = new I18nProvider();
    vscode.languages.registerCompletionItemProvider(lspLangSelectors, provider);
    vscode.languages.registerCompletionItemProvider(lspLangSelectors, provider, '\'');
    vscode.languages.registerCompletionItemProvider(lspLangSelectors, provider, '\"');
    vscode.languages.registerCompletionItemProvider(lspLangSelectors, provider, '.');

    const allProvider = new I18nAllProvider();
    vscode.languages.registerCompletionItemProvider(lspLangSelectors, allProvider, '(');
}