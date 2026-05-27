import * as vscode from 'vscode';
import { execa } from 'execa';
import { Comment, RemoteComment } from './types';
import { NotificationService } from './notification-service';
import {
  extractSubmittedCommentId as extractSubmittedCommentIdFromOutput,
  getGitProviderById,
  GitProviderDefinition,
  normalizeMRInfo,
  normalizeRemoteCommentResolution,
  substituteCommandArgs,
  unwrapMRInfo,
  unwrapMRList,
  GitProviderCommandName,
  GitProviderCommand,
} from './git-provider';

async function hasCli(cliName: string): Promise<boolean> {
  try {
    await execa('which', [cliName], { env: { PATH: process.env.PATH } });
    return true;
  } catch {
    return false;
  }
}

export type AuthErrorKind = 'ok' | 'cli_not_installed' | 'gh_not_installed' | 'gh_not_logged_in' | 'git_permission';

export interface AuthResult {
  ok: boolean;
  kind: AuthErrorKind;
  message?: string;
}

export interface MRInfo {
  id: string;
  title: string;
  sourceBranch: string;
  targetBranch: string;
}

export interface MRSubmitter {
  checkAuth(): Promise<boolean>;
  checkAuthSilent(): Promise<boolean>;
  getAuthError?(): Promise<AuthResult>;
  submitComment(mrId: string, filePath: string, lineNumber: number, content: string): Promise<string | undefined>;
  getMRId(sourceBranch: string, targetBranch: string): Promise<string | undefined>;
  listMRs(): Promise<MRInfo[]>;
  getMRByNumber(mrNumber: string): Promise<MRInfo | undefined>;
  getMRFromLink(link: string): Promise<MRInfo | undefined>;
  listComments(mrId: string): Promise<RemoteComment[]>;
  canResolveRemoteComments?(): boolean;
  resolveRemoteComment?(mrId: string, remoteCommentId: string): Promise<boolean>;
}

export function createSubmitter(platform: string, cwd?: string): MRSubmitter {
  const provider = getGitProviderById(platform);
  if (provider?.adapter?.preset === 'github' || platform === 'github') {
    return new GitHubSubmitter();
  }
  if (provider?.type === 'cli') {
    if (provider.adapter?.commands) {
      return new ConfigurableCliSubmitter(provider, cwd);
    }
    return new GitFallbackSubmitter(provider);
  }
  throw new Error(`Unknown platform: ${platform}`);
}

function parseOwnerRepoFromRemoteUrl(url: string): { owner: string; repo: string } | undefined {
  const normalized = url.replace(/\.git$/, '');

  try {
    const parsed = new URL(normalized);
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length >= 2) {
      return {
        owner: segments.slice(0, -1).join('/'),
        repo: segments[segments.length - 1],
      };
    }
  } catch {
    // Not an HTTP(S) URL; try SCP-like SSH syntax below.
  }

  const scpMatch = normalized.match(/^[^@]+@[^:]+:(.+)$/);
  const pathPart = scpMatch?.[1] ?? normalized.replace(/^[^:]+:\/\//, '');
  const segments = pathPart.split('/').filter(Boolean);
  if (segments.length >= 2) {
    return {
      owner: segments.slice(0, -1).join('/'),
      repo: segments[segments.length - 1],
    };
  }
  return undefined;
}

