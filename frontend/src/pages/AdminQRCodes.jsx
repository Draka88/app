import { useEffect, useState, useCallback, useMemo } from "react";
import { api, API, formatApiError } from "../lib/api";
import Layout from "../components/Layout";
import { toast } from "sonner";

const TEMPLATES = [
  {
    key: "nametag",
    label: "Name Tag",
    desc: "2 × 4 large printable badges (8 per A4 page). Big QR + name + role.",
    perPage: 8,
  },
  {
    key: "idcard",
    label: "ID Card",
    desc: "2 × 5 dark wallet-style cards (10 per A4). Yellow header + QR + emp ID + role.",
    perPage: 10,
  },
  {
    key: "sticker",
    label: "Sticker Sheet",
    desc: "3 × 10 stickers per A4 page (30 per page). Small QR + name + emp ID.",
    perPage: 30,
  },
  {
    key: "grid",
    label: "Compact Grid",
    desc: "5 × 8 QR-only grid (40 per A4). QR + short name + emp ID underneath.",
    perPage: 40,
  },
];

export default function AdminQRCodes() {
  const [workers, setWorkers] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [template, setTemplate] = useState("nametag");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [brand, setBrand] = useState("#09090b");
  const [brandDraft, setBrandDraft] = useState("#09090b");
  const [savingBrand, setSavingBrand] = useState(false);

  const load = useCallback(async () => {
    try {
      const [ws, b] = await Promise.all([
        api.get("/workers"),
        api.get("/settings/brand"),
      ]);
      setWorkers(ws.data || []);
      setSelected(new Set((ws.data || []).map((w) => w.id)));
      const color = b.data?.color || "#09090b";
      setBrand(color); setBrandDraft(color);
    } catch (e) { toast.error(formatApiError(e.response?.data?.detail)); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const saveBrand = async () => {
    const v = (brandDraft || "").trim();
    if (!/^#?[0-9a-fA-F]{6}$/.test(v)) return toast.error("Enter a valid #RRGGBB hex colour");
    const color = v.startsWith("#") ? v.toLowerCase() : `#${v.toLowerCase()}`;
    setSavingBrand(true);
    try {
      const { data } = await api.put("/settings/brand", { color });
      setBrand(data.color); setBrandDraft(data.color);
      toast.success("Brand colour saved. Newly generated QR codes will use it.");
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    } finally { setSavingBrand(false); }
  };

  const presetColors = [
    ["#09090b", "Zinc black"],
    ["#1e40af", "Boxwise blue"],
    ["#166534", "Forest green"],
    ["#b91c1c", "Signal red"],
    ["#7c3aed", "Ultra violet"],
    ["#eab308", "Boxwise gold"],
  ];

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return workers;
    return workers.filter((w) =>
      w.name.toLowerCase().includes(term) ||
      (w.employee_id || "").toLowerCase().includes(term) ||
      (w.job_role || "").toLowerCase().includes(term)
    );
  }, [q, workers]);

  const toggle = (id) => {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };
  const setAll = (val) => setSelected(val ? new Set(workers.map((w) => w.id)) : new Set());

  const tpl = TEMPLATES.find((t) => t.key === template) || TEMPLATES[0];
  const pages = selected.size ? Math.ceil(selected.size / tpl.perPage) : 0;

  const download = async () => {
    if (selected.size === 0) return toast.error("Select at least one worker");
    setBusy(true);
    try {
      const res = await fetch(`${API}/workers/qr-codes`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("bw_token") || ""}`,
        },
        body: JSON.stringify({ worker_ids: Array.from(selected), template }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const a = document.createElement("a");
      const url = URL.createObjectURL(blob);
      a.href = url;
      a.download = `boxwise_qr_${template}_${selected.size}workers.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      toast.success(`${selected.size} QR code${selected.size === 1 ? "" : "s"} ready`);
    } catch (e) {
      toast.error("Failed to generate PDF");
    } finally { setBusy(false); }
  };

  const printNow = async () => {
    if (selected.size === 0) return toast.error("Select at least one worker");
    setBusy(true);
    try {
      const res = await fetch(`${API}/workers/qr-codes`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("bw_token") || ""}`,
        },
        body: JSON.stringify({ worker_ids: Array.from(selected), template }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const win = window.open(url, "_blank");
      if (win) {
        // Give the PDF viewer a moment then trigger print
        setTimeout(() => { try { win.focus(); win.print(); } catch (_e) { /* browser may block */ } }, 800);
      } else {
        toast.warning("Pop-up blocked — download the PDF instead");
      }
    } catch (e) {
      toast.error("Failed to open print view");
    } finally { setBusy(false); }
  };

  const downloadZip = async () => {
    if (selected.size === 0) return toast.error("Select at least one worker");
    setBusy(true);
    try {
      const res = await fetch(`${API}/workers/qr-codes/zip`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("bw_token") || ""}`,
        },
        body: JSON.stringify({ worker_ids: Array.from(selected), scale: 10, border: 2 }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const a = document.createElement("a");
      const url = URL.createObjectURL(blob);
      a.href = url;
      a.download = `boxwise_qr_pngs_${selected.size}workers.zip`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      toast.success(`ZIP with ${selected.size} PNG${selected.size === 1 ? "" : "s"} ready`);
    } catch (e) {
      toast.error("Failed to generate ZIP");
    } finally { setBusy(false); }
  };

  return (
    <Layout>
      <div className="mb-6">
        <div className="inline-block bg-yellow-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-zinc-950 mb-2">
          Admin · QR Codes
        </div>
        <h1 className="font-heading text-5xl md:text-6xl leading-none">Bulk QR Print</h1>
        <p className="text-zinc-500 mt-2 text-sm max-w-2xl">
          Generate printable QR codes for every worker so supervisors can scan them. Pick a template, choose which workers to include, then download or print.
        </p>
      </div>

      {/* Brand colour */}
      <div className="card-sharp p-5 mb-6" data-testid="brand-color-panel">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          <div>
            <h2 className="font-heading text-xl">Brand colour</h2>
            <p className="text-xs text-zinc-500">Used for QR modules on every newly generated PDF and PNG. High contrast against white is best.</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="border-2 border-zinc-900 w-12 h-12" style={{ background: brand }} title={`Saved: ${brand}`} data-testid="brand-saved-swatch" />
            <div className="text-xs">
              <div className="font-heading text-[10px] tracking-widest text-zinc-500">SAVED</div>
              <div className="font-mono-data text-sm">{brand}</div>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
          <div>
            <label className="block font-heading text-xs mb-1 text-zinc-700">Hex</label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={/^#[0-9a-fA-F]{6}$/.test(brandDraft) ? brandDraft : "#09090b"}
                onChange={(e) => setBrandDraft(e.target.value)}
                className="h-11 w-16 border-2 border-zinc-900 p-0 cursor-pointer"
                data-testid="brand-color-picker"
              />
              <input
                type="text"
                value={brandDraft}
                onChange={(e) => setBrandDraft(e.target.value)}
                placeholder="#09090b"
                className="input-sharp font-mono-data flex-1"
                data-testid="brand-color-input"
              />
            </div>
          </div>
          <div>
            <label className="block font-heading text-xs mb-1 text-zinc-700">Presets</label>
            <div className="flex flex-wrap gap-1.5">
              {presetColors.map(([hex, label]) => (
                <button
                  key={hex}
                  title={`${label} · ${hex}`}
                  onClick={() => setBrandDraft(hex)}
                  className={`w-8 h-8 border-2 ${brandDraft.toLowerCase() === hex ? "border-yellow-500 ring-2 ring-yellow-500" : "border-zinc-900"}`}
                  style={{ background: hex }}
                  data-testid={`brand-preset-${hex.slice(1)}`}
                />
              ))}
            </div>
          </div>
          <div>
            <button
              onClick={saveBrand}
              disabled={savingBrand}
              className="btn-yellow w-full py-3 text-sm"
              data-testid="brand-save-btn"
            >
              {savingBrand ? "…" : "Save brand colour →"}
            </button>
          </div>
        </div>
      </div>

      {/* Template picker */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-6" data-testid="template-picker">
        {TEMPLATES.map((t) => (
          <button
            key={t.key}
            onClick={() => setTemplate(t.key)}
            className={`p-4 border-2 text-left transition ${template === t.key ? "bg-zinc-950 text-white border-zinc-950" : "bg-white border-zinc-300 hover:border-zinc-950"}`}
            data-testid={`tpl-${t.key}`}
          >
            <div className={`inline-block px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest ${template === t.key ? "bg-yellow-500 text-zinc-950" : "bg-zinc-200 text-zinc-700"}`}>
              {t.perPage}/PAGE
            </div>
            <div className="font-heading text-2xl leading-none mt-2">{t.label}</div>
            <div className={`text-xs mt-2 ${template === t.key ? "text-zinc-300" : "text-zinc-500"}`}>{t.desc}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Worker selection */}
        <div className="lg:col-span-2 card-sharp p-5">
          <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
            <div>
              <h2 className="font-heading text-xl">Choose workers</h2>
              <p className="text-xs text-zinc-500">{selected.size} of {workers.length} selected</p>
            </div>
            <div className="flex items-center gap-2">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search name / ID / role"
                className="input-sharp text-sm min-w-[220px]"
                data-testid="qr-search"
              />
              <button onClick={() => setAll(true)} className="btn-outline-ink px-3 py-2 text-xs" data-testid="select-all">All</button>
              <button onClick={() => setAll(false)} className="btn-outline-ink px-3 py-2 text-xs" data-testid="select-none">None</button>
            </div>
          </div>
          <div className="border border-zinc-200 max-h-[520px] overflow-y-auto">
            <table className="w-full text-sm zebra" data-testid="qr-worker-table">
              <thead className="bg-zinc-950 text-white sticky top-0">
                <tr>
                  <th className="w-8 px-2 py-2"></th>
                  <th className="text-left px-3 py-2 font-heading text-xs">Emp ID</th>
                  <th className="text-left px-3 py-2 font-heading text-xs">Name</th>
                  <th className="text-left px-3 py-2 font-heading text-xs">Role</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr><td colSpan={4} className="px-3 py-10 text-center text-zinc-500 text-xs">No workers match.</td></tr>
                )}
                {filtered.map((w) => (
                  <tr key={w.id} className="border-t border-zinc-100" data-testid={`qr-row-${w.id}`}>
                    <td className="px-2 text-center">
                      <input type="checkbox" checked={selected.has(w.id)} onChange={() => toggle(w.id)} data-testid={`qr-check-${w.id}`} />
                    </td>
                    <td className="px-3 py-2 font-mono-data text-xs whitespace-nowrap">{w.employee_id || "—"}</td>
                    <td className="px-3 py-2 font-heading">{w.name}</td>
                    <td className="px-3 py-2 text-xs">
                      {w.job_role ? (
                        <span className="inline-block border border-zinc-900 px-1.5 py-0.5 text-[10px] uppercase tracking-widest font-bold">{w.job_role}</span>
                      ) : <span className="text-zinc-400 italic">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Action panel */}
        <div className="space-y-4">
          <div className="card-sharp p-5 bg-yellow-500 border-yellow-500" data-testid="qr-summary">
            <div className="font-heading text-[10px] tracking-widest text-zinc-900">TEMPLATE</div>
            <div className="font-heading text-3xl leading-none mt-1">{tpl.label}</div>
            <div className="mt-4 grid grid-cols-3 gap-2 text-center">
              <div className="bg-white border-2 border-zinc-950 p-2">
                <div className="font-heading text-[9px] tracking-widest text-zinc-500">SELECTED</div>
                <div className="font-heading text-2xl leading-none font-bold" data-testid="qr-count">{selected.size}</div>
              </div>
              <div className="bg-white border-2 border-zinc-950 p-2">
                <div className="font-heading text-[9px] tracking-widest text-zinc-500">PER PAGE</div>
                <div className="font-heading text-2xl leading-none font-bold">{tpl.perPage}</div>
              </div>
              <div className="bg-white border-2 border-zinc-950 p-2">
                <div className="font-heading text-[9px] tracking-widest text-zinc-500">PAGES</div>
                <div className="font-heading text-2xl leading-none font-bold" data-testid="qr-pages">{pages}</div>
              </div>
            </div>
          </div>
          <div className="card-sharp p-5 space-y-3">
            <button
              onClick={download}
              disabled={busy || selected.size === 0}
              className="btn-yellow w-full py-3 text-sm"
              data-testid="qr-download-btn"
            >
              {busy ? "…" : "↓ Download PDF"}
            </button>
            <button
              onClick={printNow}
              disabled={busy || selected.size === 0}
              className="btn-outline-ink w-full py-3 text-sm border-zinc-950"
              data-testid="qr-print-btn"
            >
              {busy ? "…" : "⎙ Print now"}
            </button>
            <div className="border-t border-zinc-200 pt-3">
              <button
                onClick={downloadZip}
                disabled={busy || selected.size === 0}
                className="btn-outline-ink w-full py-3 text-sm border-zinc-950"
                data-testid="qr-zip-btn"
              >
                {busy ? "…" : "🗜 Download PNG zip"}
              </button>
              <div className="text-[10px] uppercase tracking-widest text-zinc-500 mt-2 text-center">
                One PNG per worker + <code className="font-mono-data">index.csv</code>
              </div>
            </div>
            <div className="text-[11px] text-zinc-500 leading-relaxed">
              QR content is <code className="font-mono-data">BW-W:&lt;worker_id&gt;</code> so it works with the Scan Station out of the box. Print on plain A4 or Avery labels (sticker template) — landscape mode is not required.
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
}
