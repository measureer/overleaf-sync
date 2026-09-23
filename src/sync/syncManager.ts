import * as vscode from 'vscode';
import { BaseAPI, ProjectPersist } from '../api/base';
import { ProjectSync } from './projectSync';
import { StateStore, SyncMode } from './stateStore';
import { ConfigStore, ServerConfig, StoredIdentity } from '../utils/secretStore';
import { pickServer, loginFlow } from '../utils/authFlow';
import { log, logError } from '../utils/log';

/** 管理所有进行中的同步会话 */
export class SyncManager {
    private readonly sessions = new Map<string, ProjectSync>(); // key: folder fsPath
    private readonly statusBar: vscode.StatusBarItem;
    private readonly listeners: Array<() => void> = [];

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly configStore: ConfigStore,
    ) {
        this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
        this.statusBar.command = 'overleaf-sync.openLog';
        context.subscriptions.push(this.statusBar);
        this.updateStatusBar();
    }

    onDidChange(cb: () => void) {
        this.listeners.push(cb);
    }

    private fireChange() {
        this.updateStatusBar();
        this.listeners.forEach(cb => cb());
    }

    syncingFolderOf(projectId: string): string | undefined {
        for (const [folder, session] of this.sessions) {
            if (session.projectId === projectId) { return folder; }
        }
        return undefined;
    }

    syncModeOf(projectId: string): SyncMode | undefined {
        for (const session of this.sessions.values()) {
            if (session.projectId === projectId) { return session.syncMode; }
        }
        return undefined;
    }

    presenceCountOf(projectId: string): number | undefined {
        for (const session of this.sessions.values()) {
            if (session.projectId === projectId) { return session.onlineCollaborators; }
        }
        return undefined;
    }

    async openProject(node?: { server: ServerConfig; project: ProjectPersist }): Promise<void> {
        let server = node?.server;
        if (!server) {
            server = await pickServer(this.configStore);
            if (!server) { return; }
        }
        let identity = await this.configStore.getIdentity(server.name);
        if (!identity) {
            identity = await loginFlow(this.configStore, server);
            if (!identity) { return; }
        }

        let project = node?.project;
        if (!project) {
            const api = new BaseAPI(server.url).setIdentity(identity);
            const res = await api.userProjectsJson();
            if (res.type !== 'success' || !res.projects) {
                vscode.window.showErrorMessage(`Overleaf Sync: 获取项目列表失败: ${res.message}（Cookie 可能已过期，请重新登录）`);
                return;
            }
            const picked = await vscode.window.showQuickPick(
                res.projects
                    .filter(p => !p.trashed)
                    .map(p => ({
                        label: p.name,
                        description: p.lastUpdated ? new Date(p.lastUpdated).toLocaleString() : '',
                        detail: p.archived ? '已归档' : undefined,
                        project: p,
                    })),
                { placeHolder: '选择要同步到本地的项目', ignoreFocusOut: true },
            );
            if (!picked) { return; }
            project = picked.project;
        }

        if (this.syncingFolderOf(project.id)) {
            vscode.window.showInformationMessage(`Overleaf Sync: "${project.name}" 已在同步中`);
            return;
        }

        const uris = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            openLabel: '选择同步目录',
            title: `选择 "${project.name}" 的本地同步目录`,
        });
        const folderUri = uris?.[0];
        if (!folderUri) { return; }

        await this.startSession(server, identity, project, folderUri);
    }

    async startSession(
        server: ServerConfig,
        identity: StoredIdentity,
        project: Pick<ProjectPersist, 'id' | 'name'>,
        folderUri: vscode.Uri,
    ): Promise<boolean> {
        if (this.sessions.has(folderUri.fsPath)) {
            vscode.window.showInformationMessage('Overleaf Sync: 该目录已在同步中');
            return false;
        }

        let state = await StateStore.load(folderUri);
        if (state) {
            if (state.data.projectId !== project.id) {
                vscode.window.showErrorMessage('Overleaf Sync: 该目录已绑定到其他 Overleaf 项目');
                return false;
            }
        } else {
            const entries = await vscode.workspace.fs.readDirectory(folderUri);
            if (entries.length > 0) {
                const choice = await vscode.window.showWarningMessage(
                    '所选目录不为空，首次同步将把远端文件合并写入该目录（同名文件会被远端版本覆盖）。',
                    { modal: true }, '继续',
                );
                if (choice !== '继续') { return false; }
            }
            state = StateStore.create(folderUri, server.name, server.url, project.id, project.name);
            state.data.syncMode = vscode.workspace
                .getConfiguration('overleaf-sync')
                .get<SyncMode>('defaultSyncMode', 'manual');
            await state.save();
        }

        const sync = new ProjectSync(folderUri, state, identity);
        sync.onStatusChange = () => this.fireChange();
        this.sessions.set(folderUri.fsPath, sync);
        this.fireChange();

        let ok = true;
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Overleaf Sync: ${project.name}`, cancellable: false },
            async (progress) => {
                try {
                    await sync.start(progress);
                } catch (err: any) {
                    ok = false;
                    this.sessions.delete(folderUri.fsPath);
                    logError(`同步启动失败: ${project.name}`, err);
                    vscode.window.showErrorMessage(`Overleaf Sync: 同步启动失败: ${err?.message || err}`);
                }
            },
        );
        if (ok) {
            log(`同步会话已建立: ${project.name} → ${folderUri.fsPath}`);
        }
        this.fireChange();
        return ok;
    }

    /** 启动时恢复工作区内已绑定的同步会话 */
    async resumeWorkspaceSessions(): Promise<void> {
        if (!vscode.workspace.getConfiguration('overleaf-sync').get<boolean>('autoResume', true)) { return; }
        for (const wf of vscode.workspace.workspaceFolders || []) {
            const state = await StateStore.load(wf.uri);
            if (!state) { continue; }
            const server = this.configStore.getServers().find(s => s.name === state.data.serverName);
            const identity = await this.configStore.getIdentity(state.data.serverName);
            if (!server || !identity) {
                log(`无法恢复 "${state.data.projectName}" 的同步：服务器 ${state.data.serverName} 未登录`);
                continue;
            }
            await this.startSession(server, identity, { id: state.data.projectId, name: state.data.projectName }, wf.uri);
        }
    }

    async stopSync(folderFsPath?: string): Promise<void> {
        const session = await this.pickSession(folderFsPath);
        if (!session) { return; }
        await session.sync.stop();
        this.sessions.delete(session.folder);
        this.fireChange();
    }

    async pull(folderFsPath?: string): Promise<void> {
        const session = await this.pickSession(folderFsPath);
        await session?.sync.pull();
    }

    async push(folderFsPath?: string): Promise<void> {
        const session = await this.pickSession(folderFsPath);
        await session?.sync.push();
    }

    async switchSyncMode(folderFsPath?: string): Promise<void> {
        const session = await this.pickSession(folderFsPath);
        if (!session) { return; }
        const current = session.sync.syncMode;
        const picked = await vscode.window.showQuickPick(
            [
                { label: '手动模式', description: '通过「推送」「拉取」按钮手动同步', value: 'manual' as SyncMode },
                { label: '自动模式', description: '本地与远端双向实时同步', value: 'auto' as SyncMode },
            ].map(item => item.value === current ? { ...item, description: `$(check) 当前　${item.description}` } : item),
            { placeHolder: `选择 "${session.sync.projectName}" 的同步模式`, ignoreFocusOut: true },
        );
        if (!picked || picked.value === current) { return; }
        await session.sync.setSyncMode(picked.value);
        this.fireChange();
        vscode.window.showInformationMessage(
            `Overleaf Sync: "${session.sync.projectName}" 已切换为${picked.value === 'auto' ? '自动' : '手动'}模式`,
        );
    }

    private async pickSession(folderFsPath?: string): Promise<{ folder: string; sync: ProjectSync } | undefined> {
        if (folderFsPath && this.sessions.has(folderFsPath)) {
            return { folder: folderFsPath, sync: this.sessions.get(folderFsPath)! };
        }
        if (this.sessions.size === 0) {
            vscode.window.showInformationMessage('Overleaf Sync: 当前没有进行中的同步');
            return undefined;
        }
        if (this.sessions.size === 1) {
            const [folder, sync] = [...this.sessions.entries()][0];
            return { folder, sync };
        }
        const picked = await vscode.window.showQuickPick(
            [...this.sessions.entries()].map(([folder, sync]) => ({
                label: sync.projectName,
                description: sync.statusLabel,
                detail: folder,
                value: { folder, sync },
            })),
            { placeHolder: '选择同步会话', ignoreFocusOut: true },
        );
        return picked?.value;
    }

    private updateStatusBar() {
        const n = this.sessions.size;
        if (n === 0) {
            this.statusBar.hide();
            return;
        }
        const sessions = [...this.sessions.values()];
        const hasError = sessions.some(s => s.status === 'error' || s.status === 'offline');
        this.statusBar.text = hasError ? `$(warning) Overleaf ×${n}` : `$(sync) Overleaf ×${n}`;
        if (hasError) {
            this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        } else {
            this.statusBar.backgroundColor = undefined;
        }
        this.statusBar.tooltip = sessions.map(s =>
            `${s.projectName}: ${s.statusLabel} · ${s.modeLabel}模式`
            + (s.onlineCollaborators > 0 ? ` · ${s.onlineCollaborators} 位协作者在线` : ''),
        ).join('\n');
        this.statusBar.show();
    }

    async disposeAll(): Promise<void> {
        for (const session of this.sessions.values()) {
            await session.stop();
        }
        this.sessions.clear();
    }
}
