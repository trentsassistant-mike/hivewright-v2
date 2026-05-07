"use client";

import { Phone, PhoneOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useHiveContext } from "@/components/hive-context";
import { useVoiceCallDirect } from "@/hooks/useVoiceCallDirect";
import { cn } from "@/lib/utils";

type GlobalCallEaButtonProps = {
  placement: "desktop" | "mobile";
};

export function GlobalCallEaButton({ placement }: GlobalCallEaButtonProps) {
  const { selected: hive, loading } = useHiveContext();
  const { status, startCall, endCall } = useVoiceCallDirect(hive?.id ?? "");
  const disabled = loading || !hive || status === "connecting" || status === "ending";
  const inCall = status === "active";
  const label = inCall ? "End call" : status === "connecting" ? "Connecting" : "Call EA";
  const title = hive ? label : "Select a hive before calling EA";
  const Icon = inCall ? PhoneOff : Phone;

  return (
    <Button
      type="button"
      onClick={inCall ? endCall : startCall}
      disabled={disabled}
      aria-label={label}
      title={title}
      className={cn(
        "border-amber-300/40 bg-amber-300 text-zinc-950 shadow-[0_0_0_1px_rgba(255,197,98,0.25),0_12px_30px_rgba(229,154,27,0.2)] hover:bg-amber-200 focus-visible:ring-amber-300/45 dark:border-amber-300/30 dark:bg-amber-300 dark:text-zinc-950 dark:hover:bg-amber-200",
        inCall && "border-red-300/40 bg-red-500 text-white hover:bg-red-400 dark:bg-red-500 dark:text-white dark:hover:bg-red-400",
        placement === "desktop" && "h-9 px-3",
        placement === "mobile" &&
          "size-9 rounded-full p-0 shadow-[0_12px_30px_rgba(229,154,27,0.2)] md:hidden [&_span]:sr-only",
      )}
    >
      <Icon aria-hidden="true" className="size-4" />
      <span>{label}</span>
    </Button>
  );
}
