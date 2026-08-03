# Boxwise Payroll — Product Requirements

## Original Problem Statement
Automatically calculate the total number of boxes processed by each worker every week for payroll purposes, using a manually entered payment rate per box (AUD). Export to PDF.

## Evolved Product Requirements
**Supervisor-Only Scanning Workflow** — Workers do NOT log in. Supervisors log in and use a smartphone to scan the workers' QR name tags. Each scan counts as 1 completed box for that worker. Payroll is strictly Hourly (working hours × hourly rate). App handles time attendance, shift clocking, barcode generation, whitelisting, and detailed CSV/PDF reporting.

**Location-Based Attendance (NEW — Feb 2026)**
- Supervisor scans a worker's QR name tag on their phone to Clock In/Out that worker.
- The Supervisor's phone GPS is used for geo-verification.
- Admin manages multiple worksites (name, lat/lng, radius in meters, active flag).
- Default radius: 50m. Attendance is REJECTED if the Supervisor's GPS is outside every active site's radius (or outside the selected site's radius).
- GPS permission denied → clock-in/out rejected entirely.
- Every attendance row stores: worker id/name, date, clock_in/out times, GPS coords, distance, assigned worksite, supervising supervisor.
- Working hours auto-sync into Hourly payroll (pay_configs).
- Attendance history visible to Admin/Supervisor; Admin can export Excel + PDF.

## Personas
- **Admin/Owner** — manages workers, worksites, payroll config, exports reports.
- **Supervisor** — logs in on phone, scans worker QR tags for boxes / clock-in / clock-out.
- **Worker** — has a printed QR name tag only. No login.

## Implemented (as of Feb 2026)
- Auth (JWT + Bearer cookie), admin-only worker CRUD
- Worker QR name tags PDF (2×4 grid)
- Supervisor Scan Station with three modes: **+1 Box**, **Clock In**, **Clock Out**
- Attendance history with GPS + worksite stamp, admin exports (XLSX/PDF)
- Worksite CRUD with "Use my current GPS" helper
- Geofenced clock-in/out (Haversine distance)
- Hourly payroll (piece-rate deprecation still pending cleanup)
- Barcode Whitelisting, Rejection Audit CSV/PDF
- Barcode Generator (Avery templates)

## API — new endpoints
- `GET /api/worksites` (auth)
- `POST /api/worksites` (admin)
- `PATCH /api/worksites/{id}` (admin)
- `DELETE /api/worksites/{id}` (admin)
- `POST /api/attendance/scan-clock-in` (admin, geofenced)
- `POST /api/attendance/scan-clock-out` (admin, geofenced)
- `GET /api/attendance/xlsx?from_date&to_date`
- `GET /api/attendance/pdf?from_date&to_date`

## Data model — new
- **worksites**: `{id, name, latitude, longitude, radius_m, active, created_by/at, updated_by/at}`
- **attendance** (extended): now includes `clock_in_lat/lng/accuracy_m/distance_m`, `worksite_id/name/lat/lng/radius_m`, `supervisor_id/name/email`, plus `clock_out_lat/lng/accuracy_m/distance_m`, `clock_out_worksite_*`, `clock_out_supervisor_*`.

## Prioritized Backlog
- **P1** — Remove residual Piece-Rate UI/logic from `AdminPayConfig.jsx` + payroll code
- **P1** — Overtime multiplier (1.5× above 8 hrs/day)
- **P2** — Direct Print button on QR nametags (no download)
- **P2** — Live map preview for worksites

## Recently Completed (Feb 2026)
- **Logout + Idle Auto-Logout** (P1 → DONE): every logged-in role sees a "Sign out" button top-right of the header (Workers, Supervisors, Admins — all use `Layout`). Click prompts confirmation, calls `POST /api/auth/logout` (clears the `access_token` httpOnly cookie server-side) + removes `bw_token` from localStorage + redirects to `/login`. Backend verified: cookie cleared, `/auth/me` returns 401 post-logout. Idle auto-logout: **30 min** of no mouse/touch/keyboard/scroll activity, with a **60s warning** toast, then automatic sign-out.
- **Beep + Haptic Feedback On Scan** (P2 → DONE)
- **Scanner Auto-Open + Rich Confirmation Banner** (P0 → DONE)
- **Supervisor Worker Lookup + Scan Correction** (P1 → DONE)
- **Worker Password Reset** (P2 → DONE): forgot-password flow via Emergent-managed Resend. New endpoints `POST /api/auth/forgot-password` (worker-only; admin emails silently ignored) and `POST /api/auth/reset-password`. Secure random URL-safe token (32 bytes) stored in `password_reset_tokens`, expires in **30 minutes**, single-use, invalidates prior unused tokens on new request. Response is always generic to prevent email enumeration. Sender: `Boxwise` via managed Resend proxy. New pages `/forgot-password` and `/reset-password?token=…` plus a "Forgot password?" link on the login screen.
- **Worker Login Restored** (P0 → DONE)
- **Supervisor Self-Scan Block** (P0 → DONE): every scan path (`/scans/for-worker`, `/attendance/scan-clock-in`, `/attendance/scan-clock-out`) now rejects with 409 and message "You cannot scan your own QR code…" when the QR id equals the authenticated supervisor's id. Every attempt is written to `db.scan_rejections` with `reason: "supervisor-self-scan"` + `kind`. Frontend Scan Station shows a titled toast for this case.
- **Restrict Workers to Sites** (P2 → DONE): admin can assign one or more worksites per worker via `PATCH /api/workers/{id}` (`assigned_worksite_ids`). Geofenced clock-in/out is refused with the message "{name} is not permitted to clock in/out at {site}." Empty list = worker allowed at any active site. UI: checkboxes in the Workers roster edit mode.

## Test Credentials
See `/app/memory/test_credentials.md`.

## Deployment Notes
- Production deployment exists. Only preview environment is edited.
- Backend: `/app/backend/server.py` (single-file FastAPI). Frontend: React under `/app/frontend/src`.
