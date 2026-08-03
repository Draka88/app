import { useEffect, useState, useCallback, useRef } from "react";
import { api, API, formatApiError } from "../lib/api";
import { fmtAUD, fmtInt, isoWeekKey, weekLabel } from "../lib/format";
import Layout from "../components/Layout";
import { useAuth } from "../contexts/AuthContext";
import { toast } from "sonner";

function fmtTime(iso) {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
}
function fmtDuration(startISO) {
  if (!startISO) return "—";
  const s = Math.max(0, Math.floor((Date.now() - new Date(startISO).getTime()) / 1000));
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m ${String(s % 60).padStart(2, "0")}s`;
}

export default function WorkerDashboard() {
  const { user } = useAuth();
  const [week, setWeek] = useState(isoWeekKey());
  const [weeks, setWeeks] = useState([]);
  const [summary, setSummary] = useState(null);
  const [history, setHistory] = useState([]);
  const [entry, setEntry] = useState(null);
  const [worksites, setWorksites] = useState([]);
  const [worksiteId, setWorksiteId] = useState("");
  const [gps, setGps] = useState(null);
  const [gpsError, setGpsError] = useState(null);
  const [locating, setLocating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);
  const timerRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const [wks, s, h, tod, sites] = await Promise.all([
        api.get("/weeks"),
        api.get(`/summary/me?week=${week}`),
        api.get(`/attendance/me?limit=30`),
        api.get(`/attendance/me?date_=${today}`),
        api.get(`/worksites?only_active=true`),
      ]);
      setWeeks(wks.data.weeks);
      setSummary(s.data);
      setHistory(Array.isArray(h.data) ? h.data : []);
      setEntry(tod.data || null);
      setWorksites(sites.data || []);
    } catch (e) { toast.error(formatApiError(e.response?.data?.detail)); }
  }, [week]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (entry && entry.clock_in && !entry.clock_out) {
      timerRef.current = setInterval(() => setTick((t) => t + 1), 1000);
      return () => clearInterval(timerRef.current);
    }
  }, [entry]);

  const requestGps = useCallback(() => new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Geolocation not supported"));
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const g = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
        setGps(g); setGpsError(null); setLocating(false); resolve(g);
      },
      (err) => {
        setLocating(false);
        const msg = err.code === 1
          ? "GPS permission denied. Clock In/Out is not allowed without location access."
          : (err.message || "Unable to get GPS location");
        setGpsError(msg);
        reject(new Error(msg));
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
    );
  }), []);

  useEffect(() => { requestGps().catch(() => {}); }, [requestGps]);

  const doClock = async (kind) => {
    setBusy(true);
    try {
      let g = gps;
      try { g = await requestGps(); } catch (e) { toast.error(e.message); return; }
      const payload = { latitude: g.lat, longitude: g.lng, accuracy_m: g.accuracy };
      if (worksiteId) payload.worksite_id = worksiteId;
      const path = kind === "in" ? "/attendance/clock-in" : "/attendance/clock-out";
      const { data } = await api.post(path, payload);
      toast.success(
        kind === "in"
          ? `Clocked IN at ${fmtTime(data.clock_in)}`
          : `Clocked OUT · ${data.hours}h worked`,
        { description: kind === "in" ? "Have a great shift!" : "Hours auto-saved to your payroll" }
      );
      load();
    } catch (e) {
      const detail = e.response?.data?.detail;
      if (detail && typeof detail === "object" && detail.message) {
        toast.error(detail.message, { description: detail.reason, duration: 4200 });
      } else {
        toast.error(formatApiError(detail));
      }
    } finally { setBusy(false); }
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

  const active = entry && entry.clock_in && !entry.clock_out;
  const done = entry && entry.clock_out;

  return (
    <Layout>
      <div className="flex items-end justify-between mb-6 gap-4 flex-wrap">
        <div>
          <div className="inline-block bg-yellow-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-zinc-950 mb-2">
            {user?.employee_id ? `${user.employee_id} · ` : ""}{user?.name} · Worker
          </div>
          <h1 className="font-heading text-4xl sm:text-5xl leading-none">My Shift</h1>
          <p className="text-zinc-500 mt-2 text-sm">
            Clock in when you arrive on-site. Your GPS confirms you are at the workplace.
          </p>
        </div>
        <div>
          <label className="block font-heading text-xs mb-1 text-zinc-700">Week</label>
          <select className="input-sharp min-w-[180px]" value={week} onChange={(e) => setWeek(e.target.value)} data-testid="week-selector">
            {weeks.map((w) => <option key={w} value={w}>{weekLabel(w)}</option>)}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <Kpi label="Today" value={active ? fmtDuration(entry.clock_in) : (done ? `${entry.hours}h` : "—")} testid="kpi-today" mono={active} />
        <Kpi label="Week Hours" value={fmtInt(summary?.total_hours || 0)} testid="kpi-hours" />
        <Kpi label="Sessions" value={fmtInt(history.length)} testid="kpi-sessions" />
        <Kpi label="Week Pay" value={fmtAUD(summary?.earnings || 0)} testid="kpi-earnings" accent />
      </div>

      {/* Attendance controls */}
      <div className="card-sharp p-5 mb-6" data-testid="attendance-controls">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
          <div>
            <label className="block font-heading text-xs mb-1 text-zinc-700">Worksite</label>
            <select value={worksiteId} onChange={(e) => setWorksiteId(e.target.value)} className="input-sharp w-full" data-testid="worksite-select">
              <option value="">Auto-detect nearest</option>
              {worksites.map((w) => (
                <option key={w.id} value={w.id}>{w.name} · {w.radius_m}m</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block font-heading text-xs mb-1 text-zinc-700">Your GPS</label>
            <div className="input-sharp w-full font-mono-data text-xs">
              {gps ? `${gps.lat.toFixed(5)}, ${gps.lng.toFixed(5)} ±${Math.round(gps.accuracy)}m` : (locating ? "Locating…" : "—")}
            </div>
          </div>
          <div>
            <button onClick={() => requestGps().catch((e) => toast.error(e.message))} className="btn-outline-ink px-4 py-2 text-xs w-full" disabled={locating} data-testid="refresh-gps-btn">
              {locating ? "Locating…" : "◎ Refresh GPS"}
            </button>
          </div>
        </div>
        {gpsError && (
          <div className="mt-3 border-2 border-red-500 bg-red-50 p-3 text-xs text-red-800" data-testid="gps-error">
            <b>Location required:</b> {gpsError}
          </div>
        )}
      </div>

      {/* Clock card */}
      <div className={`card-sharp p-5 mb-6 ${active ? "bg-yellow-500 border-yellow-500" : ""}`} data-testid="clock-card">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className={`inline-block w-2.5 h-2.5 rounded-full ${active ? "bg-zinc-950 animate-pulse" : done ? "bg-zinc-400" : "bg-green-600"}`}></span>
              <span className="font-heading text-xs tracking-widest">TIME ATTENDANCE · {active ? "ACTIVE" : done ? "COMPLETED" : "READY"}</span>
            </div>
            {active && (
              <>
                <div className="mt-2 font-heading text-4xl leading-none font-mono-data" data-testid="live-duration">
                  {fmtDuration(entry.clock_in)}
                </div>
                <div className="mt-1 text-xs text-zinc-800">
                  In at <b>{fmtTime(entry.clock_in)}</b> · {entry.worksite_name || "—"} · live shift
                </div>
              </>
            )}
            {done && (
              <>
                <div className="mt-2 font-heading text-3xl leading-none">
                  {entry.hours} h <span className="text-zinc-500 text-lg">worked today</span>
                </div>
                <div className="mt-1 text-xs text-zinc-600">
                  In <b>{fmtTime(entry.clock_in)}</b> → Out <b>{fmtTime(entry.clock_out)}</b> · {entry.worksite_name || "—"}
                </div>
              </>
            )}
            {!active && !done && (
              <>
                <div className="mt-2 font-heading text-3xl leading-none">Not clocked in</div>
                <div className="mt-1 text-xs text-zinc-500">
                  Ready when you are. GPS must be inside a registered worksite.
                </div>
              </>
            )}
          </div>
          <div>
            {!active && !done && (
              <button onClick={() => doClock("in")} disabled={busy || !gps} className="btn-yellow px-6 py-4 text-sm" data-testid="clock-in-btn">
                {busy ? "…" : "▶ Clock in"}
              </button>
            )}
            {active && (
              <button onClick={() => doClock("out")} disabled={busy || !gps} className="btn-outline-ink px-6 py-4 text-sm border-zinc-950" data-testid="clock-out-btn">
                {busy ? "…" : "■ Clock out"}
              </button>
            )}
            {done && (
              <div className="font-mono-data text-xs text-zinc-600 text-right" data-testid="clock-done">Shift closed</div>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Attendance history */}
        <div className="card-sharp p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-heading text-xl">My attendance</h2>
            <span className="text-xs text-zinc-500">Last 30 days</span>
          </div>
          <div className="overflow-x-auto border border-zinc-200 max-h-[420px] overflow-y-auto">
            <table className="w-full text-sm zebra" data-testid="my-attendance-table">
              <thead className="bg-zinc-950 text-white sticky top-0">
                <tr>
                  <th className="text-left px-3 py-2 font-heading text-xs">Date</th>
                  <th className="text-left px-3 py-2 font-heading text-xs">In</th>
                  <th className="text-left px-3 py-2 font-heading text-xs">Out</th>
                  <th className="text-right px-3 py-2 font-heading text-xs">Hours</th>
                  <th className="text-left px-3 py-2 font-heading text-xs">Site</th>
                </tr>
              </thead>
              <tbody>
                {history.length === 0 && (
                  <tr><td colSpan={5} className="px-3 py-8 text-center text-zinc-500 text-xs">No shifts yet.</td></tr>
                )}
                {history.map((h) => (
                  <tr key={h.id} className="border-t border-zinc-100" data-testid={`my-attn-${h.id}`}>
                    <td className="px-3 py-2 font-mono-data text-xs">{h.date}</td>
                    <td className="px-3 py-2 font-mono-data text-xs">{fmtTime(h.clock_in)}</td>
                    <td className="px-3 py-2 font-mono-data text-xs">{h.clock_out ? fmtTime(h.clock_out) : <span className="text-yellow-700 font-bold">ACTIVE</span>}</td>
                    <td className="px-3 py-2 text-right font-mono-data font-bold">{h.hours ?? "—"}</td>
                    <td className="px-3 py-2 text-xs">{h.worksite_name || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Payroll breakdown */}
        <div className="card-sharp p-5">
          <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
            <div>
              <h2 className="font-heading text-xl">Weekly payroll · {week}</h2>
              <p className="text-xs text-zinc-500">{summary?.week_start} → {summary?.week_end}</p>
            </div>
            <div className="flex gap-2">
              <button onClick={() => download(`/payslip/${user.id}?week=${week}`, `payslip_${week}.pdf`)} className="btn-outline-ink px-3 py-2 text-xs" data-testid="payslip-pdf-btn">↓ PDF</button>
              <button onClick={() => download(`/payslip/${user.id}/xlsx?week=${week}`, `payslip_${week}.xlsx`)} className="btn-outline-ink px-3 py-2 text-xs" data-testid="payslip-xlsx-btn">↓ Excel</button>
            </div>
          </div>
          <div className="overflow-x-auto border border-zinc-200">
            <table className="w-full text-sm zebra" data-testid="my-payroll-table">
              <thead className="bg-zinc-950 text-white">
                <tr>
                  <th className="text-left px-3 py-2 font-heading text-xs">Date</th>
                  <th className="text-right px-3 py-2 font-heading text-xs">Hours</th>
                  <th className="text-right px-3 py-2 font-heading text-xs">Rate</th>
                  <th className="text-right px-3 py-2 font-heading text-xs">Amount</th>
                </tr>
              </thead>
              <tbody>
                {(!summary?.days || summary.days.length === 0) && (
                  <tr><td colSpan={4} className="px-3 py-8 text-center text-zinc-500 text-xs">No payroll entries this week.</td></tr>
                )}
                {(summary?.days || []).map((d) => (
                  <tr key={d.date} className="border-t border-zinc-100">
                    <td className="px-3 py-2 font-mono-data text-xs">{d.date}</td>
                    <td className="px-3 py-2 text-right font-mono-data">{d.hours || 0}</td>
                    <td className="px-3 py-2 text-right font-mono-data">{fmtAUD(d.hourly_rate || 0)}</td>
                    <td className="px-3 py-2 text-right font-mono-data font-bold">{fmtAUD(d.earnings || 0)}</td>
                  </tr>
                ))}
              </tbody>
              {summary?.days?.length > 0 && (
                <tfoot>
                  <tr className="bg-zinc-100 border-t-2 border-zinc-900">
                    <td className="px-3 py-2 font-heading">Total</td>
                    <td className="px-3 py-2 text-right font-mono-data font-bold">{summary.total_hours}</td>
                    <td></td>
                    <td className="px-3 py-2 text-right font-mono-data font-bold">{fmtAUD(summary.earnings)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      </div>
    </Layout>
  );
}

function Kpi({ label, value, testid, accent, mono }) {
  return (
    <div className={`card-sharp p-4 ${accent ? "bg-yellow-500 border-yellow-500" : ""}`} data-testid={testid}>
      <div className={`font-heading text-[10px] tracking-widest ${accent ? "text-zinc-900" : "text-zinc-500"}`}>{label}</div>
      <div className={`mt-2 font-heading text-2xl sm:text-3xl leading-none ${mono ? "font-mono-data" : ""}`}>{value}</div>
    </div>
  );
}
