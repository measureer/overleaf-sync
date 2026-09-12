/* eslint-disable @typescript-eslint/naming-convention */
import { Identity, ProjectEntity, FileEntity, FileType, FolderEntity, DocumentEntity, FileRefEntity } from './base';
import { log } from '../utils/log';

export function decodePackedUtf8(text: string): string {
    return Buffer.from(text, 'latin1').toString('utf-8');
}

export interface UpdateSchema {
    doc: string; //doc id
    op?: {
        p: number; //position
        i?: string; //insert
        d?: string; //delete
        u?: boolean; //isUndo
    }[];
    v: number; //doc version number
    lastV?: number; //last version number
    hash?: string; //(not needed if lastV is provided)
    meta?: {
        source: string; //socketio client id
        ts: number; //unix timestamp
        user_id: string;
    };
}

export interface SocketEvents {
    onFileCreated?: (parentFolderId: string, type: FileType, entity: FileEntity) => void;
    onFileRenamed?: (entityId: string, newName: string) => void;
    onFileRemoved?: (entityId: string) => void;
    onFileMoved?: (entityId: string, newParentFolderId: string) => void;
    onFileChanged?: (update: UpdateSchema) => void;
    onDisconnected?: () => void;
    onRejoinNeeded?: () => void;
}

type ConnectionScheme = 'v1' | 'v2';

export class SocketIOAPI {
    private scheme: ConnectionScheme = 'v1';
    private socket?: any;
    private emit: any;
    private joined = false;
    publicId = '';

    constructor(
        private readonly url: string,
        private readonly identity: Identity,
        private readonly projectId: string,
        private readonly events: SocketEvents,
    ) {}

    // Reference: "github:overleaf/overleaf/services/web/frontend/js/ide/connection/ConnectionManager.js#L137"
    private createSocket() {
        const io = require('socket.io-client');
        const origin = new URL(this.url).origin;
        const query = this.scheme === 'v2' ? `?projectId=${this.projectId}&t=${Date.now()}` : '';
        return io.connect(origin + query, {
            reconnect: true,
            'reconnection delay': 1000,
            'reconnection limit': 16000,
            'max reconnection attempts': 10,
            'force new connection': true,
            extraHeaders: {
                'Origin': origin,
                'Cookie': this.identity.cookies,
            },
        });
    }

