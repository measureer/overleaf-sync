import { SocketIOAPI, UpdateSchema } from '../api/socketio';
import { diffToOps, applyOps } from './otDiff';

/** 单个文档的 OT 状态：内容（'\n' 连接）与版本号 */
export class DocSession {
    version: number;
    content: string;

    constructor(readonly docId: string, version: number, content: string) {
        this.version = version;
        this.content = content;
    }

    static async join(socket: SocketIOAPI, docId: string): Promise<DocSession> {
        const res = await socket.joinDoc(docId);
        return new DocSession(docId, res.version, res.docLines.join('\n'));
    }

    /** 本地内容变更 → 生成 OT update；无变更返回 undefined */
    buildUpdate(newContent: string, source: string, userId: string): UpdateSchema | undefined {
        const ops = diffToOps(this.content, newContent);
        if (ops.length === 0) { return undefined; }
        return {
            doc: this.docId,
            op: ops,
            v: this.version,
            lastV: this.version,
            meta: { source, ts: Date.now(), user_id: userId },
        };
    }

    /** 推送成功后提交本地状态 */
    commitLocal(newContent: string) {
        this.content = newContent;
        this.version += 1;
    }

    /** 应用远端 update；版本掉队返回 undefined（调用方应重新 joinDoc） */
    applyRemote(update: UpdateSchema): string | undefined {
        if (update.v !== this.version) { return undefined; }
        if (update.op) {
            this.content = applyOps(this.content, update.op);
        }
        this.version += 1;
        return this.content;
    }
}
