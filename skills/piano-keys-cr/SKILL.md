---
name: piano-keys-cr
description: Use when reviewing code diffs, creating inline review comments, or managing MR comments via the piano-keys VSCode extension. Trigger whenever the user mentions code review, CR, reviewing changes, opening a diff, comparing branches, submitting or confirming review comments, or asks to review a merge request or pull request. Also use when the user wants AI-assisted code review on any branch comparison.
version: 44
---

# Piano Keys CodeReview

## Overview

Agent interface for the piano-keys VSCode extension. Adds review comments to an active review session via HTTP API.

## Human in the Loop — Core Principle

**All agent review results must be reviewed by a human before being submitted to the MR platform.**

When you add review comments via the `/comments` API, they are created with `status: "pending"` — awaiting human review. **Do NOT automatically confirm or submit comments** unless the user explicitly instructs you to do so.

### CRITICAL: Review Only — Do NOT Modify Code

**When the user asks you to review code using this plugin, your ONLY job is to analyze and add comments. You MUST NOT modify any project files or code content.**

- The review process is: find issues → add comments via `/comments` API → user reviews → user decides whether to fix
- Do NOT auto-fix issues you find. Do NOT write code changes to project files. Do NOT create new files as "suggested fixes".
- Even if you spot a P0 bug, only add a comment describing the issue. The user will decide how to handle it.
- The only exception: the user explicitly tells you to fix specific issues (e.g., "帮我修复 P0 问题" or "fix all P0 bugs"). Only then should you modify files.

### When NOT to auto-confirm/submit (default behavior):

- User says "code review", "帮我 review", "评审一下", "分析这个 MR" — only add comments, then notify the user to review in the side panel
- User says "install skill and review" — only add comments, do NOT call `/confirm-all` or `/submit-all`
- Any general review request — your job is to **analyze and suggest**, the user decides what to keep

### When it IS appropriate to confirm/submit (only with explicit user intent):

- User says "帮我确认评论" or "confirm all comments" — call `/comments/confirm-all`
- User says "帮我提交评论" or "submit comments" — call `/comments/submit-all` (after confirming they are confirmed)
- User says "自动确认并提交" or "auto-confirm and submit" — call both endpoints in sequence
- User says "全部确认然后提交" — call both endpoints in sequence

**The key signal**: the user must explicitly mention **确认/confirm** or **提交/submit** in their instruction. Without these words, only add comments and notify the user.

### Ambiguous Intent — Ask for Clarification:

If the user's instruction is ambiguous — for example, "帮我评审并提交评论" (could mean "add review comments" or "add + confirm + submit") — **you MUST ask the user once to clarify** before proceeding. Example:

> 我完成评审后会添加评论到侧边栏。请问你需要我自动确认并提交到 MR，还是仅添加评论由你审核后决定？

Do NOT guess the user's intent. When in doubt, ask.

### Agent Review Workflow (default):

1. Read diff content via `git diff` commands
2. Analyze each changed file and add comments via `POST /comments`
3. **Stop** — notify the user with a review summary (see "Review Summary" section), including:
   - 变更概览、评论统计（P0/P1/P2 数量）、重点问题、总体风险评估
   - 提醒用户：在 VSCode 侧边栏「当前评论」tab 中查看每条评论，可点击 **保留**（确认）、**删除** 或 **编辑**
4. User reviews each comment in the VSCode side panel, clicks **保留** (keep) or **删除** (delete)
5. User clicks **提交全部** to push confirmed comments to the MR platform

### Re-review Existing Agent Comments

When the user already asked an agent to review and add comments, then asks for another review / re-review / 重新评审:

1. Fetch the latest diff and perform a full review again — do not only inspect old comments.
2. Also fetch current review state via `GET /state` and compare existing local agent comments against the latest diff/source branch.
3. For each previous comment, decide whether the issue still exists, was fixed, became obsolete, or needs an updated comment.
4. If a previous issue appears fixed, **ask the user whether to delete that corresponding local comment card** (move it to recycle bin). Do NOT delete automatically unless the user explicitly agrees.
5. In the review summary, include a short "旧评论复核" section: fixed/obsolete/still-valid counts and any comments you recommend deleting.

### After Fixing Comments

When the user asks the agent to fetch comments through piano-keys and fix the reported issues:

- Track every evaluated comment with an outcome: `fixed`, `not fixed`, or `ignored`.
- For **current local comments** (`comments` from `/state`): only delete/move to recycle bin the comments whose issues were actually fixed in code. Comments evaluated as ignorable, not worth changing, false positive, out of scope, or intentionally left unchanged MUST remain in the current comments list unless the user explicitly asks to delete them.
- For **remote MR comments** (`remoteComments` from `/state` or `/refresh-remote-comments`): only resolve comments whose issues were actually fixed in code. Comments evaluated as ignorable, not worth changing, false positive, out of scope, or intentionally left unchanged MUST remain unresolved unless the user explicitly asks to resolve them.
- Do not auto-delete local comments or auto-resolve remote comments unless the user explicitly agrees and the available platform/API supports the operation.
- After finishing the fix pass, provide a list-style report covering **all evaluated comments**:
  - **已修复**: comment id/location, what was fixed, and how it was verified.
  - **未修复/已忽略**: comment id/location, why it was not fixed or why it was ignored.
  - **后续操作提示**: clearly state that unfixed/ignored comments were not deleted or resolved, then ask whether the user wants batch delete/resolve anyway, or prefers to decide manually in the side panel / MR platform.

## Default Behavior (No Specific Instructions)

When this skill is triggered but the user hasn't given specific instructions (e.g., they just said "code review" or "帮我 review 一下"), follow these steps:

0. **CRITICAL — Confirm project before reviewing**: First call `curl -s $BASE/state -H "$AUTH_HEADER"` to get the current review session. Tell the user which project the review belongs to and confirm it's the right one. Example:
   > 当前插件连接的评审项目为 **<project-name>**，评审的是 `feature/xxx` → `main`（MR #42）。请确认这是你需要评审的项目，如需切换请先在 VSCode 中打开对应项目。
1. **Introduce the plugin capabilities** — show the full feature overview below
2. **Guide the user to start** — ask for branches or MR link, or explain how to open the side panel manually
3. **Explain the two review modes** (manual vs. agent-assisted)
4. **Ask the user which mode they prefer** and proceed accordingly

### Plugin Capabilities

piano-keys provides a VSCode side panel for code review with:

**Core Features:**

- **分支对比（无需 MR）**：无需关联 MR/PR，只需填写源分支和目标分支，即可对比两个分支的代码差异并进行代码阅读和评审。即使没有 MR，所有评论功能（添加、编辑、确认、删除）均可正常使用，只是无法提交到代码平台
- **MR/PR 关联**：自动检测并关联 GitHub PR 或其他 Git 平台 MR，关联后可将评论提交到对应平台
- **评论保存在本地**：所有评论在用户点击 **提交全部** 按钮前均保存在本地，不会自动推送到代码平台。用户可随时查看、编辑、删除评论，只有主动提交后评论才会发布到 MR/PR
- **评论生命周期**：评论经历 `pending → confirmed → submitted/deleted` 状态流转，用户完全控制
- **Agent 辅助评审**：Agent 通过 HTTP API 添加评审意见，用户审核决定保留或删除
- **双端同步**：侧边栏和 Diff 编辑器评论线程实时同步
- **回收站**：误删评论可恢复
- **本地 HTTP API**：外部 Agent（Claude Code、Codex 等）通过 curl 即可与插件交互
- **清空对比**：可清空当前变更文件、本地评论、远端评论和回收站，同时保留当前 MR/分支选择，便于重新打开最新 diff
- **远端评论跟踪**：关联 MR/PR 后可刷新远端已有评论；支持的平台会返回 resolved/unresolved 状态，并允许在侧边栏将未解决评论标记为已解决
- **多主题**：5 套主题可选（Piano Dark/Light、Midnight Blue、Nocturne Purple、Classic Light）
- **统一通知浮层**：插件提示、确认、输入和选择交互会优先显示在 VSCode 侧边栏底部，并自动适配当前主题；当侧边栏未就绪时会降级为 VSCode 原生弹窗
- **签名配置**：支持用户和 Agent 分别配置签名，自动追加到评论末尾

