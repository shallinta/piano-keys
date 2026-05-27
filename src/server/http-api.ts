import { ReviewSession } from '../types';

export const CLEAR_REVIEW_ENDPOINT = '/review/clear';

export function normalizeClearReviewRequest(body: any): Partial<Pick<ReviewSession, 'sourceBranch' | 'targetBranch' | 'mrId'>> {
  const result: Partial<Pick<ReviewSession, 'sourceBranch' | 'targetBranch' | 'mrId'>> = {};
  if (body && typeof body === 'object') {
    if (body.sourceBranch !== undefined) result.sourceBranch = String(body.sourceBranch).trim();
    if (body.targetBranch !== undefined) result.targetBranch = String(body.targetBranch).trim();
    if (body.mrId !== undefined) result.mrId = String(body.mrId).trim() || undefined;
  }
  return result;
}
