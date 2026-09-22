/* eslint-disable @typescript-eslint/naming-convention */
import * as vscode from 'vscode';
import * as path from 'path';
import { BaseAPI, FileEntity, FileType, FolderEntity, ProjectEntity } from '../api/base';
import { SocketIOAPI, UpdateSchema } from '../api/socketio';
import { DocSession } from './docSession';
import { StateStore, EntityRecord, SyncMode, STATE_FILE_NAME } from './stateStore';
import { StoredIdentity } from '../utils/secretStore';
import { IgnoreMatcher, IGNORE_FILE_NAME } from '../utils/ignoreMatcher';
import { log, logError } from '../utils/log';

export type SyncStatus = 'connecting' | 'synced' | 'offline' | 'error';

const TEXT_EXTENSIONS = new Set([
    '.tex', '.ltx', '.dtx', '.ins', '.def', '.bib', '.sty', '.cls', '.bst', '.txt', '.md',
    '.markdown', '.csv', '.tsv', '.json', '.xml', '.svg', '.rnw', '.cfg', '.ini', '.gitignore',
    '.latexmkrc', '.nix', '.sh', '.py', '.m', '.r', '.jl', '.lua', '.hs', '.cpp', '.c', '.h',
    '.hpp', '.java', '.js', '.ts', '.html', '.css', '.yml', '.yaml', '.toml', '.bbx', '.cbx',
]);

const BINARY_EXTENSIONS = new Set([
    '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.eps', '.ps', '.zip', '.tar',
    '.gz', '.bz2', '.xz', '.7z', '.rar', '.mp3', '.mp4', '.mov', '.avi', '.webm', '.ttf',
    '.otf', '.woff', '.woff2', '.eot', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
]);

/** 单个 Overleaf 项目 ↔ 一个本地目录的双向同步会话 */
export class ProjectSync {
    status: SyncStatus = 'connecting';
    onStatusChange?: () => void;

    private readonly api: BaseAPI;
    private socket?: SocketIOAPI;
    private watcher?: vscode.FileSystemWatcher;
    private readonly docs = new Map<string, DocSession>();
    private queue: Promise<void> = Promise.resolve();
    private readonly suppressed = new Map<string, number>();
    private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
    private saveTimer?: NodeJS.Timeout;
    private stopped = false;
    private rootFolderId = '';
    private authErrorNotified = false;
    private ignore: IgnoreMatcher = IgnoreMatcher.empty();

    constructor(
        readonly folderUri: vscode.Uri,
        private readonly state: StateStore,
        private readonly identity: StoredIdentity,
    ) {
        this.api = new BaseAPI(state.data.serverUrl).setIdentity(identity);
    }

    get projectName() { return this.state.data.projectName; }
    get projectId() { return this.state.data.projectId; }
    get syncMode(): SyncMode { return this.state.data.syncMode ?? 'manual'; }
    get modeLabel(): string { return this.syncMode === 'auto' ? '自动' : '手动'; }

    get statusLabel(): string {
        switch (this.status) {
            case 'connecting': return '连接中';
            case 'synced': return '已同步';
            case 'offline': return '离线';
            case 'error': return '需要重新登录';
        }
    }

    private setStatus(status: SyncStatus) {
        if (this.status !== status) {
            this.status = status;
            this.onStatusChange?.();
        }
    }

    // ---------- 生命周期 ----------

    async start(progress?: vscode.Progress<{ message?: string }>): Promise<void> {
        this.setStatus('connecting');
        this.ignore = await IgnoreMatcher.load(this.folderUri);
        this.socket = new SocketIOAPI(this.state.data.serverUrl, this.identity, this.projectId, {
            onFileChanged: (update) => this.enqueue(() => this.applyRemoteUpdate(update)),
            onFileCreated: (parentFolderId, type, entity) => this.enqueue(() => this.applyRemoteCreate(parentFolderId, type, entity)),
            onFileRenamed: (entityId, newName) => this.enqueue(() => this.applyRemoteRename(entityId, newName)),
            onFileRemoved: (entityId) => this.enqueue(() => this.applyRemoteRemove(entityId)),
            onFileMoved: (entityId, folderId) => this.enqueue(() => this.applyRemoteMove(entityId, folderId)),
            onDisconnected: () => {
                if (this.stopped) { return; }
                this.setStatus('offline');
                log(`[${this.projectName}] 连接断开，等待自动重连…`);
            },
            onRejoinNeeded: () => this.enqueue(() => this.rejoin()),
        });

        progress?.report({ message: '连接 Overleaf 实时服务…' });
        const project = await this.socket.connect();
        this.rootFolderId = this.rootFolderOf(project)?._id ?? '';
        const remoteEntities = this.flattenProject(project);

        if (Object.keys(this.state.data.entities).length === 0) {
            await this.initialDownload(remoteEntities, progress);
        } else if (this.syncMode === 'auto') {
            progress?.report({ message: '与远端状态对齐…' });
            await this.reconcile(remoteEntities, progress);
        } else {
            log(`[${this.projectName}] 手动模式：跳过启动时的自动对齐`);
        }
        await this.state.save();
        if (this.syncMode === 'auto') { this.startWatcher(); }
        this.setStatus('synced');
        log(`[${this.projectName}] 同步已启动（${this.modeLabel}模式）: ${this.folderUri.fsPath}`);
    }

