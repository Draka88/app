import { useEffect, useState, useCallback, useRef } from "react";
import { api, formatApiError } from "../lib/api";
import Layout from "../components/Layout";
import { toast } from "sonner";

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function AdminWhitelist() {
  const [dateStr, setDateStr] = useState(todayISO());
  const [text, setText] = useState("");
  const [replace, setReplace] = useState(false);
  const [entries, setEntries] = useState([]);
  const [busy, setBusy] = useState(false);
  const [suspicious, setSuspicious] = useState([]);
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const [wl, sus] = await Promise.all([
        api.get(`/whitelist?date_=${dateStr}`),
        api.get(`/scans/suspicious?limit=50`),
      ]);
      setEntries(wl.data.barcodes || []);
      setSuspicious((sus.data || []).filter((s) => s.date === dateStr));
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    }
  }, [dateStr]);

  useEffect(() => {
    load();
  }, [load]);

  const parseInput = () => {
    // Accept newline, comma, semicolon, or tab separated
    return text
      .split(/[\n,;\t]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  };

  const upload = async () => {
    const list = parseInput();
    if (list.length === 0) {
      toast.error("Paste some barcodes first");
      return;
    }
    setBusy(true);
    try {
      const { data } = await api.post("/whitelist", {
        date: dateStr,
        barcodes: list,
        replace,
      });
      toast.success(`Whitelist saved · ${data.total} barcodes total`);
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
    if (!window.confirm(`Clear the entire whitelist for ${dateStr}?`)) return;
    try {
      await api.delete(`/whitelist?date_=${dateStr}`);
      toast.success("Whitelist cleared");
      await load();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    }
  };

  const onFile = async (file) => {
    if (!file) return;
    const raw = await file.text();
    setText((prev) => (prev ? prev + "\n" : "") + raw);
    toast.success(`Loaded ${file.name}`);
  };

  const enforcementOn = entries.length > 0;

  return (
    <Layout>
      <div className="mb-6">
        <div className="inline-block bg-yellow-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-zinc-950 mb-2">
          Admin · Barcode Whitelist
        </div>
        <h1 className="font-heading text-5xl md:text-6xl leading-none">Daily Whitelist</h1>
        <p className="text-zinc-500 mt-2">
          Upload the barcodes you expect for the day. Scans that don't match get flagged as
          <span className="font-bold"> SUSPICIOUS</span> on the reports — nothing is blocked, so
          real work never stops.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Upload card */}
        <div className="card-sharp p-5 lg:col-span-2 space-y-4" data-testid="upload-card">
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

          <div>
            <label className="block font-heading text-xs mb-1 text-zinc-700">
              Barcodes (one per line, or comma-separated)
            </label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={10}
              placeholder={`BOX-0001\nBOX-0002\nBOX-0003`}
              className="input-sharp font-mono-data text-sm"
              data-testid="whitelist-textarea"
            />
            <div className="text-[11px] text-zinc-500 mt-1">
              Parsed: {parseInput().length} barcode{parseInput().length === 1 ? "" : "s"}
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
              {busy ? "Saving…" : "Save whitelist →"}
            </button>
            <button
              onClick={clearAll}
              className="btn-outline-ink px-3 py-3 text-xs border-red-600 text-red-600 hover:bg-red-600 hover:text-white"
              data-testid="whitelist-clear"
              disabled={!enforcementOn}
              style={{ opacity: enforcementOn ? 1 : 0.5 }}
            >
              Clear day
            </button>
          </div>
        </div>

        {/* Status + suspicious */}
        <div className="lg:col-span-3 space-y-4">
          <div className={`card-sharp p-5 ${enforcementOn ? "bg-yellow-500 border-yellow-500" : ""}`} data-testid="status-card">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <div className="font-heading text-xs tracking-widest">
                  Enforcement · {dateStr}
                </div>
                <div className="font-heading text-3xl mt-1">
                  {enforcementOn ? "ACTIVE" : "OFF"}
                </div>
                <p className="text-xs mt-1 max-w-md">
                  {enforcementOn
                    ? `${entries.length} barcode${entries.length === 1 ? "" : "s"} expected. Scans outside this list are flagged.`
                    : "No whitelist uploaded — all scans are accepted without flagging."}
                </p>
              </div>
              <div className="text-right font-mono-data">
                <div className="text-[10px] uppercase tracking-widest">Suspicious today</div>
                <div className="text-4xl font-bold" data-testid="suspicious-count">{suspicious.length}</div>
              </div>
            </div>
          </div>

          <div className="card-sharp p-5" data-testid="suspicious-card">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-heading text-xl">Suspicious scans</h2>
              <span className="text-xs text-zinc-500">Barcodes scanned but NOT on the whitelist</span>
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
                      {enforcementOn ? "No suspicious scans yet today." : "Upload a whitelist to start flagging."}
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

          <div className="card-sharp p-5" data-testid="entries-card">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-heading text-xl">Whitelist · {dateStr}</h2>
              <span className="text-xs text-zinc-500">{entries.length} expected barcodes</span>
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
        </div>
      </div>
    </Layout>
  );
}
