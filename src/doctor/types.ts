export interface DoctorDiagnosis {
  action:
    | "rewrite_brief"
    | "reassign"
    | "split_task"
    | "fix_environment"
    | "escalate"
    | "reclassify"
    | "convert-to-goal";
  details: string;
  newBrief?: string;
  newRole?: string;
  subTasks?: { title: string; brief: string; assignedTo: string }[];
  decisionTitle?: string;
  decisionContext?: string;
  failureContext?: string;
}

export type ParseDoctorDiagnosisResult =
  | { ok: true; diagnosis: DoctorDiagnosis }
  | { ok: false; reason: string; kind: "no_block" | "malformed" };

export interface DoctorInput {
  taskId: string;
  hiveId: string;
  title: string;
  brief: string;
  acceptanceCriteria: string | null;
  assignedTo: string;
  failureHistory: {
    attempt: number;
    error: string;
    partialOutput?: string;
  }[];
}
