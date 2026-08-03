import { useEffect, useState, useCallback } from "react";
import { api, API, formatApiError } from "../lib/api";
import Layout from "../components/Layout";
import { toast } from "sonner";

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function daysAgoISO(n) {
  const d = new Date(); d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fmtTime(iso) {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
}

export default function AdminAttendance() {
  const [fromDate, setFromDate] = useState(daysAgoISO(6));
  const [toDate, setToDate] = useState(todayISO());
  const [rows, setRows] = useState([]);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get(`/attendance?from_date=${fromDate}&to_date=${toDate}`);
      setRows(data || []);
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    }
  }, [fromDate, toDate]);

  useEffect(() => { load(); }, [load]);

  const download = (path, filename) => {
    fetch(`${API}${path}`, {
      credentials: "include",
      headers: { Authorization: `Bearer ${localStorage.getItem("bw_token") || ""}` },
    })
      .then((r) => { if (!r.ok) throw new Error("dl"); return r.blob(); })
      .then((blob) => {
        const a = document.createElement("a");
        const url = URL.createObjectURL(blob);
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
      })
      .catch(() => toast.error("Download failed"));
  };

  const totalHours = rows.reduce((s, r) => s + (Number(r.hours) || 0), 0).toFixed(2);
  const uniqueWorkers = new Set(rows.map((r) => r.worker_id)).size;

  return (
    <Layout>
      <div className="mb-6">
        <div className="inline-block bg-yellow-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-zinc-950 mb-2">
          Admin · Attendance
        </div>
        <h1 className="font-heading text-5xl md:text-6xl leading-none">Attendance History</h1>
        <p className="text-zinc-500 mt-2">
          Every shift is geo-verified: GPS coordinates and the assigned worksite are stamped on each clock-in/out.
        </p>
      </div>

      <div className="card-sharp p-5 mb-6 flex flex-wrap items-end gap-4">
        <div>
          <label className="block font-heading text-xs mb-1 text-zinc-700">From</label>
          <input
            type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)}
            className="input-sharp font-mono-data" data-testid="attn-from"
          />
        </div>
        <div>
          <label className="block font-heading text-xs mb-1 text-zinc-700">To</label>
          <input
            type="date" value={toDate} onChange={(e) => setToDate(e.target.value)}
            className="input-sharp font-mono-data" data-testid="attn-to"
          />
        </div>
        <div className="ml-auto flex gap-2">
          <button
            onClick={() => download(`/attendance/xlsx?from_date=${fromDate}&to_date=${toDate}`, `attendance_${fromDate}_${toDate}.xlsx`)}
            className="btn-outline-ink px-4 py-2 text-xs"
            data-testid="attn-xlsx"
          >↓ Excel</button>
          <button
            onClick={() => download(`/attendance/pdf?from_date=${fromDate}&to_date=${toDate}`, `attendance_${fromDate}_${toDate}.pdf`)}
            className="btn-outline-ink px-4 py-2 text-xs"
            data-testid="attn-pdf"
          >↓ PDF</button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Kpi label="Shifts" value={rows.length} testid="ak-shifts" />
        <Kpi label="Workers" value={uniqueWorkers} testid="ak-workers" />
        <Kpi label="Total Hours" value={totalHours} testid="ak-hours" accent />
        <Kpi label="Range" value={`${fromDate} → ${toDate}`} testid="ak-range" small />
      </div>

      <div className="card-sharp p-5">
        <div className="overflow-x-auto border border-zinc-200">
          <table className="w-full text-sm zebra" data-testid="attendance-table">
            <thead className="bg-zinc-950 text-white">
              <tr>
                <th className="text-left px-3 py-2 font-heading text-xs">Date</th>
                <th className="text-left px-3 py-2 font-heading text-xs">Worker</th>
                <th className="text-left px-3 py-2 font-heading text-xs">In</th>
                <th className="text-left px-3 py-2 font-heading text-xs">Out</th>
                <th className="text-right px-3 py-2 font-heading text-xs">Hours</th>
                <th className="text-left px-3 py-2 font-heading text-xs">Worksite</th>
                <th className="text-left px-3 py-2 font-heading text-xs">GPS (in)</th>
                <th className="text-right px-3 py-2 font-heading text-xs">Dist (m)</th>
                <th className="text-left px-3 py-2 font-heading text-xs">Supervisor</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={9} className="px-3 py-10 text-center text-zinc-500">No attendance in this range.</td></tr>
              )}
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-zinc-100" data-testid={`attn-row-${r.id}`}>
                  <td className="px-3 py-2 font-mono-data text-xs">{r.date}</td>
                  <td className="px-3 py-2 font-heading">{r.worker_name}</td>
                  <td className="px-3 py-2 font-mono-data text-xs">{fmtTime(r.clock_in)}</td>
                  <td className="px-3 py-2 font-mono-data text-xs">{r.clock_out ? fmtTime(r.clock_out) : <span className="text-yellow-700 font-bold">ACTIVE</span>}</td>
                  <td className="px-3 py-2 text-right font-mono-data font-bold">{r.hours ?? "—"}</td>
                  <td className="px-3 py-2 text-xs">{r.worksite_name || "—"}</td>
                  <td className="px-3 py-2 font-mono-data text-[10px] text-zinc-600">
                    {r.clock_in_lat != null ? `${Number(r.clock_in_lat).toFixed(5)}, ${Number(r.clock_in_lng).toFixed(5)}` : "—"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono-data text-xs">{r.clock_in_distance_m ?? "—"}</td>
                  <td className="px-3 py-2 text-xs text-zinc-600">{r.supervisor_name || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  );
}

function Kpi({ label, value, testid, accent, small }) {
  return (
    <div className={`card-sharp p-5 ${accent ? "bg-yellow-500 border-yellow-500" : ""}`} data-testid={testid}>
      <div className={`font-heading text-[10px] tracking-widest ${accent ? "text-zinc-900" : "text-zinc-500"}`}>{label}</div>
      <div className={`mt-2 font-heading ${small ? "text-base" : "text-4xl"} leading-none`}>{value}</div>
    </div>
  );
}
