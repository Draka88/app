import { useEffect, useState, useCallback } from "react";
import { api, API, formatApiError } from "../lib/api";
import { fmtAUD, fmtInt, todayISO, isoWeekKey } from "../lib/format";
import Layout from "../components/Layout";
import { useAuth } from "../contexts/AuthContext";
import { toast } from "sonner";

export default function WorkerDashboard() {
  const { user } = useAuth();
  const [rate, setRate] = useState(0);
  const [weeks, setWeeks] = useState([]);
  const [week, setWeek] = useState(isoWeekKey());
  const [summary, setSummary] = useState(null);
  const [reports, setReports] = useState([]);
  const [boxes, setBoxes] = useState("");
  const [date, setDate] = useState(todayISO());
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [r, w, s, rep] = await Promise.all([
        api.get("/settings/rate"),
        api.get("/weeks"),
        api.get(`/summary/me?week=${week}`),
        api.get(`/reports/me?week=${week}`),
      ]);
      setRate(r.data.rate);
      setWeeks(w.data.weeks);
      setSummary(s.data);
      setReports(rep.data);
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    }
  }, [week]);

  useEffect(() => {
    load();
  }, [load]);

  const submit = async (e) => {
    e.preventDefault();
    const n = parseInt(boxes, 10);
    if (isNaN(n) || n < 0) {
      toast.error("Enter a valid box count");
      return;
    }
    setSubmitting(true);
    try {
      await api.post("/reports", { boxes: n, date, note: note || null });
      toast.success(`Reported ${n} boxes`);
      setBoxes("");
      setNote("");
      // Auto-switch view to the week of the reported date
      const wk = isoWeekKey(new Date(date));
      if (wk !== week) setWeek(wk);
      else await load();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    } finally {
      setSubmitting(false);
    }
  };

  const removeReport = async (id) => {
    try {
      await api.delete(`/reports/${id}`);
      toast.success("Report removed");
      load();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    }
  };

  const downloadPayslip = () => {
    const url = `${API}/payslip/${user.id}?week=${week}`;
    // Use fetch to include auth headers, then trigger a download
    fetch(url, {
      credentials: "include",
      headers: { Authorization: `Bearer ${localStorage.getItem("bw_token") || ""}` },
    })
      .then((r) => {
        if (!r.ok) throw new Error("Failed");
        return r.blob();
      })
      .then((blob) => {
        const a = document.createElement("a");
        const objUrl = URL.createObjectURL(blob);
        a.href = objUrl;
        a.download = `payslip_${user.name.replace(/\s+/g, "_")}_${week}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(objUrl);
      })
      .catch(() => toast.error("Failed to download payslip"));
  };

  return (
    <Layout>
      <div className="flex items-end justify-between mb-8 gap-4 flex-wrap">
        <div>
          <div className="inline-block bg-yellow-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-zinc-950 mb-2">
            {user?.name} · Worker
          </div>
          <h1 className="font-heading text-5xl md:text-6xl leading-none">
            My Shift Log
          </h1>
          <p className="text-zinc-500 mt-2">
            Report your daily box count. Your payslip updates in real time.
          </p>
        </div>
        <div>
          <label className="block font-heading text-xs mb-1 text-zinc-700">Week</label>
          <select
            className="input-sharp min-w-[180px]"
            value={week}
            onChange={(e) => setWeek(e.target.value)}
            data-testid="week-selector"
          >
            {weeks.map((w) => (
              <option key={w} value={w}>{w}</option>
            ))}
          </select>
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <Kpi label="Total Boxes (Week)" value={fmtInt(summary?.total_boxes || 0)} testid="kpi-boxes" />
        <Kpi label="Rate / Box" value={fmtAUD(rate)} testid="kpi-rate" mono />
        <Kpi
          label="Weekly Earnings"
          value={fmtAUD(summary?.earnings || 0)}
          testid="kpi-earnings"
          accent
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Reporting form */}
        <div className="card-sharp p-6 lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-heading text-2xl">Report Boxes</h2>
            <span className="text-[10px] uppercase tracking-widest text-zinc-500">
              Add daily entry
            </span>
          </div>
          <form onSubmit={submit} className="space-y-4" data-testid="report-form">
            <div>
              <label className="block font-heading text-xs mb-2 text-zinc-700">Boxes processed</label>
              <input
                type="number"
                min="0"
                step="1"
                required
                value={boxes}
                onChange={(e) => setBoxes(e.target.value)}
                placeholder="e.g. 24"
                className="input-sharp font-mono-data text-2xl"
                data-testid="report-boxes-input"
              />
            </div>
            <div>
              <label className="block font-heading text-xs mb-2 text-zinc-700">Date</label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="input-sharp font-mono-data"
                data-testid="report-date-input"
                required
              />
            </div>
            <div>
              <label className="block font-heading text-xs mb-2 text-zinc-700">Note (optional)</label>
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Shift comment"
                className="input-sharp"
                data-testid="report-note-input"
              />
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="btn-yellow w-full py-3 text-sm"
              data-testid="report-submit-button"
            >
              {submitting ? "Saving…" : "Log boxes →"}
            </button>
          </form>
        </div>

        {/* Weekly log + payslip */}
        <div className="card-sharp p-6 lg:col-span-3">
          <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
            <div>
              <h2 className="font-heading text-2xl">Weekly Log</h2>
              <p className="text-xs text-zinc-500">
                {summary?.week_start} → {summary?.week_end}
              </p>
            </div>
            <button
              onClick={downloadPayslip}
              className="btn-outline-ink px-4 py-2 text-xs"
              data-testid="payslip-download-button"
            >
              ↓ Download Payslip PDF
            </button>
          </div>

          <div className="overflow-x-auto border border-zinc-200">
            <table className="w-full text-sm zebra" data-testid="reports-table">
              <thead className="bg-zinc-950 text-white">
                <tr>
                  <th className="text-left px-3 py-2 font-heading text-xs">Date</th>
                  <th className="text-right px-3 py-2 font-heading text-xs">Boxes</th>
                  <th className="text-right px-3 py-2 font-heading text-xs">Amount</th>
                  <th className="text-left px-3 py-2 font-heading text-xs">Note</th>
                  <th className="px-2 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {reports.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-8 text-center text-zinc-500">
                      No entries yet this week. Log your first box count above.
                    </td>
                  </tr>
                )}
                {reports.map((r) => (
                  <tr key={r.id} className="border-t border-zinc-100" data-testid={`report-row-${r.id}`}>
                    <td className="px-3 py-2 font-mono-data">{r.date}</td>
                    <td className="px-3 py-2 text-right font-mono-data font-semibold">{fmtInt(r.boxes)}</td>
                    <td className="px-3 py-2 text-right font-mono-data">{fmtAUD(r.boxes * rate)}</td>
                    <td className="px-3 py-2 text-zinc-600">{r.note || "—"}</td>
                    <td className="px-2 py-2 text-right">
                      <button
                        onClick={() => removeReport(r.id)}
                        className="text-xs text-red-600 hover:underline"
                        data-testid={`delete-report-${r.id}`}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              {reports.length > 0 && (
                <tfoot>
                  <tr className="bg-zinc-100 border-t-2 border-zinc-900">
                    <td className="px-3 py-2 font-heading">Total</td>
                    <td className="px-3 py-2 text-right font-mono-data font-bold">
                      {fmtInt(summary?.total_boxes || 0)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono-data font-bold">
                      {fmtAUD(summary?.earnings || 0)}
                    </td>
                    <td colSpan={2}></td>
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
    <div
      className={`card-sharp p-6 ${accent ? "bg-yellow-500 border-yellow-500" : ""}`}
      data-testid={testid}
    >
      <div className={`font-heading text-xs tracking-widest ${accent ? "text-zinc-900" : "text-zinc-500"}`}>
        {label}
      </div>
      <div className={`mt-3 font-heading text-5xl leading-none ${mono ? "font-mono-data" : ""}`}>
        {value}
      </div>
    </div>
  );
}
