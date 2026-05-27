# Changelog

## 1.0.0 - 2026-05-26

### Changed
- 转为社区开源版本，移除所有内部平台集成代码
- 仅保留 GitHub 内置 provider，自定义 Git Provider 架构（CLI adapter）继续保留
- 发布方式改为 VSIX 手动上传至 VSCode Marketplace

## 0.4.5 - 2026-05-25

### Added
- 分支输入框新增 autocomplete：source 聚焦时实时获取当前分支，target 优先展示 `{init}`、main/master/release 与历史分支建议，最多保留 5 个选项，并支持空格填入高亮项
- 变更文件 tab 顶部新增「清空对比」入口，清空当前变更文件、当前评论、远端评论和回收站内容，同时保留 MR 选择与分支输入值
- 新增 `POST /review/clear` HTTP API，供 Agent 清空当前 review 内容并按需保留 MR/source/target 信息

### Changed
- 打开不同 MR diff 时避免旧 session 评论状态泄漏，MR 选择只更新界面状态，打开 diff 时再创建或复用正确 session
- Agent code review skill 更新到 v44，补充清空对比 API 和使用说明

## 0.4.4 - 2026-05-21

### Fixed
- 修复文件变更 tab 下文件树目录与文件行缩进不一致的问题，统一缩进计算并补齐文件行箭头占位
- 修复选择不同 MR 后打开 diff 时复用旧 session，导致当前评论 tab 继续显示旧 MR 已提交评论的问题

## 0.4.3 - 2026-05-21

### Changed
- README 同步补充 Agent HTTP API 说明，更新 `ports.json` 连接发现方式、评论 tool-name 格式、`hint` 处理和远端评论刷新/解决能力
- Agent code review skill 更新到 v43，补充自定义 Git Provider adapter 的命令需求表、capabilities 字段含义、true/false 配置规则和完整 CLI adapter 模板
- 自定义 Git Provider 文档补充 capability 与 command 的关系，以及 `remoteCommentResolutionState`、`resolveRemoteComment`、`authLogin`、`reopenRemoteComment` 等边界行为

## 0.4.2 - 2026-05-21

### Changed
- 更新插件图标：Activity Bar SVG 改为对话气泡中包含钢琴键的单色图标，Marketplace PNG 改为彩色外边框对话气泡与黑白钢琴键组合

## 0.4.1 - 2026-05-21

### Changed
- Agent code review skill 更新到 v40，强化 `<tool-name>` 选择规则：仅在无法识别真实工具名时才使用 `AI Assistant` 兜底，并要求检查 `/comments` 返回的 `hint`
- 技能升级交互优化：当 `.agents/skills/piano-keys-cr` 版本较低时，安装选择器展示所有检测到的 agent 工具（包括已有软链接的工具），并标注共享升级、未安装或已最新状态

### Added
- `POST /comments` 对缺失 tool-name 或使用 `AI Assistant` 兜底的评论返回 `hint`，提示 agent 必要时可用 `PATCH /comments/{id}` 修改刚创建的评论

## 0.4.0 - 2026-05-21

### Added
- 新增自定义 Git Provider 架构与 `piano-keys.07.gitProviders` 配置，内置 GitHub provider，并支持 CLI adapter 扩展
- 新增自定义 CLI Provider 的命令模板、MR 信息 normalize、远端评论三态 resolution（已解决/未解决/状态未知）与 fallback 行为
- 远端评论支持按 capability 展示 Resolve 操作；部分自定义 provider 支持将远端未解决评论标记为已解决
- 远端评论 tab 在关联 MR 后始终显示刷新按钮，并在刷新后通过通知提示结果
- 新增自定义 Git Provider 方案文档和实现计划文档

### Changed
- 远端评论筛选按钮调整为已解决、未解决、状态未知顺序，并避免 GitHub 等不支持 resolved 状态的平台被误标为未解决
- Agent code review skill 更新到 v39，补充自定义 provider 配置说明、远端评论处理说明，以及评审总结中声明本次使用的 `<tool-name>`
- README 与 AGENTS 配置说明同步新增自定义 Git Provider 使用说明

