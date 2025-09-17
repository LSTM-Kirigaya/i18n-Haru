import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'js-yaml';
import { ISOCodeArray, t, ValidISOCode } from './i18n';
import { parseJson, ParseResult, parseYaml } from './parse';
import { OutgoingMessage } from 'http';
import { jsonSuggestor } from './lsp/diagnostics';

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
    workspacePath: string
}

export const GlobalConfig: IGlobalConfig = {
    root: 'i18n',
    main: 'zh-cn',
    display: '',
    parseMode: 'json',
    workspacePath: ''
};

// 这里没有设计为 Map 是为了 JSON 的序列化和反序列化更加方便
type I18nText = Record<string, string>;

export interface I18nTextItem {
    file: string,
    code: string,
    content: I18nText,
    keyRanges: Map<string, vscode.Range>
}

/**
 * @description 用于管理全局 i18n message 的数据结构，key 为 ISO code
 */
export const I18nMapper: Map<string, I18nTextItem> = new Map();


// 用于 import 功能的中间变量
export const ImportConfig: IGlobalConfig = {
    root: 'i18n',
    main: 'zh-cn',
    display: '',
    parseMode: 'json',
    workspacePath: ''
}

export const ImportI18nMapper: Map<string, I18nTextItem> = new Map();


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

    let display = i18nSetting.get<string>('display') || '';
    if (display.length === 0) {
        display = main;
    }
    GlobalConfig.display = display;

    // TODO: 支持更多语言的适配
    GlobalConfig.parseMode = i18nSetting.get<IParseMode>('lang') || 'json';
    const configuration = vscode.workspace.getConfiguration('i18n-haru');
    await updateMapper(GlobalConfig, I18nMapper, configuration);
}

