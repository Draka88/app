import { useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { toast } from "sonner";

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setErr("");
    const res = await login(email.trim(), password);
    setLoading(false);
    if (!res.ok) {
      setErr(res.error);
      toast.error(res.error);
    } else {
      toast.success(`Welcome, ${res.user.name}`);
    }
  };

  return (
    <div className="min-h-screen w-full grid md:grid-cols-2">
      {/* Left visual panel */}
      <div
        className="relative hidden md:block bg-zinc-950"
        style={{
          backgroundImage:
            "linear-gradient(rgba(9,9,11,0.78), rgba(9,9,11,0.92)), url('https://images.pexels.com/photos/4487383/pexels-photo-4487383.jpeg')",
          backgroundSize: "cover",
          backgroundPosition: "center",
        }}
      >
        <div className="hatch absolute inset-0" />
        <div className="relative z-10 h-full flex flex-col justify-between p-10 text-white">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 bg-yellow-500 grid place-items-center">
              <span className="font-heading text-2xl text-zinc-950 font-black">
                B
              </span>
            </div>
            <div>
              <div className="font-heading text-xl tracking-wide">
                BOXWISE
              </div>
              <div className="text-xs text-zinc-400">
                Payroll · AUD
              </div>
            </div>
          </div>
          <div>
            <div className="font-heading text-5xl leading-none">
              Count the boxes.
              <br />
              <span className="text-yellow-500">Cut the payroll.</span>
            </div>
            <p className="mt-6 text-zinc-300 max-w-md">
              Workers report boxes daily. The system tallies the week and multiplies
              by your rate. Payslips print in one click.
            </p>
          </div>
          <div className="text-xs text-zinc-500 uppercase tracking-widest">
            v1 · Australian Dollar · ISO Week Payroll
          </div>
        </div>
      </div>

      {/* Right form panel */}
      <div className="flex items-center justify-center p-6 md:p-14 bg-white">
        <form
          onSubmit={submit}
          className="w-full max-w-md space-y-8"
          data-testid="login-form"
        >
          <div>
            <div className="inline-block bg-yellow-500 px-3 py-1 mb-4 text-xs font-bold uppercase tracking-widest text-zinc-950">
              Sign In
            </div>
            <h1 className="font-heading text-5xl leading-none">
              Log in to
              <br />your shift.
            </h1>
            <p className="mt-3 text-zinc-500">
              Enter your credentials to report boxes or manage payroll.
            </p>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block font-heading text-xs mb-2 text-zinc-700">
                Email
              </label>
              <input
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="input-sharp"
                placeholder="you@company.com"
                data-testid="login-email-input"
              />
            </div>
            <div>
              <label className="block font-heading text-xs mb-2 text-zinc-700">
                Password
              </label>
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input-sharp"
                placeholder="••••••••"
                data-testid="login-password-input"
              />
            </div>
          </div>

          {err && (
            <div
              className="border-2 border-red-600 bg-red-50 text-red-700 px-3 py-2 text-sm"
              data-testid="login-error"
            >
              {err}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="btn-yellow w-full py-3 text-sm"
            data-testid="login-submit-button"
          >
            {loading ? "Signing in…" : "Enter shift →"}
          </button>

          <div className="text-sm text-zinc-600 flex justify-between">
            <a
              href="/register"
              className="font-bold underline text-zinc-950"
              data-testid="link-to-register"
            >
              New worker? Create an account
            </a>
            <a
              href="/forgot-password"
              className="font-bold underline text-zinc-700 hover:text-zinc-950"
              data-testid="link-to-forgot"
            >
              Forgot password?
            </a>
          </div>

          <div className="pt-2 border-t border-zinc-200 text-xs text-zinc-500 font-mono-data">
            <div>Demo · Admin: soerjantowerri@gmail.com / Admin@2026</div>
            <div>Demo · Worker: worker.a@example.com / Worker@2026</div>
          </div>
        </form>
      </div>
    </div>
  );
}
