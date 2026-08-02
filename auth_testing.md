# Auth Testing — Boxwise Payroll

Admin: soerjantowerri@gmail.com / Admin@2026
Workers (seeded): worker.a@example.com / Worker@2026, worker.b@example.com / Worker@2026

Endpoints:
- POST /api/auth/login  { email, password } → 200 { token, user }
- GET /api/auth/me (cookie or Bearer) → 200 UserOut
- POST /api/auth/logout → clears cookie

Notes:
- JWT stored as httpOnly cookie AND returned in body (Bearer fallback used by SPA).
- 401 for bad credentials.
- Only admin can hit /api/workers, /api/settings/rate PUT, /api/summary/weekly.
