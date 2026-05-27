import { execa } from 'execa';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { DiffFile } from './types';

const TEMP_DIR_PREFIX = 'piano-keys-';
const STALE_TEMP_DIR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export class GitService {
  readonly workspacePath: string;
  private remote: string;
  private tempDir: string;

  constructor(workspacePath: string, remote: string = 'origin') {
    this.workspacePath = workspacePath;
    this.remote = remote;
    try {
      this.cleanupStaleTempDirs();
      this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_DIR_PREFIX));
    } catch (err: any) {
      throw new Error(`Failed to create Piano Keys temp directory: ${err?.message || err}`);
    }
  }

  dispose(): void {
    try {
      fs.rmSync(this.tempDir, { recursive: true, force: true });
    } catch { /* temp dir may already be cleaned up */ }
  }

  async fetch(): Promise<{ ok: boolean; error: string }> {
    try {
      await execa('git', ['fetch', this.remote], { cwd: this.workspacePath });
      return { ok: true, error: '' };
    } catch (err) {
      const msg = (err as any)?.stderr || (err as Error).message || '';
      console.error(`[Piano Keys] git fetch ${this.remote} failed, retrying:`, msg);
      try {
        await this.delay(500);
        await execa('git', ['fetch', this.remote], { cwd: this.workspacePath });
        return { ok: true, error: '' };
      } catch (err) {
        const retryMsg = (err as any)?.stderr || (err as Error).message || '';
        console.error(`[Piano Keys] git fetch ${this.remote} retry also failed:`, retryMsg);
        return { ok: false, error: retryMsg };
      }
    }
  }

  async getRemoteUrl(): Promise<string> {
    const { stdout } = await execa('git', ['remote', 'get-url', this.remote], {
      cwd: this.workspacePath,
    });
    return stdout.trim();
  }

  async getAllFiles(branch: string): Promise<DiffFile[]> {
    const sourceRef = await this.resolveBranchRef(branch);
    // List all files in the source branch using git ls-tree
    const { stdout } = await execa('git', [
      'ls-tree', '-r', '--long',
      sourceRef,
    ], { cwd: this.workspacePath });

    const files: DiffFile[] = [];
    for (const line of stdout.split('\n').filter(Boolean)) {
      // Format: mode type hash size\tfilepath
      // e.g.: 100644 blob abc123 1234\tsrc/index.ts
      const tabIdx = line.indexOf('\t');
      if (tabIdx === -1) continue;
      const filePath = line.substring(tabIdx + 1);
      if (!filePath) continue;

      files.push({
        filePath,
        additions: 0,
        deletions: 0,
        originalUri: '',
        modifiedUri: '',
      });
    }

    return files;
  }

  async getDiffFiles(sourceBranch: string, targetBranch: string): Promise<DiffFile[]> {
    // '{init}' means list all files in source branch — compare against empty tree
    if (targetBranch === '{init}') {
      return this.getAllFiles(sourceBranch);
    }

    const sourceRef = await this.resolveBranchRef(sourceBranch);
    const targetRef = await this.resolveBranchRef(targetBranch);

    const { stdout } = await execa('git', [
      'diff', '--numstat', `${targetRef}..${sourceRef}`,
    ], { cwd: this.workspacePath });

    const files: DiffFile[] = [];
    for (const line of stdout.split('\n').filter(Boolean)) {
      const [additions, deletions, filePath] = line.split('\t');
      if (!filePath) continue;

      files.push({
        filePath,
        additions: parseInt(additions, 10) || 0,
        deletions: parseInt(deletions, 10) || 0,
        originalUri: '',
        modifiedUri: '',
      });
    }

    return files;
  }

  async getFileUris(filePath: string, sourceBranch: string, targetBranch: string): Promise<{ originalUri: vscode.Uri; modifiedUri: vscode.Uri }> {
    const sourceRef = await this.resolveBranchRef(sourceBranch);

    if (targetBranch === '{init}') {
      // Original file is empty (file doesn't exist before source branch)
      const originalPath = this.writeTempFile('original', filePath, '');
      const modifiedContent = await this.showFile(sourceRef, filePath);
      const modifiedPath = this.writeTempFile('modified', filePath, modifiedContent);

      return {
        originalUri: vscode.Uri.file(originalPath),
        modifiedUri: vscode.Uri.file(modifiedPath),
      };
    }

    const targetRef = await this.resolveBranchRef(targetBranch);
    const originalContent = await this.showFile(targetRef, filePath);
    const modifiedContent = await this.showFile(sourceRef, filePath);
    const originalPath = this.writeTempFile('original', filePath, originalContent);
    const modifiedPath = this.writeTempFile('modified', filePath, modifiedContent);

    return {
      originalUri: vscode.Uri.file(originalPath),
      modifiedUri: vscode.Uri.file(modifiedPath),
    };
  }

  private async showFile(ref: string, filePath: string): Promise<string> {
    try {
      const { stdout } = await execa('git', ['show', `${ref}:${filePath}`], {
        cwd: this.workspacePath,
      });
      return stdout;
    } catch (err: any) {
      const msg = err?.stderr || err?.message || '';
      if (msg && !msg.includes('exists on disk, but not in')) {
        console.warn(`[Piano Keys] git show failed for ${ref}:${filePath}: ${msg}`);
      }
      return '';
    }
  }

  private async resolveBranchRef(branch: string): Promise<string> {
    if (branch === '{init}') return branch;
    const remoteRef = `${this.remote}/${branch}`;
    try {
      await execa('git', ['rev-parse', '--verify', remoteRef], { cwd: this.workspacePath });
      return remoteRef;
    } catch {
      await execa('git', ['rev-parse', '--verify', branch], { cwd: this.workspacePath });
      console.warn(`[Piano Keys] remote ref '${remoteRef}' not found; using local branch '${branch}' instead`);
      return branch;
    }
  }

  private cleanupStaleTempDirs(): void {
    const tmpDir = os.tmpdir();
    const now = Date.now();
    try {
      for (const entry of fs.readdirSync(tmpDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith(TEMP_DIR_PREFIX)) continue;
        const candidate = path.join(tmpDir, entry.name);
        try {
          const stat = fs.statSync(candidate);
          if (now - stat.mtimeMs > STALE_TEMP_DIR_MAX_AGE_MS) {
            fs.rmSync(candidate, { recursive: true, force: true });
          }
        } catch {
          // Ignore individual stale entry cleanup failures.
        }
      }
    } catch {
      // Ignore tmp directory scan failures; temp creation below will surface fatal errors.
    }
  }

  private writeTempFile(side: 'original' | 'modified', filePath: string, content: string): string {
    const tempPath = path.join(this.tempDir, side, filePath);
    fs.mkdirSync(path.dirname(tempPath), { recursive: true });
    fs.writeFileSync(tempPath, content);
    return tempPath;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async currentBranch(): Promise<string> {
    const { stdout } = await execa('git', ['branch', '--show-current'], {
      cwd: this.workspacePath,
    });
    return stdout.trim();
  }

  async listBranches(): Promise<string[]> {
    const { stdout } = await execa('git', [
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/heads',
      `refs/remotes/${this.remote}`,
    ], { cwd: this.workspacePath });

    return stdout
      .split('\n')
      .map(branch => branch.trim())
      .filter(branch => branch && branch !== `${this.remote}/HEAD` && !branch.endsWith('/HEAD'));
  }
}

export function getWorkspacePath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