    /** 切换同步模式；切到自动时立即启动监听并对齐两端 */
    async setSyncMode(mode: SyncMode): Promise<void> {
        if (this.stopped || mode === this.syncMode) { return; }
        this.state.data.syncMode = mode;
        await this.state.save();
        if (mode === 'auto') {
            this.startWatcher();
            this.enqueue(() => this.rejoin());
        } else {
            this.watcher?.dispose();
            this.watcher = undefined;
            for (const timer of this.debounceTimers.values()) { clearTimeout(timer); }
            this.debounceTimers.clear();
        }
        log(`[${this.projectName}] 同步模式切换为: ${this.modeLabel}`);
        this.onStatusChange?.();
    }

    async stop(): Promise<void> {
        this.stopped = true;
        for (const timer of this.debounceTimers.values()) { clearTimeout(timer); }
        this.debounceTimers.clear();
        if (this.saveTimer) { clearTimeout(this.saveTimer); }
        this.watcher?.dispose();
        this.socket?.disconnect();
        try { await this.state.save(); } catch { /* ignore */ }
        log(`[${this.projectName}] 同步已停止`);
    }

    /** 断线重连后重新加入项目并对齐状态 */
    private async rejoin(): Promise<void> {
        if (this.stopped) { return; }
        log(`[${this.projectName}] 重新加入项目…`);
        try {
            const project = await this.socket!.rejoinProject();
            this.rootFolderId = this.rootFolderOf(project)?._id ?? this.rootFolderId;
            if (this.syncMode === 'auto') {
                await this.reconcile(this.flattenProject(project));
                await this.state.save();
            }
            this.setStatus('synced');
            log(`[${this.projectName}] 重连成功`);
        } catch (err) {
            logError(`[${this.projectName}] 重连失败`, err);
            this.setStatus('offline');
        }
    }

    /** 拉取：远端优先，本地文件结构/文档内容全部以远端为准 */
    async pull(): Promise<void> {
        this.enqueue(async () => {
            if (!this.socket) { return; }
            log(`[${this.projectName}] 从远端拉取…`);
            const project = await this.socket.rejoinProject();
            this.rootFolderId = this.rootFolderOf(project)?._id ?? this.rootFolderId;
            const remote = this.flattenProject(project);

            // 结构对齐：删本地多余，拉远端新增/移动
            const remoteIds = new Set([...remote.values()].map(r => r.id));
            for (const [rel, rec] of Object.entries({ ...this.state.data.entities })) {
                if (!remoteIds.has(rec.id)) {
                    await this.deleteLocal(rel, rec.type);
                    this.state.removeRecursive(rel);
                }
            }
            const localIds = new Map(Object.entries(this.state.data.entities).map(([rel, rec]) => [rec.id, rel]));
            for (const [rel, rec] of remote) {
                const oldRel = localIds.get(rec.id);
                if (oldRel === undefined) {
                    this.state.data.entities[rel] = rec;
                    await this.downloadEntity(rel, rec);
                } else if (oldRel !== rel && this.state.data.entities[oldRel]) {
                    await this.moveLocal(oldRel, rel);
                    this.state.rekeyRecursive(oldRel, rel);
                }
            }
            // 内容：文档一律以远端为准；二进制文件本地缺失才下载
            for (const [rel, rec] of remote) {
                try {
                    if (rec.type === 'doc') {
                        const session = await DocSession.join(this.socket!, rec.id);
                        this.docs.set(rec.id, session);
                        this.state.data.docVersions[rec.id] = session.version;
                        await this.writeLocal(rel, session.content);
                    } else if (rec.type === 'file') {
                        try {
                            await vscode.workspace.fs.stat(this.localUri(rel));
                        } catch {
                            await this.downloadEntity(rel, rec);
                        }
                    }
                } catch (err) { logError(`拉取失败: ${rel}`, err); }
            }
            await this.state.save();
            this.setStatus('synced');
            log(`[${this.projectName}] 拉取完成`);
            vscode.window.showInformationMessage(`Overleaf Sync: "${this.projectName}" 已从远端完整拉取`);
        });
    }

