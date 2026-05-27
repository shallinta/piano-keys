const AI_ASSISTANT_TOOL_NAME_PATTERN = /by\s*\*\*AI Assistant\*\*/i;
const TOOL_NAME_PATTERN = /by\s*\*\*[^*]+\*\*/i;

export function createCommentToolNameHint(content: string, appendToolName: boolean): string | undefined {
  if (!appendToolName) return undefined;

  const trimmed = content.trim();
  if (!TOOL_NAME_PATTERN.test(trimmed)) {
    return 'agentAppendToolName is enabled. Please include your concrete tool name in the first line, e.g. `[P1] [**AI** —— by **claude code**]`. The plugin does not rewrite comments automatically.';
  }

  if (AI_ASSISTANT_TOOL_NAME_PATTERN.test(trimmed)) {
    return '你使用了兜底 tool-name `AI Assistant`。只有在确实无法识别具体工具名时才使用它；如果你知道当前工具名（如 `claude code`、`codex` 等），请改用真实工具名。若你认为有必要，可以通过 `PATCH /comments/{id}` 修改刚提交的评论内容。';
  }

  return undefined;
}
