import { ReviewSession } from './types';

export function clearReviewSessionContent(
  session: Pick<ReviewSession, 'files' | 'comments' | 'remoteComments'> & Partial<Pick<ReviewSession, 'sourceBranch' | 'targetBranch' | 'mrId'>>,
  preserve?: Partial<Pick<ReviewSession, 'sourceBranch' | 'targetBranch' | 'mrId'>>
): void {
  session.files = [];
  session.comments = [];
  session.remoteComments = [];
  if (preserve?.sourceBranch !== undefined) session.sourceBranch = preserve.sourceBranch;
  if (preserve?.targetBranch !== undefined) session.targetBranch = preserve.targetBranch;
  if (preserve?.mrId !== undefined) session.mrId = preserve.mrId || undefined;
}
