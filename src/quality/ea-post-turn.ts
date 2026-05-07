import type { Sql } from "postgres";
import { extractImplicitQualitySignals } from "./extractor";

export interface ScheduleImplicitQualityExtractionInput {
  hiveId: string;
  ownerMessage: string;
  ownerMessageId?: string | null;
}

export function scheduleImplicitQualityExtraction(
  sql: Sql,
  input: ScheduleImplicitQualityExtractionInput,
): void {
  void extractImplicitQualitySignals(sql, {
    hiveId: input.hiveId,
    ownerMessage: input.ownerMessage,
    ownerMessageId: input.ownerMessageId ?? null,
  }).catch((error) => {
    console.error("[quality] implicit EA extraction error:", error);
  });
}
