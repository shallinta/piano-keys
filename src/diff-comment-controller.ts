import * as vscode from 'vscode';
import * as path from 'path';
import { CommentStore } from './comment-store';
import { getWorkspacePath } from './git';
import { getFocusedThreadKey, getThreadCollapsibleState } from './comment-thread-focus';
import { NotificationService } from './notification-service';

interface ThreadFocusTarget {
  filePath: string;
  lineNumber: number;
}

interface RefreshThreadOptions {
  focusedThread?: ThreadFocusTarget;
}

class PianoComment implements vscode.Comment {
  id: string;
  author: vscode.CommentAuthorInformation;
  body: string | vscode.MarkdownString;
  mode: vscode.CommentMode;
  contextValue?: string;
  parent?: vscode.CommentThread;

  constructor(id: string, body: string | vscode.MarkdownString, mode: vscode.CommentMode, author: vscode.CommentAuthorInformation, contextValue?: string) {
    this.id = id;
    this.body = body;
    this.mode = mode;
    this.author = author;
    this.contextValue = contextValue;
  }
}

export class DiffCommentController {
  private controller: vscode.CommentController;
  private commentStore: CommentStore;
  // Key: "relativePath#lineNumber", Value: { thread, fsPath }
  private threadMap = new Map<string, { thread: vscode.CommentThread; fsPath: string }>();
  private focusedThreadKey: string | undefined;

