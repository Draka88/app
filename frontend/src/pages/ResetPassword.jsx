import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, formatApiError } from "../lib/api";
import { toast } from "sonner";

export default function ResetPassword() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [token, setToken] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => { setToken(params.get("token") || ""); }, [params]);

  const submit = async (e) => {
    e.preventDefault();
    setErr("");
    if (pw.length < 6) return setErr("Password must be at least 6 characters");
    if (pw !== pw2) return setErr("Passwords do not match");
    setLoading(true);
    try {
      await api.post("/auth/reset-password", { token, new_password: pw });
      setDone(true);
      toast.success("Password updated. Please sign in.");
      setTimeout(() => nav("/login", { replace: true }), 1600);
    } catch (e) {
      const msg = formatApiError(e.response?.data?.detail) || e.message;
      setErr(msg);
      toast.error(msg);
    } finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen w-full bg-white">
      <div className="max-w-md mx-auto px-5 pt-10 pb-16 md:pt-16">
        <div className="flex items-center gap-3 mb-8">
          <div className="h-10 w-10 bg-yellow-500 grid place-items-center">
            <span className="font-heading text-2xl text-zinc-950 font-black">B</span>
          </div>
          <div>
            <div className="font-heading text-lg leading-none">BOXWISE</div>
            <div className="text-[10px] uppercase tracking-widest text-zinc-500">Set new password</div>
          </div>
        </div>

        <div className="inline-block bg-yellow-500 px-3 py-1 mb-4 text-xs font-bold uppercase tracking-widest text-zinc-950">
          Reset password
        </div>
        <h1 className="font-heading text-4xl sm:text-5xl leading-none">Choose a new one.</h1>
        <p className="mt-3 text-zinc-500">
          Enter and confirm a new password. Minimum 6 characters.
        </p>

        {!token && (
          <div className="mt-6 border-2 border-red-600 bg-red-50 p-4">
            <div className="font-heading text-lg">Missing token</div>
            <p className="text-sm text-zinc-700 mt-1">
              This page requires a token in the URL. Please use the link from your reset email or
              <Link to="/forgot-password" className="ml-1 font-bold underline text-zinc-950">request a new one</Link>.
            </p>
          </div>
        )}

        {token && !done && (
          <form onSubmit={submit} className="mt-8 space-y-5" data-testid="reset-form">
            <div>
              <label className="block font-heading text-xs mb-2 text-zinc-700">New password</label>
              <input
                type="password" autoComplete="new-password" required minLength={6}
                value={pw} onChange={(e) => setPw(e.target.value)}
                className="input-sharp text-base" placeholder="At least 6 characters"
                data-testid="reset-pw-input"
              />
            </div>
            <div>
              <label className="block font-heading text-xs mb-2 text-zinc-700">Confirm new password</label>
              <input
                type="password" autoComplete="new-password" required minLength={6}
                value={pw2} onChange={(e) => setPw2(e.target.value)}
                className="input-sharp text-base" placeholder="Repeat it"
                data-testid="reset-pw2-input"
              />
            </div>
            {err && (
              <div className="border-2 border-red-600 bg-red-50 text-red-700 px-3 py-2 text-sm" data-testid="reset-error">
                {err}
              </div>
            )}
            <button type="submit" disabled={loading} className="btn-yellow w-full py-4 text-base" data-testid="reset-submit-btn">
              {loading ? "Saving…" : "Set new password →"}
            </button>
          </form>
        )}

        {done && (
          <div className="mt-6 border-2 border-yellow-500 bg-yellow-50 p-4" data-testid="reset-done-card">
            <div className="font-heading text-lg">Password updated ✓</div>
            <p className="text-sm text-zinc-700 mt-1">Redirecting you to sign in…</p>
          </div>
        )}
      </div>
    </div>
  );
}
