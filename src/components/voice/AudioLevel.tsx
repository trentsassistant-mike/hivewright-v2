"use client";
import { useEffect, useState } from "react";

export function AudioLevel({ stream }: { stream: MediaStream | null }) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!stream) return;
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    let raf = 0;
    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      const avg = buf.reduce((s, v) => s + Math.abs(v - 128), 0) / buf.length;
      setLevel(Math.min(1, avg / 40));
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      ctx.close();
    };
  }, [stream]);
  return (
    <div className="h-2 w-40 overflow-hidden rounded bg-gray-200">
      <div
        className="h-full bg-green-500 transition-all"
        style={{ width: `${level * 100}%` }}
      />
    </div>
  );
}
