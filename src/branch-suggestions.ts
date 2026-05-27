export const BRANCH_SUGGESTION_LIMIT = 5;

export function normalizeBranchName(branch: string): string {
  return branch
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\//, '')
    .replace(/^origin\//, '');
}

function uniq(branches: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of branches) {
    const branch = normalizeBranchName(raw);
    if (!branch || branch === 'HEAD' || branch.endsWith('/HEAD')) continue;
    if (seen.has(branch)) continue;
    seen.add(branch);
    result.push(branch);
  }
  return result;
}

function pickMainBranch(branches: string[]): string | undefined {
  const normalized = uniq(branches);
  const exactPriority = ['main', 'master'];
  for (const candidate of exactPriority) {
    if (normalized.includes(candidate)) return candidate;
  }
  return normalized.find(branch => branch === 'release' || branch.startsWith('release/'));
}

export function buildTargetBranchSuggestions(remoteBranches: string[], history: string[] = []): string[] {
  const normalizedBranches = uniq(remoteBranches);
  const normalizedHistory = uniq(history);
  const mainBranch = normalizedHistory[0] || pickMainBranch(normalizedBranches) || 'main';

  return uniq([
    '{init}',
    mainBranch,
    ...normalizedHistory,
    'main',
    'master',
    ...normalizedBranches.filter(branch => branch === 'release' || branch.startsWith('release/')),
    ...normalizedBranches,
  ]);
}

export function filterBranchSuggestions(suggestions: string[], query: string, keepInit = false): string[] {
  const needle = query.trim().toLowerCase();
  const filtered = !needle ? suggestions : suggestions.filter((branch) => {
    if (keepInit && branch === '{init}') return true;
    return branch.toLowerCase().includes(needle);
  });
  return filtered.slice(0, BRANCH_SUGGESTION_LIMIT);
}

export function isBranchSuggestionAcceptKey(key: string): boolean {
  return key === 'Enter' || key === ' ' || key === 'Spacebar';
}