    /** 推送：本地优先，本地删除/新增同步到远端，文档内容以本地覆盖远端 */
    async push(): Promise<void> {
        this.enqueue(async () => {
            if (!this.socket) { return; }
            log(`[${this.projectName}] 推送本地修改…`);
            this.ignore = await IgnoreMatcher.load(this.folderUri);
            const project = await this.socket.rejoinProject();
            this.rootFolderId = this.rootFolderOf(project)?._id ?? this.rootFolderId;
            const remote = this.flattenProject(project);

            // 结构：本地已删除的推送删除到远端，本地新增的上传到远端
            await this.pushOfflineDeletions(remote);
            await this.uploadOfflineCreations();

            // 文档内容：本地优先（远端也有修改时以本地覆盖）
            let pushed = 0;
            for (const [rel, rec] of Object.entries({ ...this.state.data.entities })) {
                if (rec.type !== 'doc') { continue; }
                try {
                    const content = await this.readLocalText(rel);
                    if (content === undefined) { continue; }
                    // 始终重新加入文档，拿到远端最新版本，避免手动模式下缓存会话过期
                    const session = await DocSession.join(this.socket!, rec.id);
                    this.docs.set(rec.id, session);
                    const storedV = this.state.data.docVersions[rec.id];
                    if (storedV !== undefined && session.version !== storedV && content !== session.content) {
                        log(`[${this.projectName}] 远端也有修改，以本地覆盖: ${rel}`);
                    }
                    if (await this.pushDocContent(rec.id, session, content)) { pushed++; }
                    this.state.data.docVersions[rec.id] = session.version;
                } catch (err) { logError(`推送失败: ${rel}`, err); }
            }
            await this.state.save();
            log(`[${this.projectName}] 推送完成，共 ${pushed} 个文档有更新`);
            vscode.window.showInformationMessage(`Overleaf Sync: "${this.projectName}" 推送完成（${pushed} 个文档有更新）`);
        });
    }

    // ---------- 远端文件树 ----------

    private rootFolderOf(project: ProjectEntity): FolderEntity | undefined {
        const roots = Array.isArray(project.rootFolder) ? project.rootFolder : [project.rootFolder];
        return roots[0];
    }

    private flattenProject(project: ProjectEntity): Map<string, EntityRecord> {
        const out = new Map<string, EntityRecord>();
        const root = this.rootFolderOf(project);
        if (root) { this.flattenFolder(root, '', out); }
        return out;
    }

    private flattenFolder(folder: FolderEntity, prefix: string, out: Map<string, EntityRecord>) {
        for (const doc of folder.docs || []) {
            out.set(prefix + doc.name, { id: doc._id, type: 'doc' });
        }
        for (const file of folder.fileRefs || []) {
            out.set(prefix + file.name, { id: file._id, type: 'file' });
        }
        for (const sub of folder.folders || []) {
            out.set(prefix + sub.name, { id: sub._id, type: 'folder' });
            this.flattenFolder(sub, prefix + sub.name + '/', out);
        }
    }

    private async initialDownload(remoteEntities: Map<string, EntityRecord>, progress?: vscode.Progress<{ message?: string }>): Promise<void> {
        const entities = [...remoteEntities.entries()];
        let done = 0;
        for (const [rel, rec] of entities) {
            progress?.report({ message: `下载 ${rel} (${++done}/${entities.length})` });
            try {
                await this.downloadEntity(rel, rec);
                this.state.data.entities[rel] = rec;
            } catch (err) {
                logError(`初始下载失败: ${rel}`, err);
            }
        }
    }

