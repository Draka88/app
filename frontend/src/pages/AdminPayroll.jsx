import { useEffect, useMemo, useState, useCallback } from "react";
import { api, API, formatApiError } from "../lib/api";
import { fmtAUD, fmtInt, isoWeekKey, weekLabel } from "../lib/format";
import Layout from "../components/Layout";
import { toast } from "sonner";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  LabelList,
} from "recharts";

const ALL = "__all__";
const UNASSIGNED = "__unassigned__";

export default function AdminPayroll() {
  const [rate, setRate] = useState(0);
  const [weeks, setWeeks] = useState([]);
  const [week, setWeek] = useState(isoWeekKey());
  const [payroll, setPayroll] = useState(null);
  const [roleFilter, setRoleFilter] = useState(ALL);
  const [recentScans, setRecentScans] = useState([]);

  const load = useCallback(async () => {
    try {
      const [r, w, p] = await Promise.all([
        api.get("/settings/rate"),
        api.get("/weeks"),
        api.get(`/summary/weekly?week=${week}`),
      ]);
      setRate(r.data.rate);
      setWeeks(w.data.weeks);
      setPayroll(p.data);
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    }
  }, [week]);

  useEffect(() => {
    load();
  }, [load]);

  // Live scan feed: poll every 4s
  useEffect(() => {
    let stop = false;
    const pull = async () => {
      try {
        const { data } = await api.get("/scans/recent?limit=15");
        if (!stop) {
          setRecentScans((prev) => {
            // Only refresh payroll totals when a NEW scan arrives (first id changed)
            if (prev.length > 0 && data.length > 0 && prev[0].id !== data[0].id) {
              load();
            }
            return data;
          });
        }
      } catch {}
    };
    pull();
    const t = setInterval(pull, 4000);
    return () => { stop = true; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [week]);

  // Distinct roles in the current payroll set
  const roles = useMemo(() => {
    const s = new Set();
    let hasUnassigned = false;
    (payroll?.rows || []).forEach((r) => {
      if (r.job_role) s.add(r.job_role);
      else hasUnassigned = true;
    });
    return { list: Array.from(s).sort(), hasUnassigned };
  }, [payroll]);

  const filteredRows = useMemo(() => {
    const rows = payroll?.rows || [];
    if (roleFilter === ALL) return rows;
    if (roleFilter === UNASSIGNED) return rows.filter((r) => !r.job_role);
    return rows.filter((r) => r.job_role === roleFilter);
  }, [payroll, roleFilter]);

  const totals = useMemo(() => {
    const boxes = filteredRows.reduce((a, r) => a + (r.boxes || 0), 0);
    const earnings = filteredRows.reduce((a, r) => a + (r.earnings || 0), 0);
    return { boxes, earnings, workers: filteredRows.length };
  }, [filteredRows]);

  const downloadPayslip = (workerId, name) => {
    const url = `${API}/payslip/${workerId}?week=${week}`;
    fetch(url, {
      credentials: "include",
      headers: { Authorization: `Bearer ${localStorage.getItem("bw_token") || ""}` },
    })
      .then((r) => r.blob())
      .then((blob) => {
        const a = document.createElement("a");
        const objUrl = URL.createObjectURL(blob);
        a.href = objUrl;
        a.download = `payslip_${name.replace(/\s+/g, "_")}_${week}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(objUrl);
      })
      .catch(() => toast.error("Failed to download"));
  };

  const filterActive = roleFilter !== ALL;

  const exportCSV = () => {
    if (!filteredRows.length) {
      toast.error("Nothing to export");
      return;
    }
    const esc = (v) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ["Worker", "Role", "Email", "Boxes", "Rate (AUD)", "Earnings (AUD)"];
    const lines = [header.join(",")];
    filteredRows.forEach((r) => {
      lines.push([
        esc(r.name),
        esc(r.job_role || ""),
        esc(r.email),
        r.boxes,
        rate.toFixed(2),
        r.earnings.toFixed(2),
      ].join(","));
    });
    lines.push([
      esc(filterActive ? `${roleFilter === UNASSIGNED ? "Unassigned" : roleFilter} Subtotal` : "Total"),
      "",
      "",
      totals.boxes,
      rate.toFixed(2),
      totals.earnings.toFixed(2),
    ].join(","));
    const meta = [
      `# Boxwise Payroll · Week ${week} (${payroll?.week_start} to ${payroll?.week_end})`,
      `# Filter: ${filterActive ? (roleFilter === UNASSIGNED ? "Unassigned" : roleFilter) : "All roles"}`,
      `# Rate per box (AUD): ${rate.toFixed(2)}`,
      "",
    ].join("\n");
    const blob = new Blob([meta + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    const objUrl = URL.createObjectURL(blob);
    const scope = filterActive
      ? `_${(roleFilter === UNASSIGNED ? "unassigned" : roleFilter).toLowerCase().replace(/\s+/g, "-")}`
      : "";
    a.href = objUrl;
    a.download = `payroll_${week}${scope}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objUrl);
    toast.success("CSV downloaded");
  };

  const chartData = useMemo(
    () =>
      filteredRows
        .filter((r) => r.boxes > 0)
        .map((r) => ({
          name: r.name,
          role: r.job_role || "Unassigned",
          boxes: r.boxes,
          earnings: r.earnings,
        })),
    [filteredRows]
  );

  return (
    <Layout>
      <div className="flex items-end justify-between mb-8 gap-4 flex-wrap">
        <div>
          <div className="inline-block bg-yellow-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-zinc-950 mb-2">
            Admin · Payroll
          </div>
          <h1 className="font-heading text-5xl md:text-6xl leading-none">Weekly Payroll</h1>
          <p className="text-zinc-500 mt-2">
            Auto-computed from reported boxes × the global rate per box.
          </p>
        </div>
        <div className="flex gap-3 items-end flex-wrap">
          <div>
            <label className="block font-heading text-xs mb-1 text-zinc-700">Role</label>
            <select
              className="input-sharp min-w-[180px]"
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value)}
              data-testid="role-filter"
            >
              <option value={ALL}>All roles</option>
              {roles.list.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
              {roles.hasUnassigned && <option value={UNASSIGNED}>Unassigned</option>}
            </select>
          </div>
          <div>
            <label className="block font-heading text-xs mb-1 text-zinc-700">Week</label>
            <select
              className="input-sharp min-w-[180px]"
              value={week}
              onChange={(e) => setWeek(e.target.value)}
              data-testid="admin-week-selector"
            >
              {weeks.map((w) => (
                <option key={w} value={w}>{weekLabel(w)}</option>
              ))}
            </select>
          </div>
          <button
            onClick={exportCSV}
            className="btn-outline-ink px-4 py-[10px] text-xs h-[42px]"
            data-testid="export-csv-button"
            title="Download filtered payroll as CSV"
          >
            ↓ CSV
          </button>
          <button
            onClick={() => {
              fetch(`${API}/payroll/xlsx?period=week&key=${week}`, {
                credentials: "include",
                headers: { Authorization: `Bearer ${localStorage.getItem("bw_token") || ""}` },
              })
                .then((r) => { if (!r.ok) throw new Error("dl"); return r.blob(); })
                .then((blob) => {
                  const a = document.createElement("a");
                  const url = URL.createObjectURL(blob);
                  a.href = url; a.download = `payroll_${week}.xlsx`;
                  document.body.appendChild(a); a.click(); a.remove();
                  URL.revokeObjectURL(url);
                })
                .catch(() => toast.error("Excel download failed"));
            }}
            className="btn-outline-ink px-4 py-[10px] text-xs h-[42px]"
            data-testid="export-xlsx-button"
            title="Download payroll as Excel"
          >
            ↓ Excel
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 mb-4">
        <Kpi label="Rate / Box" value={fmtAUD(rate)} testid="kpi-rate" mono />
        <Kpi
          label={filterActive ? "Boxes (Filtered)" : "Total Boxes"}
          value={fmtInt(totals.boxes)}
          testid="kpi-total-boxes"
        />
        <Kpi
          label={filterActive ? "Workers (Filtered)" : "Workers"}
          value={fmtInt(totals.workers)}
          testid="kpi-workers"
        />
        <Kpi
          label={filterActive ? "Earnings (Filtered)" : "Payroll Total"}
          value={fmtAUD(totals.earnings)}
          testid="kpi-total-earnings"
          accent
        />
      </div>

      {filterActive && (
        <div
          className="mb-6 flex items-center gap-3 border-l-4 border-yellow-500 bg-white px-4 py-2 text-sm"
          data-testid="filter-active-banner"
        >
          <span className="font-heading tracking-widest text-xs text-zinc-500">Filter</span>
          <span className="font-bold">
            {roleFilter === UNASSIGNED ? "Unassigned" : roleFilter}
          </span>
          <span className="text-zinc-500">·</span>
          <span className="font-mono-data text-zinc-700">
            {totals.workers} {totals.workers === 1 ? "worker" : "workers"} · {fmtInt(totals.boxes)} boxes · {fmtAUD(totals.earnings)}
          </span>
          <button
            onClick={() => setRoleFilter(ALL)}
            className="ml-auto text-xs uppercase tracking-widest text-zinc-950 hover:underline"
            data-testid="clear-role-filter"
          >
            Clear ×
          </button>
        </div>
      )}

      <div className="card-sharp p-5 mb-6" data-testid="live-feed">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-500 opacity-75"></span>
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-green-600"></span>
            </span>
            <h2 className="font-heading text-xl">Live Scan Feed</h2>
            <span className="text-xs text-zinc-500">updates every 4s</span>
          </div>
          <span className="text-xs text-zinc-500 font-mono-data">{recentScans.length} recent</span>
        </div>
        {recentScans.length === 0 ? (
          <div className="border border-dashed border-zinc-300 py-6 text-center text-zinc-500 text-xs">
            Waiting for the next barcode scan…
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 max-h-[240px] overflow-y-auto pr-1">
            {recentScans.map((s) => (
              <div key={s.id} className={`border p-2 flex items-center gap-3 ${s.suspicious ? "border-red-600 bg-red-50" : "border-zinc-200 bg-white"}`} data-testid={`live-${s.id}`}>
                <div className={`h-8 w-8 grid place-items-center font-heading text-sm shrink-0 ${s.suspicious ? "bg-red-600 text-white" : "bg-yellow-500 text-zinc-950"}`}>
                  {s.suspicious ? "!" : "+1"}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-heading text-sm truncate flex items-center gap-1">
                    {s.worker_name}
                    {s.suspicious && (
                      <span className="text-[9px] uppercase tracking-widest bg-red-600 text-white px-1 py-0.5 font-bold" title={s.suspicious_reason || "flagged"}>
                        Suspicious
                      </span>
                    )}
                  </div>
                  <div className="font-mono-data text-[10px] text-zinc-500 truncate">{s.barcode}</div>
                </div>
                <div className="font-mono-data text-[10px] text-zinc-500 whitespace-nowrap">
                  {new Date(s.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card-sharp p-6 mb-6" data-testid="chart-card">
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <div>
            <h2 className="font-heading text-2xl">Boxes per worker</h2>
            <p className="text-xs text-zinc-500">
              {filterActive
                ? `Filtered · ${roleFilter === UNASSIGNED ? "Unassigned" : roleFilter}`
                : "Ranked by boxes processed this week"}
            </p>
          </div>
          {chartData.length > 0 && (
            <div className="font-mono-data text-xs text-zinc-600">
              Top:{" "}
              <span className="font-bold text-zinc-950">
                {chartData.slice().sort((a, b) => b.boxes - a.boxes)[0].name}
              </span>{" "}
              · {fmtInt(chartData.slice().sort((a, b) => b.boxes - a.boxes)[0].boxes)} boxes
            </div>
          )}
        </div>
        {chartData.length === 0 ? (
          <div className="py-14 text-center text-zinc-500 text-sm border border-dashed border-zinc-300">
            No boxes reported yet for this view.
          </div>
        ) : (
          <div className="w-full" style={{ height: 260 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={chartData.slice().sort((a, b) => b.boxes - a.boxes)}
                margin={{ top: 20, right: 20, left: 0, bottom: 10 }}
              >
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 11, fill: "#09090b", fontFamily: "IBM Plex Mono" }}
                  axisLine={{ stroke: "#09090b" }}
                  tickLine={{ stroke: "#09090b" }}
                  interval={0}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "#71717a", fontFamily: "IBM Plex Mono" }}
                  axisLine={{ stroke: "#09090b" }}
                  tickLine={{ stroke: "#09090b" }}
                  allowDecimals={false}
                />
                <Tooltip
                  cursor={{ fill: "rgba(234,179,8,0.15)" }}
                  contentStyle={{
                    background: "#09090b",
                    border: "none",
                    borderRadius: 0,
                    color: "#fff",
                    fontFamily: "IBM Plex Mono",
                    fontSize: 12,
                  }}
                  labelStyle={{ color: "#eab308", fontWeight: 700 }}
                  formatter={(v, k) =>
                    k === "boxes" ? [fmtInt(v), "Boxes"] : [fmtAUD(v), "Earnings"]
                  }
                />
                <Bar dataKey="boxes" fill="#eab308" isAnimationActive={false}>
                  {chartData
                    .slice()
                    .sort((a, b) => b.boxes - a.boxes)
                    .map((_, i) => (
                      <Cell key={i} fill={i === 0 ? "#09090b" : "#eab308"} />
                    ))}
                  <LabelList
                    dataKey="boxes"
                    position="top"
                    style={{
                      fill: "#09090b",
                      fontFamily: "IBM Plex Mono",
                      fontSize: 12,
                      fontWeight: 700,
                    }}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <div className="card-sharp p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="font-heading text-2xl">Roster · {week}</h2>
            <p className="text-xs text-zinc-500">
              {payroll?.week_start} → {payroll?.week_end}
            </p>
          </div>
        </div>

        <div className="overflow-x-auto border border-zinc-200">
          <table className="w-full text-sm zebra" data-testid="payroll-table">
            <thead className="bg-zinc-950 text-white">
              <tr>
                <th className="text-left px-3 py-2 font-heading text-xs">Worker</th>
                <th className="text-left px-3 py-2 font-heading text-xs">Role</th>
                <th className="text-left px-3 py-2 font-heading text-xs">Email</th>
                <th className="text-right px-3 py-2 font-heading text-xs">Boxes</th>
                <th className="text-right px-3 py-2 font-heading text-xs">Rate</th>
                <th className="text-right px-3 py-2 font-heading text-xs">Earnings</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-10 text-center text-zinc-500">
                    {filterActive
                      ? `No workers match "${roleFilter === UNASSIGNED ? "Unassigned" : roleFilter}" this week.`
                      : "No workers yet. Add workers under the Workers tab."}
                  </td>
                </tr>
              )}
              {filteredRows.map((r) => (
                <tr key={r.worker_id} className="border-t border-zinc-100" data-testid={`payroll-row-${r.worker_id}`}>
                  <td className="px-3 py-2 font-heading text-base">{r.name}</td>
                  <td className="px-3 py-2">
                    {r.job_role ? (
                      <button
                        onClick={() => setRoleFilter(r.job_role)}
                        className="inline-block border border-zinc-900 px-2 py-0.5 text-[10px] uppercase tracking-widest font-bold hover:bg-zinc-950 hover:text-white transition-colors duration-150"
                        title={`Filter by ${r.job_role}`}
                        data-testid={`role-pill-${r.worker_id}`}
                      >
                        {r.job_role}
                      </button>
                    ) : (
                      <span className="text-zinc-400 text-xs italic">unassigned</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-zinc-600">{r.email}</td>
                  <td className="px-3 py-2 text-right font-mono-data font-semibold">{fmtInt(r.boxes)}</td>
                  <td className="px-3 py-2 text-right font-mono-data">{fmtAUD(rate)}</td>
                  <td className="px-3 py-2 text-right font-mono-data font-bold">{fmtAUD(r.earnings)}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => downloadPayslip(r.worker_id, r.name)}
                      className="btn-outline-ink px-3 py-1.5 text-xs"
                      data-testid={`download-payslip-${r.worker_id}`}
                    >
                      ↓ Payslip
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            {filteredRows.length > 0 && (
              <tfoot>
                <tr className="bg-zinc-100 border-t-2 border-zinc-900">
                  <td className="px-3 py-2 font-heading" colSpan={3}>
                    {filterActive ? `${roleFilter === UNASSIGNED ? "Unassigned" : roleFilter} · Subtotal` : "Total"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono-data font-bold">{fmtInt(totals.boxes)}</td>
                  <td className="px-3 py-2 text-right font-mono-data">{fmtAUD(rate)}</td>
                  <td className="px-3 py-2 text-right font-mono-data font-bold">{fmtAUD(totals.earnings)}</td>
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

function Kpi({ label, value, testid, accent, mono }) {
  return (
    <div
      className={`card-sharp p-6 ${accent ? "bg-yellow-500 border-yellow-500" : ""}`}
      data-testid={testid}
    >
      <div className={`font-heading text-xs tracking-widest ${accent ? "text-zinc-900" : "text-zinc-500"}`}>
        {label}
      </div>
      <div className={`mt-3 font-heading text-4xl leading-none ${mono ? "font-mono-data" : ""}`}>
        {value}
      </div>
    </div>
  );
}
