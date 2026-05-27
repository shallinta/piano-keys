import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CommentStore } from './comment-store';
import { Coordinator } from './coordinator';
import { MRInfo } from './mr-submitter';
import { detectPlatform, Platform, promptPlatform } from './platform-detector';
import { getWorkspacePath, GitService } from './git';
import { NotificationService } from './notification-service';
import { buildTargetBranchSuggestions, normalizeBranchName } from './branch-suggestions';

const TARGET_BRANCH_HISTORY_KEY = 'piano-keys.targetBranchHistory';
const TARGET_BRANCH_HISTORY_LIMIT = 8;

export class SidePanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'piano-keys.sidePanel';

  private view?: vscode.WebviewView;
  private commentStore: CommentStore;
  private context: vscode.ExtensionContext;
  private coordinator: Coordinator | null = null;
  private mrList: MRInfo[] = [];
  private activeFilePath: string | undefined;

  constructor(context: vscode.ExtensionContext, commentStore: CommentStore) {
    this.context = context;
    this.commentStore = commentStore;
  }

  setCoordinator(coordinator: Coordinator): void {
    this.coordinator = coordinator;
  }

  setActiveFilePath(filePath: string | undefined): void {
    this.activeFilePath = filePath;
    this.updateView();
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this.view = webviewView;
    NotificationService.setView(webviewView);
    this.view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };

    const htmlPath = path.join(this.context.extensionPath, 'webview', 'side-panel.html');
    this.view.webview.html = fs.readFileSync(htmlPath, 'utf-8');

    this.view.webview.onDidReceiveMessage((message) => this.handleMessage(message));

    // Delay to ensure webview JS is loaded before sending cached state
    setTimeout(() => {
      this.updateView();
      // Load MR list once on initialization (no feedback)
      this.doLoadMRs(false);
    }, 200);
  }

  private async handleMessage(message: any) {
    switch (message.type) {
      case 'restoreState':
        this.updateView();
        break;
      case 'notificationResponse':
        NotificationService.handleResponse(message);
        break;
      case 'openDiff':
        await this.rememberTargetBranch(message.targetBranch);
        vscode.commands.executeCommand('piano-keys.openDiff', {
          sourceBranch: message.sourceBranch,
          targetBranch: message.targetBranch,
          mrId: message.mrId,
        });
        break;
      case 'getBranchSuggestions':
        await this.sendBranchSuggestions(message.kind === 'target' ? 'target' : 'source');
        break;
      case 'confirmComment': {
        const sessionId = this.commentStore.activeSessionId;
        if (!sessionId) break;
        await this.commentStore.updateCommentStatus(sessionId, message.id, 'confirmed');
        this._onConfirmComment(message.id);
        break;
      }
      case 'deleteComment': {
        const sessionId = this.commentStore.activeSessionId;
        if (!sessionId) break;
        await this.commentStore.moveToTrash(sessionId, message.id);
        this._onConfirmComment(message.id);
        break;
      }
      case 'confirmAllAgent': {
        const sessionId = this.commentStore.activeSessionId;
        if (!sessionId) break;
        const count = await this.commentStore.confirmAllAgentComments(sessionId);
        NotificationService.info(`Confirmed ${count} agent comments`);
        this._onConfirmComment();
        break;
      }
      case 'submitComment':
        vscode.commands.executeCommand('piano-keys.submitSingleComment', message.id);
        break;
      case 'submitAll':
        vscode.commands.executeCommand('piano-keys.submitAllComments');
        break;
      case 'clearReview': {
        const sessionId = this.commentStore.activeSessionId;
        if (!sessionId) break;
        await this.commentStore.clearReviewContent(sessionId, {
          sourceBranch: message.sourceBranch,
          targetBranch: message.targetBranch,
          mrId: message.mrId,
        });
        await this.updateView();
        vscode.commands.executeCommand('piano-keys.refreshEditorThreads');
        NotificationService.info('已清空当前对比的变更文件和评论');
        break;
      }
      case 'settings':
        vscode.commands.executeCommand('workbench.action.openSettings', 'piano-keys');
        break;
      case 'installSkill':
        vscode.commands.executeCommand('piano-keys.installSkill');
        break;
      case 'undoDeleteComment': {
        const sessionId = this.commentStore.activeSessionId;
        if (!sessionId) break;
        await this.commentStore.restoreFromTrash(sessionId, message.id);
        this._onConfirmComment();
        break;
      }
      case 'openFile':
        vscode.commands.executeCommand('piano-keys.openFile', message.filePath);
        break;
      case 'openFileAtLine': {
        // Open file in diff editor and navigate to line
        await vscode.commands.executeCommand('piano-keys.openFile', message.filePath, { lineNumber: message.lineNumber });
        // Wait a tick for editor to open, then reveal line
        setTimeout(() => {
          const editor = vscode.window.activeTextEditor;
          if (editor) {
            const line = message.lineNumber - 1; // 0-based
            const range = new vscode.Range(line, 0, line, 0);
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
            editor.selection = new vscode.Selection(line, 0, line, 0);
          }
        }, 300);
        break;
      }
      case 'startEdit': {
        const comment = this.commentStore.getCommentById(this.commentStore.activeSessionId!, message.id);
        if (comment) {
          const config = vscode.workspace.getConfiguration('piano-keys');
          const signature = comment.author === 'agent'
            ? config.get<string>('05.agentSignature', '')
            : config.get<string>('04.userSignature', '');
          let content = comment.content;
          if (signature) {
            const escapedSig = signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const sigRegex = new RegExp('\\s*' + escapedSig + '\\s*$');
            content = content.replace(sigRegex, '');
          }
          this.view?.webview.postMessage({ type: 'editContent', id: message.id, content });
        }
        break;
      }
      case 'editComment': {
        const rawContent = message.currentContent;
        if (rawContent) {
          const config = vscode.workspace.getConfiguration('piano-keys');
          const agentSignature = config.get<string>('05.agentSignature', '');
          const userSignature = config.get<string>('04.userSignature', '');
          const comment = this.commentStore.getCommentById(this.commentStore.activeSessionId!, message.id);
          let newContent = rawContent;
          if (comment) {
            if (comment.author === 'agent' && agentSignature) {
              newContent = this.appendSignatureOnce(newContent, agentSignature);
            } else if (comment.author === 'user' && userSignature) {
              newContent = this.appendSignatureOnce(newContent, userSignature);
            }
          }
          await this.commentStore.updateCommentContent(
            this.commentStore.activeSessionId!,
            message.id,
            newContent
          );
          this.updateView();
          vscode.commands.executeCommand('piano-keys.refreshEditorThreads');
        }
        break;
      }
      case 'changeTheme': {
        const config = vscode.workspace.getConfiguration('piano-keys');
        await config.update('01.theme', message.theme, vscode.ConfigurationTarget.Global);
        break;
      }
      case 'loadMRs': {
        await this.doLoadMRs(true);
        break;
      }
      case 'selectMR': {
        // Selecting an MR in the dropdown only pre-fills branch inputs in the webview.
        // Do not mutate the active review session here: changing mrId/branches while
        // keeping the old comments makes a later openDiff reuse the old session for a
        // different MR, leaking submitted comments into the new review.
        break;
      }
      case 'inputMR': {
        const mrInput = message.mrInput;
        if (mrInput && this.coordinator) {
          const mrInfo = await this.coordinator.resolveMRFromLink(mrInput);
          if (mrInfo) {
            await this.coordinator.setMR(mrInfo.id);
            NotificationService.info(`已关联 MR: #${mrInfo.id} ${mrInfo.title}`);
          } else {
            await this.coordinator.setMR(mrInput.trim());
            NotificationService.info(`已设置 MR 编号: ${mrInput.trim()}`);
          }
          await this.updateView();
        }
        break;
      }
      case 'refreshRemoteComments': {
        if (this.coordinator) {
          const session = this.commentStore.activeSession;
          if (session?.mrId) {
            try {
              const comments = await this.coordinator.fetchRemoteComments(this.commentStore.activeSessionId!, session.mrId);
              await this.updateView();
              NotificationService.info(comments.length > 0 ? `远端评论刷新完成，共获取 ${comments.length} 条评论` : '远端评论刷新完成，未获取到远端评论');
            } catch (err: any) {
              NotificationService.error(`远端评论刷新失败：${err?.message || err}`);
            }
          } else {
            NotificationService.warning('当前未关联 MR，无法刷新远端评论');
          }
        }
        break;
      }
      case 'resolveRemoteComment': {
        if (this.coordinator) {
          const ok = await this.coordinator.resolveRemoteComment(message.id);
          await this.updateView();
          if (ok) {
            NotificationService.info('远端评论已标记为已解决');
          } else {
            NotificationService.warning('当前代码平台不支持解决远端评论，或操作失败');
          }
        }
        break;
      }
      default:
        console.warn('[Piano Keys] Unknown side panel message type:', message?.type);
    }
  }

  private appendSignatureOnce(content: string, signature: string): string {
    const normalizedSignature = signature.trim();
    if (!normalizedSignature) return content.trimEnd();
    const escapedSig = normalizedSignature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const sigRegex = new RegExp('\\s*' + escapedSig + '\\s*$');
    return content.replace(sigRegex, '').trimEnd() + '\n\n' + normalizedSignature;
  }

  private async rememberTargetBranch(targetBranch: string | undefined): Promise<void> {
    const branch = (targetBranch || '').trim();
    if (!branch || branch === '{init}') return;
    const current = this.context.globalState.get<string[]>(TARGET_BRANCH_HISTORY_KEY, []);
    const next = [branch, ...current.filter(item => item !== branch)].slice(0, TARGET_BRANCH_HISTORY_LIMIT);
    await this.context.globalState.update(TARGET_BRANCH_HISTORY_KEY, next);
  }

  private async sendBranchSuggestions(kind: 'source' | 'target'): Promise<void> {
    if (!this.view) return;
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      this.view.webview.postMessage({ type: 'updateBranchSuggestions', kind, suggestions: [] });
      return;
    }

    const gitService = new GitService(workspacePath);
    try {
      const branches = await gitService.listBranches();
      if (kind === 'source') {
        const currentBranch = await gitService.currentBranch();
        const suggestions = this.uniqueBranches([currentBranch, ...branches]);
        this.view.webview.postMessage({ type: 'updateBranchSuggestions', kind, suggestions, currentBranch });
      } else {
        const history = this.context.globalState.get<string[]>(TARGET_BRANCH_HISTORY_KEY, []);
        const suggestions = buildTargetBranchSuggestions(branches, history);
        this.view.webview.postMessage({ type: 'updateBranchSuggestions', kind, suggestions });
      }
    } catch (err: any) {
      console.warn(`[Piano Keys] failed to load ${kind} branch suggestions:`, err?.message || err);
      this.view.webview.postMessage({ type: 'updateBranchSuggestions', kind, suggestions: [] });
    } finally {
      gitService.dispose();
    }
  }

  private uniqueBranches(branches: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const raw of branches) {
      const branch = normalizeBranchName(raw);
      if (!branch || seen.has(branch)) continue;
      seen.add(branch);
      result.push(branch);
    }
    return result;
  }

  async updateView(fetchFailed: boolean = false) {
    if (!this.view) return;

    const session = this.commentStore.activeSession;
    const sessionId = this.commentStore.activeSessionId;
    const config = vscode.workspace.getConfiguration('piano-keys');
    const theme = config.get<string>('01.theme', 'piano-dark');
    const agentSignature = config.get<string>('05.agentSignature', '');
    const userSignature = config.get<string>('04.userSignature', '');
    const state = {
      comments: session?.comments || [],
      deletedComments: sessionId ? this.commentStore.getDeletedComments(sessionId) : [],
      files: session?.files || [],
      sourceBranch: session?.sourceBranch || '',
      targetBranch: session?.targetBranch || '',
      sessionId,
      fetchFailed,
      mrId: session?.mrId || '',
      mrList: this.mrList,
      remoteComments: session?.remoteComments || [],
      activeFilePath: this.activeFilePath || '',
      theme,
      agentSignature,
      userSignature,
      remoteCapabilities: this.coordinator?.getRemoteCommentCapabilities() || { canResolveRemoteComments: false },
    };

    this.view.webview.postMessage({ type: 'updateState', state });
  }

  async doLoadMRs(showFeedback = false) {
    if (!this.coordinator) {
      if (showFeedback) NotificationService.warning('插件未初始化，请重启 VSCode');
      return;
    }

    // Detect platform from git remote (independent of active session)
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      if (showFeedback) NotificationService.warning('未检测到工作区，请先打开一个项目');
      return;
    }

    let platform: Platform = 'unknown';
    try {
      const gitService = new GitService(workspacePath);
      const remoteUrl = await gitService.getRemoteUrl();
      platform = detectPlatform(remoteUrl);
    } catch {
      // getRemoteUrl failed
    }

    if (platform === 'unknown') {
      // Fallback: use platform from active session if available
      const session = this.commentStore.activeSession;
      if (session && session.platform !== 'unknown') {
        platform = session.platform;
      } else {
        if (showFeedback) NotificationService.warning('未检测到有效的代码平台配置。请配置 piano-keys.07.gitProviders，或让 agent 使用 piano-keys-cr skill 交互式配置自定义 provider。');
        return;
      }
    }

    this.mrList = await this.coordinator.loadMRs(platform);

    if (showFeedback) {
      if (this.mrList.length > 0) {
        NotificationService.info(`已加载 ${this.mrList.length} 个 MR`);
      } else {
        NotificationService.warning('未找到 MR，请确认当前项目已关联 MR');
      }
    }

    // Send MR list to webview
    if (this.view) {
      const session = this.commentStore.activeSession;
      this.view.webview.postMessage({
        type: 'updateMRList',
        mrList: this.mrList,
        mrId: session?.mrId || '',
      });
    }
  }

  updateMRList(mrs: MRInfo[]): void {
    this.mrList = mrs;
    if (this.view) {
      const session = this.commentStore.activeSession;
      this.view.webview.postMessage({
        type: 'updateMRList',
        mrList: this.mrList,
        mrId: session?.mrId || '',
      });
    }
  }

  /** Send updated state to webview and refresh editor threads. */
  private _onConfirmComment(_commentId?: string): void {
    this.updateView();
    vscode.commands.executeCommand('piano-keys.refreshEditorThreads');
  }
}