    private async downloadEntity(rel: string, rec: EntityRecord): Promise<void> {
        if (rec.type === 'folder') {
            this.suppress(rel);
            await vscode.workspace.fs.createDirectory(this.localUri(rel));
        } else if (rec.type === 'doc') {
            const session = await DocSession.join(this.socket!, rec.id);
            this.docs.set(rec.id, session);
            this.state.data.docVersions[rec.id] = session.version;
            await this.writeLocal(rel, session.content);
        } else {
            const res = await this.api.getFile(this.projectId, rec.id);
            if (res.type === 'success' && res.content) {
                await this.writeLocal(rel, res.content);
            } else {
                this.checkAuthError(res);
                logError(`下载文件失败: ${rel}: ${res.message}`);
            }
        }
    }

    /** 恢复/重连时对齐：结构 + 文档内容（远端版本未变则推送本地离线修改，否则远端优先） */
    private async reconcile(remoteEntities: Map<string, EntityRecord>, progress?: vscode.Progress<{ message?: string }>): Promise<void> {
        const local = this.state.data.entities;
        const remoteIds = new Map([...remoteEntities.entries()].map(([rel, rec]) => [rec.id, rel]));
        const localIds = new Map(Object.entries(local).map(([rel, rec]) => [rec.id, rel]));

        for (const [rel, rec] of Object.entries({ ...local })) {
            if (!remoteIds.has(rec.id)) {
                await this.deleteLocal(rel, rec.type);
                this.state.removeRecursive(rel);
            }
        }
        for (const [rel, rec] of remoteEntities) {
            const oldRel = localIds.get(rec.id);
            if (oldRel === undefined) {
                this.state.data.entities[rel] = rec;
                try { await this.downloadEntity(rel, rec); } catch (err) { logError(`下载失败: ${rel}`, err); }
            } else if (oldRel !== rel && this.state.data.entities[oldRel]) {
                // entities[oldRel] 不存在说明父文件夹的移动已处理过该子项
                await this.moveLocal(oldRel, rel);
                this.state.rekeyRecursive(oldRel, rel);
            }
        }

        // 离线期间的本地结构变更：删除推送远端，新增上传远端
        await this.pushOfflineDeletions(remoteEntities);
        await this.uploadOfflineCreations();

        for (const [rel, rec] of remoteEntities) {
            if (rec.type !== 'doc') { continue; }
            if (!this.state.data.entities[rel]) { continue; }
            progress?.report({ message: `校验 ${rel}` });
            try {
                const session = await DocSession.join(this.socket!, rec.id);
                this.docs.set(rec.id, session);
                const storedV = this.state.data.docVersions[rec.id];
                const localContent = await this.readLocalText(rel);
                if (localContent === undefined) {
                    // 本地文件在校验间隙被删：跳过，交由下一轮对齐处理
                    continue;
                } else if (storedV === session.version) {
                    if (localContent !== session.content) {
                        await this.pushDocContent(rec.id, session, localContent);
                        log(`[${this.projectName}] 推送离线修改: ${rel}`);
                    }
                } else if (localContent !== session.content) {
                    await this.writeLocal(rel, session.content);
                    vscode.window.showWarningMessage(`Overleaf Sync: "${rel}" 在远端有更新，已覆盖本地版本`);
                    log(`[${this.projectName}] 远端覆盖本地: ${rel}`);
                }
                this.state.data.docVersions[rec.id] = session.version;
            } catch (err) {
                logError(`校验文档失败: ${rel}`, err);
            }
        }
    }

    /** 离线期间本地删除的文件（在状态记录中、磁盘上不存在、远端仍存在）→ 推送删除到远端 */
    private async pushOfflineDeletions(remoteEntities: Map<string, EntityRecord>): Promise<void> {
        const remoteIds = new Set([...remoteEntities.values()].map(r => r.id));
        // 深层路径先删（子项先于父文件夹）
        const entries = Object.entries({ ...this.state.data.entities })
            .sort((a, b) => b[0].split('/').length - a[0].split('/').length);
        for (const [rel, rec] of entries) {
            if (!remoteIds.has(rec.id)) { continue; }
            if (await this.existsLocal(rel)) { continue; }
            if (this.ignore.isIgnored(rel, rec.type === 'folder')) {
                // 被忽略的路径不同步删除：远端文件保留，仅停止本地跟踪
                log(`[${this.projectName}] 已忽略，跳过推送删除: ${rel}`);
                this.state.removeRecursive(rel);
                continue;
            }
            const res = await this.api.deleteEntity(this.projectId, rec.type, rec.id);
            // 404/410：父文件夹删除时已连带删除，视为成功
            if (res.type !== 'success' && !/^(404|410)/.test(res.message ?? '')) {
                this.checkAuthError(res);
                logError(`推送离线删除失败: ${rel}: ${res.message}`);
                continue;
            }
            if (rec.type === 'doc') { this.docs.delete(rec.id); }
            this.state.removeRecursive(rel);
            log(`[${this.projectName}] 推送离线删除: ${rel}`);
        }
    }

