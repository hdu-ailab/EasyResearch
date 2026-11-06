import { useEffect, useMemo, useRef, useState } from "react";
import type { FileEntryDto } from "../../../../web/contracts";
import { listEntries } from "../../api";

/** One requested directory at a time; a late response never belongs to a newer query/owner. */
export function useComposerFiles(directory: string | null | undefined, query: string) {
  const generation = useRef(0);
  const [result, setResult] = useState<{
    directory: string;
    entries: FileEntryDto[];
    status: "loading" | "ready" | "error";
  }>();
  useEffect(() => {
    const current = ++generation.current;
    if (!directory) {
      setResult(undefined);
      return;
    }
    const controller = new AbortController();
    setResult({ directory, entries: [], status: "loading" });
    void listEntries(directory, controller.signal).then(
      (entries) => {
        if (!controller.signal.aborted && generation.current === current)
          setResult({ directory, entries, status: "ready" });
      },
      () => {
        if (!controller.signal.aborted && generation.current === current)
          setResult({ directory, entries: [], status: "error" });
      },
    );
    return () => controller.abort();
  }, [directory]);

  const entries = useMemo(
    () =>
      result && result.directory === directory
        ? result.entries
            .filter((entry) => entry.name.toLowerCase().includes(query))
            .sort(
              (a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name),
            )
            .slice(0, 100)
        : [],
    [result, directory, query],
  );
  return { entries, status: directory ? (result?.directory === directory ? result.status : "loading") : "ready" };
}
