import { useEffect, useState, useCallback, useRef } from "react";
import { api, formatApiError } from "../lib/api";
import { toast } from "sonner";

function fmtDuration(startISO, endISO) {
  if (!startISO) return "—";
  const start = new Date(startISO).getTime();
  const end = endISO ? new Date(endISO).getTime() : Date.now();
  const s = Math.max(0, Math.floor((end - start) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${h}h ${String(m).padStart(2, "0")}m ${String(ss).padStart(2, "0")}s`;
}
function fmtTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function ClockInOut() {
  const [entry, setEntry] = useState(null); // {clock_in, clock_out, hours}
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const timerRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const { data } = await api.get(`/attendance/me?date_=${today}`);
      setEntry(data);
    } catch (e) {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // live ticker when actively clocked in
  useEffect(() => {
    if (entry && entry.clock_in && !entry.clock_out) {
      timerRef.current = setInterval(() => setTick((t) => t + 1), 1000);
      return () => clearInterval(timerRef.current);
    }
  }, [entry]);

  const clockIn = async () => {
    setBusy(true);
    try {
      const { data } = await api.post("/attendance/clock-in");
      setEntry(data);
      toast.success(`Clocked in at ${fmtTime(data.clock_in)}`);
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    } finally { setBusy(false); }
  };

  const clockOut = async () => {
    if (!window.confirm("Clock out now?")) return;
    setBusy(true);
    try {
      const { data } = await api.post("/attendance/clock-out");
      setEntry((prev) => ({ ...prev, ...data }));
      toast.success(`Clocked out · ${data.hours}h worked`, {
        description: "Hours saved automatically to today's payroll (Hourly mode).",
      });
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    } finally { setBusy(false); }
  };

  if (loading) return null;

  const active = entry && entry.clock_in && !entry.clock_out;
  const done = entry && entry.clock_out;
  const state = active ? "ACTIVE" : done ? "COMPLETED" : "READY";

  return (
    <div className={`card-sharp p-5 mb-6 ${active ? "bg-yellow-500 border-yellow-500" : ""}`} data-testid="clock-card">
      <div className="flex items-center gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`inline-block w-2.5 h-2.5 rounded-full ${active ? "bg-zinc-950 animate-pulse" : done ? "bg-zinc-400" : "bg-green-600"}`}></span>
            <span className="font-heading text-xs tracking-widest">TIME ATTENDANCE · {state}</span>
          </div>
          {active && (
            <>
              <div className="mt-2 font-heading text-4xl leading-none font-mono-data" data-testid="live-duration">
                {fmtDuration(entry.clock_in, null)}
              </div>
              <div className="mt-1 text-xs text-zinc-800">
                In at <b>{fmtTime(entry.clock_in)}</b> · live shift
              </div>
            </>
          )}
          {done && (
            <>
              <div className="mt-2 font-heading text-3xl leading-none">
                {entry.hours} h <span className="text-zinc-500 text-lg">worked today</span>
              </div>
              <div className="mt-1 text-xs text-zinc-600">
                In <b>{fmtTime(entry.clock_in)}</b> → Out <b>{fmtTime(entry.clock_out)}</b> · auto-saved to Hourly payroll
              </div>
            </>
          )}
          {!active && !done && (
            <>
              <div className="mt-2 font-heading text-3xl leading-none">Not clocked in</div>
              <div className="mt-1 text-xs text-zinc-500">
                Tap to start your shift. Hours will auto-fill your Hourly payroll for today.
              </div>
            </>
          )}
        </div>
        <div>
          {!active && !done && (
            <button
              onClick={clockIn}
              disabled={busy}
              className="btn-yellow px-6 py-4 text-sm"
              data-testid="clock-in-btn"
            >
              {busy ? "…" : "▶ Clock in"}
            </button>
          )}
          {active && (
            <button
              onClick={clockOut}
              disabled={busy}
              className="btn-outline-ink px-6 py-4 text-sm border-zinc-950"
              data-testid="clock-out-btn"
            >
              {busy ? "…" : "■ Clock out"}
            </button>
          )}
          {done && (
            <div className="font-mono-data text-xs text-zinc-600 text-right" data-testid="clock-done">
              Shift closed
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
