import { useEffect, useState, useCallback } from "react";
import { api, formatApiError } from "../lib/api";
import Layout from "../components/Layout";
import { toast } from "sonner";

const EMPTY = { name: "", latitude: "", longitude: "", radius_m: 50, active: true };

export default function AdminWorksites() {
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState(EMPTY);
  const [editingId, setEditingId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get("/worksites");
      setRows(data || []);
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const useMyLocation = () => {
    if (!navigator.geolocation) {
      toast.error("Geolocation is not available on this device");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setForm((f) => ({
          ...f,
          latitude: pos.coords.latitude.toFixed(6),
          longitude: pos.coords.longitude.toFixed(6),
        }));
        toast.success(`GPS captured (±${Math.round(pos.coords.accuracy)}m)`);
        setLocating(false);
      },
      (err) => {
        setLocating(false);
        toast.error(err.message || "Unable to get GPS location. Please enable location permission.");
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  };

  const reset = () => { setForm(EMPTY); setEditingId(null); };

  const save = async () => {
    if (!form.name.trim()) return toast.error("Name is required");
    const lat = parseFloat(form.latitude);
    const lng = parseFloat(form.longitude);
    if (isNaN(lat) || isNaN(lng)) return toast.error("Valid latitude and longitude are required");
    const radius_m = parseInt(form.radius_m, 10);
    if (!radius_m || radius_m < 5) return toast.error("Radius must be at least 5m");
    setBusy(true);
    try {
      const payload = { name: form.name.trim(), latitude: lat, longitude: lng, radius_m, active: !!form.active };
      if (editingId) {
        await api.patch(`/worksites/${editingId}`, payload);
        toast.success("Worksite updated");
      } else {
        await api.post("/worksites", payload);
        toast.success("Worksite created");
      }
      reset();
      load();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    } finally { setBusy(false); }
  };

  const edit = (r) => {
    setEditingId(r.id);
    setForm({
      name: r.name,
      latitude: String(r.latitude),
      longitude: String(r.longitude),
      radius_m: r.radius_m,
      active: r.active,
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const remove = async (r) => {
    if (!window.confirm(`Delete worksite "${r.name}"? Attendance records will keep their history.`)) return;
    try {
      await api.delete(`/worksites/${r.id}`);
      toast.success("Worksite deleted");
      load();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    }
  };

  return (
    <Layout>
      <div className="mb-6">
        <div className="inline-block bg-yellow-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-zinc-950 mb-2">
          Admin · Worksites
        </div>
        <h1 className="font-heading text-5xl md:text-6xl leading-none">Geofenced Locations</h1>
        <p className="text-zinc-500 mt-2">
          Register the workplaces where Supervisors are allowed to clock workers in/out.
          Attendance is rejected when the Supervisor's phone is outside the radius.
        </p>
      </div>

      <div className="card-sharp p-5 mb-8" data-testid="worksite-form">
        <h2 className="font-heading text-2xl mb-4">
          {editingId ? "Edit worksite" : "Add worksite"}
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div className="md:col-span-2">
            <label className="block font-heading text-xs mb-1 text-zinc-700">Name</label>
            <input
              className="input-sharp w-full"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Main Warehouse · Sydney"
              data-testid="worksite-name-input"
            />
          </div>
          <div>
            <label className="block font-heading text-xs mb-1 text-zinc-700">Radius (m)</label>
            <input
              type="number" min="5" max="5000"
              className="input-sharp w-full font-mono-data"
              value={form.radius_m}
              onChange={(e) => setForm({ ...form, radius_m: e.target.value })}
              data-testid="worksite-radius-input"
            />
          </div>
          <div className="flex items-end gap-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => setForm({ ...form, active: e.target.checked })}
                data-testid="worksite-active-input"
              />
              Active
            </label>
          </div>
          <div>
            <label className="block font-heading text-xs mb-1 text-zinc-700">Latitude</label>
            <input
              className="input-sharp w-full font-mono-data"
              value={form.latitude}
              onChange={(e) => setForm({ ...form, latitude: e.target.value })}
              placeholder="-33.865143"
              data-testid="worksite-lat-input"
            />
          </div>
          <div>
            <label className="block font-heading text-xs mb-1 text-zinc-700">Longitude</label>
            <input
              className="input-sharp w-full font-mono-data"
              value={form.longitude}
              onChange={(e) => setForm({ ...form, longitude: e.target.value })}
              placeholder="151.209900"
              data-testid="worksite-lng-input"
            />
          </div>
          <div className="md:col-span-2 flex items-end gap-2">
            <button
              onClick={useMyLocation}
              className="btn-outline-ink px-4 py-2 text-xs"
              disabled={locating}
              data-testid="use-my-location-btn"
            >
              {locating ? "Locating…" : "◎ Use my current GPS"}
            </button>
          </div>
        </div>
        <div className="mt-4 flex gap-2">
          <button
            onClick={save}
            className="btn-yellow px-6 py-3 text-sm"
            disabled={busy}
            data-testid="save-worksite-btn"
          >
            {busy ? "…" : editingId ? "Update worksite" : "Add worksite"}
          </button>
          {editingId && (
            <button onClick={reset} className="btn-outline-ink px-4 py-3 text-xs" data-testid="cancel-edit-btn">
              Cancel
            </button>
          )}
        </div>
      </div>

      <div className="card-sharp p-5">
        <h2 className="font-heading text-2xl mb-4">Registered locations</h2>
        <div className="overflow-x-auto border border-zinc-200">
          <table className="w-full text-sm zebra" data-testid="worksites-table">
            <thead className="bg-zinc-950 text-white">
              <tr>
                <th className="text-left px-3 py-2 font-heading text-xs">Name</th>
                <th className="text-left px-3 py-2 font-heading text-xs">GPS</th>
                <th className="text-right px-3 py-2 font-heading text-xs">Radius</th>
                <th className="text-center px-3 py-2 font-heading text-xs">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={5} className="px-3 py-10 text-center text-zinc-500">No worksites yet. Add one above.</td></tr>
              )}
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-zinc-100" data-testid={`worksite-row-${r.id}`}>
                  <td className="px-3 py-2 font-heading text-base">{r.name}</td>
                  <td className="px-3 py-2 font-mono-data text-xs">
                    {Number(r.latitude).toFixed(6)}, {Number(r.longitude).toFixed(6)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono-data">{r.radius_m}m</td>
                  <td className="px-3 py-2 text-center">
                    <span className={`inline-block px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest ${r.active ? "bg-yellow-500 text-zinc-950" : "bg-zinc-200 text-zinc-600"}`}>
                      {r.active ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap space-x-3">
                    <button
                      onClick={() => edit(r)}
                      className="text-xs text-zinc-700 hover:underline"
                      data-testid={`edit-worksite-${r.id}`}
                    >Edit</button>
                    <button
                      onClick={() => remove(r)}
                      className="text-xs text-red-600 hover:underline"
                      data-testid={`delete-worksite-${r.id}`}
                    >Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  );
}
