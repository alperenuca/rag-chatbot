export type AnswerReportStatus = 'open' | 'reviewed' | 'dismissed';

export type AnswerReportRow = {
  id: string;
  user_id: string;
  conversation_id: string | null;
  message_id: string | null;
  user_question: string;
  assistant_reply: string;
  reason: string;
  status: AnswerReportStatus;
  created_at: string;
  /** Admin listesinde doldurulur */
  reporter_email?: string | null;
  reporter_name?: string | null;
};

export const REPORT_REASON_MAX = 500;
export const REPORT_REPLY_SNAPSHOT_MAX = 4000;
export const REPORT_QUESTION_SNAPSHOT_MAX = 1000;

export function clampReportText(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}
