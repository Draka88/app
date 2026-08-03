import { useEffect, useState, useCallback } from "react";
import { api, API, formatApiError } from "../lib/api";
import { fmtAUD, fmtInt, isoWeekKey, todayISO, weekLabel } from "../lib/format";
import Layout from "../components/Layout";
import { toast } from "sonner";

function monthKeyNow() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default function AdminReports() {
  const [period, setPeriod] = useState("day");
  const [key, setKey] = useState(todayISO());
  const [data, setData] = useState(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get(`/summary/period?period=${period}&key=${key}`);
      setData(data);
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    }
  }, [period, key]);

  useEffect(() => { load(); }, [load]);

  const setPeriodAndKey = (p) => {
    setPeriod(p);
    if (p === "day") setKey(todayISO());
    else if (p === "week") setKey(isoWeekKey());
    else setKey(monthKeyNow());
  };

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

  const inputType = period === "day" ? "date" : "text";
  const inputPlaceholder = period === "week" ? "W2026-08-05" : period === "month" ? "2026-08" : "";

  return (
    <Layout>
      <div className="mb-6">
        <div className="inline-block bg-yellow-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-zinc-950 mb-2">
          Admin · Reports
        </div>
        <h1 className="font-heading text-5xl md:text-6xl leading-none">Production Reports</h1>
        <p className="text-zinc-500 mt-2">
          Daily, weekly and monthly output per worker. Includes scan counts, manual entries, and payroll.
        </p>
      </div>

      <div className="card-sharp p-5 mb-6 flex flex-wrap items-end gap-4">
        <div className="flex" data-testid="period-toggle">
          {["day", "week", "month"].map((p) => (
            <button
              key={p}
              onClick={() => setPeriodAndKey(p)}
              className={`px-4 py-2 text-xs font-heading tracking-widest border-2 border-r-0 last:border-r-2 ${period === p ? "bg-zinc-950 text-white border-zinc-950" : "bg-white border-zinc-300 text-zinc-700 hover:border-zinc-950"}`}
              data-testid={`period-${p}`}
            >
              {p.toUpperCase()}
            </button>
          ))}
        </div>
        <div>
          <label className="block font-heading text-xs mb-1 text-zinc-700">
            {period === "day" ? "Date" : period === "week" ? "Payroll week (Wed → Tue)" : "Month"}
          </label>
          <input
            type={inputType}
            value={key}
            placeholder={inputPlaceholder}
            onChange={(e) => setKey(e.target.value)}
            className="input-sharp font-mono-data min-w-[180px]"
            data-testid="period-key-input"
          />
          {period === "week" && key && key.startsWith("W") && (
            <div className="text-[10px] uppercase tracking-widest text-zinc-500 mt-1">{weekLabel(key)}</div>
          )}
        </div>
        <div className="ml-auto flex gap-2">
          <button
            onClick={() => download(`/payroll/xlsx?period=${period}&key=${key}`, `payroll_${key}.xlsx`)}
            className="btn-outline-ink px-4 py-2 text-xs"
            data-testid="reports-xlsx"
          >
            ↓ Excel
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Kpi label="Total Boxes" value={fmtInt(data?.total_boxes || 0)} testid="rk-boxes" />
        <Kpi label="Scans" value={fmtInt(data?.total_scans || 0)} testid="rk-scans" />
        <Kpi label="Workers" value={fmtInt(data?.rows?.length || 0)} testid="rk-workers" />
        <Kpi label="Payroll" value={fmtAUD(data?.total_earnings || 0)} testid="rk-earnings" accent />
      </div>

      <div className="card-sharp p-5">
        <h2 className="font-heading text-2xl mb-4">Per Worker · {period.toUpperCase()} · {data?.key}</h2>
        <div className="overflow-x-auto border border-zinc-200">
          <table className="w-full text-sm zebra" data-testid="reports-table">
            <thead className="bg-zinc-950 text-white">
              <tr>
                <th className="text-left px-3 py-2 font-heading text-xs">Worker</th>
                <th className="text-left px-3 py-2 font-heading text-xs">Role</th>
                <th className="text-right px-3 py-2 font-heading text-xs">Scans</th>
                <th className="text-right px-3 py-2 font-heading text-xs">Manual</th>
                <th className="text-right px-3 py-2 font-heading text-xs">Total Boxes</th>
                <th className="text-right px-3 py-2 font-heading text-xs">Earnings</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {(!data || data.rows.length === 0) && (
                <tr><td colSpan={7} className="px-3 py-10 text-center text-zinc-500">No data for this period.</td></tr>
              )}
              {data?.rows.map((r) => (
                <tr key={r.worker_id} className="border-t border-zinc-100" data-testid={`row-${r.worker_id}`}>
                  <td className="px-3 py-2 font-heading text-base">{r.name}</td>
                  <td className="px-3 py-2">
                    {r.job_role ? (
                      <span className="inline-block border border-zinc-900 px-2 py-0.5 text-[10px] uppercase tracking-widest font-bold">{r.job_role}</span>
                    ) : <span className="text-zinc-400 text-xs italic">unassigned</span>}
                  </td>
                  <td className="px-3 py-2 text-right font-mono-data">{fmtInt(r.scans)}</td>
                  <td className="px-3 py-2 text-right font-mono-data text-zinc-500">{fmtInt(r.manual)}</td>
                  <td className="px-3 py-2 text-right font-mono-data font-bold">{fmtInt(r.boxes)}</td>
                  <td className="px-3 py-2 text-right font-mono-data font-bold">{fmtAUD(r.earnings)}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap space-x-2">
                    <button
                      onClick={() => download(`/payslip/${r.worker_id}?week=${period === "week" ? key : isoWeekKey()}`, `payslip_${r.name.replace(/\s+/g,'_')}.pdf`)}
                      className="text-xs text-zinc-700 hover:underline"
                      data-testid={`pdf-${r.worker_id}`}
                    >
                      PDF
                    </button>
                    <button
                      onClick={() => download(`/payslip/${r.worker_id}/xlsx?week=${period === "week" ? key : isoWeekKey()}`, `payslip_${r.name.replace(/\s+/g,'_')}.xlsx`)}
                      className="text-xs text-zinc-700 hover:underline"
                      data-testid={`xlsx-${r.worker_id}`}
                    >
                      Excel
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            {data && data.rows.length > 0 && (
              <tfoot>
                <tr className="bg-zinc-100 border-t-2 border-zinc-900">
                  <td className="px-3 py-2 font-heading" colSpan={2}>Total</td>
                  <td className="px-3 py-2 text-right font-mono-data font-bold">{fmtInt(data.total_scans)}</td>
                  <td className="px-3 py-2 text-right font-mono-data">{fmtInt(data.total_boxes - data.total_scans)}</td>
                  <td className="px-3 py-2 text-right font-mono-data font-bold">{fmtInt(data.total_boxes)}</td>
                  <td className="px-3 py-2 text-right font-mono-data font-bold">{fmtAUD(data.total_earnings)}</td>
                  <td></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </Layout>
  );
}

function Kpi({ label, value, testid, accent }) {
  return (
    <div className={`card-sharp p-5 ${accent ? "bg-yellow-500 border-yellow-500" : ""}`} data-testid={testid}>
      <div className={`font-heading text-[10px] tracking-widest ${accent ? "text-zinc-900" : "text-zinc-500"}`}>{label}</div>
      <div className="mt-2 font-heading text-4xl leading-none">{value}</div>
    </div>
  );
}