**Side Panel Interface:**

- **Four tabs**: 变更文件 (changed files), 当前评论 (local comments), 远端评论 (remote MR comments with resolution status when supported), 回收站 (recycle bin)
- **File tree**: 所有目录默认展开；连续空目录合并；当前打开的文件高亮
- **Comment cards**: 显示作者、文件路径、行号、状态标签、操作按钮
- **Quick filter toggle**: 顶部可快速筛选"我的评论" / "AI 评论" / "已提交"

**Comment Status:**
| Status | Description | Available Actions |
|--------|-------------|-------------------|
| pending | Agent-added comments awaiting review | 保留 (keep) / 删除 (delete) |
| confirmed | User-approved comments | 编辑 / 删除 / 提交 |
| submitted | Comments pushed to MR platform | Read-only |
| deleted | Soft-deleted comments | 恢复 (restore from trash) |

### Opening a Diff Review

**Via branches:** Tell the user to provide the source branch and target branch, or use the side panel's "打开对比" button. You can also open it for them:

```bash
curl -s -X POST $BASE/open-review-by-branches -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{"sourceBranch": "feature/my-branch", "targetBranch": "main"}'
```

**Via MR/PR link:** If the user provides a GitHub PR or other MR link, use the link endpoint directly:

```bash
curl -s -X POST $BASE/open-review-by-link -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{"link": "https://github.com/org/repo/pull/42"}'
```

You do NOT need to manually extract branches — the plugin will parse the link, resolve branches, and open the review automatically.

### Manual Review vs. Agent Review

| Mode              | How it works                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Manual Review** | User opens the Diff Editor, reads the changes, and adds comments directly in the diff editor. Comments appear immediately in the side panel. User reviews, confirms, and submits comments themselves.                                                                                                                                                                                                                                                                           |
| **Agent Review**  | User opens the Diff Editor first (minimum requirement). Then the agent reads the diff via `git diff` commands, analyzes each changed file, and adds review comments via the HTTP API. Agent comments appear as `pending` status with `[AI]` prefix. **The agent MUST NOT auto-confirm or auto-submit** — the user reviews each agent comment, decides to **保留** (keep/confirm) or **删除** (delete). Confirmed comments can then be submitted to the MR platform by the user. |

### Platform Differences

| Platform                       | Comment submission                                    |
| ------------------------------ | ----------------------------------------------------- |
| **GitHub**                     | Comments are submitted as PR review comments          |
| **GitLab / Gitea / Others**    | Comments are submitted as MR comments via custom CLI provider |

The plugin auto-detects the platform from the git remote. The review workflow is the same for both platforms.

### Retain (保留) Operation

When agent comments appear in the side panel or diff editor, each has a **保留** (keep) button. Clicking it changes the comment status from `pending` to `confirmed`, meaning the user agrees with the comment and wants to keep it. Only confirmed comments can be submitted to the MR platform. Deleted comments go to the recycle bin (回收站 tab) where they can be restored.

### Closing

After explaining the above, **always ask the user**:

- 是否需要我帮你打开 Diff 面板？请提供源分支和目标分支，或者给我一个 MR/PR 链接。
- 你想用人工 review 还是 Agent 辅助 review？

### Detecting Already-Open MR Review

When the skill is triggered but the user has not explicitly provided an MR number or link, first check whether a diff review is already open:

```bash
curl -s $BASE/state -H "$AUTH_HEADER"
```

If the response contains `mrInfo` (non-null), it means the user has already opened a diff review for that MR. **Do NOT ask the user to provide an MR again** — instead, briefly introduce the open MR and ask if they want to proceed with reviewing it:

> 当前已打开 MR #${mrInfo.id} — ${mrInfo.title}（${mrInfo.sourceBranch} → ${mrInfo.targetBranch}），是否开始基于此 MR 进行评审？如需切换其他 MR，请提供 MR 编号或链接。

The `/state` response also includes `mrList` (the full MR list), which you can use to show available MRs if the user wants to switch.

If `mrInfo` is `null` (no MR associated) but there is an active review session (`sourceBranch` and `targetBranch` are set), tell the user:

> 当前已打开分支对比：${sourceBranch} → ${targetBranch}，但未关联 MR。是否开始评审？如需关联 MR 以便提交评论到代码平台，请提供 MR 编号或链接。

### Multi-Agent Review

When introducing Agent-assisted review, inform the user that piano-keys supports **multi-agent collaboration**:

- The plugin runs a local HTTP server per VSCode instance, with a unique port and token
- **Multiple Agent tools** (e.g., Claude Code, Codex, Open Code) can run in separate terminals or as sub-agents, all connecting to the **same** piano-keys instance via its HTTP API
- Each agent can independently add review comments to the same MR/project — all comments appear in the same review session and are distinguished by author (agent)
- This allows users to leverage different agents' strengths: one for security review, one for code style, one for architecture analysis, etc.

Example workflow:

1. Open the project in VSCode — piano-keys starts on port `12345` with token `abc...`
2. Terminal 1: Run `claude code` → connects to `http://127.0.0.1:12345` → adds comments
3. Terminal 2: Run `codex` → connects to same port → adds more comments
4. All comments appear in the side panel "当前评论" tab, user reviews and confirms each one

The port and token are stored in `~/.piano-keys/ports.json`, so any agent tool can discover them.

### Sub-agent Delegation Requirements

When you dispatch a sub-agent or another agent tool to perform code review through piano-keys, your delegation prompt MUST include all of the following:

1. **Skill activation first**: Tell the sub-agent to invoke the `piano-keys-cr` skill before doing any review work, and to read/follow the complete skill instructions loaded from that skill.
2. **Assigned tool name**: Give the sub-agent an explicit `<tool-name>` value to use in every piano-keys comment when `agentAppendToolName=true`.
3. **Distinct attribution**: Prefer a `<tool-name>` that is different from your own attribution name, so the user can distinguish orchestrator comments from delegated review comments. Examples: `codex-security-reviewer`, `claude-subagent-architecture`, `codex-style-reviewer`.
4. **Config propagation**: Pass the current `agentAppendToolName` value if you already fetched `/config`; otherwise instruct the sub-agent to fetch `/config` before commenting.

Suggested delegation snippet:

```text
Before reviewing, invoke the piano-keys-cr skill and read/follow the complete skill instructions. Use <tool-name>="<assigned-distinct-tool-name>" for all piano-keys review comments when agentAppendToolName=true. Fetch /config before commenting if I did not provide agentAppendToolName.
```

### Combining with Other Code Review Skills

This skill is the **submission channel** — it provides the HTTP API to add, manage, and submit review comments. It does NOT conflict with other installed code review skills or tools.

- You can (and should) use other code review skills, linters, static analysis tools, or custom review workflows alongside this one
- Those tools handle the **analysis** — this skill handles the **comment submission** to the VSCode side panel and MR platform
- After other skills finish their review, submit the results through this skill's `/comments` API
- All comments from different sources appear together in the same review session, distinguished by author

> **Tip:** To distinguish which agent tool each comment came from, users should enable the `agentAppendToolName` setting in VSCode settings (`piano-keys.agentAppendToolName`). When enabled, agents must include the tool name in the first line, e.g. `` `[P1]` [**AI** —— by **claude code**] ``. When disabled, agents should use `` `[P1]` [**AI**] `` without tool attribution.

### Iterative Development with Review Loop

When the user is doing multi-phase / multi-step complex feature development in a coding agent (Claude Code, Codex, OpenCode, etc.), you can use piano-keys for **per-phase code review without needing an MR**:

