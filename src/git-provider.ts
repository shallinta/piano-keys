import type { MRInfo } from './mr-submitter';
import type { RemoteCommentResolution } from './types';

export type GitProviderType = 'cli';
export type GitProviderPreset = 'github' | 'custom';

export type GitProviderCommandName =
  | 'checkAuth'
  | 'listMRs'
  | 'getMRByNumber'
  | 'getMRFromLink'
  | 'getMRId'
  | 'submitComment'
  | 'listComments'
  | 'resolveRemoteComment'
  | 'reopenRemoteComment';

export interface GitProviderCommand {
  command: string;
  args?: string[];
  cwd?: string;
}

export interface GitProviderCapabilities {
  checkAuth?: boolean;
  authLogin?: boolean;
  listMRs?: boolean;
  getMRByNumber?: boolean;
  getMRFromLink?: boolean;
  getMRId?: boolean;
  submitComment?: boolean;
  listComments?: boolean;
  remoteCommentResolutionState?: boolean;
  resolveRemoteComment?: boolean;
  reopenRemoteComment?: boolean;
}

export interface GitProviderAdapter {
  preset?: GitProviderPreset;
  capabilities?: GitProviderCapabilities;
  commands?: Partial<Record<GitProviderCommandName, GitProviderCommand>>;
}

export interface GitProviderDefinition {
  id: string;
  label?: string;
  type: GitProviderType;
  builtIn?: boolean;
  remoteUrlPatterns: string[];
  cli?: string;
  adapter?: GitProviderAdapter;
}

export interface GitProviderMatchResult {
  provider?: GitProviderDefinition;
  conflicts: GitProviderDefinition[];
  duplicateIds: string[];
}

export type CommandContext = Record<string, string | number | undefined>;

export function createBuiltInGitProviders(): GitProviderDefinition[] {
  return [
    {
      id: 'github',
      label: 'GitHub',
      type: 'cli',
      builtIn: true,
      remoteUrlPatterns: ['github.com'],
      cli: 'gh',
      adapter: {
        preset: 'github',
        capabilities: {
          checkAuth: true,
          authLogin: true,
          listMRs: true,
          getMRByNumber: true,
          getMRFromLink: true,
          getMRId: true,
          submitComment: true,
          listComments: true,
          remoteCommentResolutionState: false,
          resolveRemoteComment: false,
          reopenRemoteComment: false,
        },
      },
    },
  ];
}

export function getConfiguredGitProviders(): GitProviderDefinition[] {
  const vscode = require('vscode') as typeof import('vscode');
  const config = vscode.workspace.getConfiguration('piano-keys');
  const configured = config.get<GitProviderDefinition[]>('07.gitProviders', []);
  if (!Array.isArray(configured) || configured.length === 0) {
    return createBuiltInGitProviders();
  }
  return configured;
}

export function getGitProviderById(providerId: string): GitProviderDefinition | undefined {
  return getConfiguredGitProviders().find(provider => provider.id === providerId)
    ?? createBuiltInGitProviders().find(provider => provider.id === providerId);
}

export function matchGitProvider(remoteUrl: string, providers: GitProviderDefinition[]): GitProviderMatchResult {
  const normalizedRemote = remoteUrl.toLowerCase();
  const seenIds = new Set<string>();
  const duplicateIds: string[] = [];
  const uniqueProviders: GitProviderDefinition[] = [];

  for (const provider of providers) {
    if (!provider?.id) continue;
    if (seenIds.has(provider.id)) {
      duplicateIds.push(provider.id);
      continue;
    }
    seenIds.add(provider.id);
    uniqueProviders.push(provider);
  }

  const matches = uniqueProviders
    .map(provider => {
      const pattern = (provider.remoteUrlPatterns || [])
        .filter(Boolean)
        .map(item => item.toLowerCase())
        .filter(pattern => normalizedRemote.includes(pattern))
        .sort((a, b) => b.length - a.length)[0];
      return pattern ? { provider, pattern } : undefined;
    })
    .filter((item): item is { provider: GitProviderDefinition; pattern: string } => !!item)
    .sort((a, b) => b.pattern.length - a.pattern.length);

  const selected = matches[0]?.provider;
  const conflicts = matches.slice(1).map(item => item.provider);
  return { provider: selected, conflicts, duplicateIds };
}

export function detectGitProvider(remoteUrl: string): GitProviderDefinition | undefined {
  const configuredProviders = getConfiguredGitProviders();
  return matchGitProvider(remoteUrl, configuredProviders).provider;
}

export function substituteCommandArgs(args: string[] = [], context: CommandContext): string[] {
  return args.map(arg => arg.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, key) => String(context[key] ?? '')));
}

function pickFirst(obj: any, keys: string[]): any {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

export function unwrapMRList(parsed: any): any[] {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.MergeRequests)) return parsed.MergeRequests;
  if (Array.isArray(parsed?.mergeRequests)) return parsed.mergeRequests;
  if (Array.isArray(parsed?.items)) return parsed.items;
  if (Array.isArray(parsed?.data)) return parsed.data;
  if (Array.isArray(parsed?.result)) return parsed.result;
  return [];
}

export function unwrapMRInfo(parsed: any): any {
  if (Array.isArray(parsed)) return parsed[0];
  return parsed?.MergeRequest ?? parsed?.mergeRequest ?? parsed?.mr ?? parsed?.data ?? parsed?.result ?? parsed;
}

export function normalizeMRInfo(raw: any): MRInfo | undefined {
  if (!raw) return undefined;
  const id = pickFirst(raw, ['id', 'number', 'iid', 'Id', 'ID', 'Number']);
  if (id === undefined || id === null || id === '') return undefined;
  return {
    id: String(id),
    title: String(pickFirst(raw, ['title', 'Title']) ?? ''),
    sourceBranch: String(pickFirst(raw, ['sourceBranch', 'source_branch', 'headRefName', 'SourceBranch', 'SourceBranchName']) ?? ''),
    targetBranch: String(pickFirst(raw, ['targetBranch', 'target_branch', 'baseRefName', 'TargetBranch', 'TargetBranchName']) ?? ''),
  };
}

export function normalizeRemoteCommentResolution(raw: any, supportsResolution: boolean): RemoteCommentResolution {
  if (!supportsResolution) return 'unknown';
  const status = String(raw?.Status ?? raw?.status ?? '').toLowerCase();
  if (status === 'resolved' || raw?.Resolved === true || raw?.resolved === true) return 'resolved';
  return 'unresolved';
}

export function extractSubmittedCommentId(stdout: string): string | undefined {
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
