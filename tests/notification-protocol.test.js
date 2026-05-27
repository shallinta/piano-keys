const assert = require('assert');
const {
  createNotificationRequest,
  normalizeNotificationItems,
  getNotificationTimeoutMs,
} = require('../out/notification-protocol');
const {
  getPendingSkillTargets,
  createSkillInstallPlan,
  getSkillInstallTargetDetail,
  buildSymlinkAwareSkillInstallTargets,
  buildSkillInstallTargets,
  shouldContinueSkillInstall,
  shouldShowSkillInstallPicker,
} = require('../out/skill-installation');
const {
  createBuiltInGitProviders,
  matchGitProvider,
  normalizeMRInfo,
  normalizeRemoteCommentResolution,
  substituteCommandArgs,
} = require('../out/git-provider');
const {
  createCommentToolNameHint,
} = require('../out/comment-hints');
const {
  buildTargetBranchSuggestions,
  filterBranchSuggestions,
  isBranchSuggestionAcceptKey,
} = require('../out/branch-suggestions');
const {
  clearReviewSessionContent,
} = require('../out/review-session-utils');
const {
  CLEAR_REVIEW_ENDPOINT,
  normalizeClearReviewRequest,
} = require('../out/server/http-api');

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

test('normalizes string buttons into label/value pairs', () => {
  assert.deepStrictEqual(normalizeNotificationItems(['Install', 'Cancel']), [
    { label: 'Install', value: 'Install' },
    { label: 'Cancel', value: 'Cancel' },
  ]);
});

test('keeps quick pick item metadata when normalizing buttons', () => {
  assert.deepStrictEqual(normalizeNotificationItems([{ label: 'GitHub', platform: 'github' }]), [
    { label: 'GitHub', value: 'GitHub', platform: 'github' },
  ]);
});

test('builds toast requests with deterministic ids and timeouts', () => {
  const request = createNotificationRequest({
    id: 'notification-1',
    kind: 'toast',
    severity: 'warning',
    message: '远程同步失败',
    items: ['重试'],
  });

  assert.deepStrictEqual(request, {
    type: 'notificationRequest',
    id: 'notification-1',
    kind: 'toast',
    severity: 'warning',
    message: '远程同步失败',
    items: [{ label: '重试', value: '重试' }],
    timeoutMs: 0,
  });
});

test('uses auto-dismiss timeout only for non-interactive toasts', () => {
  assert.strictEqual(getNotificationTimeoutMs('toast', []), 4200);
  assert.strictEqual(getNotificationTimeoutMs('toast', [{ label: 'OK', value: 'OK' }]), 0);
  assert.strictEqual(getNotificationTimeoutMs('input', []), 0);
});

test('shows skill install picker when any detected target is missing or outdated', () => {
  const targets = [
    { label: 'Agents', installedVersion: 35 },
    { label: 'Codex', installedVersion: 0 },
    { label: 'Claude Code', installedVersion: 34 },
  ];

  assert.strictEqual(shouldShowSkillInstallPicker(targets, 35), true);
  assert.deepStrictEqual(getPendingSkillTargets(targets, 35).map(t => t.label), ['Codex', 'Claude Code']);
});

test('does not show skill install picker when every detected target is up to date', () => {
  const targets = [
    { label: 'Agents', installedVersion: 35 },
    { label: 'Codex', installedVersion: 36 },
  ];

  assert.strictEqual(shouldShowSkillInstallPicker(targets, 35), false);
  assert.deepStrictEqual(getPendingSkillTargets(targets, 35), []);
});

test('builds install plan from pre-install versions for every detected target', () => {
  const targets = [
    { label: 'Agents', installedVersion: 34, alwaysInstall: true },
    { label: 'Claude Code', installedVersion: 34 },
    { label: 'Cursor', installedVersion: 35 },
    { label: 'Codex', installedVersion: 0 },
  ];

  const plan = createSkillInstallPlan(targets, 35);

  assert.strictEqual(plan.shouldInstallBase, true);
  assert.deepStrictEqual(plan.pickerTargets.map(t => t.label), ['Claude Code', 'Codex']);
});

test('shows every detected agent in picker during base skill upgrade', () => {
  const targets = [
    { label: 'Agents', installedVersion: 36, alwaysInstall: true },
    { label: 'Claude Code', installedVersion: 39, sharesBaseSkill: true },
    { label: 'Cursor', installedVersion: 0 },
    { label: 'Codex', installedVersion: 39, sharesBaseSkill: true },
  ];

  const plan = createSkillInstallPlan(targets, 39, { includeAllPickerTargets: true });

  assert.strictEqual(plan.shouldInstallBase, true);
  assert.deepStrictEqual(plan.pickerTargets.map(t => t.label), ['Claude Code', 'Cursor', 'Codex']);
});