    /** 离线期间本地新增的文件（磁盘上存在、不在状态记录中）→ 上传到远端 */
    private async uploadOfflineCreations(): Promise<void> {
        const pending: string[] = [];
        const walk = async (dirRel: string): Promise<void> => {
            const dirUri = dirRel ? this.localUri(dirRel) : this.folderUri;
            let entries: [string, vscode.FileType][];
            try {
                entries = await vscode.workspace.fs.readDirectory(dirUri);
            } catch { return; }
            for (const [name, type] of entries) {
                const rel = dirRel ? `${dirRel}/${name}` : name;
                if (rel === STATE_FILE_NAME) { continue; }
                if (this.ignore.isIgnored(rel, type === vscode.FileType.Directory)) { continue; }
                if (!this.state.data.entities[rel]) { pending.push(rel); }
                if (type === vscode.FileType.Directory) { await walk(rel); }
            }
        };
        await walk('');
        // 浅层路径优先（文件夹先于其中的文件创建）
        pending.sort((a, b) => a.split('/').length - b.split('/').length);
        for (const rel of pending) {
            try {
                await this.handleLocalCreate(rel);
                log(`[${this.projectName}] 上传离线新增: ${rel}`);
            } catch (err) {
                logError(`上传离线新增失败: ${rel}`, err);
            }
        }
    }

    // ---------- 远端事件 → 本地 ----------

    private async applyRemoteUpdate(update: UpdateSchema): Promise<void> {
        if (this.stopped || !this.socket) { return; }
        // 回声消除：本端推送的更新
        if (update.meta?.source && update.meta.source === this.socket.publicId) { return; }
        if (this.syncMode === 'manual') {
            // 手动模式下不应用远端改动，仅使缓存的文档会话失效（推送时会重新加入）
            this.docs.delete(update.doc);
            return;
        }
        const rel = this.state.findPathById(update.doc);
        if (!rel) { return; }

        let session = this.docs.get(update.doc);
        if (!session) {
            // 尚未加入该文档：直接全量同步
            await this.resyncDoc(update.doc, rel);
            return;
        }
        const newContent = session.applyRemote(update);
        if (newContent === undefined) {
            log(`[${this.projectName}] 文档版本掉队，重新同步: ${rel}`);
            await this.resyncDoc(update.doc, rel);
            return;
        }
        await this.writeLocal(rel, newContent);
        this.state.data.docVersions[update.doc] = session.version;
        this.scheduleSave();
    }

    private async resyncDoc(docId: string, rel: string): Promise<void> {
        const session = await DocSession.join(this.socket!, docId);
        this.docs.set(docId, session);
        this.state.data.docVersions[docId] = session.version;
        await this.writeLocal(rel, session.content);
        this.scheduleSave();
    }

    private async applyRemoteCreate(parentFolderId: string, type: FileType, entity: FileEntity): Promise<void> {
        if (this.stopped || this.syncMode === 'manual') { return; }
        const parentRel = parentFolderId === this.rootFolderId ? '' : (this.state.findPathById(parentFolderId) ?? '');
        const rel = parentRel ? `${parentRel}/${entity.name}` : entity.name;
        if (this.state.data.entities[rel]) { return; }
        const rec: EntityRecord = { id: entity._id, type };
        this.state.data.entities[rel] = rec;
        try {
            await this.downloadEntity(rel, rec);
            log(`[${this.projectName}] 远端新增: ${rel}`);
        } catch (err) {
            logError(`远端新增处理失败: ${rel}`, err);
        }
        this.scheduleSave();
    }

