/**
 * Compatibility surface for one major release. The authoritative
 * FeedbackAnalysisPort contract now lives in core so runtime can consume it
 * without creating the previous eval -> runtime -> eval package cycle.
 */
export {
  FEEDBACK_ANALYSIS_ISSUE_CODES,
  HUMAN_REVIEW_CONFIDENCE_THRESHOLD,
  candidateDisposition,
  createInMemoryFeedbackAnalysisPort,
  shouldInvokeFeedbackAnalysis,
  validateFeedbackAnalysisOutput,
  type FeedbackAnalysisIssue,
  type FeedbackAnalysisIssueCode,
  type FeedbackAnalysisPort,
  type FeedbackAnalysisResult,
} from "@universal-harness-internal/core";