    private promisifyEmit() {
        const socket = this.socket;
        this.emit = (event: string, ...args: any[]) => new Promise<any[]>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`socket emit timeout: ${event}`)), 5000);
            try {
                socket.emit(event, ...args, (err: any, ...data: any[]) => {
                    clearTimeout(timer);
                    if (err) {
                        reject(err instanceof Error ? err : new Error(String(err)));
                    } else {
                        resolve(data);
                    }
                });
            } catch (err) {
                clearTimeout(timer);
                reject(err);
            }
        });
    }

    private registerHandlers(onV2Joined?: (project: ProjectEntity, publicId: string) => void) {
        const s = this.socket;
        s.on('connect', () => {
            log('socketio: connected');
            const sessionId = s.socket?.sessionid;
            if (sessionId) { this.publicId = sessionId; }
            if (this.joined) {
                this.events.onRejoinNeeded?.();
            }
        });
        s.on('connect_failed', () => log('socketio: connect_failed'));
        s.on('forceDisconnect', (message: string) => log(`socketio: forceDisconnect ${message}`));
        s.on('connectionRejected', (err: any) => log(`socketio: connectionRejected ${err?.message || err}`));
        s.on('error', (err: any) => log(`socketio: error ${err?.message || err}`));
        s.on('disconnect', () => this.events.onDisconnected?.());
        s.on('connectionAccepted', (_: any, publicId: any) => {
            if (typeof publicId === 'string') { this.publicId = publicId; }
        });

        if (this.events.onFileCreated) {
            const handler = this.events.onFileCreated;
            s.on('reciveNewDoc', (parentFolderId: string, doc: DocumentEntity) => handler(parentFolderId, 'doc', doc));
            s.on('reciveNewFile', (parentFolderId: string, file: FileRefEntity) => handler(parentFolderId, 'file', file));
            s.on('reciveNewFolder', (parentFolderId: string, folder: FolderEntity) => handler(parentFolderId, 'folder', folder));
        }
        if (this.events.onFileRenamed) {
            s.on('reciveEntityRename', (entityId: string, newName: string) => this.events.onFileRenamed!(entityId, newName));
        }
        if (this.events.onFileRemoved) {
            s.on('removeEntity', (entityId: string) => this.events.onFileRemoved!(entityId));
        }
        if (this.events.onFileMoved) {
            s.on('reciveEntityMove', (entityId: string, folderId: string) => this.events.onFileMoved!(entityId, folderId));
        }
        if (this.events.onFileChanged) {
            s.on('otUpdateApplied', (update: UpdateSchema) => this.events.onFileChanged!(update));
        }

        if (this.scheme === 'v2' && onV2Joined) {
            s.on('joinProjectResponse', (res: any) => {
                onV2Joined(res.project as ProjectEntity, res.publicId as string);
            });
        }
    }

    /** 连接并加入项目：先 v1 方案，被 connectionRejected 则回退 v2 */
    async connect(): Promise<ProjectEntity> {
        const schemes: ConnectionScheme[] = ['v1', 'v2'];
        let lastError: any;
        for (const scheme of schemes) {
            this.scheme = scheme;
            try {
                return await this.tryJoin();
            } catch (err) {
                log(`socketio: joinProject failed with scheme ${scheme}: ${err}`);
                lastError = err;
                this.teardownSocket();
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    /** 断线重连后重新加入项目 */
    async rejoinProject(): Promise<ProjectEntity> {
        if (this.scheme === 'v2') {
            // v2 的连接与项目绑定，重连后需要全新 socket
            this.teardownSocket();
            this.joined = false;
            return this.tryJoin();
        }
        const returns = await this.emit('joinProject', { project_id: this.projectId }) as [ProjectEntity, string, number];
        return returns[0];
    }

    private tryJoin(): Promise<ProjectEntity> {
        return new Promise<ProjectEntity>((resolve, reject) => {
            this.socket = this.createSocket();
            this.promisifyEmit();

            const timeout = setTimeout(() => reject(new Error('joinProject timeout')), 15000);
            const done = (project: ProjectEntity, publicId?: string) => {
                clearTimeout(timeout);
                if (publicId) { this.publicId = publicId; }
                this.joined = true;
                resolve(project);
            };

            this.registerHandlers((project, publicId) => done(project, publicId));
            this.socket.on('connectionRejected', (err: any) => {
                clearTimeout(timeout);
                reject(new Error(err?.message || 'connectionRejected'));
            });

            if (this.scheme === 'v1') {
                // Reference: services/web/frontend/js/ide/connection/ConnectionManager.js#L427
                this.emit('joinProject', { project_id: this.projectId })
                    .then((returns: [ProjectEntity, string, number]) => done(returns[0]))
                    .catch((err: any) => {
                        clearTimeout(timeout);
                        reject(err);
                    });
            }
            // v2: 等待 joinProjectResponse 事件
        });
    }

    private teardownSocket() {
        if (!this.socket) { return; }
        try {
            if (typeof this.socket.removeAllListeners === 'function') {
                this.socket.removeAllListeners();
            }
            if (typeof this.socket.disconnect === 'function') {
                this.socket.disconnect();
            }
        } catch {
            // best-effort cleanup
        }
        this.socket = undefined;
    }

    disconnect() {
        this.joined = false;
        this.teardownSocket();
    }

    /**
     * Reference: services/web/frontend/js/ide/editor/Document.js#L500
     */
    async joinDoc(docId: string) {
        const returns = await this.emit('joinDoc', docId, { encodeRanges: true }) as [Array<string>, number, Array<any>, any];
        const [docLinesAscii, version, updates, ranges] = returns;
        const docLines = docLinesAscii.map((line) => decodePackedUtf8(line));
        return { docLines, version, updates, ranges };
    }

    /**
     * Reference: services/web/frontend/js/ide/editor/Document.js#L591
     */
    async leaveDoc(docId: string) {
        return this.emit('leaveDoc', docId).then(() => { return; });
    }

    /**
     * Reference: services/web/frontend/js/ide/editor/ShareJsDocs.js#L78
     */
    async applyOtUpdate(docId: string, update: UpdateSchema) {
        return this.emit('applyOtUpdate', docId, update).then(() => { return; });
    }
}
