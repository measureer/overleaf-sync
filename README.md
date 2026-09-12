# Overleaf Sync

把 Overleaf / ShareLaTeX 项目**双向实时同步**到本地文件夹的 VS Code 扩展：

- 本地修改 LaTeX 文档并保存 → 实时推送到 Overleaf（网页端立即可见）
- 网页端（或协作者）的修改 → 实时写回本地文件
- 文件的新建、删除、重命名、移动双向同步
- 同时支持官方 `overleaf.com`（Cookie 登录）与自建 ShareLaTeX / Overleaf CE（账号密码登录）

实现原理参考 [overleaf-workshop/Overleaf-Workshop](https://github.com/overleaf-workshop/Overleaf-Workshop)：REST API 负责登录与文件结构操作，Socket.IO（0.9.x 老协议）负责文档内容的 OT 增量同步。

## 安装

```bash
npm install
npm run package   # 生成 overleaf-sync-0.1.0.vsix
```

然后在 VS Code 中：`Extensions` 面板 → `...` → `Install from VSIX…` 选择生成的 vsix 文件。

## 使用方法

### 1. 添加服务器并登录

在资源管理器侧栏找到 **Overleaf Sync** 面板，点击 `+` 添加服务器（默认 `https://www.overleaf.com`）。

推荐使用 **Cookie 登录**（overleaf.com 有验证码/SSO，账号密码登录通常不可用）：

1. 在已登录 Overleaf 的浏览器中按 `F12` 打开开发者工具，切换到 **Network** 标签页；
2. 地址栏访问 Overleaf 主页（如 `https://www.overleaf.com/project`）；
3. 在请求列表中筛选 `/project`，选中该请求；
4. 在 **Request Headers** 中找到 `Cookie`，复制其中 `overleaf_session2=...`（自建服务器为 `sharelatex.sid=...`）这一段；
5. 粘贴到扩展的登录输入框中。

自建服务器也可以选择 **账号密码登录**。

### 2. 同步项目到本地

- 展开服务器节点查看项目列表；
- 点击项目（或右键 → `同步到本地文件夹…`），选择一个本地目录；
- 扩展会把项目完整下载到该目录，并生成 `.overleaf-sync.json` 记录同步状态。

### 3. 双向同步

- 在本地目录中编辑 `.tex` 等文本文件并**保存**，改动会实时推送到 Overleaf；
- 在 Overleaf 网页端编辑，改动会在约 1 秒内写回本地文件；
- 本地新建/删除文件、新建文件夹都会同步到远端；远端的文件结构变更同样会镜像到本地。

### 4. 命令

命令面板（`Ctrl+Shift+P`）中以 `Overleaf Sync:` 开头：

| 命令 | 说明 |
|---|---|
| 添加服务器 / 登录 / 登出 / 移除服务器 | 服务器管理 |
| 同步到本地文件夹… | 选择项目并开始同步 |
| 停止同步 | 停止某个项目的同步会话 |
| 强制从远端拉取 | 放弃本地未同步改动，全部以远端为准 |
| 强制推送本地修改 | 把所有本地文档内容推送到远端（本地优先） |
| 打开日志 | 查看同步日志 |

状态栏会显示进行中的同步会话数量；断线时会自动重连并对齐状态。

## 冲突策略

- 文档内容基于 OT 版本号同步；版本掉队时自动重新拉取该文档全量内容；
- 恢复同步/重连时：若远端版本未变而本地内容不同 → 推送本地离线修改；若远端已变且本地也不同 → **远端优先**覆盖本地，并弹出提示；
- 本地与远端同时编辑同一文档时，后到的改动以远端为准（建议避免两端同时编辑）。

## 已知限制

- **本地重命名/移动文件**在远端表现为"删除 + 新建"（文件内容会保留，但 Overleaf 侧该文件的编辑历史关联会断开）；
- 本地修改**二进制文件**（图片、PDF 等）会先在远端删除再重新上传；
- 只同步保存到磁盘的内容；编辑器中未保存的改动不会推送；
- 不做编译与 PDF 预览——本地编译请配合 [LaTeX-Workshop](https://github.com/James-Yu/LaTeX-Workshop)。

## 手动测试清单

1. Cookie 登录 `overleaf.com`，项目列表正常显示；
2. 同步一个项目到空目录：所有 `.tex`/`.bib` 文档与图片等附件完整落盘；
3. 本地修改 `main.tex` 保存 → 网页端刷新可见改动；
4. 网页端修改文档 → 本地文件约 1 秒内更新；
5. 本地新建 `sections/intro.tex` → 远端出现对应文件夹与文档；
6. 网页端新建/重命名/删除文件 → 本地同步变化；
7. 关闭并重开 VS Code（工作区包含同步目录）→ 同步自动恢复；
8. 断网后再恢复 → 自动重连且内容对齐。

## 开发

```bash
npm install        # 安装依赖并自动应用 socket.io-client 补丁（patch-package）
npm run typecheck  # TypeScript 类型检查
npm run compile    # esbuild 打包到 dist/extension.js
npm run watch      # 监听构建
```

调试：在 VS Code 中打开本目录，按 `F5` 启动 Extension Development Host（需自行添加 `.vscode/launch.json`）。
