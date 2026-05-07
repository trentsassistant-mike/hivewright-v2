"use client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

interface Hive {
  id: string;
  slug: string;
  name: string;
  type: string;
}

interface HiveContextValue {
  hives: Hive[];
  selected: Hive | null;
  selectHive: (id: string) => void;
  loading: boolean;
}

const HiveContext = createContext<HiveContextValue>({
  hives: [],
  selected: null,
  selectHive: () => {},
  loading: true,
});

export function useHiveContext() {
  return useContext(HiveContext);
}

export function HiveProvider({ children }: { children: ReactNode }) {
  const [hives, setHives] = useState<Hive[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/hives")
      .then((r) => r.json())
      .then((body) => {
        const list = body.data || [];
        setHives(list);
        // Restore from localStorage or pick first
        const stored = localStorage.getItem("selectedHiveId");
        const match = list.find((b: Hive) => b.id === stored);
        if (match) setSelectedId(match.id);
        else if (list.length > 0) setSelectedId(list[0].id);
      })
      .finally(() => setLoading(false));
  }, []);

  const selectHive = (id: string) => {
    setSelectedId(id);
    localStorage.setItem("selectedHiveId", id);
  };

  const selected = hives.find((b) => b.id === selectedId) || null;

  return (
    <HiveContext.Provider value={{ hives, selected, selectHive, loading }}>
      {children}
    </HiveContext.Provider>
  );
}
