import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function initLog() {
    channel = vscode.window.createOutputChannel('Overleaf Sync');
}

export function log(message: string) {
    const time = new Date().toLocaleTimeString();
    channel?.appendLine(`[${time}] ${message}`);
}

export function logError(message: string, err?: any) {
    const detail = err ? (err?.message || String(err)) : '';
    log(`ERROR: ${message}${detail ? ': ' + detail : ''}`);
}

export function showLog() {
    channel?.show();
}
