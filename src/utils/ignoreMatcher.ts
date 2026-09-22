import * as vscode from 'vscode';
import { log, logError } from './log';

export const IGNORE_FILE_NAME = '.overleafignore';

interface IgnoreRule {
    regex: RegExp;
    /** true 表示该规则是取反规则（重新包含被忽略的路径） */
    negated: boolean;
    /** true 表示该规则只匹配目录 */
    dirOnly: boolean;
    /** true 表示模式不含分隔符，按 basename 在任意层级匹配（gitignore 语义） */
    basenameOnly: boolean;
}

/**
 * 解析项目目录下的 .overleafignore，语法与 .gitignore 一致：
 * `#` 注释、空行忽略；`!` 前缀取反；行尾 `/` 仅匹配目录；行首 `/` 锚定根目录；
 * 含 `/` 的模式相对根目录匹配，不含 `/` 的模式按任意层级的 basename 匹配；
 * 支持 `*`（不含 `/`）、`**`（任意字符含 `/`）、`?`（单个非 `/` 字符）。
 * 规则按顺序匹配，最后一条命中规则生效。
 */
export class IgnoreMatcher {
    private constructor(private readonly rules: IgnoreRule[]) {}

    /** 读取 <folder>/.overleafignore；文件不存在时只保留内置默认规则 */
    static async load(folderUri: vscode.Uri): Promise<IgnoreMatcher> {
        const rules: IgnoreRule[] = IgnoreMatcher.defaultRules();
        try {
            const raw = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folderUri, IGNORE_FILE_NAME));
            const text = Buffer.from(raw).toString('utf-8');
            for (const line of text.split(/\r?\n/)) {
                const rule = IgnoreMatcher.compileLine(line);
                if (rule) { rules.push(rule); }
            }
        } catch (err) {
            if (!(err instanceof vscode.FileSystemError && err.code === 'FileNotFound')) {
                logError(`解析 ${IGNORE_FILE_NAME} 失败，本次忽略该文件`, err);
            }
        }
        return new IgnoreMatcher(rules);
    }

    static empty(): IgnoreMatcher {
        return new IgnoreMatcher(IgnoreMatcher.defaultRules());
    }

    private static defaultRules(): IgnoreRule[] {
        // `.git` 命中目录本身（遍历时跳过递归），`.git/**` 命中其中的内容（watcher 事件）
        return IgnoreMatcher.compileLines(['.git', '.git/**']);
    }

    static compileLines(lines: string[]): IgnoreRule[] {
        const rules: IgnoreRule[] = [];
        for (const line of lines) {
            const rule = IgnoreMatcher.compileLine(line);
            if (rule) { rules.push(rule); }
        }
        return rules;
    }

    private static compileLine(raw: string): IgnoreRule | undefined {
        // gitignore：去除首尾空白（不处理行内转义空格，保持简单）
        let line = raw.trim();
        if (line === '' || line.startsWith('#')) { return undefined; }

        let negated = false;
        if (line.startsWith('!')) {
            negated = true;
            line = line.slice(1);
            if (line === '') { return undefined; }
        }

        let dirOnly = false;
        if (line.endsWith('/')) {
            dirOnly = true;
            line = line.slice(0, -1);
        }

        let anchored = false;
        if (line.startsWith('/')) {
            anchored = true;
            line = line.slice(1);
        }
        if (line === '') { return undefined; }

        const basenameOnly = !anchored && !line.includes('/');
        const regex = new RegExp(`^${IgnoreMatcher.globToRegexSource(line)}$`);
        return { regex, negated, dirOnly, basenameOnly };
    }

    /** 把 gitignore glob 转成正则源码（不含 ^ $ 定界符） */
    private static globToRegexSource(glob: string): string {
        let src = '';
        let i = 0;
        while (i < glob.length) {
            const ch = glob[i];
            if (ch === '*') {
                if (glob[i + 1] === '*') {
                    if (glob[i + 2] === '/') {
                        // `**/`：匹配任意深度（含零层）
                        src += '(?:[^/]+/)*';
                        i += 3;
                    } else {
                        // `**`：匹配任意字符（含 `/`）
                        src += '.*';
                        i += 2;
                    }
                } else {
                    src += '[^/]*';
                    i += 1;
                }
            } else if (ch === '?') {
                src += '[^/]';
                i += 1;
            } else {
                src += IgnoreMatcher.escapeRegex(ch);
                i += 1;
            }
        }
        return src;
    }

    private static escapeRegex(ch: string): string {
        return /[.+^${}()|[\]\\]/.test(ch) ? '\\' + ch : ch;
    }

    /** rel 为相对项目根的 posix 路径；isDir 未知时按 false 处理（文件） */
    isIgnored(rel: string, isDir = false): boolean {
        // 任一父目录被忽略时其内容一并忽略（与 git 一致，且无法用 ! 重新包含）
        const segments = rel.split('/');
        for (let depth = 1; depth < segments.length; depth++) {
            if (this.matches(segments.slice(0, depth).join('/'), true)) { return true; }
        }
        return this.matches(rel, isDir);
    }

    private matches(rel: string, isDir: boolean): boolean {
        const basename = rel.split('/').pop()!;
        let ignored = false;
        for (const rule of this.rules) {
            if (rule.dirOnly && !isDir) { continue; }
            const target = rule.basenameOnly ? basename : rel;
            if (rule.regex.test(target)) {
                ignored = !rule.negated;
            }
        }
        return ignored;
    }
}
