export type CommentStatus = 'pending' | 'confirmed' | 'submitted' | 'deleted';

export type CommentAuthor = 'user' | 'agent';

export type Platform = string;

export type RemoteCommentResolution = 'resolved' | 'unresolved' | 'unknown';

export interface Comment {
  id: string;
  author: CommentAuthor;
  filePath: string;
  lineNumber: number;
  content: string;
  status: CommentStatus;
  previousStatus?: CommentStatus;
  createdAt: number;
  updatedAt: number;
  mrId?: string;
  platformCommentId?: string;
}

export interface DiffFile {
  filePath: string;
  additions: number;
  deletions: number;
  originalUri: string;
  modifiedUri: string;
}

export interface RemoteComment {
  id: string;
  threadId?: string;
  author: string;
  filePath: string;
  lineNumber: number;
  content: string;
  createdAt: string;
  resolution: RemoteCommentResolution;
  resolved?: boolean;
  canResolve?: boolean;
}

export interface ReviewSession {
  id: string;
  sourceBranch: string;
  targetBranch: string;
  mrId?: string;
  platform: Platform;
  files: DiffFile[];
  comments: Comment[];
  remoteComments: RemoteComment[];
  createdAt: number;
  workspacePath?: string;
}

export interface CommentState {
  sessions: Record<string, ReviewSession>;
  activeSessionId: string | null;
  trash?: Record<string, Comment[]>;
}