  constructor(context: vscode.ExtensionContext, commentStore: CommentStore) {
    this.commentStore = commentStore;
    this.controller = vscode.comments.createCommentController('piano-keys', 'Piano Keys CodeReview');

    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document) => {
        const session = this.commentStore.activeSession;
        if (!session) return [];

        const workspacePath = getWorkspacePath();
        const relativePath = this.extractRelativePath(document.uri, workspacePath);
        if (!relativePath) return [];

        const isInSession = session.files.some(f => f.filePath === relativePath);
        if (!isInSession) return [];

        return [new vscode.Range(0, 0, document.lineCount - 1, 0)];
      }
    };

    // Command for creating a new comment thread
    context.subscriptions.push(
      vscode.commands.registerCommand('piano-keys.createComment', (reply: vscode.CommentReply) => {
        this.handleCreateReply(reply);
      })
    );

    // Command for replying to an existing thread
    context.subscriptions.push(
      vscode.commands.registerCommand('piano-keys.replyComment', (reply: vscode.CommentReply) => {
        this.handleCreateReply(reply);
      })
    );

    // Command for deleting a thread
    context.subscriptions.push(
      vscode.commands.registerCommand('piano-keys.deleteThread', (thread: vscode.CommentThread) => {
        thread.dispose();
      })
    );

    // Command for deleting a comment
    context.subscriptions.push(
      vscode.commands.registerCommand('piano-keys.deleteComment', async (comment: PianoComment) => {
        const thread = comment.parent;
        if (!thread) return;

        try {
          // Move to trash via CommentStore
          const sessionId = this.commentStore.activeSessionId;
          if (sessionId) {
            await this.commentStore.moveToTrash(sessionId, comment.id);
          }
        } catch (err: any) {
          console.error('[Piano Keys] moveToTrash failed:', err?.message);
        }

        // Remove from thread
        thread.comments = thread.comments.filter(c => (c as PianoComment).id !== comment.id);
        if (thread.comments.length === 0) {
          thread.dispose();
          const line = thread.range ? thread.range.start.line + 1 : 1;
          const workspacePath = getWorkspacePath();
          const relPath = this.extractRelativePath(thread.uri, workspacePath);
          if (relPath) {
            this.threadMap.delete(`${relPath}#${line}`);
          }
        }

        // Refresh side panel and editor threads after deletion
        vscode.commands.executeCommand('piano-keys.refreshSidePanel').then(undefined, () => {});
        vscode.commands.executeCommand('piano-keys.refreshEditorThreads').then(undefined, () => {});
      })
    );

    context.subscriptions.push(this.controller);
  }

  private async handleCreateReply(reply: vscode.CommentReply) {
    const sessionId = this.commentStore.activeSessionId;
    if (!sessionId) {
      NotificationService.error('No active review session');
      return;
    }

    const workspacePath = getWorkspacePath();
    const filePath = this.extractRelativePath(reply.thread.uri, workspacePath);
    if (!filePath) {
      NotificationService.error('Could not determine file path');
      return;
    }

    if (!reply.thread.range) {
      NotificationService.error('Cannot create a line comment without a target range');
      return;
    }

    const lineNumber = reply.thread.range.start.line + 1;

    const comment = await this.commentStore.createComment(sessionId, {
      author: 'user',
      filePath,
      lineNumber,
      content: reply.text,
      status: 'confirmed',
    });

    // Add to thread
    const newPianoComment = new PianoComment(
      comment.id,
      comment.content,
      vscode.CommentMode.Preview,
      { name: 'You' },
      'canDelete'
    );
    newPianoComment.parent = reply.thread;

    reply.thread.comments = [...reply.thread.comments, newPianoComment];
    reply.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    const line = reply.thread.range.start.line + 1;
    if (filePath) {
      // Only register threads on modified-side files, not temp originals
      const isModifiedSide = this.extractRelativePath(reply.thread.uri, workspacePath) === filePath;
      if (isModifiedSide) {
        this.threadMap.set(`${filePath}#${line}`, { thread: reply.thread, fsPath: reply.thread.uri.fsPath });
      }
    }

    // Trigger side panel refresh
    vscode.commands.executeCommand('piano-keys.refreshSidePanel');
  }

  private extractRelativePath(uri: vscode.Uri, workspacePath: string | undefined): string | null {
    if (workspacePath && uri.fsPath.startsWith(workspacePath)) {
      return uri.fsPath.slice(workspacePath.length + 1);
    }

    const session = this.commentStore.activeSession;
    if (session) {
      const uriString = uri.toString();
      for (const file of session.files) {
        if (file.modifiedUri && file.modifiedUri === uriString) {
          return file.filePath;
        }
        if (this.isModifiedTempPath(uri.fsPath, file.filePath) || this.isModifiedTempPath(uri.path, file.filePath)) {
          return file.filePath;
        }
      }
    }

    return null;
  }

  private pathEndsWithFilePath(candidatePath: string, filePath: string): boolean {
    const normalizedCandidate = path.normalize(candidatePath);
    const normalizedFilePath = path.normalize(filePath);
    return normalizedCandidate === normalizedFilePath || normalizedCandidate.endsWith(path.sep + normalizedFilePath);
  }

  private isModifiedTempPath(candidatePath: string, filePath: string): boolean {
    const normalizedCandidate = path.normalize(candidatePath);
    return normalizedCandidate.includes(path.sep + 'modified' + path.sep) && this.pathEndsWithFilePath(normalizedCandidate, filePath);
  }

  /**
   * Refresh comment threads for all open documents that are part of the review session.
   * Only processes documents within the workspace path (modified side of diffs).
   */
  refreshAllEditorThreads(options?: RefreshThreadOptions) {
    const session = this.commentStore.activeSession;
    if (!session) return;

    this.focusedThreadKey = options?.focusedThread
      ? getFocusedThreadKey(options.focusedThread.filePath, options.focusedThread.lineNumber)
      : undefined;

    // Step 1: Update existing threads in-place from threadMap
    this.syncExistingThreads();

    // Step 2: Scan only open documents that belong to the review session
    const workspacePath = getWorkspacePath();
    const sessionFiles = new Set(session.files.map(file => file.filePath));
    for (const doc of vscode.workspace.textDocuments) {
      const relativePath = this.extractRelativePath(doc.uri, workspacePath);
      if (relativePath && sessionFiles.has(relativePath)) {
        this.refreshEditorThreads(doc);
      }
    }
  }

  /**
   * Update all existing threads in threadMap to match the current store state.
   * Disposes threads whose last comment was deleted or that are on the original (temp) side.
   */
  private syncExistingThreads() {
    const session = this.commentStore.activeSession;
    if (!session) return;

    const workspacePath = getWorkspacePath();

    for (const [key, entry] of this.threadMap) {
      const { thread } = entry;
      const parts = key.lastIndexOf('#');
      if (parts < 0) continue;
      const relativePath = key.substring(0, parts);
      const line = parseInt(key.substring(parts + 1), 10);

      // Dispose threads on the original (temp) side — only keep threads on modified-side files
      if (!this.extractRelativePath(thread.uri, workspacePath)) {
        thread.dispose();
        this.threadMap.delete(key);
        continue;
      }

      // Get valid comments for this line
      const validComments = session.comments.filter(
        c => c.filePath === relativePath && c.lineNumber === line && c.status !== 'deleted'
      );

      if (validComments.length === 0) {
        // No valid comments left, dispose the thread
        thread.dispose();
        this.threadMap.delete(key);
      } else {
        // Update thread comments in-place
        const pianoComments = validComments.map(c => {
          const pc = new PianoComment(
            c.id,
            c.content,
            vscode.CommentMode.Preview,
            { name: c.author === 'agent' ? 'Agent' : 'You' },
            c.status === 'submitted' ? 'submitted' : 'canDelete'
          );
          pc.parent = thread;
          return pc;
        });
        thread.comments = pianoComments;
        if (this.focusedThreadKey) {
          thread.collapsibleState = this.getCollapsibleState(`${relativePath}#${line}`);
        }
      }
    }
  }

  focusThread(filePath: string, lineNumber: number): void {
    this.focusedThreadKey = getFocusedThreadKey(filePath, lineNumber);

    for (const [key, entry] of this.threadMap) {
      entry.thread.collapsibleState = this.getCollapsibleState(key);
    }
  }

  private getCollapsibleState(threadKey: string): vscode.CommentThreadCollapsibleState {
    return getThreadCollapsibleState(
      threadKey,
      this.focusedThreadKey,
      vscode.CommentThreadCollapsibleState
    ) as vscode.CommentThreadCollapsibleState;
  }

  /**
   * Clear all existing comment threads for a document, then recreate from store.
   * Used to sync after side panel changes.
   */
  refreshEditorThreads(document: vscode.TextDocument) {
    const session = this.commentStore.activeSession;
    if (!session) return;

    const workspacePath = getWorkspacePath();
    const relativePath = this.extractRelativePath(document.uri, workspacePath);
    if (!relativePath) return;

    // Dispose and remove old threads for this relativePath (covers both original/modified URIs)
    const oldKeys: string[] = [];
    for (const key of this.threadMap.keys()) {
      if (key.startsWith(relativePath + '#')) {
        oldKeys.push(key);
      }
    }
    for (const key of oldKeys) {
      this.threadMap.get(key)?.thread.dispose();
      this.threadMap.delete(key);
    }

    // Get comments for this file
    const fileComments = session.comments.filter(
      c => c.filePath === relativePath && c.status !== 'deleted'
    );

    // Group by line number
    const byLine = new Map<number, typeof fileComments>();
    for (const c of fileComments) {
      const existing = byLine.get(c.lineNumber) || [];
      existing.push(c);
      byLine.set(c.lineNumber, existing);
    }

    // Create threads
    for (const [line, comments] of byLine) {
      const threadKey = `${relativePath}#${line}`;
      const range = new vscode.Range(line - 1, 0, line - 1, 0);
      const pianoComments = comments.map(c => {
        const pc = new PianoComment(
          c.id,
          c.content,
          vscode.CommentMode.Preview,
          { name: c.author === 'agent' ? 'Agent' : 'You' },
          c.status === 'submitted' ? 'submitted' : 'canDelete'
        );
        return pc;
      });
      const thread = this.controller.createCommentThread(document.uri, range, pianoComments);
      thread.label = `Line ${line}`;
      thread.canReply = true;
      thread.collapsibleState = this.getCollapsibleState(threadKey);

      for (const c of pianoComments) {
        c.parent = thread;
      }
      this.threadMap.set(threadKey, { thread, fsPath: document.uri.fsPath });
    }
  }

  dispose() {
    this.controller.dispose();
    this.threadMap.clear();
  }
}