export async function initialise(context: vscode.ExtensionContext) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
        const workspaceFolder = workspaceFolders[0];
        GlobalConfig.workspacePath = workspaceFolder.uri.fsPath;
        const dotVscode = path.join(workspaceFolder.uri.fsPath, '.vscode');
        if (!fs.existsSync(dotVscode)) {
            fs.mkdirSync(dotVscode, { recursive: true });
        }
        const settingPath = path.join(workspaceFolder.uri.fsPath, '.vscode', 'settings.json');
        if (!fs.existsSync(settingPath)) {
            fs.writeFileSync(settingPath, JSON.stringify({}, null, '    '));
        }

        await updateAll();

        // 初始化 诊断器
        for (const [_, item] of I18nMapper.entries()) {
            await jsonSuggestor.lint(item.file);
        }

        // 配置文件发生变化时
        vscode.workspace.onDidChangeConfiguration(async event => {
            
            if (event.affectsConfiguration('i18n-haru')) {
                await updateAll();
            }
        });

        // 重命名
        vscode.workspace.onDidRenameFiles(async event => {
            const newEvent = { files: event.files.map(file => file.oldUri) };
            const i18nRootFiles = getI18nFilesFromEvent(newEvent);
            if (i18nRootFiles.length > 0) {
                await updateAll();
            }
        });

        // i18n 文件发生新增时
        vscode.workspace.onDidCreateFiles(async event => {
            const i18nRootFiles = getI18nFilesFromEvent(event);
            if (i18nRootFiles.length === 0) {
                return;
            }

            const i18nFiles: string[] = [];
            const parseSuffixs = getParseSuffix(GlobalConfig);

            for (const file of fs.readdirSync(GlobalConfig.root)) {
                let extname = file.split('.').at(-1);
                if (extname === undefined) {
                    continue;
                }
                if (parseSuffixs !== undefined && !parseSuffixs.includes(extname.toLowerCase())) {
                    continue;   
                }
                i18nFiles.push(file);
            }

            // 从计算得到的映射中读取 i18n 配置并载入全局变量
            const i18nSetting = vscode.workspace.getConfiguration('i18n-haru');
            const customMapping: Record<string, string> = clearCustomMapping(i18nSetting.get('custom-language-mapping'));

            // 去除公共前缀和后缀
            const prefix = await vscode.window.withProgress({
                title: t('info.update-i18n.make-prefix.title'),
                location: vscode.ProgressLocation.Window
            }, async (progress: vscode.Progress<{ message: string, increment: number }>, token: vscode.CancellationToken) => {
                return longestCommonPrefix(i18nFiles);
            });


            for (const file of i18nRootFiles) {
                const filename = path.basename(file);
                const i18nTextItem = await makeI18nTextItem(filename, prefix, customMapping, GlobalConfig);
                if (i18nTextItem) {
                    I18nMapper.set(i18nTextItem.code, i18nTextItem);
                }
            }
        });

        // i18n 文件删除时
        vscode.workspace.onDidDeleteFiles(async event => {
            const i18nRootFiles = getI18nFilesFromEvent(event);

            if (i18nRootFiles.length === 0) {
                return;
            }

            const i18nRootFilesSet = new Set<string>(i18nRootFiles);

            const deleteCodes = [];
            for (const [code, item] of I18nMapper.entries()) {
                if (i18nRootFilesSet.has(item.file)) {
                    deleteCodes.push(code);
                }
            }
            deleteCodes.forEach(code => I18nMapper.delete(code));
        });

        // i18n 文件发生变化时，暂时不考虑 rename 的问题
        vscode.workspace.onDidChangeTextDocument(async event => {
            const filePath = event.document.uri.fsPath;
            if (filePath.startsWith(GlobalConfig.root)) {
                const extname = path.extname(filePath).slice(1).toLowerCase();
                const parseSuffixs = getParseSuffix(GlobalConfig);
                if (parseSuffixs !== undefined && !parseSuffixs.includes(extname)) {
                    return;
                }
                // 在已有的数据结构中找到和这个路径一致的 item
                // 因为 i18n 文件数量绝对不会超过1000，所以直接 for 循环几乎不影响性能
                const items = [];
                for (const item of I18nMapper.values()) {
                    if (item.file === filePath) {
                        items.push(item);
                        break;
                    }
                }

                const res = await parseFileByParseMode(filePath, GlobalConfig);
                
                if (items.length > 0 && res) {
                    const code = items[0].code;
                    I18nMapper.set(code, {
                        code,
                        file: filePath,
                        content: res.content,
                        keyRanges: res.keyRanges
                    });
                    
                    // 诊断
                    if (code === GlobalConfig.main) {
                        // 主语言需要刷新所有的 code
                        for (const [_, item] of I18nMapper.entries()) {
                            await jsonSuggestor.lint(item.file);
                        }
                    } else {
                        // 非主语言只需要刷新自己
                        await jsonSuggestor.lint(filePath);
                    }
                }
            }
        });

        // 打开文件
        vscode.workspace.onDidOpenTextDocument(async document => {
            const filepath = document.uri.fsPath;
            if (filepath.startsWith(GlobalConfig.root)) {
                await jsonSuggestor.lint(filepath);
            }
        });

        // 切换活动区域
        vscode.window.onDidChangeActiveTextEditor(async editor => {
            if (editor?.document) {
                const filepath = editor.document.uri.fsPath;
                if (filepath.startsWith(GlobalConfig.root)) {
                    await jsonSuggestor.lint(filepath);
                }
            }
        })
    }
}

export async function configureI18nFolder(context: vscode.ExtensionContext) {
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
        const configuration = vscode.workspace.getConfiguration('i18n-haru');

        updateMapper(GlobalConfig, I18nMapper, configuration);

        const settingPath = path.join(GlobalConfig.workspacePath, '.vscode', 'settings.json');
        const originSetting = JSON.parse(fs.readFileSync(settingPath, { encoding: 'utf-8' }));
        let root = targetFolder.replace(GlobalConfig.workspacePath, '');
        if (root.startsWith('/') || root.startsWith('\\')) {
            root = root.slice(1);
        }
        originSetting["i18n-haru.root"] = root;
        fs.writeFileSync(settingPath, JSON.stringify(originSetting, null, '  '));
    }
}



