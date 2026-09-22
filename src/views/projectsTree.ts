import * as vscode from 'vscode';
import { BaseAPI, ProjectPersist } from '../api/base';
import { ConfigStore, ServerConfig } from '../utils/secretStore';
import { SyncManager } from '../sync/syncManager';
import { logError } from '../utils/log';

export class ServerNode {
    readonly kind = 'server';
    constructor(readonly server: ServerConfig) {}
}

export class ProjectNode {
    readonly kind = 'project';
    constructor(readonly server: ServerConfig, readonly project: ProjectPersist) {}
}

export type TreeNode = ServerNode | ProjectNode;

export class ProjectsTreeProvider implements vscode.TreeDataProvider<TreeNode> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private readonly projectCache = new Map<string, ProjectPersist[]>();

    constructor(
        private readonly configStore: ConfigStore,
        private readonly syncManager: SyncManager,
    ) {
        syncManager.onDidChange(() => this.refresh());
    }

    refresh() {
        this.projectCache.clear();
        this._onDidChangeTreeData.fire(undefined);
    }

    refreshProjects() {
        this.projectCache.clear();
        this._onDidChangeTreeData.fire(undefined);
    }

    async getChildren(node?: TreeNode): Promise<TreeNode[]> {
        if (!node) {
            return this.configStore.getServers().map(s => new ServerNode(s));
        }
        if (node instanceof ServerNode) {
            const identity = await this.configStore.getIdentity(node.server.name);
            if (!identity) { return []; }
            let projects = this.projectCache.get(node.server.name);
            if (!projects) {
                const api = new BaseAPI(node.server.url).setIdentity(identity);
                try {
                    const res = await api.userProjectsJson();
                    if (res.type !== 'success' || !res.projects) {
                        logError(`获取项目列表失败 (${node.server.name}): ${res.message}`);
                        return [];
                    }
                    projects = res.projects.filter(p => !p.trashed);
                    this.projectCache.set(node.server.name, projects);
                } catch (err) {
                    logError(`获取项目列表异常 (${node.server.name})`, err);
                    return [];
                }
            }
            return projects.map(p => new ProjectNode(node.server, p));
        }
        return [];
    }

    getTreeItem(node: TreeNode): vscode.TreeItem {
        if (node instanceof ServerNode) {
            const item = new vscode.TreeItem(node.server.name, vscode.TreeItemCollapsibleState.Collapsed);
            item.description = node.server.userEmail || '未登录';
            item.iconPath = new vscode.ThemeIcon(node.server.userEmail ? 'cloud' : 'cloud-offline');
            item.contextValue = node.server.userEmail ? 'serverOnline' : 'server';
            return item;
        }

        const syncingFolder = this.syncManager.syncingFolderOf(node.project.id);
        const item = new vscode.TreeItem(node.project.name, vscode.TreeItemCollapsibleState.None);
        if (syncingFolder) {
            const mode = this.syncManager.syncModeOf(node.project.id) ?? 'manual';
            item.description = mode === 'auto' ? '同步中 · 自动' : '同步中 · 手动';
            item.tooltip = `${syncingFolder}\n同步模式：${mode === 'auto' ? '自动' : '手动'}`;
            item.iconPath = new vscode.ThemeIcon(mode === 'auto' ? 'sync' : 'sync-ignored');
            item.contextValue = mode === 'auto' ? 'projectSyncingAuto' : 'projectSyncingManual';
        } else {
            item.description = node.project.lastUpdated ? new Date(node.project.lastUpdated).toLocaleDateString() : '';
            item.iconPath = new vscode.ThemeIcon(node.project.archived ? 'archive' : 'file');
            item.contextValue = 'project';
            item.command = {
                command: 'overleaf-sync.openProject',
                title: '同步到本地文件夹',
                arguments: [node],
            };
        }
        return item;
    }
}