## 0.3.2 - 2026-05-20

### Changed
- Agent code review skill 更新到 v37，补充子代理代码审查委派要求：子代理需先调用 `piano-keys-cr` 并读取完整技能说明，且评论时使用主 agent 分配的、建议与主 agent 区分的 `<tool-name>`

## 0.3.1 - 2026-05-20

### Fixed
- 简化技能安装检测：仅读取 `.agents/skills/piano-keys-cr/SKILL.md` 的真实版本号，其他 agent 工具目录只检查 `piano-keys-cr` 是否存在，避免软链接目录重复解析版本
- 修复其他 agent skills 目录存在但尚未安装 `piano-keys-cr` 时不会出现在安装选择列表的问题

## 0.3.0 - 2026-05-19

### Added
- 侧边栏统一通知浮层系统（toast、input、quickPick），替代 VSCode 原生消息框，支持 5 套主题适配
- 技能安装检测逻辑简化：`.agents/skills` 检查版本号，其他 agent 目录仅检测是否存在（软链接版本共享）
- 取消技能安装工具选择时不再误写入 `.agents/skills`
- quickPick 多选勾选改为局部 DOM 同步，避免通知弹窗闪烁

### Changed
- Agent code review skill 更新到 v36
- `doInstall()` 调整为用户确认后再写入 `.agents/skills`

## 0.2.0 - 2026-05-19

### Added
- 点击侧边栏评论卡片打开 Diff Editor 时，仅展开所点击评论所在行的 comment thread，其他 thread 自动折叠，降低多评论文件中的干扰
- 新增 comment thread 聚焦状态计算逻辑，用于根据 `filePath#lineNumber` 控制目标评论展开状态

### Changed
- `piano-keys.openFile` 支持接收目标行号参数，并在刷新 Diff Editor 评论线程时传递 focused thread 信息
- Agent code review skill 更新到 v33，补充重新评审、修复后评论处理、标准评论格式、工具名归因和 Markdown 正文规范

## 0.1.7 - 2026-05-15

### Fixed
- 修复 Diff 临时文件污染工作区问题，原始/修改文件均写入系统临时目录并支持过期清理
- 分支解析支持远端分支缺失时回退本地分支，并增加 fallback 日志
- 评论持久化保留 submitted 评论，回收站也持久化，避免重启后状态丢失
- 评论签名追加改为去重逻辑，避免编辑或创建时重复追加签名
- HTTP API 增加评论状态、文件路径、行号校验，`POST /comments` 默认不再自动打开 Diff
- 打开评审接口改为等待实际结果后返回成功/失败，避免 API 提前返回成功
- 侧边栏多处 HTML 渲染增加属性/链接转义，减少 XSS 风险
- 远端评论「已解决」标签移动到卡片右上角，与当前评论状态标签位置一致
- MR 选择改为通过 `CommentStore` 持久化分支信息，避免直接修改 session 后丢失
- 提交评论增加进度提示，自定义 CLI provider 评论提交尝试解析平台评论 ID
- `ports.json` 写入失败时提示并记录日志，文件权限设置为 `0600`

### Changed
- Agent code review skill 更新到 v31，补充 `openDiff` 行为和工具名追加说明
- 锁定 `express` 到精确版本 `5.2.1`

## 0.1.6 - 2026-05-14

### Fixed
- `GitService.fetch()` 返回值改为 `{ok, error}` 结构，修复 coordinator 中权限检测死代码问题
- `coordinator.openDiff()` 中 `updateSessionMRId` 使用了正确的 session.id 而非生成的 sessionId
- `getAuthError()` 缓存写入不一致：`GitHubSubmitter` 注释说不缓存但实际写入，统一改为都不缓存
- `GitHubSubmitter.checkAuth()` gh 未安装时返回 false，与 `checkAuthSilent()` 保持一致
- `coordinator.loadMRs()` 新增 `gh_not_installed` 分支处理，提供安装指南链接
- HTTP DELETE `/comments/:id` 改为调用 `moveToTrash()`，删除的评论进入回收站可恢复
- webview `switchTab()` 先保存滚动位置再切换 tab，修复滚动状态保存到错误 tab
- 远端评论 tab 去掉重复的 comments-header
- SKILL.md 补充行号说明（Diff Editor 右侧行号）和子代理指令传递说明
- 多个 SKILL.md 防呆指令补充和 Common Mistakes 补充

