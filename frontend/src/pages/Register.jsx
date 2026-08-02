import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, formatApiError } from "../lib/api";
import { useAuth } from "../contexts/AuthContext";
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

export default function Register() {
  const nav = useNavigate();
  const { login } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [jobRole, setJobRole] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setErr("");
    if (password.length < 6) {
      setErr("Password must be at least 6 characters");
      return;
    }
    setLoading(true);
    try {
      const { data } = await api.post("/auth/register", {
        name: name.trim(),
        email: email.trim().toLowerCase(),
        password,
        job_role: jobRole || null,
      });
      if (data.token) localStorage.setItem("bw_token", data.token);
      // Refresh auth state and route to worker dashboard
      await login(email.trim().toLowerCase(), password);
      toast.success(`Welcome, ${data.user.name}!`);
      nav("/", { replace: true });
    } catch (e) {
      const msg = formatApiError(e.response?.data?.detail) || e.message;
      setErr(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen w-full bg-white">
      <div className="max-w-md mx-auto px-5 pt-10 pb-16 md:pt-16">
        {/* Brand */}
        <div className="flex items-center gap-3 mb-8">
          <div className="h-10 w-10 bg-yellow-500 grid place-items-center">
            <span className="font-heading text-2xl text-zinc-950 font-black">B</span>
          </div>
          <div>
            <div className="font-heading text-lg leading-none">BOXWISE</div>
            <div className="text-[10px] uppercase tracking-widest text-zinc-500">
              Sign up · Worker
            </div>
          </div>
        </div>

        <div className="inline-block bg-yellow-500 px-3 py-1 mb-4 text-xs font-bold uppercase tracking-widest text-zinc-950">
          Create account
        </div>
        <h1 className="font-heading text-4xl sm:text-5xl leading-none">
          Join the crew.
        </h1>
        <p className="mt-3 text-zinc-500">
          Register with your email. Once done, your name shows up on the admin's roster
          instantly, and you can start logging boxes.
        </p>

        <form onSubmit={submit} className="mt-8 space-y-5" data-testid="register-form">
          <div>
            <label className="block font-heading text-xs mb-2 text-zinc-700">
              Full name
            </label>
            <input
              type="text"
              autoComplete="name"
              required
              minLength={2}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="input-sharp text-base"
              placeholder="e.g. Sarah Nguyen"
              data-testid="register-name-input"
            />
          </div>

          <div>
            <label className="block font-heading text-xs mb-2 text-zinc-700">
              Email
            </label>
            <input
              type="email"
              inputMode="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input-sharp text-base"
              placeholder="you@company.com"
              data-testid="register-email-input"
            />
          </div>

          <div>
            <label className="block font-heading text-xs mb-2 text-zinc-700">
              Job role (optional)
            </label>
            <select
              value={jobRole}
              onChange={(e) => setJobRole(e.target.value)}
              className="input-sharp text-base"
              data-testid="register-jobrole-input"
            >
              <option value="">Select your role…</option>
              {JOB_ROLES.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block font-heading text-xs mb-2 text-zinc-700">
              Password
            </label>
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input-sharp text-base"
              placeholder="Minimum 6 characters"
              data-testid="register-password-input"
            />
          </div>

          {err && (
            <div
              className="border-2 border-red-600 bg-red-50 text-red-700 px-3 py-2 text-sm"
              data-testid="register-error"
            >
              {err}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="btn-yellow w-full py-4 text-base"
            data-testid="register-submit-button"
          >
            {loading ? "Creating…" : "Create account →"}
          </button>

          <div className="pt-4 text-sm text-zinc-600 text-center">
            Already have an account?{" "}
            <Link to="/login" className="font-bold underline text-zinc-950" data-testid="link-to-login">
              Sign in
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
