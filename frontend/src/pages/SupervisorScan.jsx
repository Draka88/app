import { useEffect, useState, useCallback, useRef } from "react";
import { api, formatApiError } from "../lib/api";
import { fmtAUD, fmtInt, todayISO } from "../lib/format";
import Layout from "../components/Layout";
import BarcodeScanner from "../components/BarcodeScanner";
import { useAuth } from "../contexts/AuthContext";
import { toast } from "sonner";

export default function SupervisorScan() {
  const { user } = useAuth();
  const [scannerOn, setScannerOn] = useState(false);
  const [recentScans, setRecentScans] = useState([]);
  const [dayRows, setDayRows] = useState([]);
  const [dayTotal, setDayTotal] = useState({ boxes: 0, workers: 0 });
  const [lastWorker, setLastWorker] = useState(null);
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

  useEffect(() => {
    loadDay();
    const t = setInterval(loadDay, 5000);
    return () => clearInterval(t);
  }, [loadDay]);

  const handleScan = async (qr) => {
    if (scanBusyRef.current) return;
    scanBusyRef.current = true;
    try {
      const { data } = await api.post("/scans/for-worker", { worker_id: qr });
      setLastWorker({ ...data.worker, at: new Date().toISOString(), count_today: null });
      // Update local totals fast
      loadDay();
      toast.success(`+1 box · ${data.worker.name}`, { duration: 1400 });
    } catch (e) {
      const status = e.response?.status;
      const detail = e.response?.data?.detail;
      if (status === 404) {
        toast.error("Unknown QR code — is this a Boxwise worker tag?");
      } else if (status === 429) {
        toast.warning("Slow down — same worker scanned less than 2s ago");
      } else {
        toast.error(formatApiError(detail));
      }
    } finally {
      setTimeout(() => { scanBusyRef.current = false; }, 800);
    }
  };

  return (
    <Layout>
      <div className="flex items-end justify-between mb-6 gap-4 flex-wrap">
        <div>
          <div className="inline-block bg-yellow-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-zinc-950 mb-2">
            Supervisor · {user?.name}
          </div>
          <h1 className="font-heading text-5xl md:text-6xl leading-none">Scan Station</h1>
          <p className="text-zinc-500 mt-2">
            Scan the worker's QR name tag once per completed box. Every scan adds 1 to their count.
          </p>
        </div>
        <div className="text-right font-mono-data">
          <div className="text-[10px] uppercase tracking-widest text-zinc-500">Today</div>
          <div className="text-4xl font-bold" data-testid="today-boxes">{fmtInt(dayTotal.boxes)}</div>
          <div className="text-xs text-zinc-500">boxes · {dayTotal.workers} worker{dayTotal.workers === 1 ? "" : "s"}</div>
        </div>
      </div>

      {/* Big last-scanned card */}
      {lastWorker && (
        <div className="card-sharp p-5 mb-6 bg-yellow-500 border-yellow-500" data-testid="last-worker-card">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <div className="font-heading text-xs tracking-widest text-zinc-900">LAST SCAN · +1 BOX</div>
              <div className="font-heading text-4xl leading-none">{lastWorker.name}</div>
              {lastWorker.job_role && <div className="mt-1 text-xs uppercase tracking-widest text-zinc-800">{lastWorker.job_role}</div>}
            </div>
            <div className="font-mono-data text-right">
              <div className="text-[10px] uppercase tracking-widest">at</div>
              <div className="text-2xl font-bold">{new Date(lastWorker.at).toLocaleTimeString()}</div>
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
                <p className="text-xs text-zinc-500">Point camera at worker name tag</p>
              </div>
              {!scannerOn ? (
                <button onClick={() => setScannerOn(true)} className="btn-yellow px-4 py-2.5 text-xs" data-testid="start-scanner-button">
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
                Tap "Start scanning" to open the camera. Each QR = +1 box for that worker.
              </div>
            )}
          </div>
        </div>

        {/* Live totals + recent */}
        <div className="lg:col-span-3 space-y-4">
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