1. **Development phase completes** — coding agent finishes this stage, pushes changes to a feature branch
2. **Open review** — coding agent spawns a sub-agent (or notifies another agent), activates `piano-keys-cr` skill, opens review via source/target branches using `/open-review-by-branches` API (no MR needed)
3. **Auto-review** — sub-agent reads diff content, analyzes each changed file, adds review comments via `/comments` API
4. **Human review** — notify user to review AI comments in VSCode side panel, confirm or delete each one. **The sub-agent MUST NOT auto-confirm or auto-submit** — the user decides which suggestions to keep
5. **Fetch issues and fix** — development agent calls `/state` to get all confirmed comments, then fixes the reported issues
6. **Continue to next phase** — after fixes, move on to the next development stage and repeat

This workflow is especially useful for large feature development — each phase gets independently reviewed and fixed before moving on, avoiding accumulated issues at the end.

**Important**: In fully-automated development loops where the user does NOT manually review each comment, the development agent can read the `/state` response to get all comments (regardless of status) and fix them. But comments are still NOT submitted to the MR platform unless the user explicitly requests it.

### Help & Guidance — Answering User Questions

When users ask how to use the plugin, provide clear step-by-step instructions. Common scenarios:

**Q: 怎么打开评审面板？**
→ 点击 VSCode 左侧活动栏的 Piano Keys 图标，打开侧边栏 Review 面板。

**Q: 没有 MR 可以用吗？**
→ 可以。在侧边栏填写源分支和目标分支，点击"打开对比"即可进入代码对比和评审。所有评论功能正常使用，只是无法提交到代码平台。

**Q: 怎么评审源分支的全部文件（不指定目标分支）？**
→ 在侧边栏目标分支输入框填写 `{init}`，源分支填你要评审的分支名，点击"打开对比"。这会对比空树到源分支的所有文件，适用于新项目初始化、大幅重构等全量评审场景。API 同理：`{"sourceBranch": "feature/xxx", "targetBranch": "{init}"}`。

**Q: 怎么关联 MR？**
→ 在侧边栏顶部下拉框选择 MR。

**Q: MR 列表没更新，怎么刷新？**
→ 点击侧边栏顶部 MR 下拉选择框右侧的 🔄 刷新按钮，即可重新从远端拉取最新的 MR 列表。当有新的 MR 创建或状态变更时，可通过刷新获取最新数据。

**Q: 怎么添加评论？**
→ 打开 Diff 编辑器后，点击行号旁的 **+** 按钮添加评论。评论会同步显示在侧边栏"当前评论"tab。

**Q: AI 评论怎么处理？**
→ AI 评论默认状态为"待确认"，每个评论卡片上有"保留"和"删除"按钮。点击"保留"确认后，评论变为"已确认"状态。

**Q: 评论可以编辑吗？**
→ 可以。已确认的评论点击"✏️ 编辑"按钮进入编辑模式，修改后点击"保存"。

**Q: 误删了评论怎么恢复？**
→ 切换到"回收站"tab，找到已删除的评论，点击"恢复"按钮。

**Q: 怎么切换主题？**
→ 在侧边栏底部点击主题下拉框，选择 5 套主题之一：Piano Dark/Light、Midnight Blue、Nocturne Purple、Classic Light。

**Q: 怎么提交评论到 MR？**
→ 关联 MR 后，点击侧边栏底部的"提交全部"按钮，将所有已确认的评论推送到代码平台。

**Q: Agent 怎么添加评论？**
→ Agent 通过 HTTP API 调用 `/comments` 接口添加评论。评论自动标记为 `author: "agent"`、`status: "pending"`，需用户审核后才可提交。

**Q: 怎么安装 Agent 技能？**
→ 点击侧边栏"⚙️ 设置" → "🔧 安装技能"，或在命令面板执行 `Piano Keys: Install Code Review Skill`。

**Q: 评审完成后可以生成报告吗？**
→ 可以。评审结束后 Agent 会提示是否需要导出评审报告（Markdown 格式）到项目根目录。报告包含整体评价、问题分类汇总（按 P0/P1/P2 分级）、代码变更说明、下一步建议，以及所有已确认评论的详情附录。即使没有关联 MR，也可以导出本地报告作为文档留存。

## Plugin Not Installed?

If the skill is triggered but `~/.piano-keys/ports.json` does not exist, the piano-keys VSCode extension is not running. Guide the user to install and enable it:

1. **Install from VSCode marketplace**: In VSCode Extensions (`Ctrl+Shift+X`), search for **Piano Keys** (publisher: `shallinta`) and click Install.
2. **Install from source**:
   ```bash
   git clone <repo-url> piano-keys && cd piano-keys
   npm install && npm run compile
   npx @vscode/vsce package
   code --install-extension ./piano-keys-*.vsix
   ```
3. **Restart VSCode** — the extension activates automatically on workspace open.
4. After installation, verify: open VSCode side panel and look for the Piano Keys icon. Once visible, the HTTP API will be available and you can retry the connection.

If the user is on a Mac and has the `code` CLI installed, they can also install the `.vsix` file directly:

```bash
code --install-extension /path/to/piano-keys-*.vsix
```

## Connection

piano-keys supports multiple projects simultaneously. Each VSCode instance (project) runs its own API server on a unique port. The port mappings are stored in `~/.piano-keys/ports.json`:

```json
{
  "/path/to/project-a": {
    "port": 12345,
    "token": "abc...",
    "name": "project-a",
    "pid": 100
  },
  "/path/to/project-b": {
    "port": 12346,
    "token": "def...",
    "name": "project-b",
    "pid": 200
  }
}
```

**Auto-discover current project's port:**

```bash
# Find the port for the current working directory's project
PROJECT_PATH=$(pwd)
while [ "$PROJECT_PATH" != "/" ] && [ -n "$PROJECT_PATH" ]; do
  PORT=$(python3 -c "
import json, sys
with open('$HOME/.piano-keys/ports.json') as f:
    ports = json.load(f)
for k, v in ports.items():
    if k == '$PROJECT_PATH':
        print(f\"{v['port']}:{v['token']}\")
        sys.exit(0)
" 2>/dev/null)
  if [ -n "$PORT" ]; then break; fi
  PROJECT_PATH=$(dirname "$PROJECT_PATH")
done

if [ -z "$PORT" ]; then
  echo "Error: No active piano-keys instance found for this project"
  echo "Available projects:"
  python3 -c "
import json
with open('$HOME/.piano-keys/ports.json') as f:
    for path, info in json.load(f).items():
        print(f'  {info[\"name\"]} ({path}) -> port {info[\"port\"]}')
" 2>/dev/null || echo "  (ports.json not found)"
  exit 1
fi

BASE="http://127.0.0.1:${PORT%%:*}"
AUTH_HEADER="Authorization: Bearer ${PORT#*:}"
```

**Port disconnected — re-discover:** If a curl request fails with connection refused or timeout, the VSCode extension may have restarted (e.g., after an update or reload) and the port may have changed. Before reporting an error, **re-read `ports.json` and re-match the project**:

```bash
# Re-discover: re-read ports.json and find the port for current project
python3 -c "
import json, os, sys
cwd = os.getcwd()
with open(os.path.expanduser('~/.piano-keys/ports.json')) as f:
    ports = json.load(f)
# Try exact match first, then parent dirs
path = cwd
while path != '/':
    if path in ports:
        info = ports[path]
        print(f\"{info['port']}:{info['token']}\")
        sys.exit(0)
    path = os.path.dirname(path)
print('Not found', file=sys.stderr); sys.exit(1)
" 2>/dev/null
```

Then retry the failed request with the newly discovered port and token. Only report a connection error if re-discovery also fails.

**When multiple projects are active**, the agent can either:

1. Auto-detect based on `pwd` (recommended)
2. List available projects and ask the user to choose

All commands use `curl` to the local API server. The server runs inside the VSCode extension process and is only available while VSCode is open with piano-keys active.

**CRITICAL — Confirm Project Before Reviewing:** After connecting to the plugin, you MUST call `/state` to get the current review session info, then tell the user which project and which branches/MR the review belongs to, and confirm with the user before proceeding. Example:

