import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { CommentStore } from './comment-store';
import { SidePanelProvider } from './side-panel-provider';
import { Coordinator } from './coordinator';
import { DiffCommentController } from './diff-comment-controller';
import { HttpServer } from './server/http-server';
import { getWorkspacePath } from './git';
import { NotificationService } from './notification-service';
import { buildSymlinkAwareSkillInstallTargets, createSkillInstallPlan, getSkillInstallTargetDetail, shouldContinueSkillInstall, shouldShowSkillInstallPicker, SkillInstallTarget, SymlinkAwareSkillInstallCandidate } from './skill-installation';

const SKILL_NAME = 'piano-keys-cr';
const HOME_DIR = os.homedir();

// Agent skill directories
const AGENTS_SKILLS_DIR = path.join(HOME_DIR, '.agents', 'skills');

const KNOWN_AGENT_SKILL_DIRS: Record<string, string> = {
  '.agents': 'Agents',
  '.claude': 'Claude Code',
  '.codex': 'Codex',
  '.Codex': 'Codex',
  '.opencode': 'Open Code',
  '.cursor': 'Cursor',
};

export async function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('Piano Keys');
  context.subscriptions.push(outputChannel);
  outputChannel.appendLine('Piano Keys extension activated');

  // Auto-prompt skill installation on first activation
  autoInstallSkill(context);

  // Manual command to install the skill (user or agent can invoke)
  context.subscriptions.push(
    vscode.commands.registerCommand('piano-keys.installSkill', async () => {
      await installSkillManually(context);
    })
  );

  const commentStore = new CommentStore(context);
  const sidePanelProvider = new SidePanelProvider(context, commentStore);
  const diffCommentController = new DiffCommentController(context, commentStore);
  const coordinator = new Coordinator(commentStore, sidePanelProvider, diffCommentController);
  sidePanelProvider.setCoordinator(coordinator);

  // Badge provider for sidebar comment count
  try {
    const { CommentBadgeProvider } = await import('./comment-badge-provider');
    const badgeProvider = new CommentBadgeProvider(commentStore);
    context.subscriptions.push(badgeProvider);
    commentStore.onDidChange(() => {
      badgeProvider.refresh();
    });
  } catch (err: any) {
    outputChannel.appendLine(`Failed to load comment badge provider: ${err?.message}`);
  }

  // Command to focus the side panel webview
  context.subscriptions.push(
    vscode.commands.registerCommand('piano-keys.focusSidePanel', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.piano-keys');
      // Reveal the webview view
      await vscode.commands.executeCommand('piano-keys.sidePanel.focus');
    })
  );

  // Start HTTP/MCP server for external agent access
  const httpServer = new HttpServer(commentStore, coordinator, sidePanelProvider);
  await httpServer.start().then(({ port }) => {
    outputChannel.appendLine(`Piano Keys API server started on port ${port}`);
  }).catch(err => {
    outputChannel.appendLine(`Failed to start API server: ${err?.message || err}`);
    NotificationService.error(`Failed to start API server: ${err.message}`);
  });

  context.subscriptions.push(
    { dispose: () => httpServer.stop() },
    vscode.window.registerWebviewViewProvider(SidePanelProvider.viewType, sidePanelProvider),
    diffCommentController
  );

  // Update webview when theme setting changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('piano-keys.01.theme')) {
        sidePanelProvider.updateView();
      }
    })
  );

  // Refresh side panel command (called from DiffCommentController after adding comment)
  context.subscriptions.push(
    vscode.commands.registerCommand('piano-keys.refreshSidePanel', async () => {
      await sidePanelProvider.updateView();
    })
  );

  // Refresh editor threads command (called from side panel after deleting/editing comment)
  context.subscriptions.push(
    vscode.commands.registerCommand('piano-keys.refreshEditorThreads', () => {
      diffCommentController.refreshAllEditorThreads();
    })
  );

  // Track active editor file path for highlighting in file tree
  let activeFilePath: string | undefined;
  let activePathUpdateTimer: NodeJS.Timeout | undefined;
  const onDidChangeActiveTextEditor = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor?.document?.uri) {
      const workspacePath = getWorkspacePath();
      if (workspacePath && editor.document.uri.fsPath.startsWith(workspacePath)) {
        activeFilePath = editor.document.uri.fsPath.slice(workspacePath.length + 1);
      } else {
        activeFilePath = editor.document.uri.fsPath;
      }
    } else {
      activeFilePath = undefined;
    }
    // Throttle updateView to avoid full re-render on rapid editor switches
    clearTimeout(activePathUpdateTimer);
    activePathUpdateTimer = setTimeout(() => {
      sidePanelProvider.setActiveFilePath(activeFilePath);
    }, 200);
  });
  context.subscriptions.push(onDidChangeActiveTextEditor);
  // Clean up the throttle timer on extension deactivation
  context.subscriptions.push({ dispose: () => clearTimeout(activePathUpdateTimer) });

  // Sync existing Diff Editor threads to side panel on startup (e.g. after VSCode restart)
  const existingSession = commentStore.activeSession;
  if (existingSession) {
    // Delay to ensure Diff Editor is ready
    setTimeout(() => {
      diffCommentController.refreshAllEditorThreads();
    }, 500);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('piano-keys.startReview', async () => {
      const sourceBranch = await NotificationService.input({
        prompt: 'Source branch',
        placeHolder: 'feature/my-branch',
      });
      if (!sourceBranch) return;

      const targetBranch = await NotificationService.input({
        prompt: 'Target branch',
        placeHolder: 'main',
        value: 'main',
      });
      if (!targetBranch) return;

      await coordinator.openDiff(sourceBranch, targetBranch);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('piano-keys.openDiff', async (args?: { sourceBranch?: string; targetBranch?: string; mrId?: string }) => {
      await coordinator.openDiff(args?.sourceBranch, args?.targetBranch, args?.mrId);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('piano-keys.openFile', async (filePath: string, options?: { lineNumber?: number }) => {
      await coordinator.openFileDiff(filePath, options?.lineNumber);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('piano-keys.submitAllComments', async () => {
      await coordinator.submitAllComments();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('piano-keys.submitSingleComment', async (commentId: string) => {
      await coordinator.submitSingleComment(commentId);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('piano-keys.confirmAllAgentComments', async () => {
      const sessionId = commentStore.activeSessionId;
      if (!sessionId) return;
      const count = await commentStore.confirmAllAgentComments(sessionId);
      NotificationService.info(`Confirmed ${count} agent comments`);
      await sidePanelProvider.updateView();
      vscode.commands.executeCommand('piano-keys.refreshEditorThreads');
    })
  );

  // === Agent-facing commands (programmatic, no UI prompts) ===

  // Add an Agent comment
  context.subscriptions.push(
    vscode.commands.registerCommand('piano-keys.addAgentComment', async (args: {
      filePath: string;
      lineNumber: number;
      content: string;
    }) => {
      const sessionId = commentStore.activeSessionId;
      if (!sessionId) {
        NotificationService.warning('No active review session.');
        return;
      }
      await commentStore.createComment(sessionId, {
        author: 'agent',
        filePath: args.filePath,
        lineNumber: args.lineNumber,
        content: args.content,
        status: 'pending',
      });
      await sidePanelProvider.updateView();
      vscode.commands.executeCommand('piano-keys.refreshEditorThreads');
    })
  );

  // Get current review session state
  context.subscriptions.push(
    vscode.commands.registerCommand('piano-keys.getReviewState', async () => {
      const state = commentStore.getReviewState();
      if (!state) {
        NotificationService.info('No active review session');
        return;
      }
      NotificationService.info(JSON.stringify(state, null, 2));
    })
  );

  // Delete an Agent comment by ID
  context.subscriptions.push(
    vscode.commands.registerCommand('piano-keys.deleteAgentComment', async (args: { commentId: string }) => {
      const sessionId = commentStore.activeSessionId;
      if (!sessionId) return;
      await commentStore.updateCommentStatus(sessionId, args.commentId, 'deleted');
      await sidePanelProvider.updateView();
      vscode.commands.executeCommand('piano-keys.refreshEditorThreads');
    })
  );

  // Submit all comments
  context.subscriptions.push(
    vscode.commands.registerCommand('piano-keys.agentSubmitAll', async () => {
      await coordinator.submitAllComments();
    })
  );

  // Open diff for a specific file
  context.subscriptions.push(
    vscode.commands.registerCommand('piano-keys.agentOpenFileDiff', async (args: { filePath: string }) => {
      await coordinator.openFileDiff(args.filePath);
    })
  );
}

export function deactivate() {
  // HTTP server cleanup is handled via context.subscriptions dispose
}

// --- Skill Installation ---

function parseSkillVersion(filePath: string): number {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const match = content.match(/^version:\s*(\d+)/m);
    return match ? parseInt(match[1], 10) : 0;
  } catch {
    return 0;
  }
}

function autoInstallSkill(context: vscode.ExtensionContext) {
  const sourceFile = path.join(context.extensionPath, 'skills', SKILL_NAME, 'SKILL.md');
  if (!fs.existsSync(sourceFile)) return;

  const sourceVersion = parseSkillVersion(sourceFile);
  const targets = getDetectedSkillTargets(sourceVersion);
  const installedFile = path.join(AGENTS_SKILLS_DIR, SKILL_NAME, 'SKILL.md');
  const installedKey = getSkillInstalledKey();
  if (fs.existsSync(installedFile) && !shouldShowSkillInstallPicker(targets, sourceVersion)) {
    return;
  }

  const installed = context.globalState.get<boolean>(installedKey);
  const installedFileExists = fs.existsSync(installedFile);
  if (installed && installedFileExists) {
    // Already installed for this workspace, but version check above found an update is available.
  } else if (installed && !installedFileExists) {
    // User previously dismissed/installed for this workspace, but the skill file is missing; re-prompt.
  } else if (!installed) {
    // First prompt for this workspace.
  } else {
    return;
  }

  const agentsVersion = fs.existsSync(installedFile) ? parseSkillVersion(installedFile) : 0;
  const isUpgrade = agentsVersion > 0 && agentsVersion < sourceVersion;
  const primaryAction = isUpgrade ? 'Upgrade' : 'Install';
  const message = isUpgrade
    ? `Piano Keys code review skill can be upgraded from v${agentsVersion} to v${sourceVersion}. Upgrade now?`
    : 'Piano Keys includes a code review skill for AI agents. Install it now?';

  NotificationService.info(
    message,
    primaryAction, 'Not Now'
  ).then(result => {
    if (result === primaryAction) {
      doInstall(context, targets, sourceVersion);
    } else {
      context.globalState.update(installedKey, true);
    }
  });
}

function getSkillInstalledKey(): string {
  const workspacePath = getWorkspacePath();
  return workspacePath
    ? `piano-keys.skillInstalled.${workspacePath}`
    : 'piano-keys.skillInstalled.global';
}

async function installSkillManually(context: vscode.ExtensionContext) {
  const sourceFile = path.join(context.extensionPath, 'skills', SKILL_NAME, 'SKILL.md');
  if (!fs.existsSync(sourceFile)) {
    NotificationService.error('Skill file not found in extension directory');
    return;
  }

  const sourceVersion = parseSkillVersion(sourceFile);
  const targets = getDetectedSkillTargets(sourceVersion);
  if (!shouldShowSkillInstallPicker(targets, sourceVersion)) {
    NotificationService.info(`Skill already installed for all detected agents (version ${sourceVersion})`);
    return;
  }

  await doInstall(context, targets, sourceVersion);
}

function getDetectedSkillTargets(sourceVersion: number): (SkillInstallTarget & { dir: string; alwaysInstall?: boolean })[] {
  const agentsPath = path.join(AGENTS_SKILLS_DIR, SKILL_NAME, 'SKILL.md');
  const agentsVersion = fs.existsSync(agentsPath) ? parseSkillVersion(agentsPath) : 0;
  const candidates: SymlinkAwareSkillInstallCandidate[] = [{
    label: 'Agents',
    dir: AGENTS_SKILLS_DIR,
    exists: fs.existsSync(AGENTS_SKILLS_DIR),
    skillExists: fs.existsSync(path.join(AGENTS_SKILLS_DIR, SKILL_NAME)),
    installedVersion: agentsVersion,
    alwaysInstall: true,
  }];

  for (const dir of discoverOtherSkillDirectories()) {
    const agentDirName = path.basename(path.dirname(dir));
    candidates.push({
      label: KNOWN_AGENT_SKILL_DIRS[agentDirName] ?? toAgentLabel(agentDirName),
      dir,
      exists: true,
      skillExists: fs.existsSync(path.join(dir, SKILL_NAME)),
      installedVersion: 0,
    });
  }

  return buildSymlinkAwareSkillInstallTargets(candidates, sourceVersion);
}

/** Discover home skills directories under hidden agent folders, excluding .agents/skills. */
function discoverOtherSkillDirectories(): string[] {
  try {
    return fs.readdirSync(HOME_DIR, { withFileTypes: true })
      .filter(entry => entry.name.startsWith('.') && (entry.isDirectory() || entry.isSymbolicLink()))
      .map(entry => path.join(HOME_DIR, entry.name, 'skills'))
      .filter(skillsDir => fs.existsSync(skillsDir) && skillsDir !== AGENTS_SKILLS_DIR)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function toAgentLabel(agentDirName: string): string {
  const cleaned = agentDirName.replace(/^\.+/, '').replace(/[-_]+/g, ' ').trim();
  if (!cleaned) return agentDirName;
  return cleaned.replace(/\b\w/g, char => char.toUpperCase());
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function doInstall(context: vscode.ExtensionContext, detectedTargets?: (SkillInstallTarget & { dir: string })[], knownSourceVersion?: number) {
  try {
    const sourceFile = path.join(context.extensionPath, 'skills', SKILL_NAME, 'SKILL.md');
    if (!fs.existsSync(sourceFile)) {
      NotificationService.error('Skill file not found in extension directory');
      return;
    }

    const sourceVersion = knownSourceVersion ?? parseSkillVersion(sourceFile);
    const targets = detectedTargets ?? getDetectedSkillTargets(sourceVersion);
    const isUpgrade = targets.some(target => target.alwaysInstall && target.installedVersion > 0 && target.installedVersion < sourceVersion);
    const installPlan = createSkillInstallPlan(targets, sourceVersion, {
      includeAllPickerTargets: isUpgrade,
    });

    // 2. Detect all agent skill directories and offer as multi-select (all checked by default)
    const agentOptions: (vscode.QuickPickItem & { dir: string })[] = installPlan.pickerTargets
      .map(target => ({
        label: target.label,
        description: '~/' + target.dir.split('/').slice(-2).join('/') + '/',
        detail: getSkillInstallTargetDetail(target, sourceVersion),
        dir: target.dir,
        picked: true,
      }));

    let selections: readonly (vscode.QuickPickItem & { dir: string })[] | undefined;

    if (agentOptions.length > 0) {
      selections = await NotificationService.quickPick(agentOptions, {
        canPickMany: true,
        placeHolder: 'Select agents to install the skill for (all detected agents are pre-selected)',
      });

      if (!shouldContinueSkillInstall(selections?.length, agentOptions.length)) {
        return;
      }
    }

    // 1. Copy to ~/.agents/skills/ only after the optional picker is confirmed.
    ensureDir(AGENTS_SKILLS_DIR);
    const agentsTarget = path.join(AGENTS_SKILLS_DIR, SKILL_NAME);
    ensureDir(agentsTarget);
    fs.copyFileSync(sourceFile, path.join(agentsTarget, 'SKILL.md'));

    const links = ['~/.agents/skills/' + SKILL_NAME + '/'];

    if (selections) {
      for (const sel of selections) {
        if (tryCreateSymlink(sel.dir, agentsTarget, sel.label)) {
          links.push('~/' + sel.dir.split('/').slice(-2).join('/') + '/' + SKILL_NAME);
        }
      }
    }

    context.globalState.update(getSkillInstalledKey(), true);
    NotificationService.info('Skill installed:\n' + links.join('\n'));
  } catch (err: any) {
    NotificationService.error(`Failed to install skill: ${err.message}`);
  }
}

function tryCreateSymlink(targetDir: string, sourceDir: string, label: string): boolean {
  try {
    ensureDir(targetDir);
    const linkPath = path.join(targetDir, SKILL_NAME);
    const sourceDirAbs = fs.realpathSync(sourceDir);

    if (fs.existsSync(linkPath)) {
      // Already exists, check if it's the right link
      if (fs.lstatSync(linkPath).isSymbolicLink()) {
        const existing = fs.readlinkSync(linkPath);
        if (existing === sourceDirAbs || existing.includes(SKILL_NAME)) return true;
      }
      fs.rmSync(linkPath, { recursive: true, force: true });
    }

    fs.symlinkSync(sourceDirAbs, linkPath);
    return true;
  } catch (err: any) {
    console.warn(`[Piano Keys] Failed to create ${label} skill symlink: ${err?.message || err}`);
    return false;
  }
}