async function parseFileByParseMode(
    filepath: string,
    config: IGlobalConfig
): Promise<ParseResult | undefined> {
    const filecontent = fs.readFileSync(filepath, { encoding: 'utf-8' });
    switch (config.parseMode) {
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

function getParseSuffix(config: IGlobalConfig) {
    switch (config.parseMode) {
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

export interface IConfigurationLike {
    get<T>(section: string): T | undefined;
	get<T>(section: string, defaultValue: T): T;
}

/**
 * @description 根据输入的配置文件进行 IO 并更新映射器
 * @param config 
 * @param mapper 
 * @returns 
 */
export async function updateMapper(
    config: IGlobalConfig,
    mapper: Map<string, I18nTextItem>,
    configuration: IConfigurationLike
) {
    const root = config.root;
    if (!fs.existsSync(root)) {
        return;
    }

    const parseSuffixs = getParseSuffix(config);

    // 得到所有的 i18n 配置文件，必须是 i18n-haru.lang 中设置的后缀，默认为 json
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
    const prefix = await vscode.window.withProgress({
        title: t('info.update-i18n.make-prefix.title'),
        location: vscode.ProgressLocation.Window
    }, async (progress: vscode.Progress<{ message: string, increment: number }>, token: vscode.CancellationToken) => {
        return longestCommonPrefix(i18nFiles);
    });

    // 从计算得到的映射中读取 i18n 配置并载入全局变量
    const customMapping: Record<string, string> = clearCustomMapping(configuration.get('custom-language-mapping'));

    const _ = await vscode.window.withProgress({
        title: t('info.update-i18n.parse-iso.title'),
        location: vscode.ProgressLocation.Window
    }, async (progress: vscode.Progress<{ message: string, increment: number }>, token: vscode.CancellationToken) => {
        for (const file of i18nFiles) {
            const i18nTextItem = await makeI18nTextItem(file, prefix, customMapping, config);
            if (i18nTextItem && i18nTextItem.code.length > 0) {
                mapper.set(i18nTextItem.code, i18nTextItem);
            }
        }

        // 如果用户设置了 i18n-haru.custom-language-mapping，使用设置的映射去尝试覆盖
        for (const code of Object.keys(customMapping)) {
            try {
                const customPath = customMapping[code];
                const realCode = code === 'zh' ? 'zh-cn' : code;
                const res = await parseFileByParseMode(customPath, config);
                if (res) {
                    mapper.set(realCode, {
                        code: realCode,
                        file: customPath,
                        content: res.content,
                        keyRanges: res.keyRanges
                    });
                } else {
                    throw Error("parseFileByParseMode 解析错误");
                }
            } catch (error) {
                const errorMessage = t('error.parse-custom-mapping.parse-error') + error;
                vscode.window.showErrorMessage(errorMessage);
            }
        }
    });
}

/**
 * @description 检查自定义映射的类型并且将所有的非绝对路径转换为绝对路径
 * @param customMapping 
 * @returns 
 */
function clearCustomMapping(customMapping?: Record<string, any>): Record<string, string> {
    if (typeof customMapping !== 'object') {
        return {};
    }
    const mapping: Record<string, string> = {};
    for (const code of Object.keys(customMapping)) {
        const configPath = customMapping[code];
        if (typeof code !== 'string' || typeof configPath !== 'string') {
            return {};
        }
        if (!ValidISOCode.has(code) && code !== 'zh') {
            const allcodes = new Array(ValidISOCode);
            vscode.window.showWarningMessage(t('warn.not-valid-iso639-code', code, allcodes.join(',')));
            continue;
        }
        if (!path.isAbsolute(configPath)) {
            // 根据当前的项目根目录为路径进行拼凑
            const absPath = path.resolve(GlobalConfig.workspacePath, configPath);          
            mapping[code] = absPath;
        } else {
            mapping[code] = configPath;
        }
    }

    return mapping;
}


let remindUserErrorMain: boolean = false;

function getFirstOneI18nItem(mapper: Map<string, I18nTextItem>) {
    for (const item of mapper.values()) {
        return item;
    }
    
    return undefined;
}

/**
 * 
 * @param filename 文件名
 * @param prefix 公共前缀
 * @returns 
 */
async function makeI18nTextItem(
    filename: string,
    prefix: string,
    customMapping: Record<string, string>,
    config: IGlobalConfig
): Promise<I18nTextItem | undefined> {
    let validFileString = filename.slice(prefix.length);
    const filePath = path.join(config.root, filename);

    const extname = filename.split('.').at(-1);
    if (extname === undefined || extname.length === 0) {
        return undefined;
    }
    
    validFileString = validFileString.slice(0, - (extname.length + 1));
    
    const iso = getISO639Code(validFileString);
    if (iso === undefined) {
        // 查看当前文件是否在自定义映射中
        const normalizedFilePath = path.normalize(filePath);
        const inPath = Object.values(customMapping).filter(customPath => path.normalize(customPath) === normalizedFilePath);
        console.log(customMapping);
        console.log([filePath]);
        console.log(inPath);
        if (inPath.length === 0) {
            const warningMessage = t('warn.update-i18n.iso-639-not-found', filename);
            const suggestMessage = t('info.config.custom-language-mapping');
            const res = await vscode.window.showWarningMessage(warningMessage + ' ' + suggestMessage,
                { title: t('info.lookup-document'), value: true }
            );
            if (res?.value) {
                vscode.env.openExternal(vscode.Uri.parse('https://document.kirigaya.cn/docs/i18n-haru/config.custom-iso639.html#自定义【语言-配置文件】映射关系'));
            }
        }
        return undefined;
    }
    const res = await parseFileByParseMode(filePath, config);

    if (res) {
        return {
            code: iso.code,
            file: filePath,
            content: res.content,
            keyRanges: res.keyRanges
        }
    }
    return undefined
}

/**
 * @description 输入文件变动事件，返回所有变动文件中存在于 i18n-haru.root 下的文件
 * @param event 
 * @returns 
 */
function getI18nFilesFromEvent(event: { files: readonly vscode.Uri[] }) {
    const i18nRootFiles = [];
    for (const file of event.files) {
        if (file.fsPath.startsWith(GlobalConfig.root)) {
            const extname = path.extname(file.fsPath).slice(1).toLowerCase();
            const parseSuffixs = getParseSuffix(GlobalConfig);
            if (parseSuffixs !== undefined && !parseSuffixs.includes(extname)) {
                continue;
            }
            i18nRootFiles.push(file.fsPath);
        }
    }
    return i18nRootFiles;
}

/**
 * @description 从映射器中获取默认语言对应的 i18n
 * @returns 
 */
export function getDefaultI18nItem(config: IGlobalConfig, mapper: Map<string, I18nTextItem>) {
    // 调用这个函数的时候，比如 inlay hints，初始化还未完成，所以需要额外手动赋值一次 main
    const i18nSetting = vscode.workspace.getConfiguration('i18n-haru');
    let main = i18nSetting.get<string>('main') || 'zh-cn';
    
    if (main.toLowerCase() === 'zh') {
        main = 'zh-cn';
    }    
    config.main = main.toLowerCase();
    const item = mapper.get(main);
    
    if (item === undefined) {

        const firstOne = getFirstOneI18nItem(mapper);
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

/**
 * @description 从映射器中获取默认用于渲染文本的语言对应的 i18n
 * @returns 
 */
export function getDisplayI18nItem(config: IGlobalConfig, mapper: Map<string, I18nTextItem>) {
    // 调用这个函数的时候，比如 inlay hints，初始化还未完成，所以需要额外手动赋值一次 main
    const i18nSetting = vscode.workspace.getConfiguration('i18n-haru');
    let display = i18nSetting.get<string>('display') || 'zh-cn';
    
    if (display.toLowerCase() === 'zh') {
        display = 'zh-cn';
    }
    config.display = display.toLowerCase();

    const item = mapper.get(display);
    
    if (item === undefined) {

        const firstOne = getFirstOneI18nItem(mapper);
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

export const i18nFileSelectors: vscode.DocumentFilter[] = [
    {
        language: 'json',
        scheme: 'file'
    }
];

interface ICurrentTranslation {
    promptDocument?: vscode.TextDocument,
    implChangeDocument?: vscode.TextDocument,
    code: string
}

export const currentTranslation: ICurrentTranslation = {
    promptDocument: undefined,
    implChangeDocument: undefined,
    code: ''
};