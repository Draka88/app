import { useEffect, useState, useCallback } from "react";
import { QRCodeSVG } from "qrcode.react";
import { api, API, formatApiError } from "../lib/api";
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
  const [worksites, setWorksites] = useState([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [jobRole, setJobRole] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [editRole, setEditRole] = useState("");
  const [editSiteIds, setEditSiteIds] = useState([]);

  const load = useCallback(async () => {
    try {
      const [w, s] = await Promise.all([
        api.get("/workers"),
        api.get("/worksites"),
      ]);
      setWorkers(w.data);
      setWorksites(s.data || []);
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
    setEditSiteIds(w.assigned_worksite_ids || []);
  };

  const saveEdit = async (id) => {
    try {
      await api.patch(`/workers/${id}`, {
        name: editName.trim(),
        job_role: editRole.trim(),
        assigned_worksite_ids: editSiteIds,
      });
      toast.success("Worker updated");
      setEditingId(null);
      load();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    }
  };

  const toggleSite = (id) => {
    setEditSiteIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
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
          Add worker names and roles, or share the mobile signup link and let workers register themselves. Use <span className="font-bold">✎ Rename</span> to update any worker's name or role.
        </p>
      </div>

      <ShareSignupLink />

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
          <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
            <h2 className="font-heading text-2xl">Roster</h2>
            <div className="flex items-center gap-3">
              <span className="text-[10px] uppercase tracking-widest text-zinc-500">
                {workers.length} {workers.length === 1 ? "worker" : "workers"}
              </span>
              <button
                onClick={() => {
                  fetch(`${API}/workers/nametags`, {
                    credentials: "include",
                    headers: { Authorization: `Bearer ${localStorage.getItem("bw_token") || ""}` },
                  })
                    .then((r) => { if (!r.ok) throw new Error(); return r.blob(); })
                    .then((blob) => {
                      const a = document.createElement("a");
                      const url = URL.createObjectURL(blob);
                      a.href = url; a.download = "worker_nametags.pdf";
                      document.body.appendChild(a); a.click(); a.remove();
                      URL.revokeObjectURL(url);
                      toast.success("All QR name tags downloaded");
                    })
                    .catch(() => toast.error("Download failed"));
                }}
                className="btn-outline-ink px-3 py-1.5 text-xs"
                data-testid="download-all-nametags"
              >
                ↓ All QR name tags
              </button>
            </div>
          </div>
          <div className="overflow-x-auto border border-zinc-200">
            <table className="w-full text-sm zebra" data-testid="workers-table">
              <thead className="bg-zinc-950 text-white">
                <tr>
                  <th className="text-left px-3 py-2 font-heading text-xs">Emp ID</th>
                  <th className="text-left px-3 py-2 font-heading text-xs">Name</th>
                  <th className="text-left px-3 py-2 font-heading text-xs">Job role</th>
                  <th className="text-left px-3 py-2 font-heading text-xs">Assigned sites</th>
                  <th className="text-left px-3 py-2 font-heading text-xs">Email</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {workers.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-10 text-center text-zinc-500">
                      No workers yet. Add your first worker with the form on the left.
                    </td>
                  </tr>
                )}
                {workers.map((w) => (
                  <tr key={w.id} className="border-t border-zinc-100" data-testid={`worker-row-${w.id}`}>
                    <td className="px-3 py-2 font-mono-data text-xs whitespace-nowrap" data-testid={`emp-id-${w.id}`}>
                      {w.employee_id || <span className="text-zinc-400 italic">—</span>}
                    </td>
                    <td className="px-3 py-2 font-heading text-base">
                      {editingId === w.id ? (
                        <input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          className="input-sharp"
                          data-testid={`edit-name-${w.id}`}
                        />
                      ) : (
                        <div className="flex items-center gap-2 flex-wrap">
                          <span>{w.name}</span>
                          {w.self_registered && (
                            <span className="text-[9px] uppercase tracking-widest bg-yellow-500 text-zinc-950 px-1.5 py-0.5 font-bold" data-testid={`self-registered-${w.id}`}>
                              Self-signup
                            </span>
                          )}
                        </div>
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
                    <td className="px-3 py-2">
                      {editingId === w.id ? (
                        <div className="space-y-1 max-w-[240px]" data-testid={`edit-sites-${w.id}`}>
                          {worksites.length === 0 && (
                            <div className="text-[11px] text-zinc-500 italic">No worksites yet</div>
                          )}
                          {worksites.map((s) => (
                            <label key={s.id} className="flex items-center gap-2 text-xs">
                              <input
                                type="checkbox"
                                checked={editSiteIds.includes(s.id)}
                                onChange={() => toggleSite(s.id)}
                                data-testid={`site-toggle-${w.id}-${s.id}`}
                              />
                              <span>{s.name}</span>
                              {!s.active && <span className="text-[9px] text-zinc-400">(inactive)</span>}
                            </label>
                          ))}
                          {editSiteIds.length === 0 && (
                            <div className="text-[10px] uppercase tracking-widest text-yellow-700 font-bold pt-1">
                              Empty = allowed at any site
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="flex flex-wrap gap-1 max-w-[240px]" data-testid={`sites-${w.id}`}>
                          {(w.assigned_worksite_ids || []).length === 0 ? (
                            <span className="text-[10px] uppercase tracking-widest text-zinc-500">Any site</span>
                          ) : (
                            (w.assigned_worksite_ids || []).map((sid) => {
                              const s = worksites.find((x) => x.id === sid);
                              if (!s) return null;
                              return (
                                <span key={sid} className="inline-block border border-zinc-900 bg-zinc-950 text-white px-1.5 py-0.5 text-[10px] uppercase tracking-widest font-bold">
                                  {s.name}
                                </span>
                              );
                            })
                          )}
                        </div>
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
                            onClick={() => {
                              fetch(`${API}/workers/${w.id}/nametag`, {
                                credentials: "include",
                                headers: { Authorization: `Bearer ${localStorage.getItem("bw_token") || ""}` },
                              })
                                .then((r) => { if (!r.ok) throw new Error(); return r.blob(); })
                                .then((blob) => {
                                  const a = document.createElement("a");
                                  const url = URL.createObjectURL(blob);
                                  a.href = url; a.download = `nametag_${w.name.replace(/\s+/g, "_")}.pdf`;
                                  document.body.appendChild(a); a.click(); a.remove();
                                  URL.revokeObjectURL(url);
                                })
                                .catch(() => toast.error("Download failed"));
                            }}
                            className="text-xs font-bold text-zinc-950 border border-zinc-300 px-2 py-1 hover:bg-zinc-950 hover:text-white transition-colors duration-150"
                            data-testid={`nametag-${w.id}`}
                          >
                            ↓ QR tag
                          </button>
                          <button
                            onClick={() => startEdit(w)}
                            className="text-xs font-bold text-zinc-950 border border-zinc-300 px-2 py-1 hover:bg-zinc-950 hover:text-white transition-colors duration-150"
                            data-testid={`edit-worker-${w.id}`}
                          >
                            ✎ Rename
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

function ShareSignupLink() {
  const url = `${window.location.origin}/register`;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success("Signup link copied");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Copy failed — copy manually");
    }
  };
  const downloadQR = () => {
    const svg = document.getElementById("signup-qr-svg");
    if (!svg) return;
    const serializer = new XMLSerializer();
    const svgStr = serializer.serializeToString(svg);
    const img = new Image();
    const svgBlob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
    const objectUrl = URL.createObjectURL(svgBlob);
    img.onload = () => {
      const size = 600;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, size, size);
      ctx.drawImage(img, 0, 0, size, size);
      canvas.toBlob((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "boxwise-signup-qr.png";
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(objectUrl);
      }, "image/png");
    };
    img.src = objectUrl;
  };
  return (
    <div className="card-sharp p-6 mb-6" data-testid="share-signup-card">
      <div className="grid grid-cols-1 md:grid-cols-[auto,1fr] gap-6 items-center">
        <div className="flex flex-col items-center gap-2">
          <div className="bg-white border-2 border-zinc-950 p-3" data-testid="signup-qr">
            <QRCodeSVG
              id="signup-qr-svg"
              value={url}
              size={168}
              level="M"
              includeMargin={false}
              bgColor="#ffffff"
              fgColor="#09090b"
            />
          </div>
          <button
            onClick={downloadQR}
            className="text-[10px] font-heading tracking-widest text-zinc-700 hover:text-zinc-950 underline"
            data-testid="download-qr"
          >
            ↓ Download PNG
          </button>
        </div>
        <div className="min-w-0">
          <div className="inline-block bg-yellow-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-zinc-950 mb-2">
            Scan · One-Tap Signup
          </div>
          <div className="font-heading text-2xl">Worker Self-Signup</div>
          <p className="text-sm text-zinc-500 mt-1">
            Show this QR to workers — they scan with a phone camera and land straight
            on the signup form. Once submitted, they auto-appear in your roster.
          </p>
          <div className="mt-3 font-mono-data text-xs bg-zinc-100 px-2 py-2 border border-zinc-200 break-all" data-testid="signup-link-value">
            {url}
          </div>
          <div className="mt-3 flex gap-2 flex-wrap">
            <button
              onClick={copy}
              className="btn-yellow px-4 py-2 text-xs"
              data-testid="copy-signup-link"
            >
              {copied ? "Copied ✓" : "Copy link"}
            </button>
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="btn-outline-ink px-4 py-2 text-xs inline-flex items-center"
              data-testid="open-signup-link"
            >
              Open ↗
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
