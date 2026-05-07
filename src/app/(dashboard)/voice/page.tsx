"use client";
import { useVoiceCallDirect } from "@/hooks/useVoiceCallDirect";
import { CallButton } from "@/components/voice/CallButton";
import { LiveTranscript } from "@/components/voice/LiveTranscript";
import { useHiveContext } from "@/components/hive-context";

export default function VoicePage() {
  const { selected: hive, loading } = useHiveContext();
  const { status, error, transcript, startCall, endCall } = useVoiceCallDirect(
    hive?.id ?? "",
  );

  if (loading) {
    return <main className="py-12 text-center text-sm">Loading…</main>;
  }

  if (!hive) {
    return (
      <main className="mx-auto max-w-4xl py-12 text-center">
        <h1 className="text-3xl font-semibold">Voice EA</h1>
        <p className="mt-6 text-sm text-amber-900/80 dark:text-zinc-400">
          Pick a hive from the selector above to start a voice call.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl space-y-8 py-12">
      <h1 className="text-3xl font-semibold">Voice EA</h1>
      <div className="flex justify-center py-8">
        <CallButton status={status} onStart={startCall} onEnd={endCall} />
      </div>
      {error && (
        <div className="rounded bg-red-50 p-3 text-red-900">Error: {error}</div>
      )}
      <LiveTranscript entries={transcript} />
    </main>
  );
}
