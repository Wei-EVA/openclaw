# Fork 恢复指南

本文档说明如何从你的 GitHub fork 恢复本地定制化的 OpenClaw 安装。

## 你的 Fork 信息

| 项目 | 值 |
|------|-----|
| Fork 仓库 | https://github.com/Wei-EVA/openclaw |
| 分支名称 | `nice-tereshkova` |
| 上游仓库 | https://github.com/clawdbot/clawdbot |

## 场景一：完全重装后恢复

当你需要重新安装系统或在新机器上恢复时：

```bash
# 1. 克隆你的 fork
git clone https://github.com/Wei-EVA/openclaw.git
cd openclaw

# 2. 切换到你的定制分支
git checkout nice-tereshkova

# 3. 添加上游仓库（用于后续同步官方更新）
git remote add upstream https://github.com/clawdbot/clawdbot.git

# 4. 安装依赖
pnpm install

# 5. 构建项目
pnpm build
```

## 场景二：本地仓库损坏后恢复

如果本地仓库出现问题但系统完好：

```bash
# 1. 备份当前目录（可选）
mv openclaw openclaw.backup

# 2. 重新克隆
git clone https://github.com/Wei-EVA/openclaw.git
cd openclaw
git checkout nice-tereshkova

# 3. 恢复任何未推送的本地配置
# 如果备份中有 ~/.openclaw 目录，可以复制回来
```

## 场景三：同步上游更新

当官方发布新版本，你想合并更新时：

```bash
# 1. 确保在你的分支上
git checkout nice-tereshkova

# 2. 获取上游更新
git fetch upstream

# 3. 合并上游 main 分支（会在冲突时提示）
git merge upstream/main

# 4. 如果有冲突，手动解决后：
git add .
git commit -m "merge: sync with upstream"

# 5. 推送到你的 fork
git push origin nice-tereshkova
```

## 场景四：回滚到特定版本

如果合并出现问题，想回滚：

```bash
# 查看提交历史
git log --oneline -20

# 回滚到特定提交（替换 <commit-hash>）
git reset --hard <commit-hash>

# 强制推送到 fork（谨慎使用）
git push --force origin nice-tereshkova
```

## 重要文件位置

| 文件/目录 | 用途 |
|-----------|------|
| `~/.openclaw/` | 运行时配置和会话数据 |
| `~/.openclaw/credentials/` | 认证凭据 |
| `~/.openclaw/sessions/` | Pi 会话记录 |
| `~/.openclaw/agents/` | Agent 配置和日志 |

这些目录不在 git 仓库中，重装后需要重新配置或从备份恢复。

## 定期备份建议

```bash
# 推送本地更改到 fork（建议每次重要修改后执行）
git add -A
git commit -m "backup: <描述你的更改>"
git push origin nice-tereshkova

# 备份运行时配置（可选）
tar -czvf openclaw-config-backup.tar.gz ~/.openclaw
```

## 快速命令参考

```bash
# 查看当前分支
git branch

# 查看远程仓库
git remote -v

# 查看本地与远程的差异
git status

# 查看未推送的提交
git log origin/nice-tereshkova..HEAD --oneline
```

## 注意事项

1. **不要直接在 main 分支上修改** - 始终在 `nice-tereshkova` 分支上工作
2. **定期推送到 fork** - 防止本地数据丢失
3. **合并前先备份** - 在执行 `git merge upstream/main` 前确保本地更改已推送
4. **冲突解决** - 合并冲突时，你的本地更改优先级更高，但要仔细检查官方更新是否包含重要修复
