import { useEffect, useState } from "react";
import { listStatus } from "../api";
import type { StatusDto } from "../../../web/contracts";

export function HomePage({ onOpenSession }: { onOpenSession: (cwd: string) => void }) {
  const [status, setStatus] = useState<StatusDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listStatus().then(setStatus).catch((e) => setError(String(e)));
  }, []);

  return (
    <div>
      <h1>LazyResearch</h1>
      <p>
        Agent dir: {status?.agentDir ?? "…"}
      </p>
      {error && <p style={{ color: "red" }}>{error}</p>}
      <h2>Sessions</h2>
      {!status ? (
        <p>Loading…</p>
      ) : status.sessions.length === 0 ? (
        <p>No sessions yet. Run <code>lazyresearch</code> in a project folder to start one.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Project</th>
              <th>Messages</th>
              <th>Modified</th>
            </tr>
          </thead>
          <tbody>
            {status.sessions.map((s) => (
              <tr key={s.id}>
                <td>
                  <a href="#" onClick={(e) => { e.preventDefault(); onOpenSession(s.cwd); }}>
                    {s.name || s.id.slice(0, 8)}
                  </a>
                </td>
                <td>{s.cwd}</td>
                <td>{s.messageCount}</td>
                <td>{new Date(s.modified).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
