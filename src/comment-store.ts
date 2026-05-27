import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { Comment, CommentStatus, CommentState, ReviewSession, DiffFile, RemoteComment } from './types';
import { getWorkspacePath } from './git';
import { clearReviewSessionContent } from './review-session-utils';

const STORAGE_KEY = 'piano-keys.commentState';

export class CommentStore {
  private context: vscode.ExtensionContext;
  private state: CommentState;
  // In-memory trash: NOT persisted across VSCode restarts
  private trash = new Map<string, Comment[]>();
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.state = context.globalState.get<Partial<CommentState>>(STORAGE_KEY, {
      sessions: {},
      activeSessionId: null,
    }) as CommentState;
    this.trash = new Map(Object.entries(this.state.trash ?? {}));
  }

  get activeSession(): ReviewSession | undefined {
    const session = this.resolveActiveSession();
    return session ?? undefined;
  }

  get activeSessionId(): string | null {
    return this.resolveActiveSession()?.id ?? null;
  }

  /** Resolve active session, returning null if it belongs to a different workspace. */
  private resolveActiveSession(): ReviewSession | null {
    if (!this.state.activeSessionId) return null;
    const session = this.state.sessions[this.state.activeSessionId];
    if (!session) return null;
    const currentWorkspace = getWorkspacePath();
    if (currentWorkspace && session.workspacePath && session.workspacePath !== currentWorkspace) {
      return null;
    }
    return session;
  }

  async findOrCreateSession(id: string, sourceBranch: string, targetBranch: string, platform: string, mrId: string | undefined, files: DiffFile[]): Promise<ReviewSession> {
    // Try to find an existing session with same workspace + branches + mrId
    const currentWorkspace = getWorkspacePath();
    for (const sess of Object.values(this.state.sessions)) {
      if (sess.sourceBranch === sourceBranch &&
          sess.targetBranch === targetBranch &&
          sess.workspacePath === currentWorkspace &&
          sess.mrId === (mrId || undefined)) {
        // Reuse: update files/platform, keep comments, set as active
        sess.files = files;
        sess.platform = platform as ReviewSession['platform'];
        if (mrId !== undefined) sess.mrId = mrId;
        this.state.activeSessionId = sess.id;
        await this.persist();
        return sess;
      }
    }

    // No match — create new session
    return this.createSession(id, sourceBranch, targetBranch, platform, files, mrId);
  }

  async createSession(id: string, sourceBranch: string, targetBranch: string, platform: string, files: DiffFile[], mrId?: string): Promise<ReviewSession> {
    const session: ReviewSession = {
      id,
      sourceBranch,
      targetBranch,
      platform: platform as ReviewSession['platform'],
      files,
      comments: [],
      remoteComments: [],
      createdAt: Date.now(),
      workspacePath: getWorkspacePath(),
    };
    if (mrId) {
      session.mrId = mrId;
    }
    this.state.sessions[id] = session;
    this.state.activeSessionId = id;
    await this.persist();
    return session;
  }

  async createComment(sessionId: string, comment: Omit<Comment, 'id' | 'createdAt' | 'updatedAt'>): Promise<Comment> {
    const session = this.state.sessions[sessionId];
    if (!session) throw new Error(`Session ${sessionId} not found`);

    // Append signature based on author type
    let content = comment.content;
    const config = vscode.workspace.getConfiguration('piano-keys');
    const signature = comment.author === 'agent'
      ? config.get<string>('05.agentSignature', '')
      : config.get<string>('04.userSignature', '');
    if (signature) {
      content = appendSignatureOnce(content, signature);
    }

    const newComment: Comment = {
      ...comment,
      content,
      id: `comment-${crypto.randomUUID()}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    session.comments.push(newComment);
    await this.persist();
    return newComment;
  }

  async updateCommentStatus(sessionId: string, commentId: string, status: CommentStatus): Promise<Comment | undefined> {
    const session = this.state.sessions[sessionId];
    if (!session) return undefined;

    const comment = session.comments.find((c) => c.id === commentId);
    if (!comment) return undefined;

    comment.status = status;
    comment.updatedAt = Date.now();
    await this.persist();
    return comment;
  }

  /** Get a comment by id from a session. */
  getCommentById(sessionId: string, commentId: string): Comment | undefined {
    const session = this.state.sessions[sessionId];
    if (!session) return undefined;
    return session.comments.find((c) => c.id === commentId);
  }

  /** Move comment to trash (not persisted). Returns the moved comment or undefined. */
  async moveToTrash(sessionId: string, commentId: string): Promise<Comment | undefined> {
    const session = this.state.sessions[sessionId];
    if (!session) return undefined;

    const idx = session.comments.findIndex((c) => c.id === commentId);
    if (idx < 0) return undefined;

    const [comment] = session.comments.splice(idx, 1);
    comment.previousStatus = comment.status;
    comment.status = 'deleted';

    const trashList = this.trash.get(sessionId) || [];
    trashList.push(comment);
    this.trash.set(sessionId, trashList);
    await this.persist();
    return comment;
  }

  /** Restore comment from trash back to active comments. */
  async restoreFromTrash(sessionId: string, commentId: string): Promise<Comment | undefined> {
    const trashList = this.trash.get(sessionId) || [];
    const idx = trashList.findIndex((c) => c.id === commentId);
    if (idx < 0) return undefined;

    const [comment] = trashList.splice(idx, 1);
    if (trashList.length === 0) {
      this.trash.delete(sessionId);
    } else {
      this.trash.set(sessionId, trashList);
    }

    comment.status = comment.previousStatus || 'confirmed';
    delete comment.previousStatus;
    comment.updatedAt = Date.now();

    const session = this.state.sessions[sessionId];
    if (session) {
      session.comments.push(comment);
    }
    await this.persist();
    return comment;
  }

  /** Get deleted comments from trash (not persisted). */
  getDeletedComments(sessionId: string): Comment[] {
    return this.trash.get(sessionId) || [];
  }

  async updateCommentContent(sessionId: string, commentId: string, content: string): Promise<Comment | undefined> {
    const session = this.state.sessions[sessionId];
    if (!session) return undefined;

    const comment = session.comments.find((c) => c.id === commentId);
    if (!comment) return undefined;

    comment.content = content;
    comment.updatedAt = Date.now();
    await this.persist();
    return comment;
  }

  async updateSessionMRId(sessionId: string, mrId: string): Promise<void> {
    const session = this.state.sessions[sessionId];
    if (!session) return;
    session.mrId = mrId;
    await this.persist();
  }

  async updateSessionBranches(sessionId: string, sourceBranch: string, targetBranch: string): Promise<void> {
    const session = this.state.sessions[sessionId];
    if (!session) return;
    session.sourceBranch = sourceBranch;
    session.targetBranch = targetBranch;
    await this.persist();
  }

  async updateSessionRemoteComments(sessionId: string, comments: RemoteComment[]): Promise<void> {
    const session = this.state.sessions[sessionId];
    if (!session) return;
    session.remoteComments = comments;
    await this.persist();
  }

  async clearReviewContent(
    sessionId: string,
    preserve?: Partial<Pick<ReviewSession, 'sourceBranch' | 'targetBranch' | 'mrId'>>
  ): Promise<boolean> {
    const session = this.state.sessions[sessionId];
    if (!session) return false;
    clearReviewSessionContent(session, preserve);
    this.trash.delete(sessionId);
    await this.persist();
    return true;
  }

  getRemoteComments(sessionId: string): RemoteComment[] {
    const session = this.state.sessions[sessionId];
    if (!session) return [];
    return session.remoteComments;
  }

  getPendingAgentComments(sessionId: string): Comment[] {
    const session = this.state.sessions[sessionId];
    if (!session) return [];
    return session.comments.filter((c) => c.author === 'agent' && c.status === 'pending');
  }

  getSubmittableComments(sessionId: string): Comment[] {
    const session = this.state.sessions[sessionId];
    if (!session) return [];
    return session.comments.filter(
      (c) => (c.author === 'user' && c.status !== 'submitted') ||
             (c.author === 'agent' && c.status === 'confirmed')
    );
  }

  async confirmAllAgentComments(sessionId: string): Promise<number> {
    const pending = this.getPendingAgentComments(sessionId);
    for (const comment of pending) {
      comment.status = 'confirmed';
      comment.updatedAt = Date.now();
    }
    if (pending.length > 0) {
      await this.persist();
    }
    return pending.length;
  }

  getReviewState(): {
    sessionId: string;
    sourceBranch: string;
    targetBranch: string;
    platform: string;
    mrId: string;
    files: DiffFile[];
    comments: Comment[];
    remoteComments: RemoteComment[];
  } | null {
    const session = this.activeSession;
    if (!session) return null;
    return {
      sessionId: session.id,
      sourceBranch: session.sourceBranch,
      targetBranch: session.targetBranch,
      platform: session.platform,
      mrId: session.mrId || '',
      files: session.files,
      comments: session.comments,
      remoteComments: session.remoteComments,
    };
  }

  async markCommentsSubmitted(sessionId: string, commentIds: string[]): Promise<void> {
    const session = this.state.sessions[sessionId];
    if (!session) return;

    for (const comment of session.comments) {
      if (commentIds.includes(comment.id)) {
        comment.status = 'submitted';
        comment.updatedAt = Date.now();
      }
    }
    await this.persist();
  }

  private async persist(): Promise<void> {
    const snapshot: CommentState = {
      sessions: {},
      activeSessionId: this.state.activeSessionId,
      trash: Object.fromEntries(this.trash),
    };
    for (const [id, sess] of Object.entries(this.state.sessions)) {
      snapshot.sessions[id] = { ...sess, comments: sess.comments };
    }
    await this.context.globalState.update(STORAGE_KEY, snapshot);
    this._onDidChange.fire();
  }
}

function appendSignatureOnce(content: string, signature: string): string {
  const normalizedSignature = signature.trim();
  if (!normalizedSignature) return content.trimEnd();
  const escapedSig = normalizedSignature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sigRegex = new RegExp('\\s*' + escapedSig + '\\s*$');
  return content.replace(sigRegex, '').trimEnd() + '\n\n' + normalizedSignature;
}
