import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { api, API, formatApiError } from "../lib/api";
import { isoWeekKey, todayISO, weekLabel } from "../lib/format";
import Layout from "../components/Layout";
import { toast } from "sonner";

// Payroll week is Wed → Tue.
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
const WEEKDAY_LABELS = ["WED", "THU", "FRI", "SAT", "SUN", "MON", "TUE"];

export default function AdminWhitelist() {
  const [mode, setMode] = useState("day"); // day | week
  const [dateStr, setDateStr] = useState(todayISO());
  const [week, setWeek] = useState(isoWeekKey());
  const [selectedDays, setSelectedDays] = useState([true, true, true, true, true, false, false]);
  const [text, setText] = useState("");
  const [replace, setReplace] = useState(false);
  const [entries, setEntries] = useState([]);
  const [dayTotals, setDayTotals] = useState({});
  const [busy, setBusy] = useState(false);
  const [suspicious, setSuspicious] = useState([]);
  const [rejections, setRejections] = useState([]);
  const fileRef = useRef(null);

  const dates = useMemo(() => weekDates(week), [week]);

  const load = useCallback(async () => {
    try {
      if (mode === "day") {
        const [wl, sus, rej] = await Promise.all([
          api.get(`/whitelist?date_=${dateStr}`),
          api.get(`/scans/suspicious?limit=50`),
          api.get(`/scans/rejections?limit=100`),
        ]);
        setEntries(wl.data.barcodes || []);
        setSuspicious((sus.data || []).filter((s) => s.date === dateStr));
        setRejections((rej.data || []).filter((r) => r.date === dateStr));
      } else {
        const totals = {};
        const responses = await Promise.all(dates.map((d) => api.get(`/whitelist?date_=${d}`)));
        responses.forEach((r, i) => { totals[dates[i]] = r.data.total || 0; });
        setDayTotals(totals);
        const [sus, rej] = await Promise.all([
          api.get(`/scans/suspicious?limit=200`),
          api.get(`/scans/rejections?limit=200`),
        ]);
        setSuspicious((sus.data || []).filter((s) => dates.includes(s.date)));
        setRejections((rej.data || []).filter((r) => dates.includes(r.date)));
      }
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    }
  }, [mode, dateStr, week, dates]);

  useEffect(() => { load(); }, [load]);

  // Parse textarea:
  //   Plain lines "BARCODE" → assigned to all selected days
  //   Lines "YYYY-MM-DD,BARCODE" or "YYYY-MM-DD BARCODE" → assigned to that exact date
  const parsedEntries = useMemo(() => {
    const lines = text.split(/[\n]+/).map((l) => l.trim()).filter(Boolean);
    const entries = [];
    const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
    const activeDates = mode === "day"
      ? [dateStr]
      : dates.filter((_, i) => selectedDays[i]);
    for (const raw of lines) {
      const parts = raw.split(/[,;\t\s]+/).filter(Boolean);
      if (parts.length >= 2 && isDate(parts[0])) {
        // per-line date + barcode(s)
        const d = parts[0];
        for (const b of parts.slice(1)) entries.push({ date: d, barcode: b });
      } else {
        // plain barcode(s), tokenize
        for (const b of parts) {
          if (!isDate(b)) {
            for (const d of activeDates) entries.push({ date: d, barcode: b });
          }
        }
      }
    }
    // Dedupe
    const seen = new Set();
    return entries.filter((e) => {
      const k = `${e.date}::${e.barcode}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [text, mode, dateStr, dates, selectedDays]);

  const perDayPreview = useMemo(() => {
    const m = {};
    for (const e of parsedEntries) m[e.date] = (m[e.date] || 0) + 1;
    return m;
  }, [parsedEntries]);

  const upload = async () => {
    if (parsedEntries.length === 0) {
      toast.error("Paste some barcodes first");
      return;
    }
    setBusy(true);
    try {
      if (mode === "day") {
        // Use the day endpoint for backward compat
        const { data } = await api.post("/whitelist", {
          date: dateStr,
          barcodes: parsedEntries.map((e) => e.barcode),
          replace,
        });
        toast.success(`Day saved · ${data.total} barcodes for ${dateStr}`);
      } else {
        const payload = { entries: parsedEntries };
        if (replace) payload.replace_week = week;
        const { data } = await api.post("/whitelist/bulk", payload);
        toast.success(`Week saved · ${data.inserted} added, ${data.skipped} already existed · ${data.days_affected} day(s)`);
      }
      setText("");
      setReplace(false);
      await load();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    } finally {
      setBusy(false);
    }
  };

  const clearAll = async () => {
    if (mode === "day") {
      if (!window.confirm(`Clear the whitelist for ${dateStr}?`)) return;
      try {
        await api.delete(`/whitelist?date_=${dateStr}`);
        toast.success("Day cleared");
        await load();
      } catch (e) { toast.error(formatApiError(e.response?.data?.detail)); }
    } else {
      if (!window.confirm(`Clear the ENTIRE week ${week}?`)) return;
      try {
        // Use bulk endpoint with replace_week + empty valid list → workaround: pass replace_week and one dummy? Simpler: call delete per day in parallel.
        await Promise.all(dates.map((d) => api.delete(`/whitelist?date_=${d}`)));
        toast.success(`Week ${week} cleared`);
        await load();
      } catch (e) { toast.error(formatApiError(e.response?.data?.detail)); }
    }
  };

  const onFile = async (file) => {
    if (!file) return;
    const raw = await file.text();
    setText((prev) => (prev ? prev + "\n" : "") + raw);
    toast.success(`Loaded ${file.name}`);
  };

  const downloadRejections = (fmt, all = false) => {
    const params = new URLSearchParams();
    if (!all) {
      if (mode === "day") {
        params.set("from_date", dateStr);
        params.set("to_date", dateStr);
      } else {
        params.set("from_date", dates[0]);
        params.set("to_date", dates[6]);
      }
    }
    const suffix = params.toString() ? `?${params.toString()}` : "";
    const path = `/scans/rejections/${fmt}${suffix}`;
    fetch(`${API}${path}`, {
      credentials: "include",
      headers: { Authorization: `Bearer ${localStorage.getItem("bw_token") || ""}` },
    })
      .then((r) => { if (!r.ok) throw new Error("dl"); return r.blob(); })
      .then((blob) => {
        const a = document.createElement("a");
        const url = URL.createObjectURL(blob);
        a.href = url;
        const scope = all ? "all" : (mode === "day" ? dateStr : `week_${week}`);
        a.download = `rejections_${scope}.${fmt}`;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
        toast.success(`${fmt.toUpperCase()} downloaded`);
      })
      .catch(() => toast.error("Download failed"));
  };

  const enforcementOn = mode === "day"
    ? entries.length > 0
    : Object.values(dayTotals).some((v) => v > 0);
  const weekTotal = Object.values(dayTotals).reduce((a, b) => a + b, 0);

  return (
    <Layout>
      <div className="mb-6">
        <div className="inline-block bg-yellow-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-zinc-950 mb-2">
          Admin · Barcode Whitelist
        </div>
        <h1 className="font-heading text-5xl md:text-6xl leading-none">Barcode Whitelist</h1>
        <p className="text-zinc-500 mt-2">
          Upload the barcodes you expect for a single day or a whole week. Scans that don't match
          get flagged as <span className="font-bold">SUSPICIOUS</span> — nothing is blocked, so real
          work never stops.
        </p>
      </div>

      {/* Mode toggle */}
      <div className="flex items-center gap-2 mb-4" data-testid="mode-toggle">
        {["day", "week"].map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`px-4 py-2 text-xs font-heading tracking-widest border-2 ${mode === m ? "bg-zinc-950 text-white border-zinc-950" : "bg-white border-zinc-300 text-zinc-700 hover:border-zinc-950"}`}
            data-testid={`mode-${m}`}
          >
            {m.toUpperCase()}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Upload card */}
        <div className="card-sharp p-5 lg:col-span-2 space-y-4" data-testid="upload-card">
          {mode === "day" ? (
            <div>
              <label className="block font-heading text-xs mb-1 text-zinc-700">Date</label>
              <input
                type="date"
                value={dateStr}
                onChange={(e) => setDateStr(e.target.value)}
                className="input-sharp font-mono-data"
                data-testid="whitelist-date"
              />
            </div>
          ) : (
            <>
              <div>
                <label className="block font-heading text-xs mb-1 text-zinc-700">Payroll Week (Wed → Tue)</label>
                <input
                  type="text"
                  value={week}
                  onChange={(e) => setWeek(e.target.value)}
                  placeholder="W2026-08-05"
                  className="input-sharp font-mono-data"
                  data-testid="whitelist-week"
                />
                <div className="text-[11px] text-zinc-500 mt-1 font-mono-data">
                  {weekLabel(week)}
                </div>
              </div>
              <div>
                <label className="block font-heading text-xs mb-2 text-zinc-700">
                  Apply plain barcodes to
                </label>
                <div className="grid grid-cols-7 gap-1">
                  {WEEKDAY_LABELS.map((lbl, i) => (
                    <button
                      type="button"
                      key={lbl}
                      onClick={() => {
                        const next = [...selectedDays];
                        next[i] = !next[i];
                        setSelectedDays(next);
                      }}
                      className={`text-[10px] font-heading py-2 border ${selectedDays[i] ? "bg-yellow-500 border-yellow-500 text-zinc-950" : "bg-white border-zinc-300 text-zinc-500"}`}
                      data-testid={`day-toggle-${i}`}
                      title={dates[i]}
                    >
                      {lbl}
                    </button>
                  ))}
                </div>
                <div className="text-[11px] text-zinc-500 mt-1">
                  Lines with a date prefix (e.g. <code>2026-08-04,BOX-042</code>) override this.
                </div>
              </div>
            </>
          )}

          <div>
            <label className="block font-heading text-xs mb-1 text-zinc-700">
              Barcodes
            </label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={10}
              placeholder={mode === "day"
                ? `BOX-0001\nBOX-0002\nBOX-0003`
                : `BOX-0001\nBOX-0002\n2026-08-04,BOX-0100\n2026-08-05 BOX-0200`}
              className="input-sharp font-mono-data text-sm"
              data-testid="whitelist-textarea"
            />
            <div className="text-[11px] text-zinc-500 mt-1">
              Preview: {parsedEntries.length} whitelisted entr{parsedEntries.length === 1 ? "y" : "ies"}
              {mode === "week" && parsedEntries.length > 0 && (
                <span> across {Object.keys(perDayPreview).length} day(s)</span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.txt,text/plain,text/csv"
              hidden
              onChange={(e) => onFile(e.target.files?.[0])}
              data-testid="whitelist-file"
            />
            <button
              onClick={() => fileRef.current?.click()}
              className="btn-outline-ink px-3 py-2 text-xs"
              data-testid="whitelist-upload-file"
            >
              ↑ Load CSV / TXT
            </button>
            <label className="text-xs flex items-center gap-1 text-zinc-700">
              <input
                type="checkbox"
                checked={replace}
                onChange={(e) => setReplace(e.target.checked)}
                data-testid="whitelist-replace"
              />
              Replace existing
            </label>
          </div>

          <div className="flex gap-2 pt-2">
            <button
              onClick={upload}
              disabled={busy}
              className="btn-yellow flex-1 py-3 text-xs"
              data-testid="whitelist-save"
            >
              {busy ? "Saving…" : `Save ${mode} whitelist →`}
            </button>
            <button
              onClick={clearAll}
              className="btn-outline-ink px-3 py-3 text-xs border-red-600 text-red-600 hover:bg-red-600 hover:text-white"
              data-testid="whitelist-clear"
              disabled={!enforcementOn}
              style={{ opacity: enforcementOn ? 1 : 0.5 }}
            >
              Clear {mode}
            </button>
          </div>
        </div>

        {/* Status + panels */}
        <div className="lg:col-span-3 space-y-4">
          <div className={`card-sharp p-5 ${enforcementOn ? "bg-yellow-500 border-yellow-500" : ""}`} data-testid="status-card">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <div className="font-heading text-xs tracking-widest">
                  Enforcement · {mode === "day" ? dateStr : `Week ${week}`}
                </div>
                <div className="font-heading text-3xl mt-1">
                  {enforcementOn ? "ACTIVE" : "OFF"}
                </div>
                <p className="text-xs mt-1 max-w-md">
                  {mode === "day"
                    ? (enforcementOn ? `${entries.length} barcode(s) expected. Scans outside are flagged.` : "No whitelist for this day — all scans accepted.")
                    : (enforcementOn ? `${weekTotal} barcode(s) expected across the week. Scans outside are flagged.` : "No whitelist for this week yet.")}
                </p>
              </div>
              <div className="text-right font-mono-data">
                <div className="text-[10px] uppercase tracking-widest">Suspicious</div>
                <div className="text-4xl font-bold" data-testid="suspicious-count">{suspicious.length}</div>
              </div>
            </div>
          </div>

          {mode === "week" && (
            <div className="card-sharp p-5" data-testid="week-grid">
              <h2 className="font-heading text-xl mb-3">Week overview</h2>
              <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-2">
                {dates.map((d, i) => (
                  <div key={d} className="border border-zinc-200 p-2 flex flex-col items-center" data-testid={`week-day-${i}`}>
                    <div className="font-heading text-[10px] tracking-widest text-zinc-500">{WEEKDAY_LABELS[i]}</div>
                    <div className="font-mono-data text-[10px] text-zinc-500">{d.slice(5)}</div>
                    <div className="mt-1 font-heading text-2xl">{dayTotals[d] || 0}</div>
                    {perDayPreview[d] > 0 && (
                      <div className="mt-1 text-[10px] uppercase tracking-widest bg-yellow-500 text-zinc-950 px-1 font-bold">
                        +{perDayPreview[d]}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="card-sharp p-5" data-testid="suspicious-card">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-heading text-xl">Suspicious scans</h2>
              <span className="text-xs text-zinc-500">
                {mode === "day" ? `On ${dateStr}` : `Across week ${week}`}
              </span>
            </div>
            <div className="overflow-x-auto border border-zinc-200 max-h-[220px] overflow-y-auto">
              <table className="w-full text-sm zebra" data-testid="suspicious-table">
                <thead className="bg-zinc-950 text-white sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2 font-heading text-xs">Time</th>
                    <th className="text-left px-3 py-2 font-heading text-xs">Worker</th>
                    <th className="text-left px-3 py-2 font-heading text-xs">Barcode</th>
                    <th className="text-left px-3 py-2 font-heading text-xs">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {suspicious.length === 0 && (
                    <tr><td colSpan={4} className="px-3 py-6 text-center text-zinc-500 text-xs">
                      {enforcementOn ? "No suspicious scans." : "Upload a whitelist to start flagging."}
                    </td></tr>
                  )}
                  {suspicious.map((s) => (
                    <tr key={s.id} className="border-t border-zinc-100 bg-red-50/40" data-testid={`sus-${s.id}`}>
                      <td className="px-3 py-2 font-mono-data text-xs whitespace-nowrap">{new Date(s.created_at).toLocaleTimeString()}</td>
                      <td className="px-3 py-2">{s.worker_name}</td>
                      <td className="px-3 py-2 font-mono-data text-xs break-all">{s.barcode}</td>
                      <td className="px-3 py-2 text-red-700 text-xs">{s.suspicious_reason || "unknown"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card-sharp p-5" data-testid="rejections-card">
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <h2 className="font-heading text-xl">Rejected scans</h2>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-zinc-500 hidden sm:inline">
                  Duplicates blocked from counting · {mode === "day" ? dateStr : `week ${week}`}
                </span>
                <button
                  onClick={() => downloadRejections("csv")}
                  className="btn-outline-ink px-3 py-1.5 text-[11px]"
                  data-testid="rejections-csv-btn"
                  disabled={rejections.length === 0}
                  style={{ opacity: rejections.length === 0 ? 0.4 : 1 }}
                >
                  ↓ CSV
                </button>
                <button
                  onClick={() => downloadRejections("pdf")}
                  className="btn-outline-ink px-3 py-1.5 text-[11px]"
                  data-testid="rejections-pdf-btn"
                  disabled={rejections.length === 0}
                  style={{ opacity: rejections.length === 0 ? 0.4 : 1 }}
                >
                  ↓ PDF
                </button>
                <button
                  onClick={() => downloadRejections("csv", true)}
                  className="text-[11px] text-zinc-700 hover:underline"
                  data-testid="rejections-all-btn"
                  title="Download all rejections ever"
                >
                  All ↗
                </button>
              </div>
            </div>
            <div className="overflow-x-auto border border-zinc-200 max-h-[220px] overflow-y-auto">
              <table className="w-full text-sm zebra" data-testid="rejections-table">
                <thead className="bg-zinc-950 text-white sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2 font-heading text-xs">Time</th>
                    <th className="text-left px-3 py-2 font-heading text-xs">Attempted by</th>
                    <th className="text-left px-3 py-2 font-heading text-xs">Barcode</th>
                    <th className="text-left px-3 py-2 font-heading text-xs">Original scan</th>
                  </tr>
                </thead>
                <tbody>
                  {rejections.length === 0 && (
                    <tr><td colSpan={4} className="px-3 py-6 text-center text-zinc-500 text-xs">
                      No rejected duplicate scans.
                    </td></tr>
                  )}
                  {rejections.map((r) => (
                    <tr key={r.id} className="border-t border-zinc-100 bg-orange-50/50" data-testid={`rej-${r.id}`}>
                      <td className="px-3 py-2 font-mono-data text-xs whitespace-nowrap">{new Date(r.created_at).toLocaleTimeString()}</td>
                      <td className="px-3 py-2">{r.worker_name}</td>
                      <td className="px-3 py-2 font-mono-data text-xs break-all">{r.barcode}</td>
                      <td className="px-3 py-2 text-xs text-zinc-600">
                        by <b>{r.original_worker_name || "—"}</b>
                        {r.original_scanned_at && <> at {new Date(r.original_scanned_at).toLocaleTimeString()}</>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {mode === "day" && (
            <div className="card-sharp p-5" data-testid="entries-card">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-heading text-xl">Whitelist · {dateStr}</h2>
                <span className="text-xs text-zinc-500">{entries.length} expected</span>
              </div>
              <div className="overflow-x-auto border border-zinc-200 max-h-[260px] overflow-y-auto">
                <table className="w-full text-sm zebra" data-testid="entries-table">
                  <thead className="bg-zinc-950 text-white sticky top-0">
                    <tr>
                      <th className="text-left px-3 py-2 font-heading text-xs">Barcode</th>
                      <th className="text-left px-3 py-2 font-heading text-xs">Uploaded</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.length === 0 && (
                      <tr><td colSpan={2} className="px-3 py-6 text-center text-zinc-500 text-xs">No barcodes yet for this day.</td></tr>
                    )}
                    {entries.map((b) => (
                      <tr key={b.barcode} className="border-t border-zinc-100">
                        <td className="px-3 py-2 font-mono-data text-xs break-all">{b.barcode}</td>
                        <td className="px-3 py-2 text-[11px] text-zinc-500">
                          {b.uploaded_by} · {new Date(b.uploaded_at).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}
