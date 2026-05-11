import type { Metadata } from "next";
import Image from "next/image";

export const metadata: Metadata = {
  title: "HiveWright Preview",
  description: "Preview-only HiveWright landing surface.",
};

const operatingSignals = [
  "Goals, tasks, decisions, and memory stay in one operating loop.",
  "Role-shaped agents carry work forward under visible supervision.",
  "Owner judgement stays attached to consequential decisions.",
];

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <section className="hive-surface overflow-hidden">
        <div className="mx-auto grid min-h-screen max-w-7xl items-center gap-10 px-6 py-12 md:grid-cols-[1.02fr_0.98fr] md:px-10 lg:px-12">
          <div className="max-w-3xl space-y-8">
            <div className="inline-flex items-center gap-2 border border-amber-300/35 bg-amber-300/10 px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-amber-100">
              <span className="h-2 w-2 rounded-full bg-amber-300" aria-hidden="true" />
              PREVIEW / NON-PUBLIC
            </div>

            <div className="space-y-5">
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                HiveWright operating system
              </p>
              <h1 className="max-w-3xl text-4xl font-semibold leading-tight text-foreground md:text-6xl">
                Run the hive with agents that keep work moving.
              </h1>
              <p className="max-w-2xl text-base leading-8 text-muted-foreground md:text-lg">
                HiveWright gives owner-operators a command layer where agents route, track, and execute work while consequential calls stay visible.
              </p>
            </div>

            <div className="space-y-3">
              <button
                type="button"
                disabled
                className="cursor-not-allowed border border-white/10 bg-white/[0.06] px-5 py-3 text-sm font-semibold text-muted-foreground opacity-80"
              >
                Internal preview only
              </button>
              <p className="max-w-xl text-sm leading-6 text-muted-foreground">
                No public handoff channel is connected. This page is an internal readiness preview only.
              </p>
            </div>
          </div>

          <div className="relative">
            <div className="border border-white/10 bg-white/[0.035] p-3 shadow-2xl shadow-black/30">
              <Image
                src="/design-system/brand/app_example_trio.png"
                alt="HiveWright dashboard preview"
                width={380}
                height={170}
                priority
                className="aspect-[38/17] w-full object-contain"
              />
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              {operatingSignals.map((signal) => (
                <div key={signal} className="border border-white/10 bg-black/20 p-4 text-sm leading-6 text-muted-foreground">
                  {signal}
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
