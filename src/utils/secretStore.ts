import * as vscode from 'vscode';
import { Identity } from '../api/base';

export interface ServerConfig {
    name: string;   // hostname, e.g. "www.overleaf.com"
    url: string;    // origin with trailing slash, e.g. "https://www.overleaf.com/"
    userEmail?: string;
}

export interface StoredIdentity extends Identity {
    userId: string;
    userEmail: string;
}

const SERVERS_KEY = 'overleaf-sync.servers';
const identityKey = (name: string) => `overleaf-sync.identity.${name}`;

export class ConfigStore {
    constructor(private readonly context: vscode.ExtensionContext) {}

    getServers(): ServerConfig[] {
        return this.context.globalState.get<ServerConfig[]>(SERVERS_KEY, []);
    }

    async updateServer(server: ServerConfig) {
        const servers = this.getServers().filter(s => s.name !== server.name);
        servers.push(server);
        await this.context.globalState.update(SERVERS_KEY, servers);
    }

    async removeServer(name: string) {
        const servers = this.getServers().filter(s => s.name !== name);
        await this.context.globalState.update(SERVERS_KEY, servers);
        await this.context.secrets.delete(identityKey(name));
    }

    async getIdentity(name: string): Promise<StoredIdentity | undefined> {
        const raw = await this.context.secrets.get(identityKey(name));
        return raw ? JSON.parse(raw) as StoredIdentity : undefined;
    }

    async setIdentity(name: string, identity: StoredIdentity) {
        await this.context.secrets.store(identityKey(name), JSON.stringify(identity));
    }

    async deleteIdentity(name: string) {
        await this.context.secrets.delete(identityKey(name));
    }
}
