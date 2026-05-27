export type SkillInstallTarget = {
  label: string;
  installedVersion: number;
  alwaysInstall?: boolean;
  sharesBaseSkill?: boolean;
};

export type SkillInstallCandidate = SkillInstallTarget & {
  dir: string;
  exists: boolean;
};

export type SymlinkAwareSkillInstallCandidate = SkillInstallCandidate & {
  skillExists: boolean;
};

export type SkillInstallPlan<T extends SkillInstallTarget> = {
  shouldInstallBase: boolean;
  pickerTargets: T[];
};

export type SkillInstallPlanOptions = {
  includeAllPickerTargets?: boolean;
};

export function getPendingSkillTargets<T extends SkillInstallTarget>(targets: readonly T[], sourceVersion: number): T[] {
  return targets.filter(target => target.installedVersion < sourceVersion);
}

export function shouldShowSkillInstallPicker(targets: readonly SkillInstallTarget[], sourceVersion: number): boolean {
  return getPendingSkillTargets(targets, sourceVersion).length > 0;
}

export function createSkillInstallPlan<T extends SkillInstallTarget>(
  targets: readonly T[],
  sourceVersion: number,
  options: SkillInstallPlanOptions = {}
): SkillInstallPlan<T> {
  const pendingTargets = getPendingSkillTargets(targets, sourceVersion);
  const pickerTargets = options.includeAllPickerTargets
    ? targets.filter(target => !target.alwaysInstall)
    : pendingTargets.filter(target => !target.alwaysInstall);
  return {
    shouldInstallBase: pendingTargets.some(target => target.alwaysInstall),
    pickerTargets,
  };
}

export function getSkillInstallTargetDetail(target: SkillInstallTarget, sourceVersion: number): string {
  if (target.sharesBaseSkill) {
    return `已通过软链接共享，将随 Agents 升级到 v${sourceVersion}`;
  }
  if (target.installedVersion <= 0) {
    return `未安装，将创建软链接到 v${sourceVersion}`;
  }
  if (target.installedVersion < sourceVersion) {
    return `将升级 v${target.installedVersion} → v${sourceVersion}`;
  }
  return `已是最新 v${sourceVersion}`;
}

export function buildSkillInstallTargets<T extends SkillInstallCandidate>(candidates: readonly T[]): Omit<T, 'exists'>[] {
  const seenDirs = new Set<string>();
  const targets: Omit<T, 'exists'>[] = [];

  for (const candidate of candidates) {
    if (!candidate.exists && !candidate.alwaysInstall) continue;
    if (seenDirs.has(candidate.dir)) continue;
    seenDirs.add(candidate.dir);

    const { exists: _exists, ...target } = candidate;
    targets.push(target);
  }

  return targets;
}

export function buildSymlinkAwareSkillInstallTargets<T extends SymlinkAwareSkillInstallCandidate>(
  candidates: readonly T[],
  sourceVersion: number
): Omit<T, 'exists' | 'skillExists'>[] {
  const seenDirs = new Set<string>();
  const targets: Omit<T, 'exists' | 'skillExists'>[] = [];

  for (const candidate of candidates) {
    if (!candidate.exists && !candidate.alwaysInstall) continue;
    if (seenDirs.has(candidate.dir)) continue;
    seenDirs.add(candidate.dir);

    const { exists: _exists, skillExists: _skillExists, ...target } = candidate;
    targets.push({
      ...target,
      sharesBaseSkill: !candidate.alwaysInstall && candidate.skillExists,
      installedVersion: candidate.alwaysInstall
        ? candidate.installedVersion
        : candidate.skillExists ? sourceVersion : 0,
    });
  }

  return targets;
}

export function shouldContinueSkillInstall(selectedPickerTargetCount: number | undefined, pickerTargetCount: number): boolean {
  return pickerTargetCount === 0 || selectedPickerTargetCount !== undefined;
}
