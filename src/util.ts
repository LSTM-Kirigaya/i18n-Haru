import * as vscode from 'vscode';
import { currentTranslation, getDefaultI18nItem, GlobalConfig, I18nMapper, ImportConfig, ImportI18nMapper, updateAll, updateMapper } from './global';
import * as fs from 'fs';
import * as path from 'path';

import { franc } from 'franc';
import * as langs from 'langs';
import { t } from './i18n';
import { LlmName, translate } from './llm';
import { registerInlayHints } from './lsp/inlayHint';
import { saveJsonReplacer } from './parse';

export function detectLanguageISO(text: string): string {
    // 使用 franc 检测语言
    const languageCode = franc(text);

    // 如果检测到的语言代码为 'und'，表示无法确定语言
    if (languageCode === 'und') {
        return 'unknown';
    }

    // 使用 langs 获取 ISO 639-3 编码
    const language = langs.where('2', languageCode);

    if (language === undefined) {
        return 'unknown';
    }

    // 返回 ISO 639-3 编码
    return language[1] || 'unknown';
}


export async function extractUnfinishedItems(context: vscode.ExtensionContext, uri: vscode.Uri) {
    const i18nItem = findI18nItemByUri(uri);
    if (i18nItem) {
        // const unfinished = await vscode.window.withProgress({
        //     location: vscode.ProgressLocation.Notification,
        //     title: t('info.command.extract.get-unfinished-message.title')
        // }, async () => {
        //     const unfinished: Record<string, string> = {};
        //     for (const message of Object.keys(i18nItem.content)) {
        //         const messageContent = i18nItem.content[message] as string;

        //         // 当前的句子是否和当前的文件的 code 代表同一个语言
        //         let charWiseSame = false;
        //         for (const char of messageContent) {
        //             const code = detectLanguageISO(char);
        //             if (code === i18nItem.code) {
        //                 charWiseSame = true;
        //                 break;
        //             }
        //         }
        //         if (!charWiseSame) {
        //             charWiseSame = detectLanguageISO(messageContent) === i18nItem.code;
        //         }

        //         // 如果不是同一个语言，则需要翻译
        //         if (!charWiseSame) {
        //             console.log(message, messageContent, detectLanguageISO(messageContent));
        //             unfinished[message] = messageContent;
        //         }
        //     }
        //     return unfinished;
        // });


        // 创建一个临时的编辑器用于生成
        const tmpChangePath = path.join(context.extensionPath, 'i18n-Haru.json');
        fs.writeFileSync(tmpChangePath, '');
        const implChangeDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(tmpChangePath));
        await vscode.window.showTextDocument(implChangeDocument, {
            preview: false,
            viewColumn: vscode.ViewColumn.Beside
        });
        currentTranslation.implChangeDocument = implChangeDocument;
        currentTranslation.code = i18nItem.code;

    } else {
        vscode.window.showErrorMessage(t('error.command.extract.not-i18n-bundle'));
    }
}

function makeTranslationPrompt(code: string, unfinished: Record<string, string>) {
    const prompt = t('info.command.extract.translate-prompt', code) + '\n\n' + JSON.stringify(unfinished, null, '  ');
    return prompt;
}


function findI18nItemByUri(uri: vscode.Uri) {
    // 先找到 uri 对应的 i18n item
    for (const item of I18nMapper.values()) {
        if (item.file === uri.fsPath) {
            return item;
        }
    }
    return undefined;
}


