import * as vscode from 'vscode';
import { initLog, showLog } from './utils/log';
import { ConfigStore } from './utils/secretStore';
import { addServerFlow, pickServer, loginFlow } from './utils/authFlow';
import { SyncManager } from './sync/syncManager';
import { ProjectsTreeProvider, ServerNode, ProjectNode } from './views/projectsTree';

let syncManager: SyncManager | undefined;

export function activate(context: vscode.ExtensionContext) {
    initLog();
    const configStore = new ConfigStore(context);
    syncManager = new SyncManager(context, configStore);
    const treeProvider = new ProjectsTreeProvider(configStore, syncManager);

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('overleafSyncProjects', treeProvider),

        vscode.commands.registerCommand('overleaf-sync.addServer', async () => {
            const server = await addServerFlow(configStore);
            if (server) {
                treeProvider.refresh();
                await loginFlow(configStore, server);
                treeProvider.refresh();
            }
        }),

        vscode.commands.registerCommand('overleaf-sync.login', async (node?: ServerNode) => {
            const server = node?.server ?? await pickServer(configStore);
            if (server) {
                await loginFlow(configStore, server);
                treeProvider.refresh();
            }
        }),

        vscode.commands.registerCommand('overleaf-sync.logout', async (node?: ServerNode) => {
            const server = node?.server ?? await pickServer(configStore);
            if (!server) { return; }
            await configStore.deleteIdentity(server.name);
            await configStore.updateServer({ ...server, userEmail: undefined });
            treeProvider.refresh();
            vscode.window.showInformationMessage(`Overleaf Sync: 已登出 ${server.name}`);
        }),

        vscode.commands.registerCommand('overleaf-sync.removeServer', async (node?: ServerNode) => {
            const server = node?.server ?? await pickServer(configStore);
            if (!server) { return; }
            const choice = await vscode.window.showWarningMessage(
                `确定移除服务器 ${server.name}？已同步到本地的目录不会被删除。`,
                { modal: true }, '移除',
            );
            if (choice !== '移除') { return; }
            await configStore.removeServer(server.name);
            treeProvider.refresh();
        }),

        vscode.commands.registerCommand('overleaf-sync.refresh', () => {
            treeProvider.refreshProjects();
        }),

        vscode.commands.registerCommand('overleaf-sync.openProject', async (node?: ProjectNode) => {
            await syncManager!.openProject(node);
        }),

        vscode.commands.registerCommand('overleaf-sync.stopSync', async (node?: ProjectNode) => {
            const folder = node ? syncManager!.syncingFolderOf(node.project.id) : undefined;
            await syncManager!.stopSync(folder);
        }),

        vscode.commands.registerCommand('overleaf-sync.pull', async (node?: ProjectNode) => {
            const folder = node ? syncManager!.syncingFolderOf(node.project.id) : undefined;
            await syncManager!.pull(folder);
        }),

        vscode.commands.registerCommand('overleaf-sync.push', async (node?: ProjectNode) => {
            const folder = node ? syncManager!.syncingFolderOf(node.project.id) : undefined;
            await syncManager!.push(folder);
        }),

        vscode.commands.registerCommand('overleaf-sync.switchSyncMode', async (node?: ProjectNode) => {
            const folder = node ? syncManager!.syncingFolderOf(node.project.id) : undefined;
            await syncManager!.switchSyncMode(folder);
        }),

        vscode.commands.registerCommand('overleaf-sync.openLog', () => {
            showLog();
        }),
    );

    syncManager.resumeWorkspaceSessions();
}

export function deactivate(): Promise<void> | undefined {
    return syncManager?.disposeAll();
}
