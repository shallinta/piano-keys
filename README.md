# Piano Keys CodeReview

[![Version](https://img.shields.io/badge/version-1.0.1-blue)](https://marketplace.visualstudio.com/items?itemName=shallinta.piano-keys-codereview)

> VSCode 代码评审插件，支持 AI Agent 辅助 Code Review

## 功能概览

- **分支对比（无需 MR）**：无需关联 MR/PR，只需填写源分支和目标分支，即可对比两个分支的代码差异并进行代码阅读和评审
- **MR 关联**：自动检测并关联 GitHub PR 或其他平台 MR，选择 MR 后可将评论提交到对应平台
- **评论生命周期**：评论经历 `待确认 → 已确认 → 已提交` 状态流转，用户完全控制
- **Agent 辅助评审**：Agent 通过 HTTP API 添加评审意见，用户审核决定保留或删除，遵循 Human in the Loop 理念——Agent 仅负责分析和建议，最终由用户决定保留哪些评论并提交到代码平台
- **双端同步**：侧边栏和 Diff 编辑器评论线程实时同步
- **远端评论跟踪**：关联 MR/PR 后可刷新远端已有评论；支持的平台会显示 resolved/unresolved 状态，并可在侧边栏中将未解决评论标记为已解决
- **回收站**：误删评论可恢复
- **本地 HTTP API**：外部 Agent（Claude Code、Codex 等）通过 curl 即可与插件交互

## 安装

### 方式一：VSCode 扩展市场搜索安装（推荐）

1. 打开 VSCode，点击左侧活动栏的 **扩展** 图标（或按 `Ctrl+Shift+X` / `Cmd+Shift+X`）
2. 搜索 **Piano Keys CodeReview**
3. 点击 **安装** 按钮

### 方式二：通过插件网页链接安装

点击以下链接一键安装：

```
vscode:extension/Shallinta.piano-keys-codereview
```

或访问 [Marketplace 页面](https://marketplace.visualstudio.com/items?itemName=Shallinta.piano-keys-codereview)，点击 **Install** 按钮，将自动打开本地 VSCode 并完成安装。

### 方式三：从 GitHub Releases 下载安装

1. 访问 [GitHub Releases 页面](https://github.com/shallinta/piano-keys/releases)
2. 下载最新版本的 `piano-keys-codereview-*.vsix` 文件
3. 在 VSCode 中执行命令：`Extensions: Install from VSIX...`
4. 选择下载的 `.vsix` 文件完成安装

## 用户使用指南

### 1. 开始评审

打开侧边栏 Piano Keys 面板，填写源分支和目标分支，点击 **打开对比**：

```
[选择 MR]  源分支: feature/my-branch → 目标分支: main → [打开对比]
```

也可以从命令面板执行 `Piano Keys: Start Code Review`。

> **无需 MR 也可以使用**：即使当前项目没有关联 MR/PR，插件依然可以对比任意两个分支的代码差异，进行代码阅读和评审。填写分支信息后直接点击"打开对比"即可进入评审，所有评论功能（添加、编辑、确认、删除）均可正常使用，只是无法将评论推送到代码平台。
>
> **全量文件评审**：目标分支填写 `{init}` 即可对比源分支的所有文件（相当于从无到有的全量代码评审），适用于新项目初始化、大幅重构等场景。

### 2. 关联 MR/PR

- **下拉选择**：下拉框自动加载当前仓库的 MR 列表
- **刷新列表**：点击下拉框右侧的 🔄 刷新按钮，重新从远端拉取最新的 MR 列表。当 MR 列表有更新（如新建了 MR、状态变更等）时，可通过刷新获取最新数据

选择 MR 后，评论可通过 **提交全部** 按钮推送到对应平台。

### 自定义 Git Provider

插件内置支持 GitHub。其他 Git 服务可通过 `piano-keys.07.gitProviders` 配置自定义 provider。本期自定义 provider 仅支持 `type: "cli"`；HTTP provider 属于 P2 规划，当前版本暂不可用。

普通用户可以只填写基础配置：

```json
"piano-keys.07.gitProviders": [
  {
    "id": "company-code",
    "label": "Company Code",
    "type": "cli",
    "remoteUrlPatterns": ["code.company.com"],
    "cli": "company-code"
  }
]
```

只填写基础配置后，插件可以识别当前仓库 provider，并继续使用本地 Git 分支对比、本地评论管理和报告导出；但无法加载远端 MR/PR 列表、提交评论到远端平台或刷新远端评论。推荐让 agent 使用 `piano-keys-cr` skill 通过交互式问答运行 `<cli> --help` 和相关子命令 help，自动补全 `adapter` 配置。

`adapter.capabilities` 用来声明哪些远端能力可用。一般规则：有对应 `adapter.commands.<name>` 且 capability 未设为 `false` 时，该能力会被启用；确认不支持时设为 `false`，避免插件或 Agent 误以为可用。完整字段含义如下：

| Capability | 含义 | 何时设为 `true` | 何时设为 `false` / 省略 |
|------------|------|-----------------|---------------------------|
| `checkAuth` | 认证状态检查 | CLI 有可安全执行的认证检查命令，退出码 0 表示已登录 | CLI 无认证检查命令；省略时缺少命令会按已通过处理 |
| `authLogin` | 登录能力标记 | 内置 provider 使用；自定义 provider 当前不会调用自定义登录命令 | 自定义 provider 建议省略或设 `false` |
| `listMRs` | 加载 MR/PR 列表 | CLI 能输出可解析的 MR/PR 列表 JSON | 无列表接口，或输出无法规范化 |
| `getMRByNumber` | 按编号打开 MR/PR | CLI 能按编号输出单个 MR/PR JSON | 平台不支持编号查询 |
| `getMRFromLink` | 按完整链接打开 MR/PR | CLI 能直接解析完整 MR/PR URL | 若 URL 中有 `/pull/<n>`、`/merge_requests/<n>` 或 `/mr/<n>` 且已配置 `getMRByNumber`，可省略 |
| `getMRId` | 分支对比时自动关联 MR/PR | CLI 能通过 source/target branch 查到对应 MR/PR | 不支持按分支反查 MR/PR |
| `submitComment` | 提交本地已确认评论到远端 | CLI 能创建行级/文件评论，并能安全接收多行 markdown 内容 | 只能本地评审、不能提交远端评论 |
| `listComments` | 拉取远端已有评论 | CLI 能输出远端评论列表 JSON | 不支持远端评论读取 |
| `remoteCommentResolutionState` | 远端评论是否包含 resolved/unresolved 状态 | `listComments` 输出包含 `Status/status` 或 `Resolved/resolved` 字段 | 无解决状态字段时设 `false`，评论会显示为 `unknown` |
| `resolveRemoteComment` | 在插件中解决远端评论 | CLI 能按 comment/thread id 将远端评论标记为 resolved；需要同时配置同名 command | 平台不支持解决评论，或只能人工在平台页面操作 |
| `reopenRemoteComment` | 重新打开远端评论 | 当前自定义 provider runtime 不会调用 | 保持 `false`，除非后续版本增加 runtime 支持 |

更详细的 adapter 命令需求、占位符和完整 JSON 模板见 `skills/piano-keys-cr/SKILL.md` 的 **Custom Git Provider Configuration** 章节。

安全说明：provider 命令只从用户本机 VSCode settings 读取，插件不会从仓库文件读取命令配置。请只配置可信 CLI，并确认该 CLI 已完成登录授权。

### 3. 添加评论

在 Diff 编辑器中，点击行号旁的 **+** 按钮添加评论。评论会同步显示在侧边栏的 **当前评论** tab。

### 4. 评论管理

> **重要提示**：所有评论（包括用户添加的和 Agent 添加的）在点击 **提交全部** 按钮前均保存在本地，不会自动推送到代码平台。用户可以随时查看、编辑、删除或确认评论，只有主动点击提交按钮后，已确认的评论才会发布到关联的 MR/PR。

侧边栏有四个 tab：

| Tab | 内容 |
|-----|------|
| 变更文件 | 当前评审的所有变更文件 |
| 当前评论 | 本次评审中添加的评论，按状态展示 |
| 远端评论 | 关联 MR 上已有的评论；支持的平台会显示解决状态，并可将未解决评论标记为已解决 |
| 回收站 | 已删除的评论（可恢复） |

> 选择 MR 后打开 Diff，系统会自动拉取该 MR 上的已有评论，展示在 **远端评论** tab 中。远端评论的解决状态取决于平台和 provider 能力：部分自定义 provider 支持读取 resolved/unresolved 并标记为已解决；GitHub 当前显示为 unknown 且不可通过插件解决。

评论状态流转：

| 状态 | 说明 | 操作 |
|------|------|------|
| 待确认 | Agent 添加的评论，等待用户审核 | 点击 **保留** 或 **删除** |
| 已确认 | 用户同意保留的评论 | 可编辑、删除、提交 |
| 已提交 | 已推送到代码平台的评论 | 只读 |

### 5. 提交评论

确认评论后，点击侧边栏底部的 **提交全部** 按钮，评论将发布到关联的 MR/PR。

> **注意**：必须先关联 MR 才能提交评论。如果未关联，系统会提示输入 MR 链接或编号。

### 6. 分阶段开发 + 自动评审工作流

当你在 Coding Agent（Claude Code、Codex、OpenCode 等）中进行多阶段/步骤的复杂功能开发时，可以在每个阶段完成后自动触发 Code Review：

1. **开发阶段完成**：Coding Agent 完成本阶段代码变更，推送到 feature 分支
2. **开启评审**：Coding Agent 开启一个子代理（或通知另一个 Agent），使用 `piano-keys-cr` 技能，基于 source/target 分支名打开评审（无需 MR）
3. **自动评审**：子代理读取 diff 内容，分析每个变更文件，通过 HTTP API 添加评审意见
4. **用户确认**：通知用户在 VSCode 插件侧边栏查看并确认/删除 AI 评论。**Agent 不会自动确认或提交评论**——遵循 Human in the Loop 理念，最终由用户决定保留哪些评论
5. **获取问题并修复**：开发 Agent 通过 `/state` 接口获取所有评论问题，自动修复
6. **修复后继续**：修复完成后，进入下一个开发阶段，重复上述流程

这种工作流特别适合大型功能开发，每个阶段都经过独立评审和修复，避免问题累积到最后。

> **Human in the Loop**：Agent 的职责是分析代码并提出评审建议，但不会自动确认或提交评论到代码平台。所有评论必须由用户审核后决定是否保留和提交，确保 AI 评审结果经过人工把关。

## Agent 使用指南

Agent 通过本地 HTTP API 与插件交互，**不依赖** `vscode.commands.executeCommand`。

### 连接配置

插件启动后会在 `~/.piano-keys/ports.json` 写入每个 VSCode 项目的端口和令牌。Agent 应优先按当前工作目录匹配对应项目：

```bash
PORT_TOKEN=$(python3 - <<'PY'
import json, os, sys
path = os.getcwd()
ports_file = os.path.expanduser('~/.piano-keys/ports.json')
with open(ports_file) as f:
    ports = json.load(f)
while path != '/':
    if path in ports:
        info = ports[path]
        print(f"{info['port']}:{info['token']}")
        sys.exit(0)
    path = os.path.dirname(path)
print('No active piano-keys instance found for this project', file=sys.stderr)
sys.exit(1)
PY
)
BASE="http://127.0.0.1:${PORT_TOKEN%%:*}"
AUTH_HEADER="Authorization: Bearer ${PORT_TOKEN#*:}"
```

如果连接失败，VSCode 可能重载导致端口变化；请重新读取 `ports.json` 后再重试。

### API 接口

#### 获取评审状态

返回当前会话的 `sessionId`、分支信息、`platform`、文件列表、评论列表。

```bash
curl -s $BASE/state -H "$AUTH_HEADER"
```

#### 获取配置

返回主题、签名、review 文档匹配规则、`agentAppendToolName` 和 `gitProviders` 等配置。Agent 添加评论前应先读取该接口，以确定是否必须在评论首行包含具体 tool-name。

```bash
curl -s $BASE/config -H "$AUTH_HEADER"
```

#### 打开评审

通过分支：
```bash
curl -s -X POST $BASE/open-review-by-branches -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{"sourceBranch": "feature/my-branch", "targetBranch": "main"}'
```

通过 MR/PR 链接：
```bash
curl -s -X POST $BASE/open-review-by-link -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{"link": "https://github.com/org/repo/pull/42"}'
```

通过 MR/PR 编号（会先从缓存的 MR 列表校验）：
```bash
curl -s -X POST $BASE/open-review-by-mr-number -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{"mrNumber": "42"}'
```

全量文件评审时，`targetBranch` 可以传 `{init}`：
```bash
curl -s -X POST $BASE/open-review-by-branches -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{"sourceBranch": "feature/my-branch", "targetBranch": "{init}"}'
```

#### 添加评论

```bash
curl -s -X POST $BASE/comments -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{"filePath": "src/utils/helper.ts", "lineNumber": 42, "content": "`[P1]` [**AI** —— by **claude code**]\n**问题：**建议使用 null-safe 访问。\n这里直接访问嵌套字段，若上游返回空对象可能触发异常。"}'
```

评论自动标记为 `author: "agent"`、`status: "pending"`，需用户审核后才可提交。
`agentAppendToolName` 默认开启，Agent 应在评论首行使用 `` `[Px]` [**AI** —— by **<tool-name>**] `` 以标识来源；如需添加评论后立即打开对应 Diff，可在请求体中额外传入 `"openDiff": true`。接口响应可能包含 `hint`，用于提示 tool-name 缺失或过早使用 `AI Assistant`，Agent 应检查并在必要时通过 `PATCH /comments/{id}` 修改刚创建的评论。

> **重要**：Agent 的职责仅限于**添加评论**。除非用户明确指令（如"帮我确认"、"帮我提交"），否则 Agent 不得调用 `/comments/confirm-all` 或 `/comments/submit-all`。这遵循 Human in the Loop 理念——AI 负责分析建议，用户负责最终决策。

#### 删除评论（软删除）

```bash
curl -s -X DELETE $BASE/comments/{commentId} -H "$AUTH_HEADER"
```

#### 获取/更新评论

```bash
# 获取单条评论
curl -s $BASE/comments/{commentId} -H "$AUTH_HEADER"

# 更新评论内容或状态（status: pending / confirmed / submitted / deleted）
curl -s -X PATCH $BASE/comments/{commentId} -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{"content": "updated text", "status": "confirmed"}'
```

#### 刷新远端评论

```bash
curl -s -X POST $BASE/refresh-remote-comments -H "$AUTH_HEADER"
```

重新从关联 MR/PR 拉取远端已有评论，返回 `count` 和 `comments`。远端评论对象包含 `resolution`（`resolved` / `unresolved` / `unknown`）以及平台支持时的 `canResolve`。

#### 确认所有 Agent 评论

```bash
curl -s -X POST $BASE/comments/confirm-all -H "$AUTH_HEADER"
```

将所有 `pending` 状态的 Agent 评论转为 `confirmed`。

#### 提交评论

```bash
curl -s -X POST $BASE/comments/submit-all -H "$AUTH_HEADER"
```

将所有已确认的评论提交到代码平台。

> **重要**：Agent **不得主动调用** `submit-all` 或 `confirm-all`，这是用户的决定。Agent 只有在用户明确指令（如"帮我确认"、"帮我提交"）时才可以调用。

#### 打开文件 Diff

```bash
curl -s -X POST $BASE/open-diff -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{"filePath": "src/utils/helper.ts"}'
```

### Agent 技能文件

插件自带 `piano-keys-cr` 技能（`skills/piano-keys-cr/SKILL.md`），包含完整的 API 使用指南和评审规范。

安装方式：

1. 侧边栏点击 **安装技能** 按钮
2. 或在命令面板执行 `Piano Keys: Install Code Review Skill`

技能会安装到 `~/.agents/skills/piano-keys-cr/`。

### 前置依赖

#### GitHub 用户
- 推荐安装 GitHub CLI (`gh`)，用于自动加载 PR 列表和提交评论
- 如未安装 `gh`，插件会回退到 `git` 命令完成基础评审功能
- `gh` 未登录时，插件会提醒运行 `gh auth login`
- `git` 命令返回权限错误时，插件会提醒检查 SSH Key / GitHub Token 配置

#### 自定义 Git Provider 用户
- 确保对应平台的 CLI 工具已安装并认证
- 未安装 CLI 时，插件会弹窗提醒，但仍可使用分支对比评审功能（无法加载 MR 列表和提交评论到平台）

## 架构

```
┌──────────────┐     ┌────────────────┐     ┌─────────────────┐
│  VSCode UI   │────▶│ Side Panel     │────▶│ CommentStore    │
│  Diff Editor │     │ Webview        │     │ (globalState)   │
└──────────────┘     └────────────────┘     └────────┬────────┘
                                                     │
┌──────────────┐     ┌────────────────┐     ┌────────▼────────┐
│  Agent/curl  │────▶│ HTTP Server    │────▶│ Coordinator     │
│  (HTTP API)  │     │ (Express)      │     │ + MR Submitter  │
└──────────────┘     └────────────────┘     └─────────────────┘
```

核心模块：

| 模块 | 职责 |
|------|------|
| **CommentStore** | 管理评论状态和评审会话，持久化到 VSCode globalState |
| **Coordinator** | 协调分支对比、MR 加载、评论提交等核心流程 |
| **DiffCommentController** | VSCode CommentController，同步侧边栏和 Diff 编辑器评论 |
| **HTTP Server** | Express 服务器，为外部 Agent 提供 REST API |
| **MR Submitter** | 支持 GitHub (`gh`) 和自定义 CLI provider 评论提交 |
| **平台检测** | 从 git remote 自动识别 GitHub 或自定义 provider |
