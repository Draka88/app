import { useEffect, useState, useCallback } from "react";
import { api, formatApiError } from "../lib/api";
import Layout from "../components/Layout";
import { toast } from "sonner";

const JOB_ROLES = [
  "Packer",
  "Loader",
  "Sorter",
  "Forklift Operator",
  "Line Lead",
  "Supervisor",
  "Quality Control",
  "Warehouse Assistant",
];

export default function AdminWorkers() {
  const [workers, setWorkers] = useState([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [jobRole, setJobRole] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [editRole, setEditRole] = useState("");

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
      await api.post("/workers", {
        email: email.trim().toLowerCase(),
        name: name.trim(),
        password,
        job_role: jobRole.trim() || null,
      });
      toast.success(`Added ${name}${jobRole ? ` — ${jobRole}` : ""}`);
      setName("");
      setEmail("");
      setPassword("");
      setJobRole("");
      load();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (w) => {
    setEditingId(w.id);
    setEditName(w.name);
    setEditRole(w.job_role || "");
  };

  const saveEdit = async (id) => {
    try {
      await api.patch(`/workers/${id}`, {
        name: editName.trim(),
        job_role: editRole.trim(),
      });
      toast.success("Worker updated");
      setEditingId(null);
      load();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
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

  const remove = async (id, n) => {
    if (!window.confirm(`Delete ${n}? Their box reports will also be removed.`)) return;
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
          Add worker names and roles. Each worker gets login credentials to report their own boxes.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <form onSubmit={add} className="card-sharp p-6 lg:col-span-2 space-y-4" data-testid="add-worker-form">
          <h2 className="font-heading text-2xl">Add Worker</h2>

          <div>
            <label className="block font-heading text-xs mb-2 text-zinc-700">Name</label>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="input-sharp"
              data-testid="worker-name-input"
              placeholder="e.g. Worker C"
            />
          </div>

          <div>
            <label className="block font-heading text-xs mb-2 text-zinc-700">Job role</label>
            <input
              value={jobRole}
              onChange={(e) => setJobRole(e.target.value)}
              className="input-sharp"
              data-testid="worker-jobrole-input"
              placeholder="e.g. Packer, Loader, Supervisor"
              list="job-roles-list"
            />
            <datalist id="job-roles-list">
              {JOB_ROLES.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
            <div className="mt-2 flex flex-wrap gap-1">
              {JOB_ROLES.map((r) => (
                <button
                  type="button"
                  key={r}
                  onClick={() => setJobRole(r)}
                  className={`text-[10px] uppercase tracking-widest px-2 py-1 border ${
                    jobRole === r
                      ? "bg-zinc-950 text-white border-zinc-950"
                      : "border-zinc-300 hover:border-zinc-950 text-zinc-700"
                  }`}
                  data-testid={`role-chip-${r.toLowerCase().replace(/\s+/g, "-")}`}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block font-heading text-xs mb-2 text-zinc-700">Email</label>
            <input
              required
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input-sharp"
              data-testid="worker-email-input"
              placeholder="worker.c@example.com"
            />
          </div>

          <div>
            <label className="block font-heading text-xs mb-2 text-zinc-700">Temporary password</label>
            <input
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input-sharp"
              data-testid="worker-password-input"
              placeholder="Min 6 chars"
            />
          </div>

          <button
            type="submit"
            disabled={busy}
            className="btn-yellow w-full py-3 text-sm"
            data-testid="worker-submit-button"
          >
            {busy ? "Adding…" : "Add worker →"}
          </button>
        </form>

        <div className="card-sharp p-6 lg:col-span-3">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-heading text-2xl">Roster</h2>
            <span className="text-[10px] uppercase tracking-widest text-zinc-500">
              {workers.length} {workers.length === 1 ? "worker" : "workers"}
            </span>
          </div>
          <div className="overflow-x-auto border border-zinc-200">
            <table className="w-full text-sm zebra" data-testid="workers-table">
              <thead className="bg-zinc-950 text-white">
                <tr>
                  <th className="text-left px-3 py-2 font-heading text-xs">Name</th>
                  <th className="text-left px-3 py-2 font-heading text-xs">Job role</th>
                  <th className="text-left px-3 py-2 font-heading text-xs">Email</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {workers.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-10 text-center text-zinc-500">
                      No workers yet. Add your first worker with the form on the left.
                    </td>
                  </tr>
                )}
                {workers.map((w) => (
                  <tr key={w.id} className="border-t border-zinc-100" data-testid={`worker-row-${w.id}`}>
                    <td className="px-3 py-2 font-heading text-base">
                      {editingId === w.id ? (
                        <input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          className="input-sharp"
                          data-testid={`edit-name-${w.id}`}
                        />
                      ) : (
                        w.name
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {editingId === w.id ? (
                        <input
                          value={editRole}
                          onChange={(e) => setEditRole(e.target.value)}
                          className="input-sharp"
                          list="job-roles-list"
                          data-testid={`edit-role-${w.id}`}
                        />
                      ) : w.job_role ? (
                        <span className="inline-block border border-zinc-900 px-2 py-0.5 text-[10px] uppercase tracking-widest font-bold">
                          {w.job_role}
                        </span>
                      ) : (
                        <span className="text-zinc-400 text-xs italic">unassigned</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-zinc-600">{w.email}</td>
                    <td className="px-3 py-2 text-right space-x-3 whitespace-nowrap">
                      {editingId === w.id ? (
                        <>
                          <button
                            onClick={() => saveEdit(w.id)}
                            className="text-xs font-bold text-zinc-950 hover:underline"
                            data-testid={`save-worker-${w.id}`}
                          >
                            Save
                          </button>
                          <button
                            onClick={() => setEditingId(null)}
                            className="text-xs text-zinc-500 hover:underline"
                            data-testid={`cancel-worker-${w.id}`}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => startEdit(w)}
                            className="text-xs text-zinc-700 hover:underline"
                            data-testid={`edit-worker-${w.id}`}
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => resetPw(w.id)}
                            className="text-xs text-zinc-700 hover:underline"
                            data-testid={`reset-pw-${w.id}`}
                          >
                            Reset password
                          </button>
                          <button
                            onClick={() => remove(w.id, w.name)}
                            className="text-xs text-red-600 hover:underline"
                            data-testid={`delete-worker-${w.id}`}
                          >
                            Delete
                          </button>
                        </>
                      )}
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