> 当前插件连接的评审项目为 **<project-name>**（路径: `/path/to/project`），评审的是 `feature/xxx` → `main`（MR #42 — "xxx"）。请确认这是你需要评审的项目，如需切换到其他项目请先在 VSCode 中打开对应项目。

## Getting Diff Content

**Important:** You must fetch diff content from the remote repository, not from local files. The review compares the source branch against the target branch.

```bash
# Get full diff between source and target branches
git diff origin/target-branch..origin/source-branch

# Get diff for a specific file
git diff origin/target-branch..origin/source-branch -- path/to/file.ts

# View file content on source branch (the new version being reviewed)
git show origin/source-branch:path/to/file.ts
```

Use these commands to understand the actual changes being reviewed. Line numbers in comments refer to the source branch (new version) file content (i.e., the line numbers shown on the right/new-code side of the VSCode Diff Editor).

## Opening a Review

**Via branches:**

```bash
curl -s -X POST $BASE/open-review-by-branches -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{"sourceBranch": "feature/my-branch", "targetBranch": "main"}'
```

**Via MR/PR link:**

```bash
curl -s -X POST $BASE/open-review-by-link -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{"link": "https://github.com/org/repo/pull/42"}'
```

Both open the VSCode Diff Editor with all changed files and populate the side panel. The link endpoint automatically parses the MR/PR to resolve branches and associate the session.

**Via MR number (validated against cached MR list):**

```bash
curl -s -X POST $BASE/open-review-by-mr-number -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{"mrNumber": "42"}'
```

This endpoint validates the MR number against the cached MR list. If the MR is found, it opens the diff. If not found, it returns an error with the list of available MRs — you should then suggest refreshing the MR list or checking the number.

**Important:** When the user provides an MR number or link, prefer `/open-review-by-mr-number` for numeric IDs, as it validates the MR exists in the current list before opening. Use `/open-review-by-link` for full URLs.

## Available Commands

### Get Review State

Returns the current review session as JSON: `sessionId`, `sourceBranch`, `targetBranch`, `platform`, `files[]`, `comments[]`, `remoteComments[]`. Additionally includes:

- `projectPath`: The workspace root path of the current VSCode instance.
- `projectName`: The project/folder name (basename of projectPath).
- `mrInfo`: The MR object associated with the current session (`{ id, title, sourceBranch, targetBranch }`), or `null` if no MR is linked.
- `mrList`: The full list of cached MRs, useful for showing available options to the user.

`remoteComments[]` entries include `resolution` (`resolved`, `unresolved`, or `unknown`) and may include `canResolve` when the current provider supports resolving remote comments.

**Always check `projectName` and `projectPath` first to confirm this is the correct project the user wants to review.**

```bash
curl -s $BASE/state -H "$AUTH_HEADER"
```

### Get Config

Returns all plugin configuration.

```bash
curl -s $BASE/config -H "$AUTH_HEADER"
```

Response fields:
| Field | Type | Description |
|-------|------|-------------|
| `theme` | string | Current UI theme |
| `userSignature` | string | Signature for user comments |
| `agentSignature` | string | Signature for agent comments |
| `agentAppendToolName` | boolean | Whether agents must append tool name to agent comments. Default: `true` |
| `defaultRemote` | string | Default git remote name |
| `reviewDocPatterns` | string[] | Glob patterns for review docs |
| `gitProviders` | array | Custom Git provider configuration (`piano-keys.07.gitProviders`). Built-in GitHub provider is included by default. Custom providers currently support `type: "cli"`; HTTP providers are P2 and not active in this version. |

Before reviewing, check `reviewDocPatterns` and read matching files. Also check `agentAppendToolName` — it defaults to `true`. When `true`, include your tool name in the first line of every comment; when `false`, use the AI attribution without a tool name.

### Custom Git Provider Configuration

Piano Keys uses `gitProviders` as the single provider configuration list. Each provider has two layers:

1. **Basic provider config** — `id`, `label`, `type: "cli"`, `remoteUrlPatterns`, and `cli`. This lets the plugin recognize the current repository and know which CLI tool to use.
2. **Adapter config** — `adapter.capabilities` and `adapter.commands`. This is required for remote platform operations such as loading MR/PR lists, opening by MR number/link, submitting comments, refreshing remote comments, and resolving remote comments.

Users may hand-write only the basic fields. If adapter is missing, Piano Keys can still do local Git diff review and local comment management, but it cannot load remote MR/PR lists, submit comments to the remote platform, or refresh remote comments.

#### Adapter command model

Commands are executed with `execa(command, args, { cwd })`, not through a shell. Put the executable in `command` and each CLI argument in `args`. Placeholders are replaced inside `args` before execution.

Supported placeholders:

| Placeholder | Available in | Meaning |
|-------------|--------------|---------|
| `{sourceBranch}` | `getMRId` | Source/head branch currently being reviewed |
| `{targetBranch}` | `getMRId` | Target/base branch currently being reviewed |
| `{mrNumber}` | `getMRByNumber` | Numeric MR/PR id from `/open-review-by-mr-number` |
| `{link}` | `getMRFromLink` | Full MR/PR URL from `/open-review-by-link` |
| `{mrId}` | `submitComment`, `listComments`, `resolveRemoteComment` | MR/PR id associated with the current session |
| `{filePath}` | `submitComment` | File path from the current review session |
| `{lineNumber}` | `submitComment` | 1-based line number in the source/new file |
| `{content}` | `submitComment` | Full markdown comment body; pass as a normal argument, do not interpolate into shell text |
| `{remoteCommentId}` / `{threadId}` | `resolveRemoteComment` | Remote comment/thread id to resolve |
| `{cwd}` | all commands | Workspace root used as command cwd when no command-level `cwd` is set |

Prefer direct CLI arguments over shell snippets, especially for `submitComment`, because `{content}` may contain quotes, newlines, markdown, and user-controlled text. If the target CLI cannot produce the JSON shape Piano Keys expects, use a wrapper command or `sh -lc` only for read-only commands such as `listMRs`/`listComments`, and be careful with quoting.

#### Capability semantics and true/false rules

`adapter.capabilities` tells Piano Keys which remote-platform behaviors are safe to use. For most command-backed capabilities, the practical rule is:

- Set the capability to `true` when you have mapped and verified the corresponding command.
- Set it to `false` when the platform or CLI cannot support that behavior, or when the output cannot be normalized reliably.
- If a command exists and the capability is omitted, most operations behave as enabled because the runtime checks "capability is not false and command exists". For clarity, prefer explicit `true` for supported commands and explicit `false` for unsupported commands.
- Do not set a capability to `true` just because the CLI has a similar command. Verify the command accepts the required inputs and returns data in a shape Piano Keys can normalize.

