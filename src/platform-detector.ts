import * as vscode from 'vscode';
import { NotificationService } from './notification-service';
import { detectGitProvider } from './git-provider';

export type Platform = string;

export function detectPlatform(remoteUrl: string): Platform {
  return detectGitProvider(remoteUrl)?.id ?? 'unknown';
}

export async function promptPlatform(): Promise<Platform | undefined> {
  const pick = await NotificationService.quickPick(
    [
      { label: 'GitHub', description: 'Use GitHub SSH or gh CLI', platform: 'github' as Platform },
      { label: '添加自定义 Provider', description: '在设置中配置 piano-keys.07.gitProviders，或让 agent 自动配置', platform: 'unknown' as Platform },
      { label: '仅本地评审', description: '不关联远端 MR/PR，仅使用 git 分支对比', platform: 'unknown' as Platform },
    ],
    { placeHolder: 'Select MR platform' }
  );

  if (pick?.label === '添加自定义 Provider') {
    vscode.commands.executeCommand('workbench.action.openSettings', 'piano-keys.07.gitProviders');
    NotificationService.info('可手填基础 provider 配置，或让 agent 使用 piano-keys-cr skill 通过交互式问答自动补全。');
  }

  return pick?.platform;
}