    private async applyRemoteRename(entityId: string, newName: string): Promise<void> {
        if (this.stopped || this.syncMode === 'manual') { return; }
        const rel = this.state.findPathById(entityId);
        if (!rel) { return; }
        const parentRel = rel.split('/').slice(0, -1).join('/');
        const newRel = parentRel ? `${parentRel}/${newName}` : newName;
        if (rel === newRel) { return; }
        await this.moveLocal(rel, newRel);
        this.state.rekeyRecursive(rel, newRel);
        log(`[${this.projectName}] 远端重命名: ${rel} → ${newRel}`);
        this.scheduleSave();
    }

    private async applyRemoteRemove(entityId: string): Promise<void> {
        if (this.stopped || this.syncMode === 'manual') { return; }
        const rel = this.state.findPathById(entityId);
        if (!rel) { return; }
        const rec = this.state.data.entities[rel];
        await this.deleteLocal(rel, rec.type);
        if (rec.type === 'doc') { this.docs.delete(rec.id); }
        this.state.removeRecursive(rel);
        log(`[${this.projectName}] 远端删除: ${rel}`);
        this.scheduleSave();
    }

    private async applyRemoteMove(entityId: string, folderId: string): Promise<void> {
        if (this.stopped || this.syncMode === 'manual') { return; }
        const rel = this.state.findPathById(entityId);
        if (!rel) { return; }
        const folderRel = folderId === this.rootFolderId ? '' : (this.state.findPathById(folderId) ?? '');
        const name = rel.split('/').pop()!;
        const newRel = folderRel ? `${folderRel}/${name}` : name;
        if (rel === newRel) { return; }
        await this.moveLocal(rel, newRel);
        this.state.rekeyRecursive(rel, newRel);
        log(`[${this.projectName}] 远端移动: ${rel} → ${newRel}`);
        this.scheduleSave();
    }

    // ---------- 本地事件 → 远端 ----------

    private startWatcher() {
        const pattern = new vscode.RelativePattern(this.folderUri, '**/*');
        this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
        this.watcher.onDidCreate(uri => this.onLocalEvent(uri, 'create'));
        this.watcher.onDidChange(uri => this.onLocalEvent(uri, 'change'));
        this.watcher.onDidDelete(uri => this.onLocalEvent(uri, 'delete'));
    }

    private onLocalEvent(uri: vscode.Uri, kind: 'create' | 'change' | 'delete') {
        if (this.stopped || this.syncMode === 'manual') { return; }
        const rel = this.relOf(uri);
        if (rel === undefined || rel === '' || rel === STATE_FILE_NAME) { return; }
        if (rel === IGNORE_FILE_NAME) {
            // 忽略规则变更：立即重载，无需重启同步
            void IgnoreMatcher.load(this.folderUri).then(m => {
                this.ignore = m;
                log(`[${this.projectName}] ${IGNORE_FILE_NAME} 已更新，忽略规则已重载`);
            });
            return;
        }
        if (this.ignore.isIgnored(rel)) { return; }
        if (this.isSuppressed(rel)) { return; }

        const key = kind + ':' + rel;
        const existing = this.debounceTimers.get(key);
        if (existing) { clearTimeout(existing); }
        const debounceMs = kind === 'delete' ? 50
            : vscode.workspace.getConfiguration('overleaf-sync').get<number>('debounceMs', 300);
        this.debounceTimers.set(key, setTimeout(() => {
            this.debounceTimers.delete(key);
            this.enqueue(async () => {
                if (this.stopped || !this.socket) { return; }
                try {
                    if (kind === 'create') { await this.handleLocalCreate(rel); }
                    else if (kind === 'change') { await this.handleLocalChange(rel); }
                    else { await this.handleLocalDelete(rel); }
                } catch (err) {
                    logError(`本地事件处理失败 (${kind} ${rel})`, err);
                }
            });
        }, debounceMs));
    }

