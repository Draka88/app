export const fmtAUD = (n) =>
  new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 2,
  }).format(Number(n || 0));

export const fmtInt = (n) =>
  new Intl.NumberFormat("en-AU").format(Number(n || 0));

// Payroll week runs Wed → Tue. Key encodes the Wednesday anchor date, e.g. 'W2026-08-05'.
export function isoWeekKey(d = new Date()) {
  const day = d.getDay(); // Sun=0 Mon=1 Tue=2 Wed=3 Thu=4 Fri=5 Sat=6
  // Offset back to the Wednesday of the week containing d.
  // JS getDay: Wed=3. We want (day - 3) mod 7 to remove.
  const back = (day - 3 + 7) % 7;
  const wed = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
  const y = wed.getFullYear();
  const m = String(wed.getMonth() + 1).padStart(2, "0");
  const dd = String(wed.getDate()).padStart(2, "0");
  return `W${y}-${m}-${dd}`;
}

export function weekLabel(key) {
  if (!key || !key.startsWith("W")) return key || "";
  const iso = key.slice(1);
  const wed = new Date(iso + "T00:00:00");
  const tue = new Date(wed); tue.setDate(tue.getDate() + 6);
  const fmt = (d) => d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return `${fmt(wed)} → ${fmt(tue)}, ${tue.getFullYear()}`;
}

export function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
