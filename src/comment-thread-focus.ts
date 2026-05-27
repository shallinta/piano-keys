export interface CollapsibleStateValues {
  Expanded: number;
  Collapsed: number;
}

export function getFocusedThreadKey(filePath: string, lineNumber: number): string {
  return `${filePath}#${lineNumber}`;
}

export function getThreadCollapsibleState(
  threadKey: string,
  focusedThreadKey: string | undefined,
  states: CollapsibleStateValues
): number {
  if (!focusedThreadKey) {
    return states.Expanded;
  }

  return threadKey === focusedThreadKey ? states.Expanded : states.Collapsed;
}