### Added
- 侧边栏远端评论 tab 顶部增加刷新按钮
- 侧边栏插件图标上显示评论数量 badge
- `findOrCreateSession()` 支持会话复用（同一项目同一 MR 保留已添加评论）
- `persist()` 剥离 submitted 评论减少持久化膨胀
- 新增配置项 `agentAppendToolName` 控制 Agent 评论是否追加工具名
- AGENTS.md 新增版本发布流程

## 0.1.5 - 2026-05-11

### Fixed
- Agent 评论提交时遗漏工具名落款的问题：SKILL.md curl 示例中直接包含具体工具名示例，明确说明工具名由 Agent 自行追加
- `POST /comments` 响应新增 `hint` 字段，当 `agentAppendToolName` 开启但评论内容末尾未包含 `(by **xxx**)` 时提醒 Agent
- 切换主题后点击评论卡片自动重置为 Piano Dark — `changeTheme` 写入的 key 从 `'theme'` 修正为 `'01.theme'`
- HTTP API `POST /config` 写入 key 的映射错误（无编号 → 有编号），确保与 `config.get()` 一致
- `agentAppendToolName` 多处默认值 `false` 统一修正为 `true`

### Added
- AGENTS.md 新增「配置项 Key 命名规范」章节，记录所有带编号的配置 key 和 HTTP API 映射表

## 0.1.4 - 2026-05-11

### Added
- 侧边栏图标改为评论气泡框样式
- 目标分支支持 `{init}` 占位符，可评审源分支的所有文件（全量代码评审）
- AGENTS.md 记录标准发布流程（版本变更 → 打包 → 发布 → 提交打 tag → 推送）

### Fixed
- `{init}` 全量评审使用 `git ls-tree` 替代无效的 `git diff` 空树范围

## 0.1.3 - 2026-05-11

### Added
- 刷新 MR 列表不再依赖 active session，可在打开评审前独立加载
- README 和 SKILL.md 新增"分阶段开发 + 自动评审工作流"使用场景
- `/state` 接口新增 `projectPath` 和 `projectName` 字段，Agent 可确认评审所属项目
- Agent 连接后强制要求确认项目，防止评审错项目
- SKILL.md 新增"Plugin Not Installed"章节，指导 Agent 在仅有技能但无插件时如何安装

### Fixed
- 未打开评审时点击刷新 MR 列表报错"未检测到有效的代码平台配置"

## 0.1.2 - 2026-05-11

### Added
- `/state` 接口新增 `projectPath` 和 `projectName` 字段，Agent 可确认评审所属项目
- Agent 连接后强制要求确认项目，防止评审错项目
- SKILL.md 新增"Plugin Not Installed"章节，指导 Agent 在仅有技能但无插件时如何安装

## 0.1.0 - 2026-05-07

### Added
- 分支对比评审：无需关联 MR，即可对比两个分支的代码差异
- MR/PR 关联：支持 GitHub PR 和其他平台 MR
- 评论生命周期管理：待确认 → 已确认 → 已提交
- Agent 辅助评审：通过 HTTP API 添加评审意见，用户审核决定保留或删除
- 双端同步：侧边栏和 Diff 编辑器评论线程实时同步
- 回收站：误删评论可恢复
- 远端评论：关联 MR 后自动拉取已有评论（只读）
- 本地 HTTP API：外部 Agent（Claude Code、Codex 等）通过 curl 即可与插件交互
- 5 套主题可选：Piano Dark/Light、Midnight Blue、Nocturne Purple、Classic Light
- 用户和 Agent 签名配置，自动追加到评论末尾
- 多 Agent 协作评审：多个 Agent 工具可同时连接同一插件实例
