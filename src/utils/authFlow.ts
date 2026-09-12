import * as vscode from 'vscode';
import { BaseAPI } from '../api/base';
import { ConfigStore, ServerConfig, StoredIdentity } from './secretStore';

export async function addServerFlow(configStore: ConfigStore): Promise<ServerConfig | undefined> {
    const input = await vscode.window.showInputBox({
        prompt: 'Overleaf 服务器地址，如 https://www.overleaf.com 或自建 ShareLaTeX/Overleaf CE 地址',
        value: 'https://www.overleaf.com',
        ignoreFocusOut: true,
    });
    if (!input) { return undefined; }
    let url: URL;
    try {
        url = new URL(input.trim());
    } catch {
        vscode.window.showErrorMessage('Overleaf Sync: 无效的服务器地址');
        return undefined;
    }
    const server: ServerConfig = { name: url.hostname, url: url.origin + '/' };
    await configStore.updateServer(server);
    return server;
}

export async function pickServer(configStore: ConfigStore): Promise<ServerConfig | undefined> {
    const servers = configStore.getServers();
    if (servers.length === 0) {
        return addServerFlow(configStore);
    }
    if (servers.length === 1) {
        return servers[0];
    }
    const picked = await vscode.window.showQuickPick(
        servers.map(s => ({ label: s.name, description: s.userEmail || '', server: s })),
        { placeHolder: '选择服务器', ignoreFocusOut: true },
    );
    return picked?.server;
}

export async function loginFlow(configStore: ConfigStore, server: ServerConfig): Promise<StoredIdentity | undefined> {
    const method = await vscode.window.showQuickPick([
        { label: 'Cookie 登录', description: '推荐：适用于 overleaf.com 及启用 SSO/验证码的服务器', value: 'cookie' },
        { label: '账号密码登录', description: '适用于自建 ShareLaTeX / Overleaf CE', value: 'password' },
    ], { placeHolder: `登录 ${server.name}`, ignoreFocusOut: true });
    if (!method) { return undefined; }

    const api = new BaseAPI(server.url);
    let res;
    if (method.value === 'cookie') {
        const cookie = await vscode.window.showInputBox({
            prompt: '粘贴浏览器中的 Cookie 值（形如 overleaf_session2=... 或 sharelatex.sid=...）',
            placeHolder: 'overleaf_session2=...',
            password: true,
            ignoreFocusOut: true,
        });
        if (!cookie) { return undefined; }
        res = await api.cookiesLogin(cookie.trim());
    } else {
        const email = await vscode.window.showInputBox({ prompt: '邮箱', ignoreFocusOut: true });
        if (!email) { return undefined; }
        const password = await vscode.window.showInputBox({ prompt: '密码', password: true, ignoreFocusOut: true });
        if (!password) { return undefined; }
        res = await api.passportLogin(email.trim(), password);
    }

    if (res.type === 'error' || !res.identity || !res.userInfo) {
        vscode.window.showErrorMessage(`Overleaf Sync 登录失败: ${res.message || '未知错误'}`);
        return undefined;
    }
    const identity: StoredIdentity = {
        ...res.identity,
        userId: res.userInfo.userId,
        userEmail: res.userInfo.userEmail,
    };
    await configStore.setIdentity(server.name, identity);
    await configStore.updateServer({ ...server, userEmail: identity.userEmail });
    vscode.window.showInformationMessage(`Overleaf Sync: 已登录 ${server.name} (${identity.userEmail || identity.userId})`);
    return identity;
}