    private async handleLocalCreate(rel: string): Promise<void> {
        if (this.state.data.entities[rel]) {
            await this.handleLocalChange(rel);
            return;
        }
        let stat: vscode.FileStat;
        try {
            stat = await vscode.workspace.fs.stat(this.localUri(rel));
        } catch { return; }

        if (stat.type === vscode.FileType.Directory) {
            await this.ensureRemoteFolder(rel);
            this.scheduleSave();
            return;
        }

        const name = rel.split('/').pop()!;
        const parentRel = rel.split('/').slice(0, -1).join('/');
        const parentId = await this.ensureRemoteFolder(parentRel);

        if (await this.isTextFile(rel, name)) {
            const res = await this.api.addDoc(this.projectId, parentId, name);
            if (res.type !== 'success' || !res.entity) {
                this.checkAuthError(res);
                logError(`远端创建文档失败: ${rel}: ${res.message}`);
                return;
            }
            this.state.data.entities[rel] = { id: res.entity._id, type: 'doc' };
            const session = await DocSession.join(this.socket!, res.entity._id);
            this.docs.set(res.entity._id, session);
            const content = (await this.readLocalText(rel)) ?? '';
            if (content !== session.content) {
                await this.pushDocContent(res.entity._id, session, content);
            }
            this.state.data.docVersions[res.entity._id] = session.version;
            log(`[${this.projectName}] 新建文档: ${rel}`);
        } else {
            const content = await vscode.workspace.fs.readFile(this.localUri(rel));
            const res = await this.api.uploadFile(this.projectId, parentId, name, content);
            if (res.type !== 'success' || !res.entity) {
                this.checkAuthError(res);
                logError(`上传文件失败: ${rel}: ${res.message}`);
                return;
            }
            this.state.data.entities[rel] = { id: res.entity._id, type: 'file' };
            log(`[${this.projectName}] 上传文件: ${rel}`);
        }
        this.scheduleSave();
    }

    private async handleLocalChange(rel: string): Promise<void> {
        const rec = this.state.data.entities[rel];
        if (!rec) {
            await this.handleLocalCreate(rel);
            return;
        }
        if (rec.type === 'doc') {
            const content = await this.readLocalText(rel);
            if (content === undefined) { return; }
            let session = this.docs.get(rec.id);
            if (!session) {
                session = await DocSession.join(this.socket!, rec.id);
                this.docs.set(rec.id, session);
            }
            try {
                if (await this.pushDocContent(rec.id, session, content)) {
                    this.state.data.docVersions[rec.id] = session.version;
                    this.scheduleSave();
                }
            } catch (err) {
                logError(`推送失败，重新同步文档: ${rel}`, err);
                await this.resyncDoc(rec.id, rel);
                vscode.window.showWarningMessage(`Overleaf Sync: "${rel}" 与远端冲突，已回退到远端版本`);
            }
        } else if (rec.type === 'file') {
            // Overleaf 不支持替换文件内容：删除后重新上传
            try {
                const content = await vscode.workspace.fs.readFile(this.localUri(rel));
                const del = await this.api.deleteEntity(this.projectId, 'file', rec.id);
                if (del.type !== 'success') { this.checkAuthError(del); return; }
                const parentRel = rel.split('/').slice(0, -1).join('/');
                const parentId = await this.ensureRemoteFolder(parentRel);
                const up = await this.api.uploadFile(this.projectId, parentId, rel.split('/').pop()!, content);
                if (up.type === 'success' && up.entity) {
                    this.state.data.entities[rel] = { id: up.entity._id, type: 'file' };
                    this.scheduleSave();
                    log(`[${this.projectName}] 替换文件: ${rel}`);
                } else {
                    this.checkAuthError(up);
                    logError(`重新上传失败: ${rel}: ${up.message}`);
                }
            } catch (err) { logError(`替换文件失败: ${rel}`, err); }
        }
    }

    private async handleLocalDelete(rel: string): Promise<void> {
        const rec = this.state.data.entities[rel];
        if (!rec) {
            log(`[${this.projectName}] 忽略未跟踪文件的删除事件: ${rel}`);
            return;
        }
        const res = await this.api.deleteEntity(this.projectId, rec.type, rec.id);
        if (res.type !== 'success') {
            this.checkAuthError(res);
            logError(`远端删除失败: ${rel}: ${res.message}`);
            return;
        }
        if (rec.type === 'doc') { this.docs.delete(rec.id); }
        this.state.removeRecursive(rel);
        log(`[${this.projectName}] 本地删除: ${rel}`);
        this.scheduleSave();
    }

