export type PRState = 'draft' | 'awaiting_review' | 'changes_requested' | 'approved' | 'merged';
export type DeliveryStatus = 'processed' | 'duplicate' | 'failed' | 'received' | 'processing' | 'ignored';

export interface Source {
  id: string;
  repo: string;
  webhookUrl?: string;
  secret?: string;
  status: 'waiting' | 'connected';
}

export interface PullRequest {
  id?: string;
  number: number;
  title: string;
  summary?: string;
  author: { login: string; avatarUrl?: string };
  state: PRState;
  waitingOn?: string;
  waitingSince?: string;
  stalled: boolean;
  readyAt?: string;
  firstReviewAt?: string;
  sourceId?: string;
}

export interface Verdict {
  reviewer: string;
  state: 'approved' | 'changes_requested' | 'commented' | 'dismissed';
  submittedAt: string;
}

export interface PullRequestEvent {
  id: string;
  type: 'opened' | 'ready_for_review' | 'review_requested' | 'review_submitted' | 'review_dismissed' | 'synchronize' | 'closed' | 'merged';
  actor?: string;
  occurredAt: string;
  detail?: string;
}

export interface PullRequestDetail {
  pr: PullRequest;
  verdicts: Verdict[];
  events: PullRequestEvent[];
}

export interface Delivery {
  id: string;
  deliveryId: string;
  event: string;
  status: DeliveryStatus;
  receivedAt: string;
  signatureVerified: boolean | null;
}
