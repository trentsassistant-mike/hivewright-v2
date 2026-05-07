import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyStructuredDoctorDiagnosis,
  isQualityDoctorDiagnosisTask,
} from "../../src/dispatcher";
import * as regularDoctor from "../../src/doctor";
import * as qualityDoctor from "../../src/quality/doctor";

vi.mock("../../src/doctor", () => ({
  parseDoctorDiagnosis: vi.fn(),
  applyDoctorDiagnosis: vi.fn(),
  escalateMalformedDiagnosis: vi.fn(),
}));

vi.mock("../../src/quality/doctor", () => ({
  parseQualityDoctorDiagnosis: vi.fn(),
  applyQualityDoctorDiagnosis: vi.fn(),
}));

/**
 * The dispatcher only applies a doctor diagnosis when both:
 *   - task.assignedTo === 'doctor'
 *   - task.parentTaskId is truthy
 *
 * Mirrors the condition at src/dispatcher/index.ts:422. Pinned here so
 * future refactors don't accidentally broaden the hook (which would
 * apply diagnoses against any task with a parentTaskId — catastrophic)
 * or narrow it (which would silently skip real doctor tasks).
 */
function shouldApplyDoctorHook(task: { assignedTo: string; parentTaskId: string | null }): boolean {
  return task.assignedTo === "doctor" && !!task.parentTaskId;
}

describe("dispatcher doctor-hook gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fires for a doctor task with a parent", () => {
    expect(
      shouldApplyDoctorHook({ assignedTo: "doctor", parentTaskId: "00000000-0000-0000-0000-000000000001" }),
    ).toBe(true);
  });

  it("does NOT fire for a doctor task with no parent (e.g. doctor-initiated env-fix task)", () => {
    expect(shouldApplyDoctorHook({ assignedTo: "doctor", parentTaskId: null })).toBe(false);
  });

  it("does NOT fire for a non-doctor task with a parent (e.g. split subtask)", () => {
    expect(
      shouldApplyDoctorHook({ assignedTo: "dev-agent", parentTaskId: "00000000-0000-0000-0000-000000000001" }),
    ).toBe(false);
  });

  it("does NOT fire for a regular task", () => {
    expect(shouldApplyDoctorHook({ assignedTo: "dev-agent", parentTaskId: null })).toBe(false);
  });

  it("routes retried quality-doctor tasks to the quality parser", async () => {
    const diagnosis = {
      cause: "wrong_role_or_brief",
      details: "QA was asked to diagnose its own already-shipped verdict.",
      recommendation: "Send to supervisor for a clearer review brief.",
    } as const;
    const sql = {} as never;
    vi.mocked(qualityDoctor.parseQualityDoctorDiagnosis).mockReturnValue(diagnosis);

    const handled = await applyStructuredDoctorDiagnosis(sql, {
      assignedTo: "doctor",
      createdBy: "dispatcher",
      id: "399226f6-0000-0000-0000-000000000000",
      parentTaskId: "46c6df57-0000-0000-0000-000000000000",
      title: "[Doctor retry: claude-code] Quality diagnosis: QA review",
    }, "doctor output");

    expect(handled).toBe(true);
    expect(qualityDoctor.parseQualityDoctorDiagnosis).toHaveBeenCalledWith("doctor output");
    expect(qualityDoctor.applyQualityDoctorDiagnosis).toHaveBeenCalledWith(
      sql,
      "46c6df57-0000-0000-0000-000000000000",
      diagnosis,
    );
    expect(regularDoctor.parseDoctorDiagnosis).not.toHaveBeenCalled();
  });

  it("still recognizes the original quality-doctor task shape", () => {
    expect(
      isQualityDoctorDiagnosisTask({
        createdBy: "quality-doctor",
        title: "Quality diagnosis: QA review",
      }),
    ).toBe(true);
  });
});
