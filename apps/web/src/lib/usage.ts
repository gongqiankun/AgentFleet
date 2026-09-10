export interface TokenCounts { inputTokens:number;outputTokens:number;cachedInputTokens:number;reasoningOutputTokens:number;totalTokens:number }
export interface UsageSummary {
  scope:"session"|"project"|"machine";recorded:TokenCounts|null;quotaCycle:{startsAt:string;resetsAt:string;recordedTokens:number|null;boundaryIncomplete:boolean}|null;
  observedSessions:number;totalSessions:number;firstObservedAt:string|null;lastObservedAt:string|null;coverage:"observed-only";discontinuities:number;
  last:TokenCounts|null;nativeTotal:TokenCounts|null;modelContextWindow:number|null;
  accounts:{sourceMachine:string;identityKnown:boolean;observedAt:string;stale:boolean;windows:{bucket:string;window:string;usedPercent:number;remainingPercent:number;windowMinutes:number;resetsAt:number|null}[]}[];
  topProjects:{id:string;title:string;totalTokens:number}[];
  topSessions:{id:string;title:string;totalTokens:number}[];
}
