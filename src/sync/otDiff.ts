import diff from 'fast-diff';

export interface OtOp {
    p: number;
    i?: string;
    d?: string;
}

/** 全文 diff → Overleaf OT ops。位置按 JS 字符串（UTF-16 code unit）计数。 */
export function diffToOps(oldText: string, newText: string): OtOp[] {
    const parts = diff(oldText, newText);
    const ops: OtOp[] = [];
    let pos = 0;
    for (const [type, text] of parts) {
        if (type === 0) {
            pos += text.length;
        } else if (type === 1) {
            ops.push({ p: pos, i: text });
            pos += text.length;
        } else {
            ops.push({ p: pos, d: text });
        }
    }
    return ops;
}

/** 应用远端 OT ops。op 文本是真实 UTF-8、位置按 UTF-16 code unit 计数（与参考项目一致；只有 joinDoc 的行内容才是 latin1 打包）。 */
export function applyOps(content: string, ops: OtOp[]): string {
    for (const op of ops) {
        if (op.i !== undefined) {
            content = content.slice(0, op.p) + op.i + content.slice(op.p);
        } else if (op.d !== undefined) {
            content = content.slice(0, op.p) + content.slice(op.p + op.d.length);
        }
    }
    return content;
}
