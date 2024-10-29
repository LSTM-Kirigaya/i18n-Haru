import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'js-yaml';
import { ISOCodeArray } from './i18n';
import { parseJson, ParseResult, parseYaml } from './parse';
import { OutgoingMessage } from 'http';

type IParseMode = 'json' | 'yaml'
export const defaultRange = new vscode.Range(
    new vscode.Position(0, 0),
    new vscode.Position(0, 0)
);

interface IGlobalConfig {
    root: string,
    main: string,
    display: string,
    parseMode: IParseMode
}

export const GlobalConfig: IGlobalConfig = {
    root: 'i18n',
    main: 'zh-cn',
    display: '',
    parseMode: 'json'
};

// 这里没有设计为 Map 是为了 JSON 的序列化和反序列化更加方便
type I18nText = Record<string, string>;

export interface I18nTextItem {
    file: string,
    code: string,
    content: I18nText,
    keyRanges: Map<string, vscode.Range>
}

export const I18nTextMap: Map<string, I18nTextItem> = new Map();

export async function updateAll() {
    const i18nSetting = vscode.workspace.getConfiguration('i18n-haru');
    let root = i18nSetting.get<string>('root', 'i18n');

    if (!path.isAbsolute(root) && vscode.workspace.workspaceFolders) {
        const workspacePath = vscode.workspace.workspaceFolders[0];
        root = path.resolve(workspacePath.uri.fsPath, root);
    } 

    GlobalConfig.root = root;
    let main = i18nSetting.get<string>('main') || 'zh-cn';
    
    if (main.toLowerCase() === 'zh') {
        main = 'zh-cn';
    }

    GlobalConfig.main = main.toLowerCase();

    GlobalConfig.display = i18nSetting.get<string>('display') || '';
    GlobalConfig.parseMode = i18nSetting.get<IParseMode>('lang') || 'json';

    await updateI18nFromRoot();
}

export async function initialise(context: vscode.ExtensionContext) {
    const workspaceFolders = vscode.workspace.workspaceFolders;

    if (workspaceFolders) {
        const workspaceFolder = workspaceFolders[0];
        const settingPath = path.join(workspaceFolder.uri.fsPath, '.vscode', 'settings.json');
        if (!fs.existsSync(settingPath)) {
            fs.writeFileSync(settingPath, JSON.stringify({}, null, '  '));
        }

        await updateAll();

        // 配置文件发生变化时
        vscode.workspace.onDidChangeConfiguration(async event => {
            if (event.affectsConfiguration('i18n-haru')) {
                await updateAll();
            }
        });


        // i18n 文件发生变化时，暂时不考虑 rename 的问题
        vscode.workspace.onDidChangeTextDocument(async event => {
            const filePath = event.document.uri.fsPath;
            const extname = path.extname(filePath).slice(1).toLowerCase();
            const parseSuffixs = getParseSuffix();
            if (parseSuffixs !== undefined && !parseSuffixs.includes(extname)) {
                return;
            }
            if (filePath.startsWith(GlobalConfig.root)) {
                // 在已有的数据结构中找到和这个路径一致的 item
                // 因为 i18n 文件数量绝对不会超过1000，所以直接 for 循环几乎不影响性能
                const items = [];
                for (const item of I18nTextMap.values()) {
                    if (item.file === filePath) {
                        items.push(item);
                        break;
                    }
                }

                const res = await parseFileByParseMode(filePath);
                
                if (items.length > 0 && res) {
                    const code = items[0].code;
                    I18nTextMap.set(code, {
                        code,
                        file: filePath,
                        content: res.content,
                        keyRanges: res.keyRanges
                    })
                }
            }
        })
    }
}

export async function configureI18nFolder(context: vscode.ExtensionContext) {
    const { t } = vscode.l10n;
    const res = await vscode.window.showOpenDialog({
        title: t('info.configure-i18n-folder.configure.title'),
        openLabel: t('info.configure-i18n-folder.configure.button'),
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false
    });

    if (!res) {
        return;
    }

    const targetFolder = res[0].fsPath;
    if (fs.existsSync(targetFolder)) {
        GlobalConfig.root = targetFolder;
        updateI18nFromRoot();
    }
}



async function parseFileByParseMode(filepath: string): Promise<ParseResult | undefined> {
    const filecontent = fs.readFileSync(filepath, { encoding: 'utf-8' });
    switch (GlobalConfig.parseMode) {
        case 'json':
            return await parseJson(filepath);

        case 'yaml':
            return await parseYaml(filepath);
    
        default:
            break;
    }
    return undefined;
}


