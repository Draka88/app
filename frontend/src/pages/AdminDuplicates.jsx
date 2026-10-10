import { useEffect, useState, useCallback } from "react";
import { api, formatApiError } from "../lib/api";
import Layout from "../components/Layout";
import { toast } from "sonner";

function fmtDateTime(iso) {
  return iso ? new Date(iso).toLocaleString() : "—";
}

export default function AdminDuplicates() {
  const [rows, setRows] = useState([]);
  const [onlyUnreviewed, setOnlyUnreviewed] = useState(true);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/scans/duplicates?only_unreviewed=${onlyUnreviewed}`);
      setRows(data || []);
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    } finally { setLoading(false); }
  }, [onlyUnreviewed]);

  useEffect(() => { load(); }, [load]);

  const dismiss = async (dupId) => {
    try {
      await api.post(`/scans/duplicates/${dupId}/dismiss`);
      toast.success("Marked as reviewed");
      load();
    } catch (e) { toast.error(formatApiError(e.response?.data?.detail)); }
  };

  const deleteOriginal = async (row) => {
    const reason = window.prompt(
      `Delete the original scan for ${row.worker_name} at ${new Date(row.original_scan_at).toLocaleString()}?\nReason (optional):`,
      "duplicate-rejected"
    );
    if (reason === null) return;
    try {
      await api.delete(`/scans/${row.original_scan_id}${reason ? `?reason=${encodeURIComponent(reason)}` : ""}`);
      await api.post(`/scans/duplicates/${row.id}/dismiss`); // close the review ticket
      toast.success("Original scan removed · duplicate dismissed");
      load();
    } catch (e) { toast.error(formatApiError(e.response?.data?.detail)); }
  };

  return (
    <Layout>
      <div className="mb-6">
        <div className="inline-block bg-yellow-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-zinc-950 mb-2">
          Admin · Duplicate scans
        </div>
        <h1 className="font-heading text-5xl md:text-6xl leading-none">Review Queue</h1>
        <p className="text-zinc-500 mt-2 text-sm max-w-2xl">
          Scans where the same supervisor hit the same worker inside the 10-second window.
          The second scan is <b>rejected automatically</b>; use this page to dismiss or remove the earlier one if that was the mistake.
        </p>
      </div>

      <div className="card-sharp p-4 mb-6 flex items-center gap-4 flex-wrap" data-testid="dup-controls">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={onlyUnreviewed}
            onChange={(e) => setOnlyUnreviewed(e.target.checked)}
            data-testid="only-unreviewed-toggle"
          />
          Only show unreviewed
        </label>
        <button onClick={load} className="btn-outline-ink px-3 py-2 text-xs ml-auto" data-testid="refresh-btn">↻ Refresh</button>
      </div>

      <div className="card-sharp p-5">
        <div className="overflow-x-auto border border-zinc-200">
          <table className="w-full text-sm zebra" data-testid="duplicates-table">
            <thead className="bg-zinc-950 text-white">
              <tr>
                <th className="text-left px-3 py-2 font-heading text-xs">When</th>
                <th className="text-left px-3 py-2 font-heading text-xs">Worker</th>
                <th className="text-left px-3 py-2 font-heading text-xs">Supervisor</th>
                <th className="text-right px-3 py-2 font-heading text-xs">Gap</th>
                <th className="text-left px-3 py-2 font-heading text-xs">Original scan</th>
                <th className="text-center px-3 py-2 font-heading text-xs">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={7} className="px-3 py-6 text-center text-zinc-500 text-xs">Loading…</td></tr>
              )}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-10 text-center text-zinc-500">No duplicate scans. ✓</td></tr>
              )}
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-zinc-100" data-testid={`dup-row-${r.id}`}>
                  <td className="px-3 py-2 font-mono-data text-xs whitespace-nowrap">{fmtDateTime(r.attempt_at)}</td>
                  <td className="px-3 py-2">
                    <div className="font-heading">{r.worker_name}</div>
                    {r.worker_employee_id && <div className="text-[10px] font-mono-data text-zinc-500">{r.worker_employee_id}</div>}
                  </td>
                  <td className="px-3 py-2 text-xs text-zinc-700">{r.supervisor_name}</td>
                  <td className="px-3 py-2 text-right font-mono-data text-xs">{r.gap_seconds}s</td>
                  <td className="px-3 py-2 text-xs">
                    <div className="font-mono-data text-[11px]">{fmtDateTime(r.original_scan_at)}</div>
                    {r.original_scan_exists ? (
                      <span className="inline-block mt-0.5 px-1.5 py-0.5 text-[9px] uppercase tracking-widest bg-zinc-200 text-zinc-700 font-bold">exists</span>
                    ) : (
                      <span className="inline-block mt-0.5 px-1.5 py-0.5 text-[9px] uppercase tracking-widest bg-red-100 text-red-700 font-bold">deleted</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {r.reviewed_at ? (
                      <span className="inline-block px-1.5 py-0.5 text-[10px] uppercase tracking-widest bg-zinc-200 text-zinc-700 font-bold">reviewed</span>
                    ) : (
                      <span className="inline-block px-1.5 py-0.5 text-[10px] uppercase tracking-widest bg-yellow-500 text-zinc-950 font-bold">pending</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {!r.reviewed_at && (
                      <>
                        {r.original_scan_exists && (
                          <button onClick={() => deleteOriginal(r)} className="text-xs text-red-600 hover:underline mr-3" data-testid={`del-${r.id}`}>
                            Delete original
                          </button>
                        )}
                        <button onClick={() => dismiss(r.id)} className="text-xs text-zinc-700 hover:underline" data-testid={`dismiss-${r.id}`}>
                          Dismiss
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  );
}
