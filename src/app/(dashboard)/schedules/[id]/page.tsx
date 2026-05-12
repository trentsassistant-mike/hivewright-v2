import { notFound } from "next/navigation";
import { ScheduleDetailView } from "@/components/schedule-detail-view";
import { loadScheduleDetailForPage } from "./page.helpers";

export const dynamic = "force-dynamic";

export default async function ScheduleDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const detail = await loadScheduleDetailForPage(id);
  if (!detail) notFound();

  return <ScheduleDetailView detail={detail} />;
}