test('describes skill install target state for upgrade picker', () => {
  assert.strictEqual(
    getSkillInstallTargetDetail({ label: 'Codex', installedVersion: 39, sharesBaseSkill: true }, 39),
    '已通过软链接共享，将随 Agents 升级到 v39'
  );
  assert.strictEqual(
    getSkillInstallTargetDetail({ label: 'Claude Code', installedVersion: 0 }, 39),
    '未安装，将创建软链接到 v39'
  );
  assert.strictEqual(
    getSkillInstallTargetDetail({ label: 'Codex', installedVersion: 39 }, 39),
    '已是最新 v39'
  );
});

test('builds targets from every existing skills directory, not only hardcoded agents', () => {
  const targets = buildSkillInstallTargets([
    { label: 'Agents', dir: '/home/me/.agents/skills', exists: true, installedVersion: 35, alwaysInstall: true },
    { label: 'Claude Code', dir: '/home/me/.claude/skills', exists: true, installedVersion: 35 },
    { label: 'Codex', dir: '/home/me/.codex/skills', exists: true, installedVersion: 0 },
    { label: 'Cursor', dir: '/home/me/.cursor/skills', exists: true, installedVersion: 0 },
    { label: 'OpenCode', dir: '/home/me/.opencode/skills', exists: false, installedVersion: 0 },
  ]);

  assert.deepStrictEqual(targets.map(t => t.label), ['Agents', 'Claude Code', 'Codex', 'Cursor']);
  assert.deepStrictEqual(getPendingSkillTargets(targets, 35).map(t => t.label), ['Codex', 'Cursor']);
});

test('uses base skill version and only checks linked agents for skill existence', () => {
  const targets = buildSymlinkAwareSkillInstallTargets([
    { label: 'Agents', dir: '/home/me/.agents/skills', exists: true, skillExists: true, installedVersion: 34, alwaysInstall: true },
    { label: 'Codex', dir: '/home/me/.codex/skills', exists: true, skillExists: true, installedVersion: 1 },
    { label: 'Claude Code', dir: '/home/me/.claude/skills', exists: true, skillExists: false, installedVersion: 0 },
    { label: 'OpenCode', dir: '/home/me/.opencode/skills', exists: false, skillExists: false, installedVersion: 0 },
  ], 35);

  assert.deepStrictEqual(targets.map(t => [t.label, t.installedVersion]), [
    ['Agents', 34],
    ['Codex', 35],
    ['Claude Code', 0],
  ]);
  assert.deepStrictEqual(getPendingSkillTargets(targets, 35).map(t => t.label), ['Agents', 'Claude Code']);
});

test('does not continue skill install when multi-select picker is cancelled', () => {
  assert.strictEqual(shouldContinueSkillInstall(undefined, 2), false);
});

test('continues skill install when picker is confirmed with zero selected targets', () => {
  assert.strictEqual(shouldContinueSkillInstall(0, 2), true);
});

test('continues skill install without showing picker when there are no picker targets', () => {
  assert.strictEqual(shouldContinueSkillInstall(undefined, 0), true);
});

test('matches custom provider before built-in provider and prefers longest pattern', () => {
  const providers = [
    { id: 'generic-company', label: 'Generic Company', type: 'cli', remoteUrlPatterns: ['code.company.org'], cli: 'company-code' },
    { id: 'special-company', label: 'Special Company', type: 'cli', remoteUrlPatterns: ['code.company.org:team/special'], cli: 'company-code' },
    ...createBuiltInGitProviders(),
  ];

  const match = matchGitProvider('git@code.company.org:team/special/repo.git', providers);

  assert.strictEqual(match.provider && match.provider.id, 'special-company');
  assert.deepStrictEqual(match.conflicts.map(p => p.id), ['generic-company']);
});

test('normalizes MR info from common provider JSON fields', () => {
  assert.deepStrictEqual(normalizeMRInfo({
    Number: 42,
    Title: 'Fix bug',
    SourceBranchName: 'feature/a',
    TargetBranchName: 'main',
  }), {
    id: '42',
    title: 'Fix bug',
    sourceBranch: 'feature/a',
    targetBranch: 'main',
  });
});

test('substitutes CLI command args without shell interpolation', () => {
  assert.deepStrictEqual(substituteCommandArgs([
    'mr', 'comment', '{mrId}', '--body', '{content}'
  ], {
    mrId: '12',
    content: 'hello "world" && rm -rf /',
  }), ['mr', 'comment', '12', '--body', 'hello "world" && rm -rf /']);
});

test('normalizes remote comment resolution as tri-state', () => {
  assert.strictEqual(normalizeRemoteCommentResolution({ Status: 'resolved' }, true), 'resolved');
  assert.strictEqual(normalizeRemoteCommentResolution({ Resolved: false }, true), 'unresolved');
  assert.strictEqual(normalizeRemoteCommentResolution({ Resolved: false }, false), 'unknown');
});

