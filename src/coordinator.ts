import * as vscode from 'vscode';
import { GitService, getWorkspacePath } from './git';
import { CommentStore } from './comment-store';
import { detectPlatform, promptPlatform, Platform } from './platform-detector';
import { SidePanelProvider } from './side-panel-provider';
import { createSubmitter, MRInfo, AuthResult, AuthErrorKind } from './mr-submitter';
import { DiffCommentController } from './diff-comment-controller';
import { RemoteComment } from './types';
import { NotificationService } from './notification-service';

export class Coordinator {
  private commentStore: CommentStore;
  private sidePanel: SidePanelProvider;
  private diffController: DiffCommentController;
  private gitService: GitService | null = null;
  private cwd: string | undefined;
  // Cache of available MRs for the current session
  private mrCache: MRInfo[] = [];

  constructor(commentStore: CommentStore, sidePanel: SidePanelProvider, diffController: DiffCommentController) {
    this.commentStore = commentStore;
    this.sidePanel = sidePanel;
    this.diffController = diffController;
    this.cwd = getWorkspacePath();
  }

  async openDiff(sourceBranch?: string, targetBranch?: string, mrId?: string): Promise<boolean> {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      NotificationService.error('No workspace folder open');
      return false;
    }

    // Silent git fetch with retry — reuse existing service if same workspace
    this.gitService = this.getOrCreateGitService(workspacePath);
    const fetchResult = await this.gitService.fetch();
    const fetchFailed = !fetchResult.ok;

    // Check for git permission errors
    if (fetchFailed && fetchResult.error) {
      const lower = fetchResult.error.toLowerCase();
      if (lower.includes('permission denied') || lower.includes('repository not found') || lower.includes('403') || lower.includes('could not read from remote repository')) {
        NotificationService.warning(
          'Git 远程访问失败，请检查 SSH Key / GitHub Token 配置，或确认是否有仓库访问权限'
        );
      }
    }

    // If branches not provided, prompt user
    if (!sourceBranch || !targetBranch) {
      sourceBranch = await NotificationService.input({
        prompt: 'Source branch',
        placeHolder: 'feature/my-branch',
      });
      if (!sourceBranch) return false;

      targetBranch = await NotificationService.input({
        prompt: 'Target branch',
        placeHolder: 'main',
        value: 'main',
      });
      if (!targetBranch) return false;
    }

    // Detect platform
    let platform: Platform = 'unknown';
    try {
      const remoteUrl = await this.gitService!.getRemoteUrl();
      platform = detectPlatform(remoteUrl);
    } catch {
      // Will prompt later
    }

    if (platform === 'unknown') {
      platform = await promptPlatform() || 'unknown';
    }

    // Get diff files
    let files = [];
    try {
      files = await this.gitService!.getDiffFiles(sourceBranch, targetBranch);
    } catch (err: any) {
      NotificationService.warning(`Failed to get diff: ${err.message}`);
      return false;
    }

    if (files.length === 0) {
      NotificationService.info('No changes found between branches');
      return false;
    }

