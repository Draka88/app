import { useAuth } from "../contexts/AuthContext";
import { Link, useLocation } from "react-router-dom";

export default function Layout({ children }) {
  const { user, logout } = useAuth();
  const loc = useLocation();
  const isAdmin = user && user.role === "admin";
  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <header className="bg-zinc-950 text-white border-b-4 border-yellow-500">
        <div className="hatch">
          <div className="max-w-7xl mx-auto px-5 py-4 flex items-center gap-6">
            <Link to="/" className="flex items-center gap-3" data-testid="brand-home">
              <div className="h-9 w-9 bg-yellow-500 grid place-items-center">
                <span className="font-heading text-xl text-zinc-950 font-black">B</span>
              </div>
              <div>
                <div className="font-heading text-lg leading-none">BOXWISE</div>
                <div className="text-[10px] uppercase tracking-widest text-zinc-400">
                  {isAdmin ? "Supervisor Console" : "Worker App"}
                </div>
              </div>
            </Link>

            <nav className="hidden md:flex items-center gap-2 ml-6">
              {isAdmin ? (
                <>
                  <NavLink to="/" active={loc.pathname === "/"} label="Scan" testid="nav-scan" />
                  <NavLink to="/payroll" active={loc.pathname === "/payroll"} label="Payroll" testid="nav-payroll" />
                  <NavLink to="/reports" active={loc.pathname === "/reports"} label="Reports" testid="nav-reports" />
                  <NavLink to="/duplicates" active={loc.pathname === "/duplicates"} label="Duplicates" testid="nav-duplicates" />
                  <NavLink to="/attendance" active={loc.pathname === "/attendance"} label="Attendance" testid="nav-attendance" />
                  <NavLink to="/workers" active={loc.pathname === "/workers"} label="Workers" testid="nav-workers" />
                  <NavLink to="/qr-codes" active={loc.pathname === "/qr-codes"} label="QR Codes" testid="nav-qr" />
                  <NavLink to="/worksites" active={loc.pathname === "/worksites"} label="Worksites" testid="nav-worksites" />
                  <NavLink to="/payconfig" active={loc.pathname === "/payconfig"} label="Pay Method" testid="nav-payconfig" />
                  <NavLink to="/settings" active={loc.pathname === "/settings"} label="Rate" testid="nav-settings" />
                </>
              ) : (
                <>
                  <NavLink to="/" active={loc.pathname === "/"} label="My Shift" testid="nav-shift" />
                </>
              )}
            </nav>

            <div className="ml-auto flex items-center gap-4">
              <div className="text-right hidden sm:block">
                <div className="font-heading text-sm">{user?.name}</div>
                <div className="text-[10px] uppercase tracking-widest text-zinc-400">
                  {user?.role}
                </div>
              </div>
              <button
                onClick={() => {
                  if (window.confirm("Sign out now?")) logout();
                }}
                className="btn-outline-ink border-white text-white hover:bg-white hover:text-zinc-950 px-3 py-2 text-xs"
                data-testid="logout-button"
                title="Sign out (auto-logout after 30 min idle)"
              >
                Sign out
              </button>
            </div>
          </div>
        </div>
      </header>
      <main className="max-w-7xl mx-auto px-5 py-8">{children}</main>
      <footer className="max-w-7xl mx-auto px-5 pb-8 text-[11px] uppercase tracking-widest text-zinc-500">
        Boxwise · Currency A$ · ISO Weekly Payroll
      </footer>
    </div>
  );
}

function NavLink({ to, active, label, testid }) {
  return (
    <Link
      to={to}
      data-testid={testid}
      className={`px-3 py-2 text-xs font-heading tracking-widest border-2 ${
        active
          ? "bg-yellow-500 text-zinc-950 border-yellow-500"
          : "border-transparent text-zinc-300 hover:text-white hover:border-zinc-700"
      }`}
    >
      {label}
    </Link>
  );
}