test('built-in github provider does not expose remote comment resolve capability', () => {
  const github = createBuiltInGitProviders().find(p => p.id === 'github');
  assert.ok(github);
  assert.ok(!github.adapter.capabilities.resolveRemoteComment);
});

test('hints when AI Assistant is used as fallback tool name', () => {
  const hint = createCommentToolNameHint('`[P1]` [**AI** —— by **AI Assistant**]\n**问题：**test', true);

  assert.ok(hint.includes('AI Assistant'));
  assert.ok(hint.includes('只有在确实无法识别具体工具名时才使用'));
  assert.ok(hint.includes('PATCH /comments/{id}'));
});

test('does not hint for concrete tool names or disabled attribution', () => {
  assert.strictEqual(createCommentToolNameHint('`[P1]` [**AI** —— by **claude code**]\n**问题：**test', true), undefined);
  assert.strictEqual(createCommentToolNameHint('`[P1]` [**AI** —— by **AI Assistant**]\n**问题：**test', false), undefined);
});

test('target branch suggestions keep init first and prefer detected main branch second', () => {
  assert.deepStrictEqual(
    buildTargetBranchSuggestions(['origin/release/2026', 'origin/master', 'origin/main'], []),
    ['{init}', 'main', 'master', 'release/2026']
  );
});

test('target branch suggestions prefer recent user history after init', () => {
  assert.deepStrictEqual(
    buildTargetBranchSuggestions(['origin/main', 'origin/master'], ['release/2026', 'main']),
    ['{init}', 'release/2026', 'main', 'master']
  );
});

test('branch suggestions filter by typed substring while keeping init available for target', () => {
  assert.deepStrictEqual(filterBranchSuggestions(['{init}', 'main', 'release/2026'], 'rel', true), ['{init}', 'release/2026']);
  assert.deepStrictEqual(filterBranchSuggestions(['feature/a', 'bugfix/b'], 'bug', false), ['bugfix/b']);
});

test('branch suggestions are limited to five visible options', () => {
  assert.deepStrictEqual(
    filterBranchSuggestions(['a', 'b', 'c', 'd', 'e', 'f'], '', false),
    ['a', 'b', 'c', 'd', 'e']
  );
});

test('branch autocomplete accepts highlighted suggestion with enter or space', () => {
  assert.strictEqual(isBranchSuggestionAcceptKey('Enter'), true);
  assert.strictEqual(isBranchSuggestionAcceptKey(' '), true);
  assert.strictEqual(isBranchSuggestionAcceptKey('Spacebar'), true);
  assert.strictEqual(isBranchSuggestionAcceptKey('Tab'), false);
});

test('clears review content while preserving MR and branch inputs', () => {
  const session = {
    id: 'review-1',
    sourceBranch: 'feature/a',
    targetBranch: 'main',
    mrId: '42',
    platform: 'github',
    files: [{ filePath: 'src/a.ts', additions: 1, deletions: 0 }],
    comments: [{ id: 'c1', content: 'comment' }],
    remoteComments: [{ id: 'r1', content: 'remote' }],
    createdAt: 1,
  };

  clearReviewSessionContent(session);

  assert.deepStrictEqual(session.files, []);
  assert.deepStrictEqual(session.comments, []);
  assert.deepStrictEqual(session.remoteComments, []);
  assert.strictEqual(session.sourceBranch, 'feature/a');
  assert.strictEqual(session.targetBranch, 'main');
  assert.strictEqual(session.mrId, '42');
});

test('clear review can preserve latest UI MR and branch input values', () => {
  const session = {
    id: 'review-1',
    sourceBranch: 'old-source',
    targetBranch: 'old-target',
    mrId: '1',
    platform: 'github',
    files: [{ filePath: 'src/a.ts', additions: 1, deletions: 0 }],
    comments: [{ id: 'c1', content: 'comment' }],
    remoteComments: [{ id: 'r1', content: 'remote' }],
    createdAt: 1,
  };

  clearReviewSessionContent(session, {
    sourceBranch: 'new-source',
    targetBranch: '{init}',
    mrId: '42',
  });

  assert.deepStrictEqual(session.files, []);
  assert.deepStrictEqual(session.comments, []);
  assert.deepStrictEqual(session.remoteComments, []);
  assert.strictEqual(session.sourceBranch, 'new-source');
  assert.strictEqual(session.targetBranch, '{init}');
  assert.strictEqual(session.mrId, '42');
});

test('HTTP clear review endpoint preserves optional UI fields from body', () => {
  assert.strictEqual(CLEAR_REVIEW_ENDPOINT, '/review/clear');
  assert.deepStrictEqual(normalizeClearReviewRequest({
    sourceBranch: ' feature/a ',
    targetBranch: ' main ',
    mrId: 42,
  }), {
    sourceBranch: 'feature/a',
    targetBranch: 'main',
    mrId: '42',
  });
});