export async function addI18nToken(context: vscode.ExtensionContext) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return; // 如果没有活动编辑器，则返回
    }

    const i18nItem = getDefaultI18nItem(GlobalConfig, I18nMapper);
    if (!i18nItem) {
        vscode.window.showErrorMessage(t('error.command.add-token.cannot-get-default-i18n-item'));
        return;
    }

    const selection = editor.selection;
    const selectedText = editor.document.getText(selection);

    // 获取选区的开始和结束位置
    const startPosition = selection.start;
    const endPosition = selection.end;

    // 检查选区的左侧和右侧是否存在引号
    const startLine = editor.document.lineAt(startPosition.line).text;
    const endLine = editor.document.lineAt(endPosition.line).text;

    const startQuote = findQuote(startLine, startPosition.character - 1, -1);
    const endQuote = findQuote(endLine, endPosition.character, 1);

    if (startQuote && endQuote) {
        // 扩展选区到引号的区域
        const newSelection = new vscode.Selection(
            startPosition.line, startQuote.index,
            endPosition.line, endQuote.index + 1
        );
        editor.selection = newSelection;
    }

    if (selectedText.length > 0) {
        const tokeName = await vscode.window.showInputBox({
            title: t('info.command.add-token.title'),
            placeHolder: 'level.module.name.[component]'
        });
        if (tokeName) {
            // 检验是否重复
            const allKeys = new Set(Object.keys(i18nItem.content));
            if (allKeys.has(tokeName)) {
                vscode.window.showErrorMessage(t('error.command.add-token.repeat-i18n-token'));
                return;
            }

            // 替换字符，支持无名参数和具名参数
            const quote = vscode.workspace.getConfiguration('i18n-haru').get('t-quote') || '\'';
            const { namedParamters, unamedParameters } = parseMessageParameters(selectedText);
            const translateArgs = [quote + tokeName + quote];
            for (const param of unamedParameters) {
                translateArgs.push('arg' + param.id)
            }
            if (namedParamters.length > 0) {
                const kwargs = namedParamters.map(param => param.name);
                translateArgs.push('{ ' + kwargs.join(', ') + ' }');
            }

            editor.edit(builder => builder.replace(editor.selection, `t(${translateArgs.join(', ')})`));

            // 使用翻译器进行翻译，如果有的话
            const translatorName = vscode.workspace.getConfiguration('i18n-haru').get<LlmName>('translator-name') || 'none';
            async function elegantTranslator(messageContent: string, translator: LlmName) {
                if (translator === 'none') {
                    // translator 为 none 时，实际不会引起阻塞
                    return await translate(messageContent, translator);
                } else {
                    return await vscode.window.withProgress({
                        title: t('info.command.add-token.use-translator', translator),
                        location: vscode.ProgressLocation.Window
                    }, async () => {
                        return await translate(messageContent, translator);
                    });
                }
            }
            
            const translateMessages = await elegantTranslator(selectedText, translatorName);
            if (translateMessages === undefined) {
                return;
            }

            // 把主语言也加入进去
            translateMessages[i18nItem.code] = selectedText;

            // 加载，写入，重新解析
            for (const [code, item] of I18nMapper.entries()) {
                const translation = translateMessages[code];
                item.content[tokeName] = translation;
                fs.writeFileSync(item.file, JSON.stringify(item.content, saveJsonReplacer, '    '));
            }

            await updateAll();
        }
    }
}

interface QuotePosition {
    index: number;
    quote: string;
}


function findQuote(line: string, start: number, direction: number): QuotePosition | null {
    const quotes = ['"', "'"];
    let index = start;

    while (index >= 0 && index < line.length) {
        const char = line[index];
        if (quotes.includes(char)) {
            return { index, quote: char };
        }
        index += direction;
    }

    return null;
}

export interface CustomIconPath {
    light: vscode.Uri
    dark: vscode.Uri
} 

export function getIconPath(context: vscode.ExtensionContext, name: string): CustomIconPath {
    const iconRoot = context.asAbsolutePath('icons');
    return {
        dark: vscode.Uri.file(path.join(iconRoot, 'dark', name + '.svg')),
        light: vscode.Uri.file(path.join(iconRoot, 'light', name + '.svg'))
    };
}

interface I18nQuickItem extends vscode.QuickPickItem {
    token: string
}

