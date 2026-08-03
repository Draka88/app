import { useState } from "react";
import { Link } from "react-router-dom";
import { api, formatApiError } from "../lib/api";
import { toast } from "sonner";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setErr("");
    setLoading(true);
    try {
      await api.post("/auth/forgot-password", { email: email.trim().toLowerCase() });
      setSent(true);
      toast.success("Check your inbox for the reset link");
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
            <div className="text-[10px] uppercase tracking-widest text-zinc-500">Password reset · Worker</div>
          </div>
        </div>

        <div className="inline-block bg-yellow-500 px-3 py-1 mb-4 text-xs font-bold uppercase tracking-widest text-zinc-950">
          Forgot password
        </div>
        <h1 className="font-heading text-4xl sm:text-5xl leading-none">Get back on the floor.</h1>
        <p className="mt-3 text-zinc-500">
          Enter your work email. If we find a worker account, we'll email you a link to set a new password. The link is valid for 30 minutes.
        </p>

        {sent ? (
          <div className="mt-8 border-2 border-yellow-500 bg-yellow-50 p-4" data-testid="forgot-sent-card">
            <div className="font-heading text-lg mb-1">Check your inbox</div>
            <p className="text-sm text-zinc-700">
              If a worker account exists for <b>{email}</b>, a reset email has been sent. It expires in 30 minutes.
            </p>
            <div className="mt-4 text-sm">
              <Link to="/login" className="font-bold underline text-zinc-950" data-testid="back-to-login">← Back to sign in</Link>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="mt-8 space-y-5" data-testid="forgot-form">
            <div>
              <label className="block font-heading text-xs mb-2 text-zinc-700">Work email</label>
              <input
                type="email" autoComplete="email" required
                value={email} onChange={(e) => setEmail(e.target.value)}
                className="input-sharp text-base" placeholder="you@company.com"
                data-testid="forgot-email-input"
              />
            </div>
            {err && (
              <div className="border-2 border-red-600 bg-red-50 text-red-700 px-3 py-2 text-sm" data-testid="forgot-error">
                {err}
              </div>
            )}
            <button type="submit" disabled={loading} className="btn-yellow w-full py-4 text-base" data-testid="forgot-submit-btn">
              {loading ? "Sending…" : "Send reset link →"}
            </button>
            <div className="pt-2 text-sm text-zinc-600 text-center">
              Remembered it?{" "}
              <Link to="/login" className="font-bold underline text-zinc-950" data-testid="link-to-login">Sign in</Link>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
