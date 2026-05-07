"use client";
import { useEffect, useState } from "react";
import Image from "next/image";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";

type Mode = "loading" | "signin" | "setup";

function BrandMark() {
  return (
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-md border border-honey-300/35 bg-honey-500/10 shadow-[0_0_0_1px_oklch(0.82_0.16_78/0.16),0_0_24px_-8px_oklch(0.82_0.16_78/0.55)]">
          <Image
            src="/design-system/brand/hivewright_mark.svg"
            alt=""
            aria-hidden="true"
            width={28}
            height={28}
            className="h-7 w-7"
            priority
          />
      </div>
      <div>
        <p className="font-heading text-2xl font-semibold leading-7 text-honey-300">
          HiveWright
        </p>
        <p className="text-xs font-medium text-muted-foreground">
          Owner command access
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("loading");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/auth/setup-state")
      .then((r) => r.json())
      .then((b) => {
        const needsSetup = b?.data?.needsSetup ?? b?.needsSetup ?? false;
        setMode(needsSetup ? "setup" : "signin");
      })
      .catch(() => setMode("signin"));
  }, []);

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    // Bootstrap fallback: if no real users exist yet, email is ignored by
    // the authorize() handler — just the password field matters.
    const result = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });
    setBusy(false);
    if (result?.error) {
      setError("Invalid credentials");
      return;
    }
    router.push("/");
  }

  async function handleSetup(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/bootstrap-owner", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, displayName }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Setup failed");
        return;
      }
      // Log the newly-created owner in immediately.
      await signIn("credentials", { email, password, redirect: false });
      router.push("/");
    } finally {
      setBusy(false);
    }
  }

  if (mode === "loading") {
    return (
      <div className="hive-surface flex min-h-screen items-center justify-center px-4">
        <div className="rounded-lg border border-white/[0.07] bg-card/80 px-4 py-3 shadow-[0_1px_0_rgba(255,255,255,0.04)_inset,0_18px_48px_rgba(0,0,0,0.32)]">
          <p className="text-sm text-muted-foreground">Loading…</p>
        </div>
      </div>
    );
  }

  return (
    <main className="hive-surface flex min-h-screen items-center justify-center px-4 py-8 sm:px-6">
      <section
        className="w-full max-w-md rounded-lg border border-white/[0.07] bg-card/90 p-5 shadow-[0_1px_0_rgba(255,255,255,0.04)_inset,0_18px_56px_rgba(0,0,0,0.42)] backdrop-blur-sm sm:p-7"
        aria-labelledby="login-heading"
      >
        <div className="space-y-5">
          <BrandMark />
          <div className="space-y-1 border-t border-white/[0.07] pt-5">
            <h1 id="login-heading" className="text-lg font-semibold text-foreground">
              {mode === "setup" ? "Create owner account" : "Sign in"}
            </h1>
            <p className="text-sm text-muted-foreground">
              {mode === "setup"
                ? "No owner account yet — set one up to continue."
                : "Sign in to continue"}
            </p>
          </div>
        </div>

        {mode === "setup" ? (
          <>
            <form onSubmit={handleSetup} className="mt-6 space-y-3">
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Your name (optional)"
                className="w-full rounded-md border px-3 py-2.5 text-sm shadow-[0_1px_0_rgba(255,255,255,0.03)_inset]"
              />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email"
                autoComplete="email"
                required
                className="w-full rounded-md border px-3 py-2.5 text-sm shadow-[0_1px_0_rgba(255,255,255,0.03)_inset]"
              />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Choose a password"
                autoComplete="new-password"
                required
                minLength={8}
                className="w-full rounded-md border px-3 py-2.5 text-sm shadow-[0_1px_0_rgba(255,255,255,0.03)_inset]"
              />
              {error && <p className="rounded-md border border-red-400/20 bg-red-500/10 px-3 py-2 text-sm text-red-200">{error}</p>}
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-[0_0_0_1px_oklch(0.82_0.16_78/0.24),0_0_24px_-8px_oklch(0.82_0.16_78/0.5)] transition-colors hover:bg-honey-300 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? "Creating owner…" : "Create owner & sign in"}
              </button>
            </form>
            <button
              type="button"
              onClick={() => {
                setMode("signin");
                setError("");
              }}
              className="mt-4 block w-full text-center text-xs text-honey-300/75 underline underline-offset-4 hover:text-honey-300"
            >
              Use the legacy dashboard password instead
            </button>
          </>
        ) : (
          <form onSubmit={handleSignIn} className="mt-6 space-y-3">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email"
              autoComplete="email"
              className="w-full rounded-md border px-3 py-2.5 text-sm shadow-[0_1px_0_rgba(255,255,255,0.03)_inset]"
            />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              autoComplete="current-password"
              autoFocus
              className="w-full rounded-md border px-3 py-2.5 text-sm shadow-[0_1px_0_rgba(255,255,255,0.03)_inset]"
            />
            {error && <p className="rounded-md border border-red-400/20 bg-red-500/10 px-3 py-2 text-sm text-red-200">{error}</p>}
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-[0_0_0_1px_oklch(0.82_0.16_78/0.24),0_0_24px_-8px_oklch(0.82_0.16_78/0.5)] transition-colors hover:bg-honey-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Signing in..." : "Sign in"}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