export async function deleteI18nToken(context: vscode.ExtensionContext) {
    const i18nItem = getDefaultI18nItem(GlobalConfig, I18nMapper);
    if (!i18nItem) {
        vscode.window.showErrorMessage(t('error.command.add-token.cannot-get-default-i18n-item'));
        return;
    }

    const quickItems: I18nQuickItem[] = [];
    for (const token of Object.keys(i18nItem.content)) {
        let content = i18nItem.content[token];
        quickItems.push({
            label: '$(i18n-icon) ' + token,
            token: token,
            detail: content
        });
    }

    const res = await vscode.window.showQuickPick(quickItems, {
        title: t('info.command.delete-token.title'),
        placeHolder: t('info.command.delete-token.placeholder')
    });
    
    if (res !== undefined) {
        for (const [_, item] of I18nMapper.entries()) {
            delete item.content[res.token];
            fs.writeFileSync(item.file, JSON.stringify(item.content, saveJsonReplacer, '    '));
        }
    }
}

export function isValidT(range: vscode.Range | undefined, document: vscode.TextDocument): boolean {
    if (range === undefined) {
        return false;
    }
    const start = range.start;
    if (start.character === 0) {
        return true;
    }
    const prevChar = document.lineAt(start.line).text[start.character - 1];
    if (prevChar === ' ' || prevChar === '$') {
        return true;
    }

    const prePos = new vscode.Position(start.line, start.character);    
    const preRange = document.getWordRangeAtPosition(prePos, /[a-zA-Z_][a-zA-Z0-9_]*/);
    
    if (!preRange) {
        return false;
    }
    const preWord = document.getText(preRange);    
    return preWord === 't';
}


export async function implChange(uri: vscode.Uri) {
    if (currentTranslation.code === '') {
        return;
    }
    // 将当前临时文件内的玩意儿覆盖进 i18n 文件
    const i18nItem = I18nMapper.get(currentTranslation.code);
    if (!i18nItem) {
        return;
    }
    
    if (currentTranslation.implChangeDocument) {
        const text = currentTranslation.implChangeDocument.getText();
        try {
            const json = JSON.parse(text) as Record<string, string>;
            for (const message of Object.keys(json)) {
                const translation = json[message] as string;
                i18nItem.content[message] = translation;
            }
            fs.writeFileSync(i18nItem.file, JSON.stringify(i18nItem.content, saveJsonReplacer, '  '));
        } catch (error) {
            vscode.window.showErrorMessage(t('error.command.impl-change.parse-json', `${error}`));
        }


        await vscode.window.showTextDocument(currentTranslation.implChangeDocument);
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }

    currentTranslation.code = '';
}

/**
 * @description 同步防抖 wrapper
 * @param fn 
 * @param timeout 
 * @returns 
 */
export function debouncWrapper<T>(fn: (...args: any[]) => T, timeout: number): (...args: any[]) => Promise<T> {
    let timer: NodeJS.Timeout | undefined = undefined;
    return function(...args: any[]): Promise<T> {
        return new Promise(resolve => {
            if (timer) {
                clearTimeout(timer);
            }
            timer = setTimeout(() => {
                resolve(fn(...args));
            }, timeout);
        });
    }
}

interface ParameterResult {
    unamedParameters: { id: number }[],
    namedParamters: { name: string }[]
};

export function parseMessageParameters(content: string): ParameterResult {
    const regex = /\{(.*?)\}/g;
    const unamedParameters = [];
    const namedParamters = [];
    
    for (const match of content.match(regex) || []) {
        const paramName = match.slice(1, -1);
        if (!isNaN(parseInt(paramName))) {
            const unameId = parseInt(paramName);
            unamedParameters.push({
                id: unameId
            });
        } else {
            namedParamters.push({
                name: paramName
            });
        }
    }
    return { namedParamters, unamedParameters };
}


/**
 * @description 从其他文件夹中导入 i18n message
 */