| Capability | Runtime meaning | Set `true` when | Set `false` / omit when | Command relationship |
|------------|-----------------|-----------------|--------------------------|----------------------|
| `checkAuth` | Allows a silent auth check before remote operations | The CLI has a safe auth/status command whose exit code `0` means authenticated | There is no reliable auth check. If the command is absent, Piano Keys treats auth as OK and later operations may still fail | Uses `commands.checkAuth` when present |
| `authLogin` | Declares login support for built-in/future flows | Built-in provider supports guided login | Custom providers are not currently invoked through a custom `authLogin` command; leave `false`/omitted | No custom command is called in current runtime |
| `listMRs` | Enables MR/PR dropdown and cached MR list | CLI can list open MR/PRs as JSON with id/title/source/target branch fields | No list API, auth/output unstable, or JSON cannot be normalized | Requires `commands.listMRs` |
| `getMRByNumber` | Enables `/open-review-by-mr-number` | CLI can return a single MR/PR by numeric id | Platform has no numeric id lookup or output cannot be normalized | Requires `commands.getMRByNumber` |
| `getMRFromLink` | Enables direct link parsing through CLI | CLI can accept a full MR/PR URL and return MR info | URL contains a standard number pattern and `getMRByNumber` is enough; otherwise set `false` if unsupported | Uses `commands.getMRFromLink`; if unavailable, runtime falls back to extracting number and calling `getMRByNumber` |
| `getMRId` | Auto-associates an MR/PR when opening source/target branches | CLI can query by source/head and target/base branch and return the matching MR/PR | Branch-based reverse lookup is unavailable or ambiguous | Requires `commands.getMRId` |
| `submitComment` | Enables submitting confirmed local comments to remote platform | CLI can create an inline/file comment using `{mrId}`, `{filePath}`, `{lineNumber}`, and multi-line `{content}` safely | Platform cannot create remote comments, only supports general comments when inline comments are required, or quoting/content handling is unsafe | Requires `commands.submitComment` |
| `listComments` | Enables remote comments tab and `/refresh-remote-comments` | CLI can list existing remote comments as JSON with id/author/path/line/content/time fields | Remote comments cannot be read or output cannot be normalized | Requires `commands.listComments` |
| `remoteCommentResolutionState` | Tells parser that remote comments include resolved/unresolved state | `listComments` returns `Status/status` or `Resolved/resolved`; `resolved` can be distinguished from `unresolved` | Resolution state is absent or unknown; comments should display `unknown` | Parsing flag only; no command |
| `resolveRemoteComment` | Enables resolving remote comments from the side panel | CLI can mark a remote comment/thread resolved by id, and `listComments` can refresh afterwards | Platform cannot resolve through CLI/API, or resolving requires unsafe/manual interaction | Must be explicitly `true` and requires `commands.resolveRemoteComment` |
| `reopenRemoteComment` | Future compatibility for reopening comments | Do not enable for custom providers in this version | Keep `false` unless runtime support is added | No custom command is called in current runtime |

Important edge cases:

- `resolveRemoteComment` is stricter than most capabilities: it must be explicitly `true` and have a command, otherwise the side panel will not offer resolve behavior.
- `remoteCommentResolutionState: true` without reliable resolution fields is worse than `false`, because it may show unresolved for comments whose state is actually unknown.
- `checkAuth: true` without `commands.checkAuth` does not perform a check. Only mark it true when the command exists.

#### Command requirements table

Configure the smallest set that matches the user's needs. For full plugin functionality, configure all commands marked **Full**.

| Command | Capability flag | Needed for | Required output / behavior | Priority |
|---------|-----------------|------------|----------------------------|----------|
| `checkAuth` | `checkAuth` | Silent auth checks before remote operations | Exit code `0` means authenticated; non-zero means not authenticated | Recommended |
| `listMRs` | `listMRs` | MR/PR dropdown and cached MR list | JSON array, or object with `MergeRequests` / `mergeRequests` / `items` / `data` / `result`; each item must include id/number and source/target branches | Full |
| `getMRByNumber` | `getMRByNumber` | `/open-review-by-mr-number` | Single MR JSON, or object under `MergeRequest` / `mergeRequest` / `mr` / `data` / `result` | Full |
| `getMRFromLink` | `getMRFromLink` | `/open-review-by-link` for non-standard URLs | Same as `getMRByNumber`. If omitted, Piano Keys falls back to extracting `/pull/<n>`, `/merge_requests/<n>`, or `/mr/<n>` and then calls `getMRByNumber` | Recommended |
| `getMRId` | `getMRId` | Auto-associate an MR when the user opens by source/target branches | JSON list or MR object; first MR's id is used | Full |
| `submitComment` | `submitComment` | `/comments/submit-all` and side-panel submit | Submit one inline/file comment. Stdout may be empty, or JSON/text containing an id (`id`, `Id`, `CommentId`, etc.) | Full |
| `listComments` | `listComments` | Remote comments tab and `/refresh-remote-comments` | JSON array or object with `Comments` / `comments` / `items` / `data`; fields normalized from common names such as `id`, `author`, `filePath/path`, `lineNumber/line`, `content/body`, `createdAt` | Full |
| `resolveRemoteComment` | `resolveRemoteComment` | Resolve remote comments from the side panel | Exit code `0` means resolved successfully | Optional |

Capability flags that do not map to active custom commands in the current runtime:

- `remoteCommentResolutionState` is a parsing flag, not a command. Set it to `true` only when `listComments` returns resolution fields.
- `authLogin` and `reopenRemoteComment` exist for built-in/future compatibility, but configurable custom providers do not currently call custom `authLogin` or `reopenRemoteComment` commands. Do not invent commands for them.

MR JSON fields are normalized from common names:

- id: `id`, `number`, `iid`, `Id`, `ID`, `Number`
- title: `title`, `Title`
- source branch: `sourceBranch`, `source_branch`, `headRefName`, `SourceBranch`, `SourceBranchName`
- target branch: `targetBranch`, `target_branch`, `baseRefName`, `TargetBranch`, `TargetBranchName`

Remote comment resolution:

- Set `remoteCommentResolutionState: true` only if `listComments` returns resolution data.
- A comment is considered resolved when `Status/status` is `resolved`, or `Resolved/resolved` is `true`.
- If the platform can resolve comments, set `resolveRemoteComment: true` and provide the `resolveRemoteComment` command.
- `reopenRemoteComment` exists in config for future compatibility but is not currently called by the plugin; leave it `false` unless runtime support is added.

#### Minimal vs. full config examples

Recognition-only config — enough for local branch review and local comment management, but no remote MR operations:

```json
{
  "id": "company-code",
  "label": "Company Code",
  "type": "cli",
  "remoteUrlPatterns": ["code.company.com"],
  "cli": "company-code"
}
```

Full CLI adapter template — replace commands/args with the platform's real CLI syntax. Keep only commands that the CLI truly supports:

```json
{
  "id": "company-code",
  "label": "Company Code",
  "type": "cli",
  "remoteUrlPatterns": ["code.company.com"],
  "cli": "company-code",
  "adapter": {
    "preset": "custom",
    "capabilities": {
      "checkAuth": true,
      "listMRs": true,
      "getMRByNumber": true,
      "getMRFromLink": true,
      "getMRId": true,
      "submitComment": true,
      "listComments": true,
      "remoteCommentResolutionState": true,
      "resolveRemoteComment": true,
      "reopenRemoteComment": false
    },
    "commands": {
      "checkAuth": {
        "command": "company-code",
        "args": ["auth", "status", "--json"]
      },
      "listMRs": {
        "command": "company-code",
        "args": ["mr", "list", "--state", "open", "--json"]
      },
      "getMRByNumber": {
        "command": "company-code",
        "args": ["mr", "view", "{mrNumber}", "--json"]
      },
      "getMRFromLink": {
        "command": "company-code",
        "args": ["mr", "view", "--url", "{link}", "--json"]
      },
      "getMRId": {
        "command": "company-code",
        "args": ["mr", "list", "--source", "{sourceBranch}", "--target", "{targetBranch}", "--json"]
      },
      "submitComment": {
        "command": "company-code",
        "args": ["mr", "comment", "create", "{mrId}", "--path", "{filePath}", "--line", "{lineNumber}", "--body", "{content}", "--json"]
      },
      "listComments": {
        "command": "company-code",
        "args": ["mr", "comments", "list", "{mrId}", "--json"]
      },
      "resolveRemoteComment": {
        "command": "company-code",
        "args": ["mr", "comments", "resolve", "{mrId}", "{threadId}"]
      }
    }
  }
}
```

#### Configuration workflow for agents

When the user asks to configure a custom provider, explain the difference between basic config and adapter config, then complete the adapter systematically:

1. Fetch `/config` and inspect `gitProviders`.
2. Get the current git remote URL from the workspace.
3. Ask the user for the CLI name if it cannot be inferred.
4. Run `<cli> --help` and relevant subcommand help such as `<cli> auth --help`, `<cli> mr --help`, `<cli> pr --help`, and `<cli> api --help`.
5. Map each operation in the command requirements table to an actual CLI command.
6. Run safe read-only probes (`checkAuth`, `listMRs`, `getMRByNumber`, `listComments`) to verify stdout JSON can be normalized by Piano Keys. Do not run `submitComment` or `resolveRemoteComment` as a probe unless the user explicitly permits creating/resolving test comments.
7. Generate or update the matching `gitProviders[]` entry with `adapter.capabilities` and `adapter.commands`. A capability should be `true` only when the corresponding command exists and has been mapped; set unsupported operations to `false` or omit the command.
8. Update config via `POST /config` with the full updated `gitProviders` array.
9. Tell the user which capabilities are enabled and which remain unavailable.

