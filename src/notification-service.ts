import * as vscode from 'vscode';
import { createNotificationRequest, NotificationItem, NotificationSeverity } from './notification-protocol';

type Resolver = (value: unknown) => void;
type NotificationRequestArgs = Omit<Parameters<typeof createNotificationRequest>[0], 'id'>;

export class NotificationService {
  private static view: vscode.WebviewView | undefined;
  private static pending = new Map<string, Resolver>();
  private static nextId = 1;

  static setView(view: vscode.WebviewView | undefined): void {
    this.view = view;
  }

  static handleResponse(message: { id?: string; value?: unknown; dismissed?: boolean }): void {
    if (!message.id) return;
    const resolve = this.pending.get(message.id);
    if (!resolve) return;
    this.pending.delete(message.id);
    resolve(message.dismissed ? undefined : message.value);
  }

  static info(message: string, ...items: string[]): Promise<string | undefined> {
    return this.showToast('info', message, items);
  }

  static warning(message: string, ...items: string[]): Promise<string | undefined> {
    return this.showToast('warning', message, items);
  }

  static error(message: string, ...items: string[]): Promise<string | undefined> {
    return this.showToast('error', message, items);
  }

  static async input(options: vscode.InputBoxOptions): Promise<string | undefined> {
    const result = await this.request({
      kind: 'input',
      severity: 'info',
      message: options.prompt || options.title || options.placeHolder || '请输入',
      placeholder: options.placeHolder,
      value: options.value,
    });
    return typeof result === 'string' && result.length > 0 ? result : undefined;
  }

  static async quickPick<T extends vscode.QuickPickItem>(
    items: readonly T[],
    options?: vscode.QuickPickOptions & { canPickMany?: false }
  ): Promise<T | undefined>;

  static async quickPick<T extends vscode.QuickPickItem>(
    items: readonly T[],
    options: vscode.QuickPickOptions & { canPickMany: true }
  ): Promise<T[] | undefined>;

  static async quickPick<T extends vscode.QuickPickItem>(
    items: readonly T[],
    options?: vscode.QuickPickOptions
  ): Promise<T | T[] | undefined> {
    const normalizedItems = items.map(item => ({ ...(item as unknown as Record<string, unknown>) } as NotificationItem));
    const result = await this.request({
      kind: 'quickPick',
      severity: 'info',
      message: options?.placeHolder || options?.title || '请选择',
      items: normalizedItems,
      canPickMany: options?.canPickMany,
    });
    return result as T | T[] | undefined;
  }

  private static showToast(severity: NotificationSeverity, message: string, items: string[]): Promise<string | undefined> {
    return this.request({ kind: 'toast', severity, message, items }) as Promise<string | undefined>;
  }

  private static request(args: NotificationRequestArgs): Promise<unknown> {
    if (!this.view) {
      return this.fallback(args);
    }

    const id = `notification-${this.nextId++}`;
    const request = createNotificationRequest({ ...args, id });
    return new Promise((resolve) => {
      this.pending.set(id, (value) => {
        if (request.kind === 'toast' && value && typeof value === 'object' && 'value' in (value as any)) {
          resolve((value as any).value);
        } else {
          resolve(value);
        }
      });
      this.view!.webview.postMessage(request).then((ok) => {
        if (!ok) {
          this.pending.delete(id);
          this.fallback(args).then(resolve);
        }
      }, () => {
        this.pending.delete(id);
        this.fallback(args).then(resolve);
      });
    });
  }

  private static async fallback(args: NotificationRequestArgs): Promise<unknown> {
    const labels = (args.items || []).map(item => typeof item === 'string' ? item : item.label);
    if (args.kind === 'input') {
      return vscode.window.showInputBox({ prompt: args.message, placeHolder: args.placeholder, value: args.value });
    }
    if (args.kind === 'quickPick') {
      return vscode.window.showQuickPick([...(args.items ?? [])] as unknown as vscode.QuickPickItem[], { placeHolder: args.message, canPickMany: args.canPickMany });
    }
    if (args.severity === 'error') return vscode.window.showErrorMessage(args.message, ...labels);
    if (args.severity === 'warning') return vscode.window.showWarningMessage(args.message, ...labels);
    return vscode.window.showInformationMessage(args.message, ...labels);
  }
}
