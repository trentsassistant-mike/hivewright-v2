"use client";

export function LiveTranscript({
  entries,
}: {
  entries: { role: "user" | "assistant"; text: string }[];
}) {
  return (
    <div className="mx-auto max-w-2xl space-y-3 p-4 text-sm">
      {entries.map((e, i) => (
        <div
          key={i}
          className={`rounded-lg p-3 ${
            e.role === "user" ? "bg-blue-50 text-blue-900" : "bg-gray-50 text-gray-900"
          }`}
        >
          <div className="mb-1 text-xs font-semibold opacity-60">
            {e.role === "user" ? "You" : "EA"}
          </div>
          {e.text}
        </div>
      ))}
    </div>
  );
}
