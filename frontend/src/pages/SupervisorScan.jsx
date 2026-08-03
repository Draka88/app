import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { api, formatApiError } from "../lib/api";
import { fmtInt, todayISO } from "../lib/format";
import { beepSuccess, beepClockIn, beepClockOut, beepError, primeAudio } from "../lib/beep";
import Layout from "../components/Layout";
import BarcodeScanner from "../components/BarcodeScanner";
import { useAuth } from "../contexts/AuthContext";
import { toast } from "sonner";

const MODES = [
  { key: "box", label: "+1 Box", desc: "Each scan = 1 completed box" },
  { key: "clock_in", label: "Clock In", desc: "Start a worker's shift (GPS)" },
  { key: "clock_out", label: "Clock Out", desc: "End a worker's shift (GPS)" },
];

function fmtTime(iso) {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
}

export default function SupervisorScan() {
  const { user } = useAuth();
  const [mode, setMode] = useState("box");
  const [scannerOn, setScannerOn] = useState(true);
  const [recentScans, setRecentScans] = useState([]);
  const [dayRows, setDayRows] = useState([]);
  const [dayTotal, setDayTotal] = useState({ boxes: 0, workers: 0 });
  const [lastWorker, setLastWorker] = useState(null);
  const [lastAttn, setLastAttn] = useState(null);
  const [worksites, setWorksites] = useState([]);
  const [worksiteId, setWorksiteId] = useState(""); // "" = auto (nearest)
  const [gps, setGps] = useState(null); // {lat, lng, accuracy}
  const [gpsError, setGpsError] = useState(null);
  const [locating, setLocating] = useState(false);
  const scanBusyRef = useRef(false);

  const loadDay = useCallback(async () => {
    try {
      const [period, recent] = await Promise.all([
        api.get(`/summary/period?period=day&key=${todayISO()}`),
        api.get(`/scans/recent?limit=20`),
      ]);
      setDayRows(period.data.rows || []);
      setDayTotal({ boxes: period.data.total_boxes, workers: (period.data.rows || []).filter((r) => r.boxes > 0).length });
      setRecentScans(recent.data || []);
    } catch (e) {
      // silent
    }
  }, []);

  const loadWorksites = useCallback(async () => {
    try {
      const { data } = await api.get("/worksites?only_active=true");
      setWorksites(data || []);
    } catch (e) { /* silent */ }
  }, []);

  useEffect(() => { loadDay(); loadWorksites(); }, [loadDay, loadWorksites]);
  useEffect(() => {
    const t = setInterval(loadDay, 5000);
    return () => clearInterval(t);
  }, [loadDay]);

  const requestGps = useCallback(() => new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Geolocation not supported on this device"));
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const g = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
        setGps(g); setGpsError(null); setLocating(false);
        resolve(g);
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

  // Refresh GPS when entering an attendance mode
  useEffect(() => {
    if (mode === "clock_in" || mode === "clock_out") {
      requestGps().catch(() => {});
    } else {
      setGpsError(null);
    }
  }, [mode, requestGps]);

  const handleScan = async (qr) => {
    if (scanBusyRef.current) return;
    scanBusyRef.current = true;
    try {
      if (mode === "box") {
        const { data } = await api.post("/scans/for-worker", { worker_id: qr });
        // Fetch fresh day + week totals for confirmation banner
        let dayBoxes = null, weekBoxes = null;
        try {
          const s = await api.get(`/workers/${data.worker.id}/scan-summary`);
          dayBoxes = s.data.day_boxes;
          weekBoxes = s.data.week_boxes;
        } catch (_) { /* banner will just omit totals */ }
        setLastWorker({
          ...data.worker,
          at: new Date().toISOString(),
          day_boxes: dayBoxes,
          week_boxes: weekBoxes,
        });
        loadDay();
        beepSuccess();
        toast.success(`+1 box · ${data.worker.name}`, { duration: 1400 });
      } else {
        // Clock-in / clock-out: need fresh GPS every scan
        let g = gps;
        try {
          g = await requestGps();
        } catch (e) {
          toast.error(e.message);
          return;
        }
        const endpoint = mode === "clock_in" ? "/attendance/scan-clock-in" : "/attendance/scan-clock-out";
        const payload = {
          worker_id: qr,
          latitude: g.lat,
          longitude: g.lng,
          accuracy_m: g.accuracy,
        };
        if (worksiteId) payload.worksite_id = worksiteId;
        const { data } = await api.post(endpoint, payload);
        setLastAttn({
          mode,
          name: data.worker?.name || data.worker_name,
          worksite: data.worksite_name || data.clock_out_worksite_name,
          time: mode === "clock_in" ? data.clock_in : data.clock_out,
          hours: data.hours,
          at: new Date().toISOString(),
        });
        if (mode === "clock_in") beepClockIn(); else beepClockOut();
        toast.success(
          mode === "clock_in"
            ? `Clocked IN · ${data.worker?.name || data.worker_name}`
            : `Clocked OUT · ${data.worker?.name || data.worker_name} · ${data.hours}h`,
          { description: `Worksite: ${data.worksite_name || data.clock_out_worksite_name}`, duration: 2200 }
        );
      }
    } catch (e) {
      const status = e.response?.status;
      const detail = e.response?.data?.detail;
      beepError();
      if (status === 404) {
        toast.error("Unknown QR code — is this a Boxwise worker tag?");
      } else if (status === 409 && typeof detail === "string" && detail.toLowerCase().includes("your own qr")) {
        toast.error("Self-scan blocked", { description: detail, duration: 4600 });
      } else if (status === 429) {
        toast.warning("Slow down — same worker scanned less than 2s ago");
      } else if (status === 403 && detail && typeof detail === "object" && detail.message) {
        toast.error(detail.message, {
          description: detail.reason,
          duration: 4200,
        });
      } else {
        toast.error(formatApiError(detail));
      }
    } finally {
      setTimeout(() => { scanBusyRef.current = false; }, 800);
    }
  };

  const attnMode = mode === "clock_in" || mode === "clock_out";

  return (
    <Layout>
      <div className="flex items-end justify-between mb-6 gap-4 flex-wrap">
        <div>
          <div className="inline-block bg-yellow-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-zinc-950 mb-2">
            Supervisor · {user?.name}
          </div>
          <h1 className="font-heading text-5xl md:text-6xl leading-none">Scan Station</h1>
          <p className="text-zinc-500 mt-2">
            Scan a worker's QR name tag. Choose the action below.
          </p>
        </div>
        <div className="text-right font-mono-data">
          <div className="text-[10px] uppercase tracking-widest text-zinc-500">Today · Boxes</div>
          <div className="text-4xl font-bold" data-testid="today-boxes">{fmtInt(dayTotal.boxes)}</div>
          <div className="text-xs text-zinc-500">{dayTotal.workers} worker{dayTotal.workers === 1 ? "" : "s"}</div>
        </div>
      </div>

      {/* Mode toggle */}
      <div className="mb-6 grid grid-cols-3 gap-2" data-testid="mode-toggle">
        {MODES.map((m) => (
          <button
            key={m.key}
            onClick={() => { primeAudio(); setMode(m.key); }}
            className={`p-3 border-2 text-left ${mode === m.key ? "bg-zinc-950 text-white border-zinc-950" : "bg-white border-zinc-300 hover:border-zinc-950"}`}
            data-testid={`mode-${m.key}`}
          >
            <div className="font-heading text-sm md:text-base tracking-widest">{m.label.toUpperCase()}</div>
            <div className={`text-[10px] md:text-xs mt-1 ${mode === m.key ? "text-zinc-300" : "text-zinc-500"}`}>{m.desc}</div>
          </button>
        ))}
      </div>

      {/* Attendance controls: GPS + worksite selection */}
      {attnMode && (
        <div className="card-sharp p-4 mb-6" data-testid="attendance-controls">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
            <div>
              <label className="block font-heading text-xs mb-1 text-zinc-700">Worksite</label>
              <select
                value={worksiteId}
                onChange={(e) => setWorksiteId(e.target.value)}
                className="input-sharp w-full"
                data-testid="worksite-select"
              >
                <option value="">Auto-detect nearest</option>
                {worksites.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} · {w.radius_m}m
                  </option>
                ))}
              </select>
              {worksites.length === 0 && (
                <div className="text-[11px] text-red-600 mt-1">No worksites registered. Ask admin to add one.</div>
              )}
            </div>
            <div>
              <label className="block font-heading text-xs mb-1 text-zinc-700">Your GPS</label>
              <div className="input-sharp w-full font-mono-data text-xs">
                {gps ? `${gps.lat.toFixed(5)}, ${gps.lng.toFixed(5)} ±${Math.round(gps.accuracy)}m` : (locating ? "Locating…" : "—")}
              </div>
            </div>
            <div>
              <button
                onClick={() => requestGps().catch((e) => toast.error(e.message))}
                className="btn-outline-ink px-4 py-2 text-xs w-full"
                disabled={locating}
                data-testid="refresh-gps-btn"
              >
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
      )}

      {/* Big last-action card */}
      {mode === "box" && lastWorker && (
        <div className="card-sharp p-5 mb-6 bg-yellow-500 border-yellow-500" data-testid="last-worker-card">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="min-w-0">
              <div className="font-heading text-xs tracking-widest text-zinc-900">LAST SCAN · +1 BOX</div>
              <div className="font-heading text-4xl leading-none">{lastWorker.name}</div>
              {lastWorker.job_role && <div className="mt-1 text-xs uppercase tracking-widest text-zinc-800">{lastWorker.job_role}</div>}
              <div className="mt-2 text-xs font-mono-data text-zinc-800">
                {new Date(lastWorker.at).toLocaleDateString()} · {new Date(lastWorker.at).toLocaleTimeString()}
              </div>
            </div>
            <div className="flex gap-2">
              <div className="border-2 border-zinc-950 bg-white px-3 py-2 min-w-[90px]" data-testid="last-day-total">
                <div className="font-heading text-[9px] tracking-widest text-zinc-600">TODAY</div>
                <div className="font-heading text-3xl font-bold leading-none">{lastWorker.day_boxes ?? "—"}</div>
              </div>
              <div className="border-2 border-zinc-950 bg-zinc-950 text-white px-3 py-2 min-w-[90px]" data-testid="last-week-total">
                <div className="font-heading text-[9px] tracking-widest">THIS WEEK</div>
                <div className="font-heading text-3xl font-bold leading-none">{lastWorker.week_boxes ?? "—"}</div>
              </div>
            </div>
          </div>
        </div>
      )}
      {attnMode && lastAttn && (
        <div className="card-sharp p-5 mb-6 bg-yellow-500 border-yellow-500" data-testid="last-attn-card">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <div className="font-heading text-xs tracking-widest text-zinc-900">
                LAST · {lastAttn.mode === "clock_in" ? "CLOCK IN" : "CLOCK OUT"}
              </div>
              <div className="font-heading text-4xl leading-none">{lastAttn.name}</div>
              <div className="mt-1 text-xs uppercase tracking-widest text-zinc-800">
                {lastAttn.worksite} {lastAttn.hours != null && `· ${lastAttn.hours}h`}
              </div>
            </div>
            <div className="font-mono-data text-right">
              <div className="text-[10px] uppercase tracking-widest">at</div>
              <div className="text-2xl font-bold">{fmtTime(lastAttn.time)}</div>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Scanner column */}
        <div className="lg:col-span-2">
          <div className="card-sharp p-5">
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <div>
                <h2 className="font-heading text-xl">QR Scanner</h2>
                <p className="text-xs text-zinc-500">
                  {mode === "box" && "Each QR = +1 box"}
                  {mode === "clock_in" && "Scan to CLOCK IN the worker"}
                  {mode === "clock_out" && "Scan to CLOCK OUT the worker"}
                </p>
              </div>
              {!scannerOn ? (
                <button
                  onClick={() => { primeAudio(); setScannerOn(true); }}
                  className="btn-yellow px-4 py-2.5 text-xs"
                  data-testid="start-scanner-button"
                  disabled={attnMode && (!gps || worksites.length === 0)}
                >
                  ▶ Start scanning
                </button>
              ) : (
                <button onClick={() => setScannerOn(false)} className="btn-outline-ink px-4 py-2.5 text-xs" data-testid="stop-scanner-button">
                  ■ Stop
                </button>
              )}
            </div>
            {scannerOn ? (
              <BarcodeScanner onDetected={handleScan} cooldownMs={900} />
            ) : (
              <div className="border-2 border-dashed border-zinc-300 p-8 text-center text-zinc-500 text-sm" data-testid="scanner-idle">
                <div className="font-heading text-2xl text-zinc-950 mb-1">READY</div>
                {mode === "box" && "Tap Start. Each QR = +1 box for that worker."}
                {mode === "clock_in" && (gps ? "Tap Start. Each QR clocks that worker in." : "GPS required before starting.")}
                {mode === "clock_out" && (gps ? "Tap Start. Each QR clocks that worker out." : "GPS required before starting.")}
              </div>
            )}
          </div>
        </div>

        {/* Live totals + recent */}
        <div className="lg:col-span-3 space-y-4">
          <WorkerLookup />
          <div className="card-sharp p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-heading text-xl">Today · Live Totals</h2>
              <span className="text-xs text-zinc-500">Auto-refreshes every 5s</span>
            </div>
            <div className="overflow-x-auto border border-zinc-200">
              <table className="w-full text-sm zebra" data-testid="today-table">
                <thead className="bg-zinc-950 text-white">
                  <tr>
                    <th className="text-left px-3 py-2 font-heading text-xs">Worker</th>
                    <th className="text-left px-3 py-2 font-heading text-xs">Role</th>
                    <th className="text-right px-3 py-2 font-heading text-xs">Boxes today</th>
                    <th className="text-right px-3 py-2 font-heading text-xs">Hours</th>
                  </tr>
                </thead>
                <tbody>
                  {dayRows.length === 0 && (
                    <tr><td colSpan={4} className="px-3 py-8 text-center text-zinc-500 text-xs">No scans today yet.</td></tr>
                  )}
                  {dayRows.filter((r) => r.boxes > 0 || r.hours > 0).map((r) => (
                    <tr key={r.worker_id} className="border-t border-zinc-100" data-testid={`day-row-${r.worker_id}`}>
                      <td className="px-3 py-2 font-heading text-base">{r.name}</td>
                      <td className="px-3 py-2">
                        {r.job_role ? (
                          <span className="inline-block border border-zinc-900 px-2 py-0.5 text-[10px] uppercase tracking-widest font-bold">{r.job_role}</span>
                        ) : <span className="text-zinc-400 text-xs italic">—</span>}
                      </td>
                      <td className="px-3 py-2 text-right font-mono-data font-bold">{fmtInt(r.boxes)}</td>
                      <td className="px-3 py-2 text-right font-mono-data">{r.hours || 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card-sharp p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-heading text-xl">Recent scans</h2>
              <span className="text-xs text-zinc-500">Newest first</span>
            </div>
            <div className="overflow-x-auto border border-zinc-200 max-h-[240px] overflow-y-auto">
              <table className="w-full text-sm zebra" data-testid="recent-table">
                <thead className="bg-zinc-950 text-white sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2 font-heading text-xs">Time</th>
                    <th className="text-left px-3 py-2 font-heading text-xs">Worker</th>
                    <th className="text-left px-3 py-2 font-heading text-xs">Supervisor</th>
                    <th className="text-right px-3 py-2 font-heading text-xs">+</th>
                  </tr>
                </thead>
                <tbody>
                  {recentScans.length === 0 && (
                    <tr><td colSpan={4} className="px-3 py-6 text-center text-zinc-500 text-xs">No scans yet.</td></tr>
                  )}
                  {recentScans.map((s) => (
                    <tr key={s.id} className="border-t border-zinc-100">
                      <td className="px-3 py-2 font-mono-data text-xs whitespace-nowrap">{new Date(s.created_at).toLocaleTimeString()}</td>
                      <td className="px-3 py-2">{s.worker_name}</td>
                      <td className="px-3 py-2 text-xs text-zinc-600">{s.supervisor_name || "—"}</td>
                      <td className="px-3 py-2 text-right font-mono-data font-bold">+1</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
}

function WorkerLookup() {
  const [q, setQ] = useState("");
  const [workers, setWorkers] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.get("/workers").then((r) => setWorkers(r.data || [])).catch(() => {});
  }, []);

  const matches = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return [];
    return workers
      .filter((w) => {
        const emp = (w.employee_id || "").toLowerCase();
        return w.name.toLowerCase().includes(term) || emp.includes(term) || (w.email || "").toLowerCase().includes(term);
      })
      .slice(0, 8);
  }, [q, workers]);

  const loadSummary = useCallback(async (id) => {
    if (!id) return;
    setLoading(true);
    try {
      const { data } = await api.get(`/workers/${id}/scan-summary`);
      setSummary(data);
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { if (selectedId) loadSummary(selectedId); }, [selectedId, loadSummary]);

  const pick = (w) => {
    setSelectedId(w.id);
    setQ(`${w.employee_id || ""} · ${w.name}`);
  };

  const clear = () => { setSelectedId(null); setSummary(null); setQ(""); };

  const deleteScan = async (scanId) => {
    const reason = window.prompt("Reason for removing this scan (optional):", "");
    if (reason === null) return; // cancelled
    try {
      await api.delete(`/scans/${scanId}${reason ? `?reason=${encodeURIComponent(reason)}` : ""}`);
      toast.success("Scan removed and logged in audit");
      loadSummary(selectedId);
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    }
  };

  return (
    <div className="card-sharp p-5" data-testid="worker-lookup">
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <div>
          <h2 className="font-heading text-xl">Find worker</h2>
          <p className="text-xs text-zinc-500">Search by name or Employee ID to see today's + weekly totals and scan history.</p>
        </div>
        {selectedId && (
          <button onClick={clear} className="btn-outline-ink px-3 py-1.5 text-xs" data-testid="lookup-clear-btn">Clear</button>
        )}
      </div>
      <div className="relative">
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); if (selectedId) setSelectedId(null); }}
          placeholder="Search e.g. EMP-0007 or Worker A"
          className="input-sharp w-full font-mono-data"
          data-testid="lookup-search-input"
        />
        {matches.length > 0 && !selectedId && (
          <div className="absolute left-0 right-0 top-full z-10 border-2 border-zinc-900 bg-white shadow-lg max-h-64 overflow-y-auto" data-testid="lookup-suggestions">
            {matches.map((w) => (
              <button
                key={w.id}
                onClick={() => pick(w)}
                className="block w-full text-left px-3 py-2 border-b border-zinc-100 hover:bg-yellow-100"
                data-testid={`lookup-pick-${w.id}`}
              >
                <span className="font-mono-data text-xs text-zinc-600 mr-2">{w.employee_id || "—"}</span>
                <span className="font-heading">{w.name}</span>
                {w.job_role && <span className="ml-2 text-[10px] uppercase tracking-widest text-zinc-500">{w.job_role}</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      {loading && <div className="mt-4 text-xs text-zinc-500">Loading…</div>}

      {summary && !loading && (
        <div className="mt-4 space-y-3" data-testid="lookup-summary">
          <div className="flex items-center justify-between flex-wrap gap-2 border-b border-zinc-200 pb-2">
            <div>
              <div className="font-heading text-2xl leading-none">{summary.worker.name}</div>
              <div className="text-xs text-zinc-500 font-mono-data mt-1">
                {summary.worker.employee_id || "—"} · {summary.worker.job_role || "unassigned"}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-4 gap-2">
            <MiniStat label="Today" value={summary.day_boxes} testid="lookup-day" />
            <MiniStat label="This Week" value={summary.week_boxes} testid="lookup-week" accent />
            <MiniStat label="This Month" value={summary.month_boxes} testid="lookup-month" />
            <MiniStat label="All Time" value={summary.all_time_boxes} testid="lookup-all" />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <div className="font-heading text-xs tracking-widest text-zinc-700">SCAN HISTORY · LAST {summary.recent_scans.length}</div>
              <div className="text-[10px] uppercase tracking-widest text-zinc-500">click ✕ to correct</div>
            </div>
            <div className="border border-zinc-200 max-h-[220px] overflow-y-auto">
              <table className="w-full text-sm zebra" data-testid="lookup-history-table">
                <thead className="bg-zinc-950 text-white sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-1.5 font-heading text-[10px]">Time</th>
                    <th className="text-left px-3 py-1.5 font-heading text-[10px]">Date</th>
                    <th className="text-left px-3 py-1.5 font-heading text-[10px]">Supervisor</th>
                    <th className="text-right px-3 py-1.5 font-heading text-[10px]">+</th>
                    <th className="px-3 py-1.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {summary.recent_scans.length === 0 && (
                    <tr><td colSpan={5} className="px-3 py-6 text-center text-zinc-500 text-xs">No scans yet.</td></tr>
                  )}
                  {summary.recent_scans.map((s) => (
                    <tr key={s.id} className="border-t border-zinc-100" data-testid={`lookup-scan-${s.id}`}>
                      <td className="px-3 py-1.5 font-mono-data text-[11px] whitespace-nowrap">{new Date(s.created_at).toLocaleTimeString()}</td>
                      <td className="px-3 py-1.5 font-mono-data text-[11px]">{s.date}</td>
                      <td className="px-3 py-1.5 text-[11px] text-zinc-700">{s.supervisor_name || "—"}</td>
                      <td className="px-3 py-1.5 text-right font-mono-data font-bold">+1</td>
                      <td className="px-3 py-1.5 text-right">
                        <button onClick={() => deleteScan(s.id)} className="text-red-600 text-xs hover:underline" data-testid={`del-scan-${s.id}`}>✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MiniStat({ label, value, testid, accent }) {
  return (
    <div className={`border-2 ${accent ? "bg-yellow-500 border-yellow-500" : "border-zinc-200 bg-white"} p-2`} data-testid={testid}>
      <div className={`font-heading text-[9px] tracking-widest ${accent ? "text-zinc-900" : "text-zinc-500"}`}>{label}</div>
      <div className="font-heading text-2xl font-bold leading-none mt-0.5">{fmtInt(value)}</div>
    </div>
  );
}
