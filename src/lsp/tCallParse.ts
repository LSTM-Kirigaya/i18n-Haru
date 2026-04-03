import * as vscode from 'vscode';

export interface TI18nCallSpan {
    key: string;
    /** `t` 在 `this.$t` / `$t` / `t` 中的列偏移，供 isValidT */
    tCharOffset: number;
    keyQuoteOpen: number;
    keyQuoteClose: number;
    /** 整段调用起始列（含 this / $） */
    startOffset: number;
    /** 闭合 `)` 之后一列（半开区间右端） */
    endOffset: number;
}

/** 从 `(` 起扫描到与之匹配的 `)`，尊重字符串与嵌套括号 */
function scanToClosingParen(lineText: string, openParenIndex: number): number {
    let depth = 1;
    let j = openParenIndex + 1;
    let inStr: string | null = null;
    let esc = false;
    while (j < lineText.length && depth > 0) {
        const ch = lineText[j];
        if (inStr) {
            if (esc) {
                esc = false;
                j++;
                continue;
            }
            if (ch === '\\') {
                esc = true;
                j++;
                continue;
            }
            if (ch === inStr) {
                inStr = null;
            }
            j++;
            continue;
        }
        if (ch === '"' || ch === '\'') {
            inStr = ch;
            j++;
            continue;
        }
        if (ch === '(') {
            depth++;
        } else if (ch === ')') {
            depth--;
        }
        j++;
    }
    return j;
}

/**
 * 解析一行内所有 `t('key')` / `$t('key')` / `this.$t('key')`（含第二个参数等），
 * 避免用 `.*\\)` 贪婪匹配吞掉同一行多个调用。
 */
export function parseTI18nCallsInLine(lineText: string): TI18nCallSpan[] {
    const out: TI18nCallSpan[] = [];
    const re = /(?:this\.)?\$?t\(\s*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lineText)) !== null) {
        const startOffset = m.index;
        const openParenIndex = m.index + m[0].length - 1;
        if (lineText[openParenIndex] !== '(') {
            continue;
        }

        const endOffset = scanToClosingParen(lineText, openParenIndex);
        if (endOffset > lineText.length || lineText[endOffset - 1] !== ')') {
            continue;
        }

        let i = openParenIndex + 1;
        while (i < endOffset - 1 && /\s/.test(lineText[i])) {
            i++;
        }
        const quote = lineText[i];
        if (quote !== '"' && quote !== '\'') {
            continue;
        }
        const keyQuoteOpen = i;
        const keyInnerStart = i + 1;
        let j = keyInnerStart;
        let key = '';
        while (j < lineText.length) {
            const ch = lineText[j];
            if (ch === '\\' && j + 1 < lineText.length) {
                key += lineText[j + 1];
                j += 2;
                continue;
            }
            if (ch === quote) {
                break;
            }
            key += ch;
            j++;
        }
        if (j >= lineText.length || lineText[j] !== quote) {
            continue;
        }
        const keyQuoteClose = j;

        const prefix = lineText.slice(startOffset, startOffset + m[0].length);
        const tRel = prefix.lastIndexOf('t(');
        const tCharOffset = tRel === -1 ? startOffset : startOffset + tRel;

        out.push({
            key,
            tCharOffset,
            keyQuoteOpen,
            keyQuoteClose,
            startOffset,
            endOffset
        });
    }
    return out;
}

export function findTI18nCallAtColumn(lineText: string, column: number): TI18nCallSpan | undefined {
    return parseTI18nCallsInLine(lineText).find(
        s => column >= s.startOffset && column < s.endOffset
    );
}

export function spanToKeyWithQuotesRange(line: number, span: TI18nCallSpan): vscode.Range {
    return new vscode.Range(
        new vscode.Position(line, span.keyQuoteOpen),
        new vscode.Position(line, span.keyQuoteClose + 1)
    );
}
