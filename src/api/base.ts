/* eslint-disable @typescript-eslint/naming-convention */
import FormData from 'form-data';
import { lookup as mimeLookup } from 'mime-types';
import { fetch } from 'undici';

function getSetCookie(res: any): string[] {
    if (typeof res.headers?.getSetCookie === 'function') {
        return res.headers.getSetCookie();
    }
    const raw = res.headers?.raw?.()?.['set-cookie'];
    return raw || [];
}

export interface Identity {
    csrfToken: string;
    cookies: string;
}

export type FileType = 'doc' | 'file' | 'folder';

export interface FileEntity {
    _id: string;
    name: string;
    _type?: FileType;
}

export interface DocumentEntity extends FileEntity {
    version?: number;
}

export interface FileRefEntity extends FileEntity {
    created?: string;
}

export interface FolderEntity extends FileEntity {
    docs: DocumentEntity[];
    fileRefs: FileRefEntity[];
    folders: FolderEntity[];
}

export interface ProjectEntity {
    _id: string;
    name: string;
    rootDoc_id?: string;
    rootFolder: FolderEntity[] | FolderEntity;
}

export interface ProjectPersist {
    id: string;
    name: string;
    lastUpdated?: string;
    accessLevel?: string;
    archived?: boolean;
    trashed?: boolean;
}

export interface ResponseSchema {
    type: 'success' | 'error';
    message?: string;
    userInfo?: { userId: string; userEmail: string };
    identity?: Identity;
    projects?: ProjectPersist[];
    entity?: FileEntity;
    content?: Uint8Array;
}

export class BaseAPI {
    private identity?: Identity;

    constructor(private readonly url: string) {}

    setIdentity(identity: Identity) {
        this.identity = identity;
        return this;
    }

