import { createContext, useContext, useEffect, useState, useCallback, useRef } from "react";
import { api, formatApiError } from "../lib/api";
import { toast } from "sonner";

const AuthCtx = createContext(null);

// Auto-logout after this many ms of inactivity. Warning fires 60s before.
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;   // 30 minutes
const IDLE_WARN_MS = 60 * 1000;           // 1 minute warning

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null); // null=checking, false=guest, obj=user
  const [error, setError] = useState("");
  const idleTimerRef = useRef(null);
  const idleWarnRef = useRef(null);

  const bootstrap = useCallback(async () => {
    try {
      const { data } = await api.get("/auth/me");
      setUser(data);
    } catch {
      setUser(false);
    }
  }, []);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  const logout = useCallback(async (reason) => {
    try {
      await api.post("/auth/logout");
    } catch (_e) { /* ignore network / expired */ }
    localStorage.removeItem("bw_token");
    setUser(false);
    if (reason === "idle") {
      toast.warning("Signed out for inactivity", { description: "Please sign in again to continue.", duration: 6000 });
    } else if (reason !== "silent") {
      toast.success("Signed out", { duration: 2200 });
    }
  }, []);

  const login = async (email, password) => {
    setError("");
    try {
      const { data } = await api.post("/auth/login", { email, password });
      if (data.token) localStorage.setItem("bw_token", data.token);
      setUser(data.user);
      return { ok: true, user: data.user };
    } catch (e) {
      const msg = formatApiError(e.response?.data?.detail) || e.message;
      setError(msg);
      return { ok: false, error: msg };
    }
  };

  // ---------- Idle auto-logout ----------
  useEffect(() => {
    if (!user || user === false) return;

    const scheduleTimers = () => {
      if (idleWarnRef.current) clearTimeout(idleWarnRef.current);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleWarnRef.current = setTimeout(() => {
        toast.warning("You'll be signed out in 60s", {
          description: "Move the mouse or tap anywhere to stay signed in.",
          duration: 8000,
        });
      }, IDLE_TIMEOUT_MS - IDLE_WARN_MS);
      idleTimerRef.current = setTimeout(() => { logout("idle"); }, IDLE_TIMEOUT_MS);
    };

    const activity = () => scheduleTimers();
    const events = ["mousemove", "mousedown", "keydown", "touchstart", "scroll", "wheel", "visibilitychange"];
    events.forEach((ev) => window.addEventListener(ev, activity, { passive: true }));
    scheduleTimers();

    return () => {
      events.forEach((ev) => window.removeEventListener(ev, activity));
      if (idleWarnRef.current) clearTimeout(idleWarnRef.current);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, [user, logout]);

  return (
    <AuthCtx.Provider value={{ user, error, login, logout, idleTimeoutMs: IDLE_TIMEOUT_MS }}>
      {children}
    </AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);
