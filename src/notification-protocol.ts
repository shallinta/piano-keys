export type NotificationSeverity = 'info' | 'warning' | 'error';
export type NotificationKind = 'toast' | 'input' | 'quickPick';

export type NotificationItem = {
  label: string;
  value?: string;
  description?: string;
  detail?: string;
  picked?: boolean;
  [key: string]: unknown;
};

export type NotificationRequest = {
  type: 'notificationRequest';
  id: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  message: string;
  items: NotificationItem[];
  timeoutMs: number;
  placeholder?: string;
  value?: string;
  canPickMany?: boolean;
};

export function normalizeNotificationItems(items: readonly (string | NotificationItem)[] = []): NotificationItem[] {
  return items.map((item) => {
    if (typeof item === 'string') {
      return { label: item, value: item };
    }
    return { ...item, value: typeof item.value === 'string' ? item.value : item.label };
  });
}

export function getNotificationTimeoutMs(kind: NotificationKind, items: readonly NotificationItem[]): number {
  return kind === 'toast' && items.length === 0 ? 4200 : 0;
}

export function createNotificationRequest(args: {
  id: string;
  kind: NotificationKind;
  severity?: NotificationSeverity;
  message: string;
  items?: readonly (string | NotificationItem)[];
  placeholder?: string;
  value?: string;
  canPickMany?: boolean;
}): NotificationRequest {
  const items = normalizeNotificationItems(args.items ?? []);
  return {
    type: 'notificationRequest',
    id: args.id,
    kind: args.kind,
    severity: args.severity ?? 'info',
    message: args.message,
    items,
    timeoutMs: getNotificationTimeoutMs(args.kind, items),
    ...(args.placeholder !== undefined ? { placeholder: args.placeholder } : {}),
    ...(args.value !== undefined ? { value: args.value } : {}),
    ...(args.canPickMany !== undefined ? { canPickMany: args.canPickMany } : {}),
  };
}
