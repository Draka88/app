import { useEffect, useState } from "react";
import { api, formatApiError } from "../lib/api";
import { fmtAUD } from "../lib/format";
import Layout from "../components/Layout";
import { toast } from "sonner";

export default function AdminSettings() {
  const [rate, setRate] = useState(0);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get("/settings/rate").then(({ data }) => {
      setRate(data.rate);
      setInput(String(data.rate));
    });
  }, []);

  const save = async (e) => {
    e.preventDefault();
    const v = parseFloat(input);
    if (isNaN(v) || v < 0) {
      toast.error("Enter a valid positive rate");
      return;
    }
    setBusy(true);
    try {
      const { data } = await api.put("/settings/rate", { rate: v });
      setRate(data.rate);
      toast.success(`Rate updated to ${fmtAUD(data.rate)} / box`);
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Layout>
      <div className="mb-8">
        <div className="inline-block bg-yellow-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-zinc-950 mb-2">
          Admin · Rate
        </div>
        <h1 className="font-heading text-5xl md:text-6xl leading-none">Payment Rate</h1>
        <p className="text-zinc-500 mt-2">
          Set the global rate per box in AUD. Applies to all workers, all reports.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="card-sharp p-6 bg-yellow-500 border-yellow-500" data-testid="current-rate-card">
          <div className="font-heading text-xs tracking-widest text-zinc-900">
            Current Rate / Box
          </div>
          <div className="mt-4 font-mono-data font-bold text-6xl leading-none">
            {fmtAUD(rate)}
          </div>
          <div className="mt-4 text-xs uppercase tracking-widest text-zinc-800">
            Currency · AUD
          </div>
        </div>

        <form onSubmit={save} className="card-sharp p-6 space-y-4" data-testid="rate-form">
          <h2 className="font-heading text-2xl">Update Rate</h2>
          <div>
            <label className="block font-heading text-xs mb-2 text-zinc-700">
              Rate per box (AUD)
            </label>
            <div className="flex items-stretch">
              <div className="bg-zinc-950 text-white px-4 grid place-items-center font-heading">A$</div>
              <input
                type="number"
                step="0.01"
                min="0"
                required
                value={input}
                onChange={(e) => setInput(e.target.value)}
                className="input-sharp font-mono-data text-2xl"
                data-testid="rate-input"
                placeholder="e.g. 1.75"
              />
            </div>
            <p className="text-xs text-zinc-500 mt-2">
              Example: 8 boxes × A$1.75 = A$14.00
            </p>
          </div>
          <button type="submit" disabled={busy} className="btn-yellow w-full py-3 text-sm" data-testid="rate-submit-button">
            {busy ? "Saving…" : "Save rate →"}
          </button>
        </form>
      </div>
    </Layout>
  );
}
