import { useEffect, useState } from "react";
import { api, API, formatApiError } from "../lib/api";
import Layout from "../components/Layout";
import { toast } from "sonner";

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function AdminGenerator() {
  const [prefix, setPrefix] = useState("BOX-");
  const [count, setCount] = useState(24);
  const [start, setStart] = useState(1);
  const [pad, setPad] = useState(4);
  const [templateKey, setTemplateKey] = useState("a4_3x8");
  const [templates, setTemplates] = useState([]);
  const [addToDate, setAddToDate] = useState(todayISO());
  const [addToWhitelist, setAddToWhitelist] = useState(true);
  const [preview, setPreview] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get("/barcodes/templates")
      .then((r) => setTemplates(r.data.templates || []))
      .catch(() => {});
  }, []);

  const currentTpl = templates.find((t) => t.key === templateKey);
  const perPage = currentTpl?.per_page || 0;

  useEffect(() => {
    // Auto-suggest the exact quantity to fill one page when template changes
    if (perPage && (Number(count) === 0 || Number(count) > 500)) {
      setCount(perPage);
    }
  }, [templateKey, perPage]); // eslint-disable-line

  const doPreview = async () => {
    try {
      const { data } = await api.post("/barcodes/preview", {
        prefix, count: Number(count), start: Number(start), pad: Number(pad), template: templateKey,
      });
      setPreview(data.codes);
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    }
  };

  const doGenerate = async () => {
    setBusy(true);
    try {
      const resp = await fetch(`${API}/barcodes/generate`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("bw_token") || ""}`,
        },
        body: JSON.stringify({
          prefix,
          count: Number(count),
          start: Number(start),
          pad: Number(pad),
          template: templateKey,
          add_to_whitelist_date: addToWhitelist ? addToDate : null,
        }),
      });
      if (!resp.ok) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(j.detail || `HTTP ${resp.status}`);
      }
      const total = resp.headers.get("X-Codes-Total");
      const first = resp.headers.get("X-Codes-First");
      const last = resp.headers.get("X-Codes-Last");
      const wl = resp.headers.get("X-Whitelisted");
      const blob = await resp.blob();
      const a = document.createElement("a");
      const url = URL.createObjectURL(blob);
      const dispo = resp.headers.get("Content-Disposition") || "";
      const nameMatch = dispo.match(/filename="?([^"]+)"?/i);
      a.href = url;
      a.download = nameMatch?.[1] || `barcodes_${first}_to_${last}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      toast.success(
        `PDF ready · ${total} labels (${first} → ${last})${addToWhitelist ? ` · ${wl} added to whitelist ${addToDate}` : ""}`
      );
      setStart((s) => Number(s) + Number(count));
      setPreview([]);
    } catch (e) {
      toast.error(e.message || "Generation failed");
    } finally {
      setBusy(false);
    }
  };

  const fitToPage = () => {
    if (perPage) setCount(perPage);
  };

  return (
    <Layout>
      <div className="mb-6">
        <div className="inline-block bg-yellow-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-zinc-950 mb-2">
          Admin · Barcode Generator
        </div>
        <h1 className="font-heading text-5xl md:text-6xl leading-none">Print Barcodes</h1>
        <p className="text-zinc-500 mt-2">
          Pick your label sheet (Avery 5160, L7160…), auto-generate a batch of unique Code 128 codes,
          and download a pixel-aligned printable PDF — stick, scan, ship.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <div className="card-sharp p-5 lg:col-span-2 space-y-4" data-testid="generator-form">
          <div>
            <label className="block font-heading text-xs mb-1 text-zinc-700">Label paper</label>
            <select
              value={templateKey}
              onChange={(e) => setTemplateKey(e.target.value)}
              className="input-sharp"
              data-testid="gen-template"
            >
              {templates.map((t) => (
                <option key={t.key} value={t.key}>{t.label}</option>
              ))}
            </select>
            {currentTpl && (
              <div className="mt-2 border border-zinc-200 bg-zinc-50 px-2 py-1.5 flex items-center gap-3 text-[11px] font-mono-data" data-testid="template-info">
                <span><b>{currentTpl.page}</b></span>
                <span>{currentTpl.cols} × {currentTpl.rows}</span>
                <span className="ml-auto text-zinc-700"><b>{perPage}</b> per page</span>
              </div>
            )}
          </div>

          <div>
            <label className="block font-heading text-xs mb-1 text-zinc-700">Prefix</label>
            <input
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              placeholder="BOX-"
              className="input-sharp font-mono-data"
              data-testid="gen-prefix"
            />
            <div className="text-[11px] text-zinc-500 mt-1">
              Codes look like <span className="font-mono-data">{prefix}{String(start).padStart(Number(pad) || 1, "0")}</span>.
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block font-heading text-xs mb-1 text-zinc-700">Quantity</label>
              <input
                type="number" min={1} max={500}
                value={count}
                onChange={(e) => setCount(e.target.value)}
                className="input-sharp font-mono-data"
                data-testid="gen-count"
              />
              {perPage > 0 && (
                <button
                  type="button"
                  onClick={fitToPage}
                  className="text-[10px] uppercase tracking-widest text-zinc-700 hover:underline mt-1"
                  data-testid="fit-page"
                  title={`Match this sheet exactly (${perPage} labels)`}
                >
                  ↺ Fit page ({perPage})
                </button>
              )}
            </div>
            <div>
              <label className="block font-heading text-xs mb-1 text-zinc-700">Start #</label>
              <input
                type="number" min={0}
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className="input-sharp font-mono-data"
                data-testid="gen-start"
              />
            </div>
            <div>
              <label className="block font-heading text-xs mb-1 text-zinc-700">Pad</label>
              <input
                type="number" min={1} max={12}
                value={pad}
                onChange={(e) => setPad(e.target.value)}
                className="input-sharp font-mono-data"
                data-testid="gen-pad"
              />
            </div>
          </div>

          {perPage > 0 && Number(count) !== perPage && (
            <div
              className={`text-[11px] px-2 py-1.5 border-l-4 ${Number(count) < perPage ? "border-yellow-500 bg-yellow-50" : "border-blue-500 bg-blue-50"}`}
              data-testid="quantity-hint"
            >
              {Number(count) < perPage
                ? `Only ${count} of ${perPage} label slots will be used — the rest of the sheet stays blank.`
                : `${count} labels = ${Math.ceil(Number(count) / perPage)} pages of ${perPage}.`}
            </div>
          )}

          <div className="border border-zinc-200 p-3 space-y-2">
            <label className="text-xs flex items-center gap-2 text-zinc-800 font-heading">
              <input
                type="checkbox"
                checked={addToWhitelist}
                onChange={(e) => setAddToWhitelist(e.target.checked)}
                data-testid="gen-add-whitelist"
              />
              Also add to whitelist
            </label>
            <input
              type="date"
              value={addToDate}
              onChange={(e) => setAddToDate(e.target.value)}
              disabled={!addToWhitelist}
              className="input-sharp font-mono-data"
              data-testid="gen-whitelist-date"
              style={{ opacity: addToWhitelist ? 1 : 0.4 }}
            />
          </div>

          <div className="flex gap-2 pt-1">
            <button
              onClick={doPreview}
              className="btn-outline-ink flex-1 py-3 text-xs"
              data-testid="gen-preview-btn"
            >
              Preview
            </button>
            <button
              onClick={doGenerate}
              disabled={busy}
              className="btn-yellow flex-1 py-3 text-xs"
              data-testid="gen-download-btn"
            >
              {busy ? "Generating…" : "↓ Download PDF"}
            </button>
          </div>
        </div>

        <div className="card-sharp p-5 lg:col-span-3" data-testid="preview-card">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <div>
              <h2 className="font-heading text-xl">Preview</h2>
              {currentTpl && <p className="text-xs text-zinc-500">Grid mirrors <b>{currentTpl.label}</b></p>}
            </div>
            {preview.length > 0 && (
              <span className="text-xs text-zinc-500 font-mono-data">
                {preview.length} codes · {preview[0]} → {preview[preview.length - 1]}
              </span>
            )}
          </div>
          {preview.length === 0 ? (
            <div className="border-2 border-dashed border-zinc-300 p-10 text-center text-zinc-500 text-sm">
              <div className="font-heading text-2xl text-zinc-950 mb-1">PRESS PREVIEW</div>
              Codes appear here in the same {currentTpl?.cols || 3}×{currentTpl?.rows || 8} arrangement they'll print in.
            </div>
          ) : (
            <div
              className="gap-1 max-h-[520px] overflow-y-auto grid"
              style={{ gridTemplateColumns: `repeat(${currentTpl?.cols || 3}, minmax(0, 1fr))` }}
            >
              {preview.map((c, i) => (
                <div key={c} className="border border-zinc-200 bg-white px-1 py-2 flex flex-col items-center justify-center min-h-[60px]" data-testid={`preview-${i}`}>
                  <div className="w-full h-1 bg-zinc-950 mb-1"></div>
                  <div className="font-mono-data text-[11px] font-bold text-zinc-950 text-center break-all">{c}</div>
                  <div className="text-[8px] uppercase tracking-widest text-zinc-500 mt-0.5">BOXWISE</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}