Do not configure HTTP providers as active runtime support in this version. HTTP provider support is planned for P2 only.

### Update Config

Update one or more plugin settings.

```bash
curl -s -X POST $BASE/config -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{"agentAppendToolName": true}'
```

Accepts any subset of the config fields listed in Get Config. Returns the updated full config.

### Add a Comment

```bash
curl -s -X POST $BASE/comments -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{"filePath": "src/utils/helper.ts", "lineNumber": 42, "content": "`[P1]` [**AI** —— by **claude code**]\n**问题：**缺少空值保护可能导致运行时异常\n这里直接访问嵌套字段，若上游返回空对象会触发异常。建议补充 null-safe 访问或在入口处做参数校验。"}'
```

Comments are created with `author: 'agent'` and `status: 'pending'`. The user decides to Keep or Delete each comment.
By default this endpoint only creates the comment and refreshes the side panel; it does not automatically open a Diff tab. If you explicitly need to open the Diff after adding the comment, include `"openDiff": true` in the JSON body.

**Comment format:** Every agent review comment MUST follow this markdown structure:

```markdown
`[Px]` [**AI** —— by **<tool-name>**]
**问题：**<one-line-title>
<multiple-line-comment-content-markdown>
```

If `agentAppendToolName` is `false`, L1 MUST omit the tool name and use:

```markdown
`[Px]` [**AI**]
```

- `Px` must be `P0` (critical), `P1` (important), or `P2` (suggestion).
- `<tool-name>` is your own concrete agent/tool name (e.g., `claude code`, `codex`, `cursor`, `opencode`, `gemini cli`, `copilot cli`). This is NOT added automatically by the plugin — include it only when `agentAppendToolName` is `true`.
- **Do not default to `AI Assistant`.** Use `AI Assistant` only as a last-resort fallback when you have genuinely tried and still cannot identify your concrete tool name, and no upstream/orchestrating agent assigned you a `<tool-name>`.
- The title after `**问题：**` must be one concise line.
- The body should briefly explain the reasoning/evidence for the issue and give actionable guidance. Be detailed enough for the user to understand why this matters, but do not be long or verbose.
- The body may use appropriate markdown formatting and line breaks to improve readability, such as bullet lists, code spans, fenced code blocks, emphasis, and markdown links for external references. Do NOT use heading syntax (`#`, `##`, `###`, `####`, `#####`, `######`) inside comment bodies.

**Tool-name selection priority when `agentAppendToolName=true`:**

1. If an orchestrating agent assigned you a `<tool-name>`, use that exact value.
2. Otherwise, use the current agent product/CLI name if it is known from your runtime, system prompt, executable name, skill directory, or user context (examples: `claude code`, `codex`, `cursor`, `opencode`, `gemini cli`, `copilot cli`).
3. If only capitalization or spacing is uncertain, still use the best concrete name instead of falling back.
4. Use `AI Assistant` only when no concrete tool name can be identified after the checks above.
5. Never copy placeholder/example values such as `<tool-name>`, `claude code`, or `AI Assistant` unless they truly match your current tool.

After every `POST /comments`, inspect the JSON response. If it includes a non-empty `hint`, read it carefully. If the hint indicates a missing or fallback tool name and you can determine a better concrete tool name, consider updating the just-created comment via `PATCH /comments/{id}` before continuing.

**Comment scope:** Unless the user explicitly asks for praise/positive feedback, only add comments for problems, suspected problems, possible risks, optimization opportunities, or suspected optimization opportunities. Do NOT add comments just to say something is well done.

### Delete a Comment

```bash
curl -s -X DELETE $BASE/comments/comment-1714435200-abc123 -H "$AUTH_HEADER"
```

Soft-deletes the comment (user can undo). Only delete comments you created that haven't been submitted.

### Get a Comment

Returns a single comment by ID.

```bash
curl -s $BASE/comments/comment-1714435200-abc123 -H "$AUTH_HEADER"
```

Response contains the full comment object: `{ id, author, filePath, lineNumber, content, status, createdAt, updatedAt }`.

### Update a Comment

Update comment content and/or status by ID.

```bash
# Update content only
curl -s -X PATCH $BASE/comments/comment-1714435200-abc123 -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{"content": "Updated comment text"}'

# Update status only (pending/confirmed/submitted/deleted)
curl -s -X PATCH $BASE/comments/comment-1714435200-abc123 -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{"status": "confirmed"}'

# Update both
curl -s -X PATCH $BASE/comments/comment-1714435200-abc123 -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{"content": "Updated text", "status": "confirmed"}'
```

Returns the updated comment object. At least one of `content` or `status` must be provided.

### Confirm All Agent Comments

```bash
curl -s -X POST $BASE/comments/confirm-all -H "$AUTH_HEADER"
```

Moves all pending agent comments to confirmed status.

**Do NOT call this unless the user explicitly asks you to confirm comments.** Your default behavior is to add comments and let the user review them in the side panel.

### Submit All Comments

```bash
curl -s -X POST $BASE/comments/submit-all -H "$AUTH_HEADER"
```

Submits all user-confirmed and user-created comments to the MR platform. **Do NOT call this unless the user explicitly asks you to submit comments.** See "Human in the Loop — Core Principle" at the top of this document.

### Open File Diff

```bash
curl -s -X POST $BASE/open-diff -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{"filePath": "src/utils/helper.ts"}'
```

Opens the diff for a specific file in the VSCode Diff Editor.

### Clear Current Review

Clears the current review content: changed files, local comments, remote comments, and recycle-bin comments. It preserves the current MR id and source/target branch values so the user or agent can reopen the same comparison afterwards.

Use this only when the user explicitly asks to clear/reset the current comparison. Do **not** call it during normal review or re-review flows because it removes all local review comments from the current session.

```bash
curl -s -X POST $BASE/review/clear -H "$AUTH_HEADER"
```

If the agent has newer UI-equivalent values to preserve, pass them explicitly:

```bash
curl -s -X POST $BASE/review/clear -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{"sourceBranch":"feature/my-branch","targetBranch":"main","mrId":"42"}'
```

Returns the counts that were cleared: `{ cleared: { files, comments, remoteComments, deletedComments } }`.

### Refresh Remote Comments

Re-fetches remote comments from the associated MR/PR.

```bash
curl -s -X POST $BASE/refresh-remote-comments -H "$AUTH_HEADER"
```

Returns `{ count, comments }`. Each remote comment includes `resolution` (`resolved`, `unresolved`, or `unknown`) and, when supported by the provider, `canResolve`.

## Before You Review

**CRITICAL: Before adding ANY comments, you MUST follow these steps in order. Skipping them will result in incorrect or non-compliant comments.**

### Step 1: Fetch Plugin Config (MANDATORY)

```bash
curl -s $BASE/config -H "$AUTH_HEADER"
```

The response contains critical settings:

- `reviewDocPatterns` — glob patterns for code review spec documents. **You MUST locate and read all matching files** before reviewing. Use `find` or shell globbing to locate them, then read with `cat`. Your review must comply with the standards documented in these files.
- `agentAppendToolName` — controls L1 attribution. If `true`, you MUST include `by **<tool-name>**` in the first line of EVERY comment's `content` field using the format: `` `[Px]` [**AI** —— by **<tool-name>**] ``. If `false`, use: `` `[Px]` [**AI**] ``. Detect your concrete tool name from your environment and use it consistently when needed. **The plugin will NOT rewrite this for you — it is your responsibility.** DO NOT simply copy examples. Use `AI Assistant` only as a last-resort fallback when you genuinely cannot identify a concrete tool name. **If you delegate this task to a subagent or another agent, you MUST tell it to invoke `piano-keys-cr` first, pass the `agentAppendToolName` value, and assign it an explicit `<tool-name>` that is preferably distinct from your own. The delegated agent must use that assigned `<tool-name>` in comments.**

