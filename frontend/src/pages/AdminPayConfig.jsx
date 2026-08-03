import { useEffect, useState, useCallback, useMemo } from "react";
import { api, formatApiError } from "../lib/api";
import { fmtAUD, fmtInt, isoWeekKey, weekLabel } from "../lib/format";
import Layout from "../components/Layout";
import { toast } from "sonner";

// Payroll week is Wed → Tue. Return 7 ISO dates starting on the Wednesday anchor.
const WEEKDAYS = ["Wed", "Thu", "Fri", "Sat", "Sun", "Mon", "Tue"];

function weekDates(wk) {
  if (!wk || !wk.startsWith("W")) return Array(7).fill("");
  const wed = new Date(wk.slice(1) + "T00:00:00");
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(wed); d.setDate(wed.getDate() + i);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  });
}

export default function AdminPayConfig() {
  const [week, setWeek] = useState(isoWeekKey());
  const [workers, setWorkers] = useState([]);
  const [configs, setConfigs] = useState({}); // {worker_id|date: config}
  const dates = useMemo(() => weekDates(week), [week]);

  const load = useCallback(async () => {
    try {
      const [ws, cfgs] = await Promise.all([
        api.get("/workers"),
        api.get(`/pay-configs?from_date=${dates[0]}&to_date=${dates[6]}`),
      ]);
      setWorkers(ws.data);
      const m = {};
      (cfgs.data || []).forEach((c) => { m[`${c.worker_id}|${c.date}`] = c; });
      setConfigs(m);
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    }
  }, [dates]);

  useEffect(() => { load(); }, [load]);

  const cellKey = (w, d) => `${w}|${d}`;
  const cellCfg = (w, d) => configs[cellKey(w, d)];
  const cellMethod = (w, d) => cellCfg(w, d)?.method || "piece";

  const updateCell = async (worker_id, dateStr, patch) => {
    const existing = cellCfg(worker_id, dateStr) || { method: "piece", hours: 0, hourly_rate: 0 };
    const body = {
      worker_id,
      date: dateStr,
      method: patch.method ?? existing.method,
      hours: patch.hours !== undefined ? patch.hours : (existing.hours || 0),
      hourly_rate: patch.hourly_rate !== undefined ? patch.hourly_rate : (existing.hourly_rate || 0),
    };
    try {
      const { data } = await api.put("/pay-configs", body);
      setConfigs((prev) => ({ ...prev, [cellKey(worker_id, dateStr)]: data }));
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    }
  };

  const bulkSet = async (worker_id, method) => {
    // Apply method to all 7 days for this worker
    await Promise.all(dates.map((d) => updateCell(worker_id, d, { method })));
    toast.success(`Set ${method.toUpperCase()} for the week`);
  };

  return (
    <Layout>
      <div className="mb-6">
        <div className="inline-block bg-yellow-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-zinc-950 mb-2">
          Admin · Payment Method
        </div>
        <h1 className="font-heading text-5xl md:text-6xl leading-none">Piece or Hourly</h1>
        <p className="text-zinc-500 mt-2">
          Pick each worker's payment method day-by-day. Piece-rate uses the global A${" "}rate × boxes; hourly uses hours × the worker's hourly rate.
          Historical payroll is untouched — changes only apply to the days you edit.
        </p>
      </div>

      <div className="flex items-end gap-3 mb-4 flex-wrap">
        <div>
          <label className="block font-heading text-xs mb-1 text-zinc-700">Payroll Week (Wed → Tue)</label>
          <input
            type="text"
            value={week}
            onChange={(e) => setWeek(e.target.value)}
            placeholder="W2026-08-05"
            className="input-sharp font-mono-data min-w-[180px]"
            data-testid="payconfig-week"
          />
          <div className="text-[11px] text-zinc-500 mt-1 font-mono-data">{weekLabel(week)}</div>
        </div>
        <div className="ml-auto text-xs text-zinc-600 flex items-center gap-4">
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 bg-zinc-950"></span> PIECE
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 bg-yellow-500 border border-zinc-950"></span> HOURLY
          </span>
        </div>
      </div>

      <div className="card-sharp p-4 overflow-x-auto" data-testid="payconfig-grid">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className="text-left p-2 font-heading text-xs bg-zinc-950 text-white sticky left-0 z-10">Worker</th>
              {dates.map((d, i) => (
                <th key={d} className="p-2 font-heading text-xs bg-zinc-950 text-white">
                  <div>{WEEKDAYS[i]}</div>
                  <div className="font-mono-data text-[9px] text-zinc-400">{d.slice(5)}</div>
                </th>
              ))}
              <th className="p-2 font-heading text-xs bg-zinc-950 text-white">Bulk</th>
            </tr>
          </thead>
          <tbody>
            {workers.length === 0 && (
              <tr><td colSpan={9} className="p-8 text-center text-zinc-500">No workers yet. Add them under the Workers tab.</td></tr>
            )}
            {workers.map((w) => (
              <tr key={w.id} className="border-t border-zinc-100" data-testid={`row-${w.id}`}>
                <td className="p-2 sticky left-0 bg-white z-10 min-w-[160px]">
                  <div className="font-heading text-sm">{w.name}</div>
                  {w.job_role && <div className="text-[10px] uppercase tracking-widest text-zinc-500">{w.job_role}</div>}
                </td>
                {dates.map((d) => (
                  <PayCell
                    key={d}
                    workerId={w.id}
                    dateStr={d}
                    cfg={cellCfg(w.id, d)}
                    onChange={(patch) => updateCell(w.id, d, patch)}
                  />
                ))}
                <td className="p-2 text-center whitespace-nowrap">
                  <button
                    onClick={() => bulkSet(w.id, "piece")}
                    className="text-[10px] uppercase tracking-widest text-zinc-700 hover:text-zinc-950 hover:underline mr-2"
                    data-testid={`bulk-piece-${w.id}`}
                  >
                    All piece
                  </button>
                  <button
                    onClick={() => bulkSet(w.id, "hourly")}
                    className="text-[10px] uppercase tracking-widest text-zinc-700 hover:text-zinc-950 hover:underline"
                    data-testid={`bulk-hourly-${w.id}`}
                  >
                    All hourly
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 text-xs text-zinc-500">
        <b>PIECE</b> uses total boxes × the global rate (set on the Rate page).
        <b className="ml-3">HOURLY</b> uses hours × per-worker hourly rate stored for that specific day.
      </div>
    </Layout>
  );
}

function PayCell({ workerId, dateStr, cfg, onChange }) {
  const method = cfg?.method || "piece";
  const [hours, setHours] = useState(cfg?.hours || 0);
  const [hourly, setHourly] = useState(cfg?.hourly_rate || 0);

  useEffect(() => {
    setHours(cfg?.hours || 0);
    setHourly(cfg?.hourly_rate || 0);
  }, [cfg?.hours, cfg?.hourly_rate]);

  const isHourly = method === "hourly";
  const bg = isHourly ? "bg-yellow-50" : "bg-white";

  return (
    <td className={`p-1 border border-zinc-200 align-top min-w-[140px] ${bg}`} data-testid={`cell-${workerId}-${dateStr}`}>
      <div className="flex gap-1 mb-1">
        <button
          onClick={() => onChange({ method: "piece" })}
          className={`flex-1 text-[10px] font-heading tracking-widest px-1 py-1 border ${method === "piece" ? "bg-zinc-950 text-white border-zinc-950" : "bg-white border-zinc-300 text-zinc-500 hover:border-zinc-950"}`}
          data-testid={`m-piece-${workerId}-${dateStr}`}
        >PIECE</button>
        <button
          onClick={() => onChange({ method: "hourly" })}
          className={`flex-1 text-[10px] font-heading tracking-widest px-1 py-1 border ${method === "hourly" ? "bg-yellow-500 text-zinc-950 border-yellow-500" : "bg-white border-zinc-300 text-zinc-500 hover:border-zinc-950"}`}
          data-testid={`m-hourly-${workerId}-${dateStr}`}
        >HOURLY</button>
      </div>
      {isHourly ? (
        <div className="space-y-1">
          <div className="flex items-center gap-1">
            <span className="text-[9px] uppercase text-zinc-500 w-10">Hrs</span>
            <input
              type="number" step="0.25" min="0"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              onBlur={(e) => onChange({ hours: Number(e.target.value) || 0 })}
              className="w-full input-sharp px-1 py-1 text-xs font-mono-data"
              data-testid={`hrs-${workerId}-${dateStr}`}
            />
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[9px] uppercase text-zinc-500 w-10">A$/hr</span>
            <input
              type="number" step="0.01" min="0"
              value={hourly}
              onChange={(e) => setHourly(e.target.value)}
              onBlur={(e) => onChange({ hourly_rate: Number(e.target.value) || 0 })}
              className="w-full input-sharp px-1 py-1 text-xs font-mono-data"
              data-testid={`rate-${workerId}-${dateStr}`}
            />
          </div>
          <div className="text-[10px] text-zinc-700 font-mono-data text-right">
            {fmtAUD((Number(hours) || 0) * (Number(hourly) || 0))}
          </div>
        </div>
      ) : (
        <div className="text-[10px] text-zinc-500 py-2 text-center">
          Boxes × global rate
        </div>
      )}
    </td>
  );
}
