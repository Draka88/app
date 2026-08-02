import { useEffect, useState, useCallback, useRef } from "react";
import { api, API, formatApiError } from "../lib/api";
import { fmtAUD, fmtInt, todayISO, isoWeekKey } from "../lib/format";
import Layout from "../components/Layout";
import BarcodeScanner from "../components/BarcodeScanner";
import { useAuth } from "../contexts/AuthContext";
import { toast } from "sonner";

export default function WorkerDashboard() {
  const { user } = useAuth();
  const [rate, setRate] = useState(0);
  const [weeks, setWeeks] = useState([]);
  const [week, setWeek] = useState(isoWeekKey());
  const [summary, setSummary] = useState(null);
  const [reports, setReports] = useState([]);
  const [scans, setScans] = useState([]);
  const [scannerOn, setScannerOn] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [boxes, setBoxes] = useState("");
  const [date, setDate] = useState(todayISO());
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [dayCount, setDayCount] = useState(0);
  const scanBusyRef = useRef(false);

  const loadCore = useCallback(async () => {
    try {
      const [r, w, s, rep, sc, day] = await Promise.all([
        api.get("/settings/rate"),
        api.get("/weeks"),
        api.get(`/summary/me?week=${week}`),
        api.get(`/reports/me?week=${week}`),
        api.get("/scans/me?limit=50"),
        api.get("/summary/period?period=day"),
      ]);
      setRate(r.data.rate);
      setWeeks(w.data.weeks);
      setSummary(s.data);
      setReports(rep.data);
      setScans(sc.data);
      setDayCount(day.data.total_boxes || 0);
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    }
  }, [week]);

  useEffect(() => {
    loadCore();
  }, [loadCore]);

  const handleScan = async (barcode, format) => {
    if (scanBusyRef.current) return;
    scanBusyRef.current = true;
    try {
      const { data } = await api.post("/scans", { barcode, format });
      toast.success(`+1 box · ${barcode}`, { description: `Total today: ${dayCount + 1}` });
      setScans((prev) => [data, ...prev].slice(0, 50));
      setDayCount((n) => n + 1);
      // refresh summary
      const s = await api.get(`/summary/me?week=${week}`);
      setSummary(s.data);
    } catch (e) {
      const status = e.response?.status;
      if (status === 409) {
        toast.warning("Duplicate scan ignored (10s window)");
      } else {
        toast.error(formatApiError(e.response?.data?.detail));
      }
    } finally {
      setTimeout(() => { scanBusyRef.current = false; }, 400);
    }
  };

  const submitManual = async (e) => {
    e.preventDefault();
    const n = parseInt(boxes, 10);
    if (isNaN(n) || n <= 0) { toast.error("Enter a valid box count"); return; }
    setSubmitting(true);
    try {
      await api.post("/reports", { boxes: n, date, note: note || null });
      toast.success(`Reported ${n} boxes`);
      setBoxes(""); setNote("");
      await loadCore();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    } finally {
      setSubmitting(false);
    }
  };

  const removeReport = async (id) => {
    try {
      await api.delete(`/reports/${id}`);
      toast.success("Removed");
      loadCore();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    }
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

  return (
    <Layout>
      <div className="flex items-end justify-between mb-6 gap-4 flex-wrap">
        <div>
          <div className="inline-block bg-yellow-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-zinc-950 mb-2">
            {user?.name} · Worker
          </div>
          <h1 className="font-heading text-4xl sm:text-5xl leading-none">My Shift</h1>
          <p className="text-zinc-500 mt-2 text-sm">
            Scan every box barcode as you pack. Each scan adds one box to your payslip.
          </p>
        </div>
        <div>
          <label className="block font-heading text-xs mb-1 text-zinc-700">Week</label>
          <select className="input-sharp min-w-[180px]" value={week} onChange={(e) => setWeek(e.target.value)} data-testid="week-selector">
            {weeks.map((w) => <option key={w} value={w}>{w}</option>)}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <Kpi label="Today" value={fmtInt(dayCount)} testid="kpi-today" />
        <Kpi label="This Week" value={fmtInt(summary?.total_boxes || 0)} testid="kpi-boxes" />
        <Kpi label="Rate / Box" value={fmtAUD(rate)} testid="kpi-rate" mono />
        <Kpi label="Week Pay" value={fmtAUD(summary?.earnings || 0)} testid="kpi-earnings" accent />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Scanner column */}
        <div className="lg:col-span-2 space-y-4">
          <div className="card-sharp p-5">
            <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
              <div>
                <h2 className="font-heading text-xl">Barcode Scanner</h2>
                <p className="text-xs text-zinc-500">Point camera at box barcode or QR</p>
              </div>
              {!scannerOn ? (
                <button
                  onClick={() => setScannerOn(true)}
                  className="btn-yellow px-4 py-2.5 text-xs"
                  data-testid="start-scanner-button"
                >
                  ▶ Start scanning
                </button>
              ) : (
                <button
                  onClick={() => setScannerOn(false)}
                  className="btn-outline-ink px-4 py-2.5 text-xs"
                  data-testid="stop-scanner-button"
                >
                  ■ Stop
                </button>
              )}
            </div>
            {scannerOn ? (
              <BarcodeScanner onDetected={handleScan} />
            ) : (
              <div className="border-2 border-dashed border-zinc-300 p-8 text-center text-zinc-500 text-sm" data-testid="scanner-idle">
                <div className="font-heading text-2xl text-zinc-950 mb-1">READY</div>
                Tap “Start scanning” to open the camera. Every successful scan adds 1 box.
              </div>
            )}
          </div>

          <div className="card-sharp p-5">
            <button
              onClick={() => setManualOpen((o) => !o)}
              className="w-full text-left flex items-center justify-between"
              data-testid="toggle-manual"
            >
              <div>
                <div className="font-heading text-sm">Manual entry</div>
                <div className="text-xs text-zinc-500">If a barcode is damaged or missing</div>
              </div>
              <span className="font-heading text-lg">{manualOpen ? "–" : "+"}</span>
            </button>
            {manualOpen && (
              <form onSubmit={submitManual} className="mt-4 space-y-3" data-testid="report-form">
                <div>
                  <label className="block font-heading text-xs mb-1 text-zinc-700">Boxes</label>
                  <input type="number" min="1" required value={boxes} onChange={(e) => setBoxes(e.target.value)} className="input-sharp font-mono-data text-lg" data-testid="report-boxes-input" placeholder="e.g. 5" />
                </div>
                <div>
                  <label className="block font-heading text-xs mb-1 text-zinc-700">Date</label>
                  <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} className="input-sharp font-mono-data" data-testid="report-date-input" />
                </div>
                <div>
                  <label className="block font-heading text-xs mb-1 text-zinc-700">Note</label>
                  <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Torn barcode on pallet 3" className="input-sharp" data-testid="report-note-input" />
                </div>
                <button type="submit" disabled={submitting} className="btn-yellow w-full py-2.5 text-xs" data-testid="report-submit-button">
                  {submitting ? "Saving…" : "Log manual boxes →"}
                </button>
              </form>
            )}
          </div>
        </div>

        {/* Right column: scan history + weekly log */}
        <div className="lg:col-span-3 space-y-4">
          <div className="card-sharp p-5">
            <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
              <div>
                <h2 className="font-heading text-xl">Scan history</h2>
                <p className="text-xs text-zinc-500">Every barcode you scanned, newest first · fraud-proof timestamps</p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => download(`/payslip/${user.id}?week=${week}`, `payslip_${week}.pdf`)}
                  className="btn-outline-ink px-3 py-2 text-xs"
                  data-testid="payslip-download-button"
                >
                  ↓ PDF
                </button>
                <button
                  onClick={() => download(`/payslip/${user.id}/xlsx?week=${week}`, `payslip_${week}.xlsx`)}
                  className="btn-outline-ink px-3 py-2 text-xs"
                  data-testid="payslip-xlsx-button"
                >
                  ↓ Excel
                </button>
              </div>
            </div>
            <div className="overflow-x-auto border border-zinc-200 max-h-[360px] overflow-y-auto">
              <table className="w-full text-sm zebra" data-testid="scans-table">
                <thead className="bg-zinc-950 text-white sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2 font-heading text-xs">Time</th>
                    <th className="text-left px-3 py-2 font-heading text-xs">Barcode</th>
                    <th className="text-left px-3 py-2 font-heading text-xs">Date</th>
                    <th className="text-right px-3 py-2 font-heading text-xs">Boxes</th>
                  </tr>
                </thead>
                <tbody>
                  {scans.length === 0 && (
                    <tr><td colSpan={4} className="px-3 py-8 text-center text-zinc-500 text-xs">No scans yet. Start the scanner to log your first box.</td></tr>
                  )}
                  {scans.map((s) => (
                    <tr key={s.id} className="border-t border-zinc-100" data-testid={`scan-row-${s.id}`}>
                      <td className="px-3 py-2 font-mono-data text-xs whitespace-nowrap">
                        {new Date(s.created_at).toLocaleTimeString()}
                      </td>
                      <td className="px-3 py-2 font-mono-data text-xs break-all">{s.barcode}</td>
                      <td className="px-3 py-2 font-mono-data text-xs">{s.date}</td>
                      <td className="px-3 py-2 text-right font-mono-data font-bold">+{s.boxes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card-sharp p-5">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h2 className="font-heading text-xl">Weekly log · {week}</h2>
                <p className="text-xs text-zinc-500">{summary?.week_start} → {summary?.week_end}</p>
              </div>
            </div>
            <div className="overflow-x-auto border border-zinc-200">
              <table className="w-full text-sm zebra" data-testid="reports-table">
                <thead className="bg-zinc-950 text-white">
                  <tr>
                    <th className="text-left px-3 py-2 font-heading text-xs">Date</th>
                    <th className="text-left px-3 py-2 font-heading text-xs">Source</th>
                    <th className="text-right px-3 py-2 font-heading text-xs">Boxes</th>
                    <th className="text-right px-3 py-2 font-heading text-xs">Amount</th>
                    <th className="px-2 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {reports.length === 0 && (
                    <tr><td colSpan={5} className="px-3 py-6 text-center text-zinc-500 text-xs">No entries yet this week.</td></tr>
                  )}
                  {reports.map((r) => (
                    <tr key={r.id} className="border-t border-zinc-100" data-testid={`report-row-${r.id}`}>
                      <td className="px-3 py-2 font-mono-data">{r.date}</td>
                      <td className="px-3 py-2">
                        <span className={`text-[10px] uppercase tracking-widest px-1.5 py-0.5 font-bold ${r.source === "scan" ? "bg-yellow-500 text-zinc-950" : "border border-zinc-400 text-zinc-700"}`}>
                          {r.source || "manual"}
                        </span>
                        {r.barcode && <span className="ml-2 font-mono-data text-[10px] text-zinc-500 break-all">{r.barcode}</span>}
                      </td>
                      <td className="px-3 py-2 text-right font-mono-data font-semibold">{fmtInt(r.boxes)}</td>
                      <td className="px-3 py-2 text-right font-mono-data">{fmtAUD(r.boxes * rate)}</td>
                      <td className="px-2 py-2 text-right">
                        <button onClick={() => removeReport(r.id)} className="text-xs text-red-600 hover:underline" data-testid={`delete-report-${r.id}`}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                {reports.length > 0 && (
                  <tfoot>
                    <tr className="bg-zinc-100 border-t-2 border-zinc-900">
                      <td className="px-3 py-2 font-heading" colSpan={2}>Total</td>
                      <td className="px-3 py-2 text-right font-mono-data font-bold">{fmtInt(summary?.total_boxes || 0)}</td>
                      <td className="px-3 py-2 text-right font-mono-data font-bold">{fmtAUD(summary?.earnings || 0)}</td>
                      <td></td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
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
      <div className={`mt-2 font-heading text-3xl sm:text-4xl leading-none ${mono ? "font-mono-data" : ""}`}>{value}</div>
    </div>
  );
}