    /** 确保 rel（文件夹路径，'' 表示根）在远端存在，返回其 folder id */
    private async ensureRemoteFolder(rel: string): Promise<string> {
        if (rel === '') { return this.rootFolderId; }
        const existing = this.state.data.entities[rel];
        if (existing?.type === 'folder') { return existing.id; }

        const parts = rel.split('/');
        let current = '';
        let parentId = this.rootFolderId;
        for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            const rec = this.state.data.entities[current];
            if (rec?.type === 'folder') {
                parentId = rec.id;
                continue;
            }
            const res = await this.api.addFolder(this.projectId, part, parentId);
            if (res.type !== 'success' || !res.entity) {
                this.checkAuthError(res);
                throw new Error(`远端创建文件夹失败: ${current}: ${res.message}`);
            }
            this.state.data.entities[current] = { id: res.entity._id, type: 'folder' };
            parentId = res.entity._id;
        }
        return parentId;
    }

    private async pushDocContent(docId: string, session: DocSession, content: string): Promise<boolean> {
        const update = session.buildUpdate(content, this.socket!.publicId, this.identity.userId);
        if (!update) { return false; }
        await this.socket!.applyOtUpdate(docId, update);
        session.commitLocal(content);
        return true;
    }

    // ---------- 本地文件系统工具 ----------

    private localUri(rel: string): vscode.Uri {
        return vscode.Uri.joinPath(this.folderUri, ...rel.split('/'));
    }

    private relOf(uri: vscode.Uri): string | undefined {
        const rel = path.relative(this.folderUri.fsPath, uri.fsPath);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) { return undefined; }
        return rel.split(path.sep).join('/');
    }

    private suppress(rel: string) {
        this.suppressed.set(rel, Date.now() + 5000);
    }

    private isSuppressed(rel: string): boolean {
        const until = this.suppressed.get(rel);
        if (until === undefined) { return false; }
        if (Date.now() > until) {
            this.suppressed.delete(rel);
            return false;
        }
        return true;
    }

    private async writeLocal(rel: string, content: string | Uint8Array): Promise<void> {
        this.suppress(rel);
        const parts = rel.split('/');
        const dir = vscode.Uri.joinPath(this.folderUri, ...parts.slice(0, -1));
        await vscode.workspace.fs.createDirectory(dir);
        const data = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
        await vscode.workspace.fs.writeFile(this.localUri(rel), data);
    }

    private async readLocalText(rel: string): Promise<string | undefined> {
        try {
            return Buffer.from(await vscode.workspace.fs.readFile(this.localUri(rel))).toString('utf-8');
        } catch {
            return undefined;
        }
    }

    private async existsLocal(rel: string): Promise<boolean> {
        try {
            await vscode.workspace.fs.stat(this.localUri(rel));
            return true;
        } catch {
            return false;
        }
    }

    private async deleteLocal(rel: string, type: FileType): Promise<void> {
        this.suppress(rel);
        try {
            await vscode.workspace.fs.delete(this.localUri(rel), { recursive: type === 'folder', useTrash: false });
        } catch { /* 本地已不存在 */ }
    }

    private async moveLocal(oldRel: string, newRel: string): Promise<void> {
        this.suppress(oldRel);
        this.suppress(newRel);
        const parts = newRel.split('/');
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.folderUri, ...parts.slice(0, -1)));
        try {
            await vscode.workspace.fs.rename(this.localUri(oldRel), this.localUri(newRel), { overwrite: true });
        } catch (err) {
            logError(`本地移动失败: ${oldRel} → ${newRel}`, err);
        }
    }

    private async isTextFile(rel: string, name: string): Promise<boolean> {
        const ext = path.posix.extname(name).toLowerCase();
        if (TEXT_EXTENSIONS.has(ext)) { return true; }
        if (BINARY_EXTENSIONS.has(ext)) { return false; }
        try {
            const bytes = await vscode.workspace.fs.readFile(this.localUri(rel));
            const head = bytes.subarray(0, 8000);
            return !head.includes(0);
        } catch {
            return false;
        }
    }

    // ---------- 内部 ----------

    private enqueue(task: () => Promise<void>) {
        this.queue = this.queue.then(task).catch(err => logError(`[${this.projectName}] 同步任务失败`, err));
    }

    private scheduleSave() {
        if (this.saveTimer) { clearTimeout(this.saveTimer); }
        this.saveTimer = setTimeout(() => {
            this.state.save().catch(err => logError('保存同步状态失败', err));
        }, 1000);
    }

    private checkAuthError(res: { type: string; message?: string }) {
        if (this.authErrorNotified) { return; }
        if (res.message && /^(401|403)/.test(res.message)) {
            this.authErrorNotified = true;
            this.setStatus('error');
            vscode.window.showErrorMessage(`Overleaf Sync: "${this.projectName}" 登录已过期，请重新登录后再同步`);
        }
    }
}