function extractSubmittedCommentId(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    const value = parsed.Id ?? parsed.ID ?? parsed.id ?? parsed.CommentId ?? parsed.commentId ?? parsed.Comment?.Id ?? parsed.Comment?.id;
    return value !== undefined && value !== null ? String(value) : undefined;
  } catch {
    const match = trimmed.match(/(?:comment(?:Id| ID| id)?|id)[:=\s#]+([A-Za-z0-9_-]+)/i);
    return match?.[1];
  }
}

class GitFallbackSubmitter implements MRSubmitter {
  constructor(private provider?: GitProviderDefinition) {}

  async checkAuth(): Promise<boolean> {
    NotificationService.warning(this.missingAdapterMessage());
    return false;
  }

  async checkAuthSilent(): Promise<boolean> {
    return false;
  }

  async getAuthError(): Promise<AuthResult> {
    return { ok: false, kind: 'git_permission', message: this.missingAdapterMessage() };
  }

  async submitComment(): Promise<string | undefined> {
    NotificationService.warning(this.missingAdapterMessage());
    return undefined;
  }

  async getMRId(): Promise<string | undefined> { return undefined; }
  async listMRs(): Promise<MRInfo[]> { return []; }
  async getMRByNumber(): Promise<MRInfo | undefined> { return undefined; }
  async getMRFromLink(): Promise<MRInfo | undefined> { return undefined; }
  async listComments(): Promise<RemoteComment[]> { return []; }
  canResolveRemoteComments(): boolean { return false; }
  async resolveRemoteComment(): Promise<boolean> { return false; }

  private missingAdapterMessage(): string {
    const label = this.provider?.label || this.provider?.id || '自定义 provider';
    const cli = this.provider?.cli ? `（CLI: ${this.provider.cli}）` : '';
    return `已识别 ${label}${cli}，但尚未配置 provider.adapter。可让 agent 通过 CLI --help 自动补全 piano-keys.07.gitProviders 配置。`;
  }
}

export class ConfigurableCliSubmitter implements MRSubmitter {
  constructor(private provider: GitProviderDefinition, private cwd?: string) {}

  async checkAuth(): Promise<boolean> {
    const ok = await this.checkAuthSilent();
    if (!ok) {
      const error = await this.getAuthError();
      NotificationService.warning(error.message || `${this.provider.label || this.provider.id} 认证检查失败`);
    }
    return ok;
  }

  async checkAuthSilent(): Promise<boolean> {
    const command = this.getCommand('checkAuth');
    if (!command) return true;
    try {
      await this.runCommand('checkAuth', {});
      return true;
    } catch {
      return false;
    }
  }

  async getAuthError(): Promise<AuthResult> {
    const cli = this.provider.cli || this.getCommand('checkAuth')?.command;
    if (cli && !(await hasCli(cli))) {
      return { ok: false, kind: 'cli_not_installed', message: `${cli} CLI 未安装` };
    }
    return { ok: false, kind: 'git_permission', message: `${this.provider.label || this.provider.id} CLI 认证检查失败` };
  }

  async getMRId(sourceBranch: string, targetBranch: string): Promise<string | undefined> {
    if (!this.hasCapability('getMRId')) return undefined;
    try {
      const { stdout } = await this.runCommand('getMRId', { sourceBranch, targetBranch });
      const parsed = JSON.parse(stdout || '[]');
      const mr = normalizeMRInfo(unwrapMRList(parsed)[0] ?? unwrapMRInfo(parsed));
      return mr?.id;
    } catch {
      return undefined;
    }
  }

  async listMRs(): Promise<MRInfo[]> {
    if (!this.hasCapability('listMRs')) return [];
    try {
      const { stdout } = await this.runCommand('listMRs', {});
      return unwrapMRList(JSON.parse(stdout || '[]')).map(normalizeMRInfo).filter((mr): mr is MRInfo => !!mr);
    } catch {
      return [];
    }
  }

  async getMRByNumber(mrNumber: string): Promise<MRInfo | undefined> {
    if (!this.hasCapability('getMRByNumber')) return undefined;
    try {
      const { stdout } = await this.runCommand('getMRByNumber', { mrNumber });
      return normalizeMRInfo(unwrapMRInfo(JSON.parse(stdout || '{}')));
    } catch {
      return undefined;
    }
  }

  async getMRFromLink(link: string): Promise<MRInfo | undefined> {
    if (this.hasCapability('getMRFromLink')) {
      try {
        const { stdout } = await this.runCommand('getMRFromLink', { link });
        return normalizeMRInfo(unwrapMRInfo(JSON.parse(stdout || '{}')));
      } catch {
        return undefined;
      }
    }
    const match = link.match(/(?:pull|merge_requests|mr)\/(\d+)/i);
    return match ? this.getMRByNumber(match[1]) : undefined;
  }

  async submitComment(mrId: string, filePath: string, lineNumber: number, content: string): Promise<string | undefined> {
    if (!this.hasCapability('submitComment')) {
      NotificationService.warning(`${this.provider.label || this.provider.id} 未配置提交评论能力`);
      return undefined;
    }
    try {
      const { stdout } = await this.runCommand('submitComment', { mrId, filePath, lineNumber, content });
      return extractSubmittedCommentIdFromOutput(stdout) ?? 'submitted';
    } catch (err: any) {
      NotificationService.error(`Failed to submit comment: ${err.message}`);
      return undefined;
    }
  }

  async listComments(mrId: string): Promise<RemoteComment[]> {
    if (!this.hasCapability('listComments')) return [];
    try {
      const { stdout } = await this.runCommand('listComments', { mrId });
      const parsed = JSON.parse(stdout || '[]');
      const supportsResolution = this.provider.adapter?.capabilities?.remoteCommentResolutionState === true;
      const rows = Array.isArray(parsed) ? parsed : (parsed.Comments ?? parsed.comments ?? parsed.items ?? parsed.data ?? []);
      return rows.map((comment: any) => {
        const resolution = normalizeRemoteCommentResolution(comment, supportsResolution);
        return {
          id: String(comment.Id ?? comment.ID ?? comment.id ?? ''),
          threadId: String(comment.ThreadId ?? comment.threadId ?? comment.thread_id ?? comment.Id ?? comment.ID ?? comment.id ?? ''),
          author: String(comment.CreatedBy ?? comment.author ?? comment.user?.login ?? ''),
          filePath: String(comment.Path ?? comment.filePath ?? comment.path ?? ''),
          lineNumber: Number(comment.Line ?? comment.lineNumber ?? comment.line ?? 0),
          content: String(comment.Content ?? comment.content ?? comment.body ?? ''),
          createdAt: String(comment.CreatedAt ?? comment.createdAt ?? comment.created_at ?? ''),
          resolution,
          resolved: resolution === 'unknown' ? undefined : resolution === 'resolved',
          canResolve: this.canResolveRemoteComments() && resolution === 'unresolved',
        };
      });
    } catch {
      return [];
    }
  }

  canResolveRemoteComments(): boolean {
    return this.provider.adapter?.capabilities?.resolveRemoteComment === true && !!this.getCommand('resolveRemoteComment');
  }

  async resolveRemoteComment(mrId: string, remoteCommentId: string): Promise<boolean> {
    if (!this.canResolveRemoteComments()) return false;
    try {
      await this.runCommand('resolveRemoteComment', { mrId, remoteCommentId, threadId: remoteCommentId });
      return true;
    } catch (err: any) {
      NotificationService.error(`Failed to resolve remote comment: ${err.message}`);
      return false;
    }
  }

  private hasCapability(name: GitProviderCommandName): boolean {
    const capabilities = this.provider.adapter?.capabilities as Record<string, boolean | undefined> | undefined;
    return capabilities?.[name] !== false && !!this.getCommand(name);
  }

  private getCommand(name: GitProviderCommandName): GitProviderCommand | undefined {
    return this.provider.adapter?.commands?.[name];
  }

  private runCommand(name: GitProviderCommandName, context: Record<string, string | number | undefined>) {
    const command = this.getCommand(name);
    if (!command) throw new Error(`Provider ${this.provider.id} missing command: ${name}`);
    const cwd = command.cwd || this.cwd;
    return execa(command.command, substituteCommandArgs(command.args || [], { ...context, cwd, remoteUrl: undefined }), { cwd });
  }
}

export class GitHubSubmitter implements MRSubmitter {
  private cachedAuthError: AuthResult | null = null;
  private cachedHasGh: boolean | null = null;

  private async hasGhCli(): Promise<boolean> {
    if (this.cachedHasGh !== null) return this.cachedHasGh;
    this.cachedHasGh = await hasCli('gh');
    return this.cachedHasGh;
  }
  /** Parse owner/repo from git remote URL to avoid relying on gh CLI context. */
  private async getOwnerRepo(): Promise<{ owner: string; repo: string }> {
    try {
      const { stdout } = await execa('gh', ['repo', 'view', '--json', 'nameWithOwner']);
      const parsed = JSON.parse(stdout) as { nameWithOwner: string };
      // Support org/team/repo paths — last segment is repo, rest is owner
      const lastSlash = parsed.nameWithOwner.lastIndexOf('/');
      if (lastSlash === -1) throw new Error('Invalid nameWithOwner format');
      const owner = parsed.nameWithOwner.substring(0, lastSlash);
      const repo = parsed.nameWithOwner.substring(lastSlash + 1);
      return { owner, repo };
    } catch (e: any) {
      // Fallback: parse from git remote, using configured defaultRemote
      const config = vscode.workspace.getConfiguration('piano-keys');
      const remoteName = config.get<string>('02.defaultRemote', 'origin');
      const { stdout } = await execa('git', ['remote', 'get-url', remoteName]);
      const url = stdout.trim();
      // Handle both SSH (git@github.com:owner/repo.git) and HTTPS (https://github.com/owner/repo.git),
      // including owner paths with multiple segments.
      const parsed = parseOwnerRepoFromRemoteUrl(url);
      if (parsed) return parsed;
      throw new Error(`Unable to determine GitHub owner/repo from remote '${remoteName}'. Run \`gh repo set-default\` or check your git remote.`);
    }
  }

  private repoPath(owner: string, repo: string): string {
    return `repos/${owner}/${repo}`;
  }

  async checkAuth(): Promise<boolean> {
    const hasGh = await this.hasGhCli();
    if (!hasGh) {
      // gh not installed — cannot submit comments to GitHub
      return false;
    }

    try {
      await execa('gh', ['auth', 'status']);
      return true;
    } catch (err: any) {
      const msg = err.stderr?.toLowerCase() || err.message?.toLowerCase() || '';
      if (msg.includes('not logged in') || msg.includes('no authentication') || msg.includes('not found')) {
        const action = await NotificationService.warning(
          'GitHub CLI (gh) 未登录，请运行 `gh auth login` 认证',
          '了解详情', 'Cancel'
        );
        if (action === '了解详情') {
          vscode.env.openExternal(vscode.Uri.parse('https://cli.github.com/manual/gh_auth_login'));
        }
      } else {
        NotificationService.warning(
          'GitHub CLI (gh) 认证检查失败，请确认登录状态',
        );
      }
      return false;
    }
  }

  async checkAuthSilent(): Promise<boolean> {
    const hasGh = await this.hasGhCli();
    if (!hasGh) {
      // gh not installed — return false so caller knows MR list operations won't work
      this.cachedAuthError = { ok: false, kind: 'gh_not_installed', message: 'GitHub CLI (gh) 未安装，无法加载 MR 列表和提交评论' };
      return false;
    }

    try {
      await execa('gh', ['auth', 'status']);
      this.cachedAuthError = null;
      return true;
    } catch {
      this.cachedAuthError = { ok: false, kind: 'gh_not_logged_in', message: 'GitHub CLI 未登录，请运行 `gh auth login`' };
      return false;
    }
  }

  /** Return detailed auth error info for caller to decide how to respond. */
  async getAuthError(): Promise<AuthResult> {
    // Always re-check to avoid stale cache (e.g. user logged in between calls)
    const hasGh = await this.hasGhCli();
    if (!hasGh) {
      return { ok: false, kind: 'gh_not_installed', message: 'GitHub CLI (gh) 未安装，无法加载 MR 列表和提交评论' };
    }

    try {
      await execa('gh', ['auth', 'status']);
      return { ok: true, kind: 'ok' };
    } catch (err: any) {
      const msg = err.stderr?.toLowerCase() || err.message?.toLowerCase() || '';
      if (msg.includes('not logged in') || msg.includes('no authentication') || msg.includes('not found')) {
        return { ok: false, kind: 'gh_not_logged_in', message: 'GitHub CLI 未登录，请运行 `gh auth login`' };
      } else {
        return { ok: false, kind: 'git_permission', message: 'GitHub CLI 认证检查失败' };
      }
    }
  }

  async getMRId(sourceBranch: string, targetBranch: string): Promise<string | undefined> {
    if (!(await this.hasGhCli())) return undefined;
    try {
      const { stdout } = await execa('gh', ['pr', 'list', '--head', sourceBranch, '--base', targetBranch, '--json', 'number', '--jq', '.[0].number']);
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async listMRs(): Promise<MRInfo[]> {
    if (!(await this.hasGhCli())) return [];
    try {
      const { stdout } = await execa('gh', ['pr', 'list', '--state', 'open', '--json', 'number,title,headRefName,baseRefName', '--limit', '50']);
      const prs = JSON.parse(stdout) as Array<{ number: number; title: string; headRefName: string; baseRefName: string }>;
      return prs.map(pr => ({
        id: String(pr.number),
        title: pr.title,
        sourceBranch: pr.headRefName,
        targetBranch: pr.baseRefName,
      }));
    } catch {
      return [];
    }
  }

  async getMRByNumber(mrNumber: string): Promise<MRInfo | undefined> {
    if (!(await this.hasGhCli())) return undefined;
    try {
      const { stdout } = await execa('gh', ['pr', 'view', mrNumber, '--json', 'number,title,headRefName,baseRefName']);
      const pr = JSON.parse(stdout) as { number: number; title: string; headRefName: string; baseRefName: string };
      return {
        id: String(pr.number),
        title: pr.title,
        sourceBranch: pr.headRefName,
        targetBranch: pr.baseRefName,
      };
    } catch {
      return undefined;
    }
  }

  async getMRFromLink(link: string): Promise<MRInfo | undefined> {
    const match = link.match(/\/pull\/(\d+)/);
    if (!match) return undefined;
    return this.getMRByNumber(match[1]);
  }

  async submitComment(mrId: string, filePath: string, lineNumber: number, content: string): Promise<string | undefined> {
    if (!(await this.hasGhCli())) {
      NotificationService.warning('未安装 GitHub CLI (gh)，无法提交评论到 GitHub。请安装 gh 后重试。');
      return undefined;
    }
    try {
      const { owner, repo: repoName } = await this.getOwnerRepo();
      const repoPath = this.repoPath(owner, repoName);
      // Get PR head commit SHA for inline review comments
      const { stdout: prJson } = await execa('gh', [
        'pr', 'view', mrId, '--json', 'headRefOid',
      ]);
      const prInfo = JSON.parse(prJson) as { headRefOid: string };
      const commitId = prInfo.headRefOid;
      if (!commitId) {
        NotificationService.error(`无法获取 PR #${mrId} 的 head commit SHA，请确认 PR 未被合并或关闭`);
        return undefined;
      }

      const body = JSON.stringify({
        body: content,
        path: filePath,
        line: lineNumber,
        side: 'RIGHT',
        commit_id: commitId,
      });
      await execa('gh', [
        'api',
        `${repoPath}/pulls/${mrId}/comments`,
        '--method', 'POST',
        '--input', '-',
      ], { input: body });
      return 'submitted';
    } catch (err: any) {
      NotificationService.error(`Failed to submit GitHub comment: ${err.message}`);
      return undefined;
    }
  }

  async listComments(mrId: string): Promise<RemoteComment[]> {
    if (!(await this.hasGhCli())) return [];
    try {
      const { owner, repo: repoName } = await this.getOwnerRepo();
      const repoPath = this.repoPath(owner, repoName);
      // Get review comments (inline comments)
      const { stdout: reviewJson } = await execa('gh', [
        'api',
        `${repoPath}/pulls/${mrId}/comments`,
        '--jq', '[.[] | {id: (.id | tostring), author: .user.login, filePath: (.path // ""), lineNumber: (.original_line // .line // 0), content: .body, createdAt: .created_at}]',
      ]);
      const reviewParsed = JSON.parse(reviewJson || '[]') as Array<{id: string; author: string; filePath: string; lineNumber: number; content: string; createdAt: string}>;

      // Get PR issue comments (general comments)
      const { stdout: issueJson } = await execa('gh', [
        'api',
        `${repoPath}/issues/${mrId}/comments`,
        '--jq', '[.[] | {id: (.id | tostring), author: .user.login, filePath: "", lineNumber: 0, content: .body, createdAt: .created_at}]',
      ]);
      const issueParsed = JSON.parse(issueJson || '[]') as Array<{id: string; author: string; filePath: string; lineNumber: number; content: string; createdAt: string}>;

      // GitHub PR review comments API does not expose resolved status directly
      // (unlike some platforms which have thread.Status). All comments default to unresolved.
      return [...reviewParsed, ...issueParsed].map(c => ({
        id: c.id,
        author: c.author,
        filePath: c.filePath || '',
        lineNumber: c.lineNumber || 0,
        content: c.content,
        createdAt: c.createdAt,
        resolution: 'unknown',
      }));
    } catch {
      return [];
    }
  }

  canResolveRemoteComments(): boolean { return false; }
  async resolveRemoteComment(): Promise<boolean> { return false; }
}

