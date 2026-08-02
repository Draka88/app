import axios from "axios";

const BASE = process.env.REACT_APP_BACKEND_URL;
export const API = `${BASE}/api`;

export const api = axios.create({
  baseURL: API,
  withCredentials: true,
});

// Attach Bearer fallback for environments where 3rd-party cookies are blocked
api.interceptors.request.use((cfg) => {
  const t = localStorage.getItem("bw_token");
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  return cfg;
});

export function formatApiError(detail) {
  if (detail == null) return "Something went wrong.";
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail))
    return detail
      .map((e) => (e && typeof e.msg === "string" ? e.msg : JSON.stringify(e)))
      .join(" ");
  if (detail && typeof detail.msg === "string") return detail.msg;
  return String(detail);
}
