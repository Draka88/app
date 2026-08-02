import { useEffect, useState, useCallback } from "react";
import { api, formatApiError } from "../lib/api";
import Layout from "../components/Layout";
import { toast } from "sonner";

export default function AdminWorkers() {
  const [workers, setWorkers] = useState([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get("/workers");
      setWorkers(data);
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const add = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post("/workers", { email: email.trim().toLowerCase(), name: name.trim(), password });
      toast.success(`Added ${name}`);
      setName("");
      setEmail("");
      setPassword("");
      load();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    } finally {
      setBusy(false);
    }
  };

  const resetPw = async (id) => {
    const pw = prompt("New password (min 6 chars):", "");
    if (!pw || pw.length < 6) return;
    try {
      await api.patch(`/workers/${id}`, { password: pw });
      toast.success("Password reset");
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    }
  };

  const remove = async (id, name) => {
    if (!window.confirm(`Delete ${name}? Their box reports will also be removed.`)) return;
    try {
      await api.delete(`/workers/${id}`);
      toast.success("Worker removed");
      load();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    }
  };

  return (
    <Layout>
      <div className="mb-8">
        <div className="inline-block bg-yellow-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-zinc-950 mb-2">
          Admin · Workers
        </div>
        <h1 className="font-heading text-5xl md:text-6xl leading-none">Manage Workers</h1>
        <p className="text-zinc-500 mt-2">
          Create worker accounts. They can log in and report their own boxes.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <form onSubmit={add} className="card-sharp p-6 lg:col-span-2 space-y-4" data-testid="add-worker-form">
          <h2 className="font-heading text-2xl">Add Worker</h2>
          <div>
            <label className="block font-heading text-xs mb-2 text-zinc-700">Name</label>
            <input required value={name} onChange={(e) => setName(e.target.value)} className="input-sharp" data-testid="worker-name-input" placeholder="e.g. Worker C" />
          </div>
          <div>
            <label className="block font-heading text-xs mb-2 text-zinc-700">Email</label>
            <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="input-sharp" data-testid="worker-email-input" placeholder="worker.c@example.com" />
          </div>
          <div>
            <label className="block font-heading text-xs mb-2 text-zinc-700">Temporary password</label>
            <input required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} className="input-sharp" data-testid="worker-password-input" placeholder="Min 6 chars" />
          </div>
          <button type="submit" disabled={busy} className="btn-yellow w-full py-3 text-sm" data-testid="worker-submit-button">
            {busy ? "Adding…" : "Add worker →"}
          </button>
        </form>

        <div className="card-sharp p-6 lg:col-span-3">
          <h2 className="font-heading text-2xl mb-4">Roster</h2>
          <div className="overflow-x-auto border border-zinc-200">
            <table className="w-full text-sm zebra" data-testid="workers-table">
              <thead className="bg-zinc-950 text-white">
                <tr>
                  <th className="text-left px-3 py-2 font-heading text-xs">Name</th>
                  <th className="text-left px-3 py-2 font-heading text-xs">Email</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {workers.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-3 py-10 text-center text-zinc-500">
                      No workers yet.
                    </td>
                  </tr>
                )}
                {workers.map((w) => (
                  <tr key={w.id} className="border-t border-zinc-100" data-testid={`worker-row-${w.id}`}>
                    <td className="px-3 py-2 font-heading text-base">{w.name}</td>
                    <td className="px-3 py-2 text-zinc-600">{w.email}</td>
                    <td className="px-3 py-2 text-right space-x-2 whitespace-nowrap">
                      <button onClick={() => resetPw(w.id)} className="text-xs text-zinc-700 hover:underline" data-testid={`reset-pw-${w.id}`}>Reset password</button>
                      <button onClick={() => remove(w.id, w.name)} className="text-xs text-red-600 hover:underline" data-testid={`delete-worker-${w.id}`}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </Layout>
  );
}