export async function importMessage(uri: vscode.Uri) {
    // 首先打开文件浏览器让用户选择导入源的文件夹（也就是其他项目的 i18n-haru.root）
    // 此处必须选择 .vscode/setting.json
    const res = await vscode.window.showOpenDialog({
        title: t('info.common.select-import-source'),
        openLabel: t('info.common.open'),
        canSelectFiles: true,
        canSelectMany: false,
        canSelectFolders: false,
        filters: {
            'settings.json': ['json']
        }
    });

    if (!res) {
        return;
    }

    const settingPath = res[0].fsPath;    
    // 确保路径有效性
    if (!settingPath.endsWith('settings.json')) {
        vscode.window.showErrorMessage(t('error.common.please-select-setting.json'));
        return;
    }

    const dotVscodePath = path.dirname(settingPath);    
    if (!dotVscodePath.endsWith('.vscode')) {
        vscode.window.showErrorMessage(t('error.common.please-select-setting.json'));
        return;
    }

    let root = 'i18n';
    let main = GlobalConfig.main;
    let display = GlobalConfig.display;
    let parseMode = GlobalConfig.parseMode;
    const configuration = new Map<string, any>();

    try {
        const settingJson = JSON.parse(fs.readFileSync(settingPath, { encoding: 'utf-8' }));
        root = settingJson['i18n-haru.root'] || root;
        main = settingJson['i18n-haru.main'] || main;
        display = settingJson['i18n-haru.display'] || display;
        parseMode = settingJson['i18n-haru.format'] || parseMode;
        if (settingJson['i18n-haru.custom-language-mapping']) {
            configuration.set('custom-language-mapping', settingJson['i18n-haru.custom-language-mapping']);
        }
    } catch (error) {
        vscode.window.showErrorMessage(t('error.common.cannot-parse-setting.json'));
        return;
    }

    const importPrjWorkspacePath = path.dirname(dotVscodePath);
    ImportConfig.workspacePath = importPrjWorkspacePath;

    root = path.resolve(importPrjWorkspacePath, root);
    ImportConfig.root = root;

    // ImportConfig 渲染配置直接默认和 Global 一致
    ImportConfig.main = main;
    ImportConfig.display = display;

    // TODO: 支持更多语言的适配
    ImportConfig.parseMode = GlobalConfig.parseMode;

    // 将外部 i18n mesage 载入 Import 映射器中
    await updateMapper(ImportConfig, ImportI18nMapper, configuration);

    // 让用户选择需要导入的 message
    const i18nItem = getDefaultI18nItem(ImportConfig, ImportI18nMapper);
    
    if (!i18nItem) {
        vscode.window.showErrorMessage(t('error.command.add-token.cannot-get-default-i18n-item'));
        return;
    }
    
    const quickItems: I18nQuickItem[] = [];
    for (const token of Object.keys(i18nItem.content)) {
        let content = i18nItem.content[token];
        quickItems.push({
            label: '$(i18n-icon) ' + token,
            token: token,
            detail: content
        });
    }

    const messages = await vscode.window.showQuickPick(quickItems, {
        title: t('info.common.import-i18n-message'),
        placeHolder: t('info.common.import-i18n-message.placeholder'),
        canPickMany: true,
        ignoreFocusOut: true
    });

    if (messages !== undefined) {
        // 遍历主映射器，更新并写入磁盘
        for (const [_, item] of I18nMapper.entries()) {
            // TODO: 支持选项来让用户决定是否要进行覆盖，现在默认不覆盖
            // 以当前项目为基准，多出的语言不管，少的语言默认按照导入源的 main 进行赋值
            const code = item.code;
            const sourceI18nItem = ImportI18nMapper.get(code) || i18nItem;
            for (const message of messages) {
                const importKey = message.token;
                if (item.content[importKey]) {
                    continue;
                }
                const importContent = sourceI18nItem.content[importKey] || '';
                item.content[importKey] = importContent;
            }

            fs.writeFileSync(item.file, JSON.stringify(item.content, saveJsonReplacer, '    '));
            // TODO: 添加功能，允许提醒用户是否需要自动完成缺失部分的翻译
            // 检查该功能的出现频次
        }
    }
}