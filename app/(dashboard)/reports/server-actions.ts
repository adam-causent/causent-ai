"use server";

import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/auth/session";
import { deleteDecisionReport } from "@/lib/decision-reports/persistence";
import { getServerSupabase, isLocalDemo } from "@/lib/supabase-server";

export type DeleteReportActionState =
  | { status: "idle" }
  | { status: "error"; error: string };

export async function deleteDecisionReportAction(
  _previous: DeleteReportActionState,
  formData: FormData,
): Promise<DeleteReportActionState> {
  const session = await getSession();
  if (!isLocalDemo() && !session.userId) {
    return { status: "error", error: "Sign in before deleting a report." };
  }
  const reportId = formData.get("reportId");
  if (typeof reportId !== "string") {
    return { status: "error", error: "Choose a valid report." };
  }
  const result = await deleteDecisionReport(
    await getServerSupabase(),
    session.workspaceId,
    reportId,
    session.userId,
  );
  if (!result.ok) return { status: "error", error: result.error };

  revalidatePath("/reports");
  revalidatePath("/onboarding");
  revalidatePath("/", "layout");
  return { status: "idle" };
}
