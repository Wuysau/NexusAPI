# Git 提交后自动同步

在本地仓库设置 `origin`，并确认有 `main` 分支及其推送权限。运行 `npm run hooks:install` 启用仓库级 `post-commit` hook。之后每次完成 `git commit`，hook 会读取当前提交，在干净的 `main` 工作树中创建合并提交，并以普通推送更新 `origin/main`。直接在 `main` 提交时只推送 `main`。保存文件本身不会触发 Git hook。

```sh
git remote add origin https://github.com/Wuysau/NexusAPI.git
npm run hooks:install
```

`origin` 已存在时无需再次添加。安装命令只修改本地 `core.hooksPath`，不会覆盖已经配置为其他目录的 hook。自动同步脚本位于 `scripts/git-auto-sync.mjs`；手动重试可运行 `npm run git:sync`。

同步前会检查远端连接、`main` 工作树状态及远端分支关系。主分支有未提交改动、远端发生分叉或合并冲突时，同步停止且不会强制推送。Git 的 `post-commit` 不能撤销已完成的原始提交；遇到失败应先处理错误，再运行 `npm run git:sync`。如果当前提交所在分支已包含在 `main` 中，重试只会推送尚未推送的 `main`。

本地 hook 仅在安装过的克隆中生效，其他克隆需各自运行 `npm run hooks:install`。网络或认证失败时，代码仍保存在本地提交中，远端不会更新。

可运行 `npm run test:hooks` 验证本地临时 Git 仓库中的合并、推送、失败保护和 hook 触发；该测试也包含在 `npm test` 中。

如果本地工作分支使用了与公开 `main` 不同的历史，可以在确认某个本地提交的公开文件已发布后，将该提交记录为本地 `nexus.autoSyncBaseline`。hook 此后只发布该基线之后变更的非忽略文件，并在同一文件被主分支独立修改时拒绝覆盖。此配置仅适用于已完成公开快照对齐的仓库，不应指向未经核对的提交。
