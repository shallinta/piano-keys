import * as http from 'http';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import express from 'express';
import { CommentStore } from '../comment-store';
import { Coordinator } from '../coordinator';
import { SidePanelProvider } from '../side-panel-provider';
import { CommentStatus } from '../types';
import { NotificationService } from '../notification-service';
import { GitProviderDefinition, createBuiltInGitProviders } from '../git-provider';
import { createCommentToolNameHint } from '../comment-hints';
import { CLEAR_REVIEW_ENDPOINT, normalizeClearReviewRequest } from './http-api';

const PORTS_FILE = path.join(os.homedir(), '.piano-keys', 'ports.json');
const VALID_COMMENT_STATUSES: CommentStatus[] = ['pending', 'confirmed', 'submitted', 'deleted'];

export class HttpServer {
  private app: express.Express;
  private server: http.Server | null = null;
  private token: string;
  private commentStore: CommentStore;
  private coordinator: Coordinator;
  private sidePanel: SidePanelProvider;
  private port: number = 0;

  constructor(
    commentStore: CommentStore,
    coordinator: Coordinator,
    sidePanel: SidePanelProvider
  ) {
    this.app = express();
    this.token = crypto.randomBytes(32).toString('hex');
    this.commentStore = commentStore;
    this.coordinator = coordinator;
    this.sidePanel = sidePanel;
  }

  get tokenValue(): string {
    return this.token;
  }