**Never skip this step.** Without reading the config, you won't know which review docs to follow or whether L1 should include your tool name.

### Step 2: Read Project Documentation

1. **`README.md`** — Project overview, setup instructions, and high-level architecture
2. **`AGENTS.md`** or **`CLAUDE.md`** — Agent-specific instructions, coding conventions, and workflow rules
3. **`docs/`** or **`doc/`** — Detailed documentation, development guides, and API references
4. **Lint configs** — `eslint.config.*`, `.eslintrc.*`, `.prettierrc.*`, `biome.json`, `stylelint.config.*` and similar linting/formatting configs
5. **`.github/`**, **`.vscode/`** — CI rules, editor settings, and workspace configs
6. **Other coding-related files** — `.editorconfig`, `tsconfig.json`, `package.json` scripts, `.gitignore`, `Makefile`, or any project-specific config or documentation that implies coding standards

Use these documents to understand the project's specific patterns. Your review comments should respect the project's existing style — don't suggest changes that contradict local conventions. For example, if the project uses a specific naming convention, error-handling pattern, or architectural style, review against that standard, not generic best practices.

## Review Summary

**After completing an agent review (adding all comments), you MUST provide a review summary to the user.** This summary should include:

1. **Overview**: Briefly describe what the MR/PR changes are about (file count, main areas of change)
2. **Comments summary**: Number of comments added, broken down by risk level (P0/P1/P2)
3. **Key findings**: List the most important issues you flagged, organized by severity
4. **Overall risk assessment**: Give a high-level assessment (e.g., "低风险 — 主要是样式调整和小重构" or "中风险 — 核心逻辑有变更，建议仔细审查")
5. **Tool-name disclosure**: If `agentAppendToolName=true` and you added comments through this plugin, explicitly tell the user which `<tool-name>` you used in the comment L1 attribution, so they can distinguish your comments from other agents' comments
6. **Review reminder**: Tell the user to check the side panel and review each comment, with available operations (**保留** / **删除** / **编辑**)

Example summary format:

```
## Review 总结

**变更概览**: 本次 MR 共修改 12 个文件，主要涉及用户认证模块重构和新增错误处理逻辑。

**评论统计**: 共添加 8 条评论 — P0 × 1, P1 × 3, P2 × 4

**重点问题**:
- [P0] `auth/jwt.go:45` — JWT 验证绕过漏洞，密钥硬编码
- [P1] `handler/user.go:120` — 缺少输入验证，可能导致 SQL 注入
- [P1] `middleware/rate_limit.go:33` — 限流器未考虑分布式场景
- [P1] `db/migration/003.sql` — 缺少索引，大数据量下查询性能问题

**总体风险**: 中风险 — 认证模块为核心逻辑，P0 问题必须在合并前修复。建议重点审查 auth/ 目录的变更。

**评论标识**: 我在本次通过 Piano Keys 添加的评论中使用的 tool-name 是 `claude code`，评论首行格式为 `[**AI** —— by **claude code**]`。

**下一步**: 请在 VSCode 侧边栏「当前评论」tab 中查看 AI 评论，每条可点击 **保留**（确认）、**删除** 或 **编辑**。确认后点击底部的「提交全部」可推送到 MR。
```

If the review was opened via an MR/PR link, include the MR title and number in the summary.

## Export Review Report

**After completing a code review (via MR/PR or source+target branches), offer to export a review report as a markdown file to the project root directory.**

### When to Offer

After the review summary, ask the user:

- 是否需要导出本次代码评审报告（Markdown 格式）到项目根目录？

**Special case — no MR:** When the review was started without an MR (only source+target branches), explicitly mention:

- 虽然没有 MR 无法提交评论到代码平台，但可以导出一份本地评审报告作为文档留存。是否导出？

### Report Generation

If the user agrees, follow these steps:

1. **Fetch all confirmed comments** via the HTTP API:

   ```bash
   curl -s $BASE/state -H "$AUTH_HEADER"
   ```

   Parse the response to get all comments with `status: "confirmed"` (both user and agent confirmed).

2. **Generate a markdown report** and write it to the project root directory (e.g., `code-review-report-<date>.md`):

The report should follow this structure:

```markdown
# Code Review Report

**日期**: 2025-01-15
**评审方式**: Agent 辅助评审 (Claude Code + Codex)
**分支**: feature/auth-refactor → main
**MR/PR**: #42 — "重构用户认证模块" (if applicable)
**评审人**: User + AI Agents

---

## 一、整体评价

对本次代码变更的整体质量、架构合理性、代码风格等给出综合评价。说明变更范围和总体风险水平。

---

## 二、问题分类汇总

### P0 — 严重问题

| 文件          | 行号 | 问题描述                     | 风险说明           |
| ------------- | ---- | ---------------------------- | ------------------ |
| `auth/jwt.go` | 45   | JWT 验证绕过漏洞，密钥硬编码 | 可能导致未授权访问 |

### P1 — 重要问题

| 文件                       | 行号 | 问题描述               | 风险说明          |
| -------------------------- | ---- | ---------------------- | ----------------- |
| `handler/user.go`          | 120  | 缺少输入验证           | 可能导致 SQL 注入 |
| `middleware/rate_limit.go` | 33   | 限流器未考虑分布式场景 | 高并发下可能失效  |

### P2 — 建议优化

| 文件              | 行号 | 问题描述       | 建议             |
| ----------------- | ---- | -------------- | ---------------- |
| `utils/helper.go` | 88   | 冗余的错误处理 | 可提取为公共函数 |

---

## 三、代码变更说明

按代码功能模块或文件分组，简要说明本次变更的内容和意图。

### 认证模块 (`auth/`)

- 重构 JWT 生成和验证逻辑
- 新增 refresh token 机制

### 用户处理 (`handler/`)

- 重构用户注册接口参数校验
- ...

---

## 四、下一步建议

1. **必须修复**: P0 级别问题需在合并前修复
2. **建议修复**: P1 级别问题建议在本轮 PR 中处理
3. **可后续优化**: P2 级别问题可记录为技术债，后续迭代处理
4. **建议补充**: 建议为 auth/ 模块新增单元测试覆盖

---

## 附录：已确认评论详情

以下列出本次评审中所有已确认的评论（用户 + AI）：

### 1. `[P0]` [**AI** —— by **claude code**] JWT 验证绕过漏洞

- **文件**: `auth/jwt.go`
- **行号**: 45
- **作者**: Agent (by claude code)
- **内容**: JWT secret 硬编码在源码中，建议通过环境变量注入...

### 2. `[P1]` [**AI** —— by **claude code**] 缺少输入验证

- **文件**: `handler/user.go`
- **行号**: 120
- **作者**: Agent (by claude code)
- **内容**: 用户注册接口未对 email 字段进行格式校验...

### 3. 环境变量命名不统一

- **文件**: `config/env.go`
- **行号**: 22
- **作者**: User
- **内容**: 建议统一使用大写蛇形命名...

---

_本报告由 piano-keys 插件辅助生成_
```

### Report Tips

- Use the user's language (Chinese or English) for the report content
- If `agentAppendToolName` is enabled, include the tool name in the comment attribution
- For the "整体评价" section, base it on the actual diff content and comment analysis
- Group P0/P1/P2 issues by file/module if there are many, to improve readability
- The appendix should list ALL confirmed comments, including those added by the user

## Rules

- **MANDATORY: Always fetch `/config` first** — before adding any comments, read plugin config to get `reviewDocPatterns` and `agentAppendToolName`
- **MANDATORY: Read review docs** — if `reviewDocPatterns` matches files, read them and review against those standards
- **MANDATORY: Standard comment format** — every agent comment you POST to `/comments` MUST use:
  - L1 when `agentAppendToolName=true`: `` `[Px]` [**AI** —— by **<tool-name>**] ``
  - L1 when `agentAppendToolName=false`: `` `[Px]` [**AI**] ``
  - L2: `**问题：**<one-line-title>`
  - L3+: readable markdown body with reasoning/evidence and actionable guidance
