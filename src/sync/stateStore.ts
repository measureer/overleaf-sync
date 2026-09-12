import * as vscode from 'vscode';

export const STATE_FILE_NAME = '.overleaf-sync.json';

export interface EntityRecord {
    id: string;
    type: 'doc' | 'file' | 'folder';
}

export interface SyncStateData {
    serverName: string;
    serverUrl: string;
    projectId: string;
    projectName: string;
    /** key: 相对项目根目录的 posix 路径，如 "sections/intro.tex" */
    entities: Record<string, EntityRecord>;
    /** key: docId */
    docVersions: Record<string, number>;
    updatedAt: string;
}

export class StateStore {
    private constructor(
        readonly folderUri: vscode.Uri,
        readonly data: SyncStateData,
    ) {}

    static fileUri(folderUri: vscode.Uri): vscode.Uri {
        return vscode.Uri.joinPath(folderUri, STATE_FILE_NAME);
    }

    static async load(folderUri: vscode.Uri): Promise<StateStore | undefined> {
        try {
            const raw = await vscode.workspace.fs.readFile(StateStore.fileUri(folderUri));
            const data = JSON.parse(Buffer.from(raw).toString('utf-8')) as SyncStateData;
            if (!data.projectId || !data.serverUrl) { return undefined; }
            return new StateStore(folderUri, data);
        } catch {
            return undefined;
        }
    }

    static create(
        folderUri: vscode.Uri,
        serverName: string,
        serverUrl: string,
        projectId: string,
        projectName: string,
    ): StateStore {
        return new StateStore(folderUri, {
            serverName,
            serverUrl,
            projectId,
            projectName,
            entities: {},
            docVersions: {},
            updatedAt: new Date().toISOString(),
        });
    }

    async save() {
        this.data.updatedAt = new Date().toISOString();
        await vscode.workspace.fs.writeFile(
            StateStore.fileUri(this.folderUri),
            Buffer.from(JSON.stringify(this.data, null, 2), 'utf-8'),
        );
    }

    /** 按实体 id 查找路径 */
    findPathById(id: string): string | undefined {
        for (const [rel, rec] of Object.entries(this.data.entities)) {
            if (rec.id === id) { return rel; }
        }
        return undefined;
    }

    /** 删除某路径及其全部子路径的映射 */
    removeRecursive(rel: string) {
        const prefix = rel + '/';
        for (const key of Object.keys(this.data.entities)) {
            if (key === rel || key.startsWith(prefix)) {
                const rec = this.data.entities[key];
                if (rec.type === 'doc') {
                    delete this.data.docVersions[rec.id];
                }
                delete this.data.entities[key];
            }
        }
    }

    /** 重命名/移动：把 oldRel 及其子路径迁移到 newRel 前缀下 */
    rekeyRecursive(oldRel: string, newRel: string) {
        const prefix = oldRel + '/';
        const moves: [string, string][] = [];
        for (const key of Object.keys(this.data.entities)) {
            if (key === oldRel) {
                moves.push([key, newRel]);
            } else if (key.startsWith(prefix)) {
                moves.push([key, newRel + '/' + key.slice(prefix.length)]);
            }
        }
        for (const [from, to] of moves) {
            this.data.entities[to] = this.data.entities[from];
            delete this.data.entities[from];
        }
    }
}
