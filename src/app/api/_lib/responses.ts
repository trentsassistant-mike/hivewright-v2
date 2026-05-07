import { NextResponse } from "next/server";

export function jsonOk<T>(data: T, status = 200): NextResponse {
  return NextResponse.json({ data }, { status });
}

export function jsonError(error: string, status = 400): NextResponse {
  return NextResponse.json({ error }, { status });
}

export function jsonPaginated<T>(
  data: T[],
  total: number,
  limit: number,
  offset: number,
): NextResponse {
  return NextResponse.json({ data, total, limit, offset }, { status: 200 });
}

export function parseSearchParams(url: string) {
  const { searchParams } = new URL(url);
  return {
    get: (key: string) => searchParams.get(key),
    getInt: (
      key: string,
      defaultVal: number,
      options: { min?: number; max?: number } = {},
    ) => {
      const val = searchParams.get(key);
      const parsed = val ? parseInt(val, 10) : defaultVal;
      const fallback = Number.isFinite(defaultVal) ? defaultVal : 50;
      const min = options.min ?? (key === "limit" ? 1 : 0);
      const max = options.max ?? 200;
      const normalized = Number.isFinite(parsed) ? parsed : fallback;
      return Math.min(Math.max(normalized, min), max);
    },
  };
}