  /** Get the workspace root path for this VSCode instance. */
  private getProjectPath(): string | null {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      return folders[0].uri.fsPath;
    }
    return null;
  }

  async start(): Promise<{ port: number; token: string }> {
    this.app.use(express.json());
    this.app.use(this.authMiddleware.bind(this));

    // GET /state
    this.app.get('/state', (_req, res) => {
      const state = this.commentStore.getReviewState();
      if (!state) {
        return res.json({ success: false, error: 'No active review session' });
      }

      // Enrich with MR info if mrId is set
      const mrInfo = state.mrId
        ? this.coordinator.getMRs().find(mr => String(mr.id) === String(state.mrId))
        : undefined;

      const projectPath = this.getProjectPath();

      res.json({
        success: true,
        data: {
          ...state,
          projectPath,
          projectName: projectPath ? path.basename(projectPath) : null,
          mrInfo: mrInfo ?? null,
          mrList: this.coordinator.getMRs(),
        },
      });
    });

    // GET /config
    this.app.get('/config', (_req, res) => {
      const config = vscode.workspace.getConfiguration('piano-keys');
      res.json({
        success: true,
        data: {
          theme: config.get<string>('01.theme', 'piano-dark'),
          defaultRemote: config.get<string>('02.defaultRemote', 'origin'),
          reviewDocPatterns: config.get<string[]>('03.reviewDocPatterns', []),
          userSignature: config.get<string>('04.userSignature', ''),
          agentSignature: config.get<string>('05.agentSignature', ''),
          agentAppendToolName: config.get<boolean>('06.agentAppendToolName', true),
          gitProviders: config.get<GitProviderDefinition[]>('07.gitProviders', createBuiltInGitProviders()),
        },
      });
    });

    // POST /config
    this.app.post('/config', async (req, res) => {
      const config = vscode.workspace.getConfiguration('piano-keys');
      const updates = req.body;
      if (!updates || typeof updates !== 'object') {
        return res.status(400).json({ success: false, error: 'Request body must be a JSON object with settings to update' });
      }
      const keyMap: Record<string, string> = {
        theme: '01.theme',
        defaultRemote: '02.defaultRemote',
        reviewDocPatterns: '03.reviewDocPatterns',
        userSignature: '04.userSignature',
        agentSignature: '05.agentSignature',
        agentAppendToolName: '06.agentAppendToolName',
        gitProviders: '07.gitProviders',
      };
      try {
        for (const [key, value] of Object.entries(updates)) {
          const settingKey = keyMap[key];
          if (!settingKey) {
            return res.status(400).json({ success: false, error: `Unknown setting: ${key}` });
          }
          await config.update(settingKey, value, vscode.ConfigurationTarget.Global);
        }
        // Return updated config
        const updatedConfig = vscode.workspace.getConfiguration('piano-keys');
        res.json({
          success: true,
          data: {
            theme: updatedConfig.get<string>('01.theme', 'piano-dark'),
            defaultRemote: updatedConfig.get<string>('02.defaultRemote', 'origin'),
            reviewDocPatterns: updatedConfig.get<string[]>('03.reviewDocPatterns', []),
            userSignature: updatedConfig.get<string>('04.userSignature', ''),
            agentSignature: updatedConfig.get<string>('05.agentSignature', ''),
            agentAppendToolName: updatedConfig.get<boolean>('06.agentAppendToolName', true),
            gitProviders: updatedConfig.get<GitProviderDefinition[]>('07.gitProviders', createBuiltInGitProviders()),
          },
        });
      } catch (err: any) {
        res.json({ success: false, error: err.message });
      }
    });

    // POST /comments
    this.app.post('/comments', async (req, res) => {
      const { filePath, lineNumber, content, openDiff } = req.body;
      if (!filePath || lineNumber == null || !content) {
        return res.status(400).json({ success: false, error: 'Missing required fields: filePath, lineNumber, content' });
      }
      const normalizedLineNumber = typeof lineNumber === 'number'
        ? lineNumber
        : (typeof lineNumber === 'string' && /^\d+$/.test(lineNumber) ? Number(lineNumber) : NaN);
      if (!Number.isInteger(normalizedLineNumber) || normalizedLineNumber < 1) {
        return res.status(400).json({ success: false, error: 'lineNumber must be a positive integer' });
      }
      const sessionId = this.commentStore.activeSessionId;
      if (!sessionId) {
        return res.json({ success: false, error: 'No active review session' });
      }
      const session = this.commentStore.activeSession;
      if (!session?.files.some(file => file.filePath === filePath)) {
        return res.status(400).json({ success: false, error: `File is not part of current review session: ${filePath}` });
      }
      try {
        const comment = await this.commentStore.createComment(sessionId, {
          author: 'agent',
          filePath,
          lineNumber: normalizedLineNumber,
          content,
          status: 'pending',
        });
        await this.sidePanel.updateView();
        if (openDiff === true) {
          await this.coordinator.openFileDiff(filePath);
        }
        vscode.commands.executeCommand('piano-keys.refreshEditorThreads');

        // Check tool-name attribution and hint the agent when needed.
        const config = vscode.workspace.getConfiguration('piano-keys');
        const appendToolName = config.get<boolean>('06.agentAppendToolName', true);
        const hint = createCommentToolNameHint(content, appendToolName);

        res.json({ success: true, data: { id: comment.id }, hint: hint ?? null });
      } catch (err: any) {
        res.json({ success: false, error: err.message });
      }
    });

    // DELETE /comments/:id
    this.app.delete('/comments/:id', async (req, res) => {
      const sessionId = this.commentStore.activeSessionId;
      if (!sessionId) {
        return res.json({ success: false, error: 'No active review session' });
      }
      const comment = await this.commentStore.moveToTrash(sessionId, req.params.id);
      if (!comment) {
        return res.json({ success: false, error: 'Comment not found' });
      }
      await this.sidePanel.updateView();
      vscode.commands.executeCommand('piano-keys.refreshEditorThreads');
      res.json({ success: true });
    });

    // GET /comments/:id
    this.app.get('/comments/:id', async (req, res) => {
      const sessionId = this.commentStore.activeSessionId;
      if (!sessionId) {
        return res.json({ success: false, error: 'No active review session' });
      }
      const comment = this.commentStore.getCommentById(sessionId, req.params.id);
      if (!comment) {
        return res.json({ success: false, error: 'Comment not found' });
      }
      res.json({ success: true, data: comment });
    });

    // PATCH /comments/:id — update comment content and/or status
    this.app.patch('/comments/:id', async (req, res) => {
      const sessionId = this.commentStore.activeSessionId;
      if (!sessionId) {
        return res.json({ success: false, error: 'No active review session' });
      }
      const { content, status } = req.body;
      if (content === undefined && status === undefined) {
        return res.status(400).json({ success: false, error: 'At least one of content or status is required' });
      }
      if (status !== undefined && !VALID_COMMENT_STATUSES.includes(status)) {
        return res.status(400).json({ success: false, error: `Invalid status: ${status}` });
      }
      const comment = this.commentStore.getCommentById(sessionId, req.params.id);
      if (!comment) {
        return res.json({ success: false, error: 'Comment not found' });
      }
      try {
        if (content !== undefined) {
          await this.commentStore.updateCommentContent(sessionId, req.params.id, content);
        }
        if (status !== undefined) {
          await this.commentStore.updateCommentStatus(sessionId, req.params.id, status);
        }
        await this.sidePanel.updateView();
        vscode.commands.executeCommand('piano-keys.refreshEditorThreads');
        const updated = this.commentStore.getCommentById(sessionId, req.params.id);
        res.json({ success: true, data: updated });
      } catch (err: any) {
        res.json({ success: false, error: err.message });
      }
    });

    // POST /comments/confirm-all
    this.app.post('/comments/confirm-all', async (_req, res) => {
      const sessionId = this.commentStore.activeSessionId;
      if (!sessionId) {
        return res.json({ success: false, error: 'No active review session' });
      }
      const count = await this.commentStore.confirmAllAgentComments(sessionId);
      await this.sidePanel.updateView();
      vscode.commands.executeCommand('piano-keys.refreshEditorThreads');
      res.json({ success: true, data: { confirmed: count } });
    });

    // POST /comments/submit-all
    this.app.post('/comments/submit-all', async (_req, res) => {
      const result = await this.coordinator.submitAllComments(true);
      res.json({ success: true, data: result });
    });

    // POST /review/clear - clear current diff files/comments while preserving MR/branch fields
    this.app.post(CLEAR_REVIEW_ENDPOINT, async (req, res) => {
      const sessionId = this.commentStore.activeSessionId;
      const session = this.commentStore.activeSession;
      if (!sessionId || !session) {
        return res.json({ success: false, error: 'No active review session' });
      }
      const preserve = normalizeClearReviewRequest(req.body);
      const previous = {
        files: session.files.length,
        comments: session.comments.length,
        remoteComments: session.remoteComments.length,
        deletedComments: this.commentStore.getDeletedComments(sessionId).length,
      };
      await this.commentStore.clearReviewContent(sessionId, {
        sourceBranch: preserve.sourceBranch ?? session.sourceBranch,
        targetBranch: preserve.targetBranch ?? session.targetBranch,
        mrId: preserve.mrId ?? session.mrId,
      });
      await this.sidePanel.updateView();
      vscode.commands.executeCommand('piano-keys.refreshEditorThreads');
      res.json({ success: true, data: { cleared: previous } });
    });

    // POST /open-diff
    this.app.post('/open-diff', async (req, res) => {
      const { filePath } = req.body;
      if (!filePath) {
        return res.status(400).json({ success: false, error: 'Missing required field: filePath' });
      }
      await this.coordinator.openFileDiff(filePath);
      res.json({ success: true });
    });

    // POST /open-review-by-branches - open diff by source/target branches
    this.app.post('/open-review-by-branches', async (req, res) => {
      const { sourceBranch, targetBranch, mrId } = req.body;
      if (!sourceBranch || !targetBranch) {
        return res.status(400).json({ success: false, error: 'Missing required fields: sourceBranch, targetBranch' });
      }
      try {
        const opened = await this.coordinator.openDiff(sourceBranch, targetBranch, mrId);
        if (!opened) {
          return res.json({ success: false, error: 'Failed to open review' });
        }
        res.json({ success: true, message: 'Opening review...' });
      } catch (err: any) {
        console.error('open-review-by-branches error:', err);
        res.json({ success: false, error: err.message });
      }
    });

    // POST /open-review-by-link - open diff by MR/PR link
    this.app.post('/open-review-by-link', async (req, res) => {
      const { link } = req.body;
      if (!link) {
        return res.status(400).json({ success: false, error: 'Missing required field: link' });
      }
      try {
        const opened = await this.coordinator.openDiffFromLink(link);
        if (!opened) {
          return res.json({ success: false, error: 'Failed to open review' });
        }
        res.json({ success: true, message: 'Opening review...' });
      } catch (err: any) {
        res.json({ success: false, error: err.message });
      }
    });

    // POST /open-review-by-mr-number - validate MR against cached list, then open diff
    this.app.post('/open-review-by-mr-number', async (req, res) => {
      const { mrNumber } = req.body;
      if (!mrNumber) {
        return res.status(400).json({ success: false, error: 'Missing required field: mrNumber' });
      }
      try {
        await this.coordinator.openDiffByMRNumber(mrNumber);
        res.json({ success: true, message: 'Opening review...' });
      } catch (err: any) {
        res.json({ success: false, error: err.message });
      }
    });

    // POST /refresh-remote-comments - re-fetch remote comments from the MR
    this.app.post('/refresh-remote-comments', async (_req, res) => {
      const session = this.commentStore.getReviewState();
      if (!session) {
        return res.json({ success: false, error: 'No active review session' });
      }
      if (!session.mrId) {
        return res.json({ success: false, error: 'No MR associated with current session' });
      }
      try {
        const comments = await this.coordinator.fetchRemoteComments(
          this.commentStore.activeSessionId!,
          String(session.mrId)
        );
        await this.sidePanel.updateView();
        res.json({ success: true, data: { count: comments.length, comments } });
      } catch (err: any) {
        res.json({ success: false, error: err.message });
      }
    });

    return new Promise((resolve) => {
      this.server = this.app.listen(0, '127.0.0.1', () => {
        const address = this.server!.address() as import('net').AddressInfo;
        this.port = address.port;
        try {
          this.writePortEntry();
        } catch (err: any) {
          console.error('[Piano Keys] Failed to write ports file:', err?.message || err);
          NotificationService.warning('Piano Keys API 已启动，但端口信息写入失败，外部 Agent 可能无法自动发现连接');
        }
        resolve({ port: this.port, token: this.token });
      });
    });
  }

  stop(): void {
    this.server?.close();
    this.removePortEntry();
  }

  private authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
    const auth = req.headers.authorization;
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token !== this.token) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    next();
  }

  private readPortsFile(): Record<string, { port: number; token: string; name: string; pid: number }> {
    try {
      if (fs.existsSync(PORTS_FILE)) {
        const content = fs.readFileSync(PORTS_FILE, 'utf-8');
        return JSON.parse(content);
      }
    } catch {
      // ignore parse errors
    }
    return {};
  }

  private writePortEntry(): void {
    const dir = path.dirname(PORTS_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const projectPath = this.getProjectPath();
    const ports = this.readPortsFile();
    const name = projectPath ? path.basename(projectPath) : 'unknown';
    ports[projectPath || `unknown-${this.port}`] = {
      port: this.port,
      token: this.token,
      name,
      pid: process.pid,
    };

    // Clean up stale entries (process no longer exists)
    this.cleanStaleEntries(ports);

    fs.writeFileSync(PORTS_FILE, JSON.stringify(ports, null, 2), { mode: 0o600 });
    try {
      fs.chmodSync(PORTS_FILE, 0o600);
    } catch (err: any) {
      console.warn('[Piano Keys] Failed to set ports file permissions:', err?.message || err);
    }
  }

  private removePortEntry(): void {
    const projectPath = this.getProjectPath();
    const key = projectPath || `unknown-${this.port}`;
    const ports = this.readPortsFile();
    delete ports[key];

    if (Object.keys(ports).length === 0) {
      try { fs.unlinkSync(PORTS_FILE); } catch { /* ignore */ }
    } else {
      fs.writeFileSync(PORTS_FILE, JSON.stringify(ports, null, 2), { mode: 0o600 });
      try { fs.chmodSync(PORTS_FILE, 0o600); } catch { /* ignore */ }
    }
  }

  private cleanStaleEntries(ports: Record<string, { port: number; token: string; name: string; pid: number }>): void {
    for (const [key, entry] of Object.entries(ports)) {
      if (entry.pid && !isProcessRunning(entry.pid)) {
        delete ports[key];
      }
    }
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
