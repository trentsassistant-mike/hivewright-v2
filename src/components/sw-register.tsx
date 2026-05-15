"use client";
import { useEffect } from "react";

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    if (process.env.NODE_ENV === "production") {
      navigator.serviceWorker.register("/sw.js").catch(console.error);
      return;
    }

    // Dev runs Next with Turbopack and Serwist is disabled, but browsers can keep
    // an old production service worker installed. That stale worker can intercept
    // /api polling/SSE requests and make the dashboard look frozen until reload.
    navigator.serviceWorker.getRegistrations()
      .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
      .catch(console.error);
  }, []);
  return null;
}
