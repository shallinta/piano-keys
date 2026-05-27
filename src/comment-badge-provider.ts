import * as vscode from 'vscode';
import { CommentStore } from './comment-store';

/**
 * Shows comment count as a badge/description on the sidebar tree view.
 */
export class CommentBadgeProvider {
  private commentStore: CommentStore;
  private treeView: vscode.TreeView<DummyItem>;

  constructor(commentStore: CommentStore) {
    this.commentStore = commentStore;
    this.treeView = vscode.window.createTreeView('piano-keys.badge', {
      treeDataProvider: new DummyProvider(),
      canSelectMany: false,
    });
    this.updateBadge();
  }

  refresh(): void {
    this.updateBadge();
  }

  private updateBadge(): void {
    const session = this.commentStore.activeSession;
    if (!session) {
      this.treeView.badge = undefined;
      this.treeView.description = '';
      return;
    }

    const total = session.comments.length;
    const pending = session.comments.filter(c => c.status === 'pending').length;
    const confirmed = session.comments.filter(c => c.status === 'confirmed').length;

    if (total === 0) {
      this.treeView.badge = undefined;
      this.treeView.description = '';
      return;
    }

    const badgeValue = pending > 0 ? pending : total;
    this.treeView.badge = {
      value: badgeValue,
      tooltip: `总计 ${total} 条（${confirmed} 已确认，${pending} 待确认）`,
    };
    // Show count as subtitle next to the view name
    this.treeView.description = total > 0 ? `${total}` : '';
  }

  dispose(): void {
    this.treeView.dispose();
  }
}

class DummyItem extends vscode.TreeItem {
  constructor() {
    super('', vscode.TreeItemCollapsibleState.None);
  }
}

class DummyProvider implements vscode.TreeDataProvider<DummyItem> {
  getChildren(): Thenable<DummyItem[]> {
    return Promise.resolve([]);
  }

  getTreeItem(element: DummyItem): vscode.TreeItem {
    return element;
  }

  onDidChangeTreeData = new vscode.EventEmitter<DummyItem | undefined>().event;
}