    // Create or reuse session (same workspace + branches + mrId keeps existing comments)
    const displayTarget = targetBranch === '{init}' ? '{init}' : targetBranch;
    const sessionId = `review-${sourceBranch}-${displayTarget}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const normalizedMrId = mrId !== undefined ? this.extractMRNumber(mrId) : undefined;
    const session = await this.commentStore.findOrCreateSession(sessionId, sourceBranch, targetBranch, platform, normalizedMrId, files);

    // Fetch remote comments if mrId is provided
    if (mrId !== undefined) {
      const currentSessionId = this.commentStore.activeSessionId!;
      if (normalizedMrId) {
        await this.fetchRemoteComments(currentSessionId, normalizedMrId);
      }
      // If mrId is explicitly empty, no remote comments to fetch
    }
    // If mrId is undefined, don't touch session.mrId and don't fetch remote comments
    // (user just entered branches without selecting an MR)

    // Open diff for first file
    const firstFile = files[0];
    const uris = await this.gitService!.getFileUris(firstFile.filePath, sourceBranch, targetBranch);
    firstFile.originalUri = uris.originalUri.toString();
    firstFile.modifiedUri = uris.modifiedUri.toString();

    const diffTitle = targetBranch === '{init}'
      ? `${firstFile.filePath} (全量评审 — ${sourceBranch})`
      : `${firstFile.filePath} (${sourceBranch} → ${targetBranch})`;

    try {
      await vscode.commands.executeCommand(
        'vscode.diff',
        uris.originalUri,
        uris.modifiedUri,
        diffTitle
      );
    } catch (err: any) {
      NotificationService.warning(`Failed to open diff: ${err.message}`);
      return false;
    }

    // Update side panel
    await this.sidePanel.updateView(fetchFailed);

    // Sync existing comments to all visible editors
    this.diffController.refreshAllEditorThreads();

    const bannerText = targetBranch === '{init}'
      ? `全量评审 ${files.length} 个文件: ${sourceBranch}`
      : `Reviewing ${files.length} files: ${sourceBranch} → ${targetBranch}`;
    NotificationService.info(bannerText);
    return true;
  }

  /** Parse an MR/PR link, resolve branches, and open the review. */
  async openDiffFromLink(link: string): Promise<boolean> {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      NotificationService.error('No workspace folder open');
      return false;
    }

    // Detect platform from git remote
    let platform: Platform = 'unknown';
    try {
      const remoteUrl = await (this.gitService ??= new GitService(workspacePath)).getRemoteUrl();
      platform = detectPlatform(remoteUrl);
    } catch { /* Will prompt later */ }

    if (platform === 'unknown') {
      NotificationService.error('无法检测代码平台，请确认 git remote 配置正确');
      return false;
    }

    // Fetch latest MR list before opening, to ensure validation against up-to-date data
    try {
      await this.loadMRs(platform);
    } catch {
      // Non-critical, proceed with empty cache
    }

    const submitter = createSubmitter(platform, workspacePath);
    const mrInfo = await submitter.getMRFromLink(link);

    if (!mrInfo) {
      NotificationService.error(`无法解析 MR/PR 链接: ${link}`);
      return false;
    }

    // Reuse openDiff with resolved branches and MR ID
    return this.openDiff(mrInfo.sourceBranch, mrInfo.targetBranch, mrInfo.id);
  }

  async loadMRs(platform: Platform): Promise<MRInfo[]> {
    if (platform === 'unknown' || platform === null) {
      console.log('[Coordinator] loadMRs skipped: platform is', platform);
      return [];
    }
    // Use current workspace path each time, not cached value
    const cwd = getWorkspacePath();
    console.log(`[Coordinator] loadMRs platform=${platform}, cwd=${cwd}`);
    try {
      const submitter = createSubmitter(platform, cwd);
      // Check auth silently first
      const authOk = await submitter.checkAuthSilent();
      if (!authOk) {
        // Get detailed error info for better user messaging
        const authError: AuthResult = submitter.getAuthError
          ? await submitter.getAuthError()
          : { ok: false, kind: 'git_permission' as AuthErrorKind, message: 'Auth check failed' };
        console.log(`[Coordinator] loadMRs: auth check failed, kind=${authError.kind}`);

        if (authError.kind === 'cli_not_installed' || authError.kind === 'git_permission') {
          const action = await NotificationService.warning(
            authError.message || '未检测到代码平台 CLI，无法加载 MR 列表和提交评论。',
            '安装指南', 'Cancel'
          );
          if (action === '安装指南') {
            vscode.env.openExternal(vscode.Uri.parse('https://cli.github.com/manual/'));
          }
        } else if (authError.kind === 'gh_not_installed') {
          NotificationService.warning(
            '未安装 GitHub CLI (gh)，无法加载 MR 列表和提交评论。请安装 gh 后重试。',
            '了解详情'
          ).then(action => {
            if (action === '了解详情') {
              vscode.env.openExternal(vscode.Uri.parse('https://cli.github.com/manual/'));
            }
          }, () => {});
        } else if (authError.kind === 'gh_not_logged_in') {
          const action = await NotificationService.warning(
            'GitHub CLI (gh) 未登录，无法加载 MR 列表。',
            '了解详情', 'Cancel'
          );
          if (action === '了解详情') {
            vscode.env.openExternal(vscode.Uri.parse('https://cli.github.com/manual/gh_auth_login'));
          }
        }
        return [];
      }
      this.mrCache = await submitter.listMRs();
      console.log(`[Coordinator] Loaded ${this.mrCache.length} MRs for platform ${platform}`);
      return this.mrCache;
    } catch (err: any) {
      console.error('[Coordinator] loadMRs error:', err?.message || err);
      return [];
    }
  }

  getMRs(): MRInfo[] {
    return this.mrCache;
  }

  private getOrCreateGitService(workspacePath: string): GitService {
    if (!this.gitService || this.gitService.workspacePath !== workspacePath) {
      this.gitService?.dispose();
      this.gitService = new GitService(workspacePath);
    }
    return this.gitService;
  }

  /**
   * Validate MR number/link against the latest MR list, then open diff.
   * Fetches the latest MR list before validating.
   * Rejects with error message if MR not found in the list.
   */
  async openDiffByMRNumber(input: string): Promise<void> {
    const mrNumber = this.extractMRNumber(input);

    // Fetch latest MR list — use platform from active session or detect from git remote
    const session = this.commentStore.activeSession;
    let platform = session?.platform;
    if (!platform || platform === 'unknown') {
      const workspacePath = getWorkspacePath();
      if (workspacePath) {
        try {
          // Reuse or init gitService to avoid leaking temp directories
          if (!this.gitService || this.gitService.workspacePath !== workspacePath) {
            this.gitService?.dispose();
            this.gitService = new GitService(workspacePath);
          }
          const remoteUrl = await this.gitService.getRemoteUrl();
          platform = detectPlatform(remoteUrl);
        } catch {
          // Will fail later if platform still unknown
        }
      }
    }
    if (platform && platform !== 'unknown') {
      await this.loadMRs(platform);
    } else {
      throw new Error('无法检测代码平台，请确认 git remote 配置正确后再按 MR 编号打开评审');
    }

    // Check against refreshed MR list
    const matched = this.mrCache.find(mr => String(mr.id) === mrNumber);
    if (!matched) {
      const available = this.mrCache.map(m => `#${m.id} ${m.title}`).join(', ') || '无';
      throw new Error(
        `MR #${mrNumber} 不在当前 MR 列表中。` +
        `请检查编号是否正确，或确认该 MR 是否已合并/关闭。` +
        `当前可用 MR: ${available}`
      );
    }

    // Open with validated MR info
    await this.openDiff(matched.sourceBranch, matched.targetBranch, matched.id);
  }

  async setMR(mrId: string): Promise<void> {
    const sessionId = this.commentStore.activeSessionId;
    if (!sessionId) return;
    const normalizedId = this.extractMRNumber(mrId);
    await this.commentStore.updateSessionMRId(sessionId, normalizedId);
  }

  async fetchRemoteComments(sessionId: string, mrId: string): Promise<RemoteComment[]> {
    const session = this.commentStore.activeSession;
    if (!session || !mrId) return [];
    if (session.platform === 'unknown') {
      console.log('[Coordinator] fetchRemoteComments: skipped, platform unknown');
      return [];
    }

    const cwd = getWorkspacePath() || this.cwd;
    console.log(`[Coordinator] fetchRemoteComments: mrId=${mrId}, platform=${session.platform}, cwd=${cwd}`);
    const submitter = createSubmitter(session.platform, cwd);
    const comments = await submitter.listComments(mrId);
    console.log(`[Coordinator] fetchRemoteComments: got ${comments.length} comments`);
    await this.commentStore.updateSessionRemoteComments(sessionId, comments);
    return comments;
  }

  getRemoteCommentCapabilities(): { canResolveRemoteComments: boolean } {
    const session = this.commentStore.activeSession;
    if (!session || session.platform === 'unknown') return { canResolveRemoteComments: false };
    try {
      const submitter = createSubmitter(session.platform, getWorkspacePath() || this.cwd);
      return { canResolveRemoteComments: submitter.canResolveRemoteComments?.() === true };
    } catch {
      return { canResolveRemoteComments: false };
    }
  }

  async resolveRemoteComment(remoteCommentId: string): Promise<boolean> {
    const session = this.commentStore.activeSession;
    const sessionId = this.commentStore.activeSessionId;
    if (!session || !sessionId || !session.mrId || session.platform === 'unknown') return false;
    const remoteComment = session.remoteComments.find(comment => comment.id === remoteCommentId || comment.threadId === remoteCommentId);
    const threadId = remoteComment?.threadId || remoteComment?.id || remoteCommentId;
    const submitter = createSubmitter(session.platform, getWorkspacePath() || this.cwd);
    if (submitter.canResolveRemoteComments?.() !== true || !submitter.resolveRemoteComment) return false;
    const ok = await submitter.resolveRemoteComment(session.mrId, threadId);
    if (ok) {
      await this.fetchRemoteComments(sessionId, session.mrId);
    }
    return ok;
  }

  /**
   * Extract just the numeric MR/PR ID from a string that might be a URL or a plain number.
   * Examples: "https://gitlab.com/.../merge_requests/11" → "11"
   *           "https://github.com/.../pull/42" → "42"
   *           "123" → "123"
   */
  private extractMRNumber(mrId: string): string {
    const trimmed = mrId.trim();
    if (/^\d+$/.test(trimmed)) return trimmed;

    try {
      const url = new URL(trimmed);
      const segments = url.pathname.split('/').filter(Boolean);
      for (let i = 0; i < segments.length - 1; i++) {
        if (/^(pull|merge_requests|mr)$/i.test(segments[i]) && /^\d+$/.test(segments[i + 1])) {
          return segments[i + 1];
        }
      }
    } catch {
      // Not a URL; fall through to legacy path matching for CLI-returned paths.
    }

    const pathMatch = trimmed.match(/(?:^|\/)\b(pull|merge_requests|mr)\/(\d+)(?:\/|$)/i);
    return pathMatch ? pathMatch[2] : trimmed;
  }

  async resolveMRFromLink(input: string): Promise<MRInfo | undefined> {
    const session = this.commentStore.activeSession;
    if (!session) return undefined;
    const platform = session.platform;
    if (platform === 'unknown') return undefined;

    const submitter = createSubmitter(platform, this.cwd);

    // Try to extract MR/PR number from URL or plain number
    const mrNumber = this.extractMRNumber(input);

    if (/^\d+$/.test(mrNumber)) {
      return submitter.getMRByNumber(mrNumber);
    }
    return undefined;
  }

  private async resolveOrPromptMR(sessionId: string): Promise<string | undefined> {
    const session = this.commentStore.activeSession;
    if (!session) return undefined;

    // First try to find MR by branch names
    if (session.platform === 'unknown') {
      NotificationService.error('无法提交评论：当前评审未检测到代码平台。可配置 piano-keys.07.gitProviders，或仅使用本地评审。');
      return undefined;
    }
    const submitter = createSubmitter(session.platform, getWorkspacePath() || this.cwd);
    let rawMrId = await submitter.getMRId(session.sourceBranch, session.targetBranch);
    if (rawMrId) {
      const mrId = this.extractMRNumber(rawMrId);
      await this.commentStore.updateSessionMRId(sessionId, mrId);
      return mrId;
    }

    // If no MR found by branches, prompt user
    const action = await NotificationService.warning(
      '未找到关联的 MR/PR，无法提交评论。请提供 MR 链接或编号。',
      '输入 MR 链接', '取消'
    );
    if (action !== '输入 MR 链接') return undefined;

    const input = await NotificationService.input({
      prompt: '输入 MR/PR 链接或编号',
      placeHolder: 'https://github.com/org/repo/pull/123 或 123',
    });
    if (!input) return undefined;

    const mrInfo = await this.resolveMRFromLink(input);
    if (mrInfo) {
      const normalizedId = this.extractMRNumber(mrInfo.id);
      await this.commentStore.updateSessionMRId(sessionId, normalizedId);
      return normalizedId;
    }

    // If resolve failed, treat input as raw MR number/ID (normalize it)
    const rawInput = input.trim();
    if (rawInput) {
      const normalizedId = this.extractMRNumber(rawInput);
      await this.commentStore.updateSessionMRId(sessionId, normalizedId);
      return normalizedId;
    }

    NotificationService.error('无法解析 MR 信息，请检查链接或编号是否正确');
    return undefined;
  }

  async openFileDiff(filePath: string, focusedLineNumber?: number): Promise<void> {
    const session = this.commentStore.activeSession;
    if (!session) return;

    // Lazy init gitService (e.g. after VSCode restart)
    const workspacePath = getWorkspacePath();
    if (!workspacePath) return;
    const gitService = this.getOrCreateGitService(workspacePath);

    const uris = await gitService.getFileUris(
      filePath,
      session.sourceBranch,
      session.targetBranch
    );
    const file = session.files.find(f => f.filePath === filePath);
    if (file) {
      file.originalUri = uris.originalUri.toString();
      file.modifiedUri = uris.modifiedUri.toString();
    }

    const fileTitle = session.targetBranch === '{init}'
      ? `${filePath} (全量评审 — ${session.sourceBranch})`
      : `${filePath} (${session.sourceBranch} → ${session.targetBranch})`;

    await vscode.commands.executeCommand(
      'vscode.diff',
      uris.originalUri,
      uris.modifiedUri,
      fileTitle
    );

    // Sync comments to the newly opened diff editor
    // Delay to allow the diff document to register in workspace.textDocuments
    setTimeout(() => {
      this.diffController.refreshAllEditorThreads(
        focusedLineNumber
          ? { focusedThread: { filePath, lineNumber: focusedLineNumber } }
          : undefined
      );
    }, 300);
  }

  async submitAllComments(silent = false): Promise<{ submitted: number; failed: number }> {
    const session = this.commentStore.activeSession;
    if (!session) {
      if (!silent) NotificationService.error('No active review session');
      return { submitted: 0, failed: 0 };
    }

    const comments = this.commentStore.getSubmittableComments(session.id);
    if (comments.length === 0) {
      if (!silent) NotificationService.info('No comments to submit');
      return { submitted: 0, failed: 0 };
    }

    // Resolve MR ID - prompt user if not available
    let mrId = session.mrId;
    if (!mrId) {
      mrId = await this.resolveOrPromptMR(session.id);
      if (!mrId) return { submitted: 0, failed: 0 };
    }
    // Safety net: normalize mrId to just the number
    mrId = this.extractMRNumber(mrId);

    if (session.platform === 'unknown') {
      if (!silent) NotificationService.error('无法提交评论：当前评审未检测到代码平台。可配置 piano-keys.07.gitProviders，或仅使用本地评审。');
      return { submitted: 0, failed: 0 };
    }

    const submitter = createSubmitter(session.platform, getWorkspacePath() || this.cwd);
    const authOk = await submitter.checkAuth();
    if (!authOk) return { submitted: 0, failed: 0 };

    const submittedIds: string[] = [];
    let failedCount = 0;

    const submitOne = async (comment: typeof comments[number]) => {
      const platformId = await submitter.submitComment(
        mrId!,
        comment.filePath,
        comment.lineNumber,
        comment.content
      );

      if (platformId) {
        submittedIds.push(comment.id);
      } else {
        failedCount++;
      }
    };

    if (silent) {
      for (const comment of comments) {
        await submitOne(comment);
      }
    } else {
      NotificationService.info(`开始提交 ${comments.length} 条 Piano Keys 评论`);
      for (const comment of comments) {
        await submitOne(comment);
      }
    }

    await this.commentStore.markCommentsSubmitted(session.id, submittedIds);

    // Refresh remote comments after successful submission
    if (submittedIds.length > 0 && session.mrId) {
      await this.fetchRemoteComments(session.id, session.mrId);
    }

    await this.sidePanel.updateView();

    if (!silent) {
      if (failedCount === 0) {
        NotificationService.info(`Successfully submitted ${submittedIds.length} comments`);
      } else {
        NotificationService.warning(`Submitted ${submittedIds.length} comments, ${failedCount} failed`);
      }
    }

    return { submitted: submittedIds.length, failed: failedCount };
  }

  async submitSingleComment(commentId: string): Promise<void> {
    const session = this.commentStore.activeSession;
    if (!session) return;

    const comment = session.comments.find((c) => c.id === commentId);
    if (!comment || comment.status !== 'confirmed') return;

    // Resolve MR ID - prompt user if not available
    let mrId = session.mrId;
    if (!mrId) {
      mrId = await this.resolveOrPromptMR(session.id);
      if (!mrId) return;
    }
    // Safety net: normalize mrId to just the number
    mrId = this.extractMRNumber(mrId);

    if (session.platform === 'unknown') {
      NotificationService.error('无法提交评论：当前评审未检测到代码平台。可配置 piano-keys.07.gitProviders，或仅使用本地评审。');
      return;
    }

    const submitter = createSubmitter(session.platform, getWorkspacePath() || this.cwd);
    const authOk = await submitter.checkAuth();
    if (!authOk) return;

    const platformId = await submitter.submitComment(
      mrId!,
      comment.filePath,
      comment.lineNumber,
      comment.content
    );

    if (platformId) {
      await this.commentStore.markCommentsSubmitted(session.id, [commentId]);
      // Refresh remote comments after successful submission
      if (session.mrId) {
        await this.fetchRemoteComments(session.id, session.mrId);
      }
      NotificationService.info('Comment submitted');
    } else {
      NotificationService.error('Failed to submit comment');
    }

    await this.sidePanel.updateView();
  }
}
