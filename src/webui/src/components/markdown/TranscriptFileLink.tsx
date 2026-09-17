import { createContext, type ReactNode, useContext } from "react";

export const TranscriptFileContext = createContext<((reference: string) => void) | null>(null);

export function TranscriptFileLink({
  children,
  "data-file-path": path,
}: {
  children?: ReactNode;
  "data-file-path"?: string;
}) {
  const openFile = useContext(TranscriptFileContext);
  if (!openFile || !path) return <span>{children}</span>;
  return (
    <button
      type="button"
      className="er-file-reference cursor-pointer rounded-sm text-left text-inherit underline decoration-current/50 underline-offset-2 hover:decoration-current"
      title={path}
      onClick={() => openFile(path)}
    >
      {children}
    </button>
  );
}