const ZH_CN_SAME_NAME = new Set(['zh', 'zh-cn', 'zh-hans']);
const ZH_TW_SAME_NAME = new Set(['zh-tw', 'zh-hk', 'zh-sg', 'zh-hant']);
function getISO639Code(filename: string) {
    const lowerFilename = filename.toLowerCase();

    for (const iso of ISOCodeArray) {
        if (lowerFilename.includes(iso.code)) {            
            if (ZH_CN_SAME_NAME.has(iso.code)) {
                return { code: "zh-cn",    name: "中文" };
            }
            if (ZH_TW_SAME_NAME.has(iso.code)) {
                return { code: "zh-tw",    name: "繁体中文" };
            }
            return iso;
        }
    }
    return undefined;
}

function getParseSuffix() {
    switch (GlobalConfig.parseMode) {
        case 'json':
            return ['json'];
        case 'yaml':
            return ['yaml', 'yml'];
        default:
            break;
    }
}

function longestCommonPrefix(strs: string[]): string {
    if (strs.length === 0) {
        return '';
    }

    let prefix = strs[0];
    for (let i = 1; i < strs.length; i++) {
        while (strs[i].indexOf(prefix) !== 0) {
            prefix = prefix.slice(0, prefix.length - 1);
            if (prefix === '') {
                return '';
            }
        }
    }

    return prefix;
}

async function updateI18nFromRoot() {
    const { t } = vscode.l10n;
    const root = GlobalConfig.root;
    if (!fs.existsSync(root)) {
        return;
    }

    const parseSuffixs = getParseSuffix();
    const i18nFiles: string[] = [];
    for (const file of fs.readdirSync(root)) {
        let extname = file.split('.').at(-1);
        if (extname === undefined) {
            continue;
        }
        if (parseSuffixs !== undefined && !parseSuffixs.includes(extname.toLowerCase())) {
            continue;   
        }
        i18nFiles.push(file);
    }

    // 去除公共前缀和后缀
    const prefix = longestCommonPrefix(i18nFiles);

    for (const file of i18nFiles) {
        let validFileString = file.slice(prefix.length);
        const extname = file.split('.').at(-1);
        if (extname === undefined || extname.length === 0) {
            continue;
        }

        validFileString = validFileString.slice(0, - (extname.length + 1));
        
        const iso = getISO639Code(validFileString);        
        if (iso === undefined) {
            vscode.window.showWarningMessage(t('warning.update-i18n.cannot-find-iso.window') + ' ' + file);
            continue;
        }
        const filePath = path.join(root, file);
        const res = await parseFileByParseMode(filePath);

        if (res) {
            I18nTextMap.set(iso.code, {
                code: iso.code,
                file: filePath,
                content: res.content,
                keyRanges: res.keyRanges
            });
        }
    }
}


let remindUserErrorMain: boolean = false;

function getFirstOneI18nItem() {
    for (const item of I18nTextMap.values()) {
        return item;
    }
    return undefined;
}

export function getDefaultI18nItem() {
    // 调用这个函数的时候，比如 inlay hints，初始化还未完成，所以需要额外手动赋值一次 main
    const i18nSetting = vscode.workspace.getConfiguration('i18n-haru');
    let main = i18nSetting.get<string>('main') || 'zh-cn';
    
    if (main.toLowerCase() === 'zh') {
        main = 'zh-cn';
    }
    GlobalConfig.main = main.toLowerCase();

    const item = I18nTextMap.get(main);
    
    if (item === undefined) {
        const { t } = vscode.l10n;
        const firstOne = getFirstOneI18nItem();
        if (firstOne === undefined) {
            return undefined;
        }
        if (remindUserErrorMain === false) {
            vscode.window.showWarningMessage(t('warning.lsp.get-main.cannot-find-main-use-replacer-instead') + ' ' + firstOne.code);
            remindUserErrorMain = true;
        }
        return firstOne;
    } else {
        return item;
    }
}

export const lspLangSelectors: vscode.DocumentFilter[] = [
    {
        language: 'typescript',
        scheme: 'file'
    },
    {
        language: 'vue',
        scheme: 'file'
    },
    {
        language: 'javascript',
        scheme: 'file'
    },
    {
        language: 'html',
        scheme: 'file'
    },
    {
        language: 'php',
        scheme: 'file'
    },
    {
        language: 'json',
        scheme: 'file'
    },
    {
        language: 'yaml',
        scheme: 'file'
    }
];