- **MANDATORY: Honor `agentAppendToolName`** — if `true`, include `by **<tool-name>**` in the first line of the comment. If `false`, do not include the tool name; use `[**AI**]` only. The plugin will NOT fix this for you — it is the Agent's responsibility. `AI Assistant` is not the default; it is only a last-resort fallback when no concrete tool name can be identified.
- **MANDATORY: Inspect `/comments` response hints** — after every `POST /comments`, check whether the response contains a non-empty `hint`. If it warns about missing/fallback tool name and you can determine a better concrete tool name, consider updating the already-created comment via `PATCH /comments/{id}` before continuing.
- **MANDATORY: Disclose your tool-name in the final review summary** — after completing a review and adding comments through this plugin, if `agentAppendToolName=true`, explicitly tell the user which `<tool-name>` you used in the comment L1 attribution. Example: `本次我添加评论时使用的 tool-name 是 \`claude code\`，方便你在侧边栏区分评论来源。`
- **MANDATORY: Delegated review agents must load this skill** — if you dispatch a sub-agent or another agent tool for piano-keys code review, explicitly instruct it to invoke `piano-keys-cr` first and follow the complete loaded skill instructions before reading diffs or posting comments.
- **MANDATORY: Delegated review comments use assigned tool name** — assign the delegated agent a concrete `<tool-name>` and pass it in the delegation prompt. Prefer a value distinct from your own attribution name. The delegated agent MUST use that assigned `<tool-name>` when `agentAppendToolName=true`.
- **MANDATORY: Review only — Do NOT modify project files** — when the user asks you to review code, your ONLY job is to analyze and add comments. Never modify any project files or code content unless the user explicitly tells you to fix issues
- **MANDATORY: Human in the Loop** — after adding review comments, you MUST NOT call `/comments/confirm-all` or `/comments/submit-all` unless the user explicitly instructs you to. Your job is to analyze and suggest; the user decides what to keep and submit.
- `filePath` must match a file in the current review session's file list
- `lineNumber` is 1-based and refers to the source branch (new version) file (i.e., the line numbers shown on the right/new-code side of the VSCode Diff Editor)
- One comment per issue — be specific and actionable
- Start each comment with a risk level in backticks: `` `[P0]` `` (critical), `` `[P1]` `` (important), or `` `[P2]` `` (suggestion), followed by `[**AI** —— by **<tool-name>**]` when `agentAppendToolName=true`, or `[**AI**]` when `agentAppendToolName=false`
- Unless the user asks otherwise, do not add praise-only comments; only comment on issues, suspected issues, possible risks, optimization opportunities, or suspected optimization opportunities
- Comments should include the reason/evidence for the finding, but stay concise and avoid long-winded explanations
- Comment bodies may use markdown formatting and line breaks for readability, including lists, inline code, fenced code blocks, emphasis, and markdown hyperlinks for external references; do not use H1-H6 heading syntax (`#` through `######`) inside comments
- Do NOT call `/comments/submit-all` — submitting is the user's decision
- **Always use the user's language** for comment content and replies. Detect the language from existing comments in the review session and match it. If the user writes in Chinese, reply in Chinese. If English, reply in English.
- Before adding comments, verify an active review session exists via `GET /state`
- If `~/.piano-keys/ports.json` does not exist, the VSCode extension is not running
- Always fetch diff content from `origin/<branch>` (remote), never from local uncommitted files
- On re-review, always check whether previous agent comments have been fixed and ask before deleting fixed local comment cards
- After fixing comment-reported issues, only delete local comment cards or resolve remote comments for issues that were actually fixed in code. Do not delete/resolve comments that were evaluated as ignorable, false positive, out of scope, or intentionally left unchanged unless the user explicitly asks.
- After every comment-fix pass, provide a list-style report for all evaluated comments: fixed items with what changed, unfixed/ignored items with reasons, and a clear note that unfixed/ignored comments were not deleted/resolved. Ask whether the user wants batch delete/resolve anyway or prefers to decide manually.

## Common Mistakes

- **Using the old comment format** — do not use `` `[P1]` **[AI]** ... (by **tool**) ``. Use the required three-part format: L1 risk + `[**AI** —— by **<tool-name>**]` when `agentAppendToolName=true` or `[**AI**]` when false, L2 `**问题：**...`, L3+ explanation.
- **Not reading config before reviewing** — always `curl $BASE/config -H "$AUTH_HEADER"` first to get `reviewDocPatterns` and `agentAppendToolName`; skipping this means you'll miss review docs and tool name rules
- **Not confirming the project before reviewing** — always call `curl $BASE/state -H "$AUTH_HEADER"` first, tell the user which project the review belongs to, and confirm it's the right one before proceeding
- **Not reading review documentation** — if `reviewDocPatterns` returns patterns, locate and read those files before adding comments
- **Ignoring `agentAppendToolName`** — if `true`, every comment's first line MUST include `by **<tool-name>**`; if `false`, it MUST use `[**AI**]` without tool name
- **Defaulting to `AI Assistant` too early** — do not use `AI Assistant` just because it appears in examples. First try to identify your real tool name from runtime/system prompt/executable/skill directory/user context, or use the upstream-assigned `<tool-name>` if delegated. Only fall back to `AI Assistant` when no concrete name can be identified.
- **Ignoring response hints after adding comments** — `POST /comments` may return a `hint` when your comment has a missing or fallback tool name. Read the hint and, if appropriate, fix the newly created comment with `PATCH /comments/{id}`.
- **Modifying project files during review** — when the user asks you to review code, you MUST NOT modify any project files or code content. Your job is to find issues and add comments only. Do NOT auto-fix bugs, do NOT write suggested changes into files. Only modify files if the user explicitly asks you to fix specific issues.
- **Calling `/comments/submit-all` without user approval** — submitting comments is the user's decision, not the agent's
- **Auto-confirming comments without explicit user instruction** — the agent MUST NOT call `/comments/confirm-all` or `/comments/submit-all` unless the user explicitly asks to confirm/submit. After adding comments, stop and notify the user with a review summary instead
- **Guessing ambiguous user intent** — if the user says something like "帮我评审并提交评论", you MUST ask for clarification before proceeding. Do NOT assume they mean "auto-confirm and submit"
- **Thinking "submitting" means "create + confirm + submit"** — these are three separate steps. The agent's default job is ONLY step 1 (create). Steps 2 (confirm) and 3 (submit) require explicit user intent
- **Adding comments without checking active session** — always call `GET /state` first to verify a session exists
- **Using local file content instead of remote** — diff and file content must come from `origin/<branch>`, not local uncommitted files
- **Deleting or resolving ignored comments** — if you judged a comment as ignorable/false positive/out of scope and did not actually fix code for it, do NOT delete the local comment card or resolve the remote comment unless the user explicitly asks
- **Omitting the post-fix comment report** — after fixing comments, always list every evaluated comment, what was fixed, what was ignored/not fixed, why, and which comments were intentionally left undeleted/unresolved
- **Writing praise-only comments** — unless the user asks for positive feedback, do not comment on things that are merely well done; focus on issues, risks, and optimization opportunities
- **Writing too terse or too verbose comments** — include enough reasoning/evidence for the user to understand why the issue matters, but avoid long-winded explanations
- **Making comments hard to read** — use markdown formatting and line breaks where helpful, but do not use H1-H6 heading syntax (`#`, `##`, etc.) inside comment bodies
- **Forgetting the risk level prefix** — every comment must start with `` `[P0]` ``, `` `[P1]` ``, or `` `[P2]` ``
- **Including the signature in comment content** — the signature is appended automatically by the extension; when adding comments via API, only provide the review content, not the signature
- **Skill installed but plugin not running** — if `~/.piano-keys/ports.json` doesn't exist, the VSCode extension is not installed or not running; guide the user to install it from the VSCode Marketplace or from source before attempting to connect