    private async getCsrfToken(): Promise<Identity> {
        const res = await fetch(this.url + 'login', { method: 'GET', redirect: 'manual' });
        const body = await res.text();
        const match = body.match(/<input.*name="_csrf".*value="([^"]*)">/);
        if (!match) {
            throw new Error('Failed to get CSRF token.');
        }
        const cookies = getSetCookie(res)[0]?.split(';')[0] ?? '';
        return { csrfToken: match[1], cookies };
    }

    private async getUserId(cookies: string) {
        const res = await fetch(this.url + 'project', {
            method: 'GET', redirect: 'manual',
            headers: { 'Connection': 'keep-alive', 'Cookie': cookies },
        });
        const body = await res.text();
        const userIdMatch = body.match(/<meta\s+name="ol-user_id"\s+content="([^"]*)">/);
        const userEmailMatch = body.match(/<meta\s+name="ol-usersEmail"\s+content="([^"]*)">/);
        const csrfTokenMatch = body.match(/<meta\s+name="ol-csrfToken"\s+content="([^"]*)">/);
        if (userIdMatch && csrfTokenMatch) {
            return {
                userId: userIdMatch[1],
                userEmail: userEmailMatch ? userEmailMatch[1] : '',
                csrfToken: csrfTokenMatch[1],
            };
        }
        return undefined;
    }

    async passportLogin(email: string, password: string): Promise<ResponseSchema> {
        const identity = await this.getCsrfToken();
        const res = await fetch(this.url + 'login', {
            method: 'POST', redirect: 'manual',
            headers: {
                'Accept': '*/*',
                'Connection': 'keep-alive',
                'Content-Type': 'application/json',
                'Cookie': identity.cookies,
                'X-Csrf-Token': identity.csrfToken,
            },
            body: JSON.stringify({ _csrf: identity.csrfToken, email: email, password: password }),
        });

        if (res.status === 302) {
            const redirect = ((await res.text()).match(/Found. Redirecting to (.*)/) as any)?.[1];
            if (redirect === '/project') {
                const cookies = getSetCookie(res)[0] ?? '';
                return this.cookiesLogin(cookies);
            }
            return { type: 'error', message: `Redirecting to ${redirect}` };
        } else if (res.status === 200) {
            return { type: 'error', message: (await res.json() as any)?.message?.message ?? '登录失败' };
        } else if (res.status === 401) {
            return { type: 'error', message: (await res.json() as any)?.message?.text ?? '认证失败' };
        }
        return { type: 'error', message: `${res.status}: ${await res.text()}` };
    }

    async cookiesLogin(cookies: string): Promise<ResponseSchema> {
        const res = await this.getUserId(cookies);
        if (!res) {
            return { type: 'error', message: '无法获取用户信息，Cookie 可能已过期' };
        }
        const identity: Identity = await this.updateCookies({ cookies, csrfToken: res.csrfToken });
        return {
            type: 'success',
            userInfo: { userId: res.userId, userEmail: res.userEmail },
            identity,
        };
    }

    async updateCookies(identity: Identity): Promise<Identity> {
        const res = await fetch(this.url + 'socket.io/socket.io.js', {
            method: 'GET', redirect: 'manual',
            headers: { 'Connection': 'keep-alive', 'Cookie': identity.cookies },
        });
        const cookies = getSetCookie(res)[0]?.split(';')[0];
        if (cookies) {
            identity.cookies = `${identity.cookies}; ${cookies}`;
        }
        return identity;
    }

    private isTransientError(statusCode?: number, errorMessage?: string): boolean {
        if (statusCode === undefined) {
            return true;
        }
        if (statusCode >= 500 || statusCode === 429) {
            return true;
        }
        if (errorMessage && (
            errorMessage.includes('ECONNRESET') ||
            errorMessage.includes('ETIMEDOUT') ||
            errorMessage.includes('ECONNREFUSED') ||
            errorMessage.includes('ENOTFOUND') ||
            errorMessage.includes('socket hang up')
        )) {
            return true;
        }
        return false;
    }

    private async request(
        type: 'GET' | 'POST' | 'DELETE',
        route: string,
        body?: FormData | object,
        callback?: (res?: string) => object | undefined,
    ): Promise<ResponseSchema> {
        if (this.identity === undefined) {
            return Promise.reject(new Error('not authenticated'));
        }

        const MAX_HTTP_RETRIES = 2;
        let lastError = '';

        for (let attempt = 0; attempt <= MAX_HTTP_RETRIES; attempt++) {
            try {
                const headers: Record<string, string> = {
                    'Connection': 'keep-alive',
                    'Cookie': this.identity.cookies,
                };
                let rawBody: any;
                if (body instanceof FormData) {
                    Object.assign(headers, body.getHeaders());
                    rawBody = body.getBuffer();
                } else if (body !== undefined) {
                    headers['Content-Type'] = 'application/json';
                    rawBody = JSON.stringify({ _csrf: this.identity.csrfToken, ...body });
                }
                if (type !== 'GET') {
                    headers['X-Csrf-Token'] = this.identity.csrfToken;
                }

                const res = await fetch(this.url + route, {
                    method: type, redirect: 'manual', headers, body: rawBody,
                });

                if (res.status === 200 || res.status === 204) {
                    const text = res.status === 200 ? await res.text() : undefined;
                    const response = callback && callback(text);
                    return { type: 'success', ...response } as ResponseSchema;
                } else if (this.isTransientError(res.status) && attempt < MAX_HTTP_RETRIES) {
                    const delayMs = Math.min(1000 * Math.pow(2, attempt), 4000);
                    lastError = `${res.status}: ${await res.text().catch(() => '')}`;
                    await new Promise(r => setTimeout(r, delayMs));
                    continue;
                } else {
                    return { type: 'error', message: `${res.status}: ${await res.text()}` };
                }
            } catch (err: any) {
                const errMsg = err?.message || String(err);
                if (this.isTransientError(undefined, errMsg) && attempt < MAX_HTTP_RETRIES) {
                    const delayMs = Math.min(1000 * Math.pow(2, attempt), 4000);
                    lastError = errMsg;
                    await new Promise(r => setTimeout(r, delayMs));
                    continue;
                }
                return { type: 'error', message: errMsg };
            }
        }

        return { type: 'error', message: lastError || 'request failed' };
    }

    private async download(route: string): Promise<Buffer> {
        if (this.identity === undefined) {
            return Promise.reject(new Error('not authenticated'));
        }
        const content: Buffer[] = [];
        while (true) {
            const res = await fetch(this.url + route, {
                method: 'GET', redirect: 'manual',
                headers: { 'Connection': 'keep-alive', 'Cookie': this.identity.cookies },
            });
            if (res.status === 200 || res.status === 206) {
                content.push(Buffer.from(await res.arrayBuffer()));
                if (res.status === 200) { break; }
            } else {
                break;
            }
        }
        return Buffer.concat(content);
    }

    async logout(): Promise<ResponseSchema> {
        return this.request('POST', 'logout');
    }

    async userProjectsJson(): Promise<ResponseSchema> {
        return this.request('GET', 'user/projects', undefined, (res) => {
            const projects = (JSON.parse(res!) as any).projects as any[];
            projects.forEach(project => {
                project.id = project._id;
                delete project._id;
            });
            return { projects };
        });
    }

    async getFile(projectId: string, fileId: string): Promise<ResponseSchema> {
        const content = await this.download(`project/${projectId}/file/${fileId}`);
        return { type: 'success', content: new Uint8Array(content) };
    }

    async addDoc(projectId: string, parentFolderId: string, filename: string): Promise<ResponseSchema> {
        return this.request('POST', `project/${projectId}/doc`, { parent_folder_id: parentFolderId, name: filename }, (res) => {
            const { _id } = JSON.parse(res!) as any;
            return { entity: { _type: 'doc', _id, name: filename } as FileEntity };
        });
    }

    async uploadFile(projectId: string, parentFolderId: string, filename: string, fileContent: Uint8Array): Promise<ResponseSchema> {
        const formData = new FormData();
        const mimeType = mimeLookup(filename);
        formData.append('targetFolderId', parentFolderId);
        formData.append('name', filename);
        formData.append('type', mimeType ? mimeType : 'text/plain');
        formData.append('qqfile', Buffer.from(fileContent), { filename });

        return this.request('POST', `project/${projectId}/upload?folder_id=${parentFolderId}`, formData, (res) => {
            const { entity_id, entity_type } = JSON.parse(res!) as any;
            return { entity: { _type: entity_type, _id: entity_id, name: filename } as FileEntity };
        });
    }

    async addFolder(projectId: string, folderName: string, parentFolderId: string): Promise<ResponseSchema> {
        return this.request('POST', `project/${projectId}/folder`, { name: folderName, parent_folder_id: parentFolderId }, (res) => {
            const entity = JSON.parse(res!) as FolderEntity;
            return { entity };
        });
    }

    async deleteEntity(projectId: string, fileType: FileType, fileId: string): Promise<ResponseSchema> {
        return this.request('DELETE', `project/${projectId}/${fileType}/${fileId}`);
    }

    async renameEntity(projectId: string, entityType: string, entityId: string, name: string): Promise<ResponseSchema> {
        return this.request('POST', `project/${projectId}/${entityType}/${entityId}/rename`, { name });
    }

    async moveEntity(projectId: string, entityType: string, entityId: string, newParentFolderId: string): Promise<ResponseSchema> {
        return this.request('POST', `project/${projectId}/${entityType}/${entityId}/move`, { folder_id: newParentFolderId });
    }
}
