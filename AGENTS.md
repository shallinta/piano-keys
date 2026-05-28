# AGENTS.md — piano-keys Agent 开发指南

## Skill 版本管理

每次 `skills/piano-keys-cr/` 目录下的文件（尤其是 `SKILL.md`）有更新时，**必须同步更新 `SKILL.md` 中的 `version` 版本号**。

版本号位于 SKILL.md 的 YAML frontmatter 中：

```yaml
---
name: piano-keys-cr
description: ...
version: 5
---
```

每次修改技能内容后，将 `version` 值 +1。`extension.ts` 依赖此版本号来判断是否需要提示用户更新已安装的技能。

## 配置项 Key 命名规范

所有 VSCode 配置项的 key **必须带两位数字编号前缀**，格式为 `'NN.name'`（对应 `package.json` 中 `piano-keys.NN.name`）。

**重要：** `config.get()` 和 `config.update()` 都必须使用带编号的完整 key。HTTP API（`POST /config`）的 `allowedKeys` 也要映射到带编号的 key。历史上曾因写入 `'theme'`（无编号）但读取 `'01.theme'`（有编号）导致主题切换后被重置的 bug。

### 当前所有配置 Key

| 编号 Key | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `'01.theme'` | string | `'piano-dark'` | 侧边栏主题 |
| `'02.defaultRemote'` | string | `'origin'` | 默认 git 远程名 |
| `'03.reviewDocPatterns'` | string[] | 3 个 glob 模式 | 评审规范文档匹配 |
| `'04.userSignature'` | string | `'「Powered by vscode \`Piano Keys\`」'` | 用户评论签名 |
| `'05.agentSignature'` | string | `'「Powered by vscode \`Piano Keys\`」'` | Agent 评论签名 |
| `'06.agentAppendToolName'` | boolean | `true` | Agent 评论末尾是否追加工具名 |
| `'07.gitProviders'` | array | GitHub 内置 provider | 自定义 Git provider 配置，支持 CLI provider；HTTP provider 为 P2 规划 |

### HTTP API Key 映射

`POST /config` 接收的 key 是简短形式（如 `theme`），内部必须映射到带编号的 key 再调用 `config.update()`：

```typescript
const keyMap: Record<string, string> = {
  theme: '01.theme',
  defaultRemote: '02.defaultRemote',
  reviewDocPatterns: '03.reviewDocPatterns',
  userSignature: '04.userSignature',
  agentSignature: '05.agentSignature',
  agentAppendToolName: '06.agentAppendToolName',
  gitProviders: '07.gitProviders',
};
```

新增配置项时，按顺序递增编号，并同步更新 `keyMap`。

## 版本发布流程

每次需要发布新版本时，**必须严格按以下顺序执行**：

### 1. 修改版本号和 CHANGELOG

- 更新 `package.json` 中的 `version` 字段
- 在 `CHANGELOG.md` 顶部添加新版本的变更说明

### 2. 打包并发布插件

```bash
# 编译
npm run compile

# 打包 VSIX 到 releases 目录
mkdir -p releases
npx @vscode/vsce package --out releases/
```

打包产物默认存放在 `releases/` 目录下。

**发布方式**：打包后得到 `.vsix` 文件（如 `releases/piano-keys-codereview-1.0.1.vsix`），需手动上传发布：
1. 打开 [VSCode Marketplace Publisher 管理页面](https://marketplace.visualstudio.com/manage/publishers/shallinta)
2. 点击 `piano-keys` 扩展进入详情页
3. 点击「Update」或「Upload」按钮，选择 `releases/` 目录下最新版本的 `.vsix` 文件
4. 确认版本号正确后提交发布

所有 `.vsix` 文件均提交到远端仓库（`.gitignore` 中不忽略 `*.vsix`）。

### 3. 提交代码和 Tag 到远端

```bash
# 提交变更（包括 releases/ 下的 vsix 产物）
git add .
git commit -m "chore: bump version to <version>, update CHANGELOG"

# 打 tag 并推送到远端（直接 push，无需创建 MR）
git tag v<version>
git push origin main v<version>
```

## 文档维护

每次项目功能迭代后，**必须同步更新 `skills/piano-keys-cr/SKILL.md` 中的以下内容**，确保文档描述与实际功能保持一致：

- **`## Default Behavior (No Specific Instructions)`** — 新增的功能入口、操作流程、review 模式等需要在此章节补充
- **`## Available Commands`** — 新增的 API 端点需要添加对应的 curl 示例
- **`## Rules`** — 新的使用限制或行为规范需要加入此章节
- **`## Common Mistakes`** — 新增的常见错误需要记录

文档落后于代码是最常见的问题之一。如果新增了一个功能但 SKILL.md 没有更新，Agent 就无法正确使用该功能。
