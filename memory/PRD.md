# Boxwise Payroll — PRD

## Problem Statement
Workers each report the number of boxes they process. The system must automatically calculate weekly totals per worker for payroll. Admin manually enters the payment rate per box, and each worker's total earnings = boxes reported that week × rate.

## User Choices (Feb 2026)
- Auth: Simple JWT worker/admin login (email + password)
- Reporting: Each worker logs in and reports their own boxes
- Rate: ONE global rate per box (admin-set)
- Payslip: Downloadable PDF
- Currency: AUD

## Architecture
- Backend: FastAPI + MongoDB (motor), bcrypt + PyJWT auth, reportlab PDF
- Frontend: React 19 + React Router 7 + Tailwind + shadcn/ui + sonner
- Design: Industrial safety-yellow / zinc-950 palette, Barlow Condensed headings, IBM Plex Mono for data

## Personas
1. **Owner / Admin** (soerjantowerri@gmail.com) — sets rate, manages workers, views weekly payroll, exports payslips.
2. **Worker** — logs boxes daily, views own weekly totals + earnings, downloads own payslip.

## What's Implemented (2026-02)
- Admin & worker JWT auth with role gating; admin auto-seed on startup
- Sample workers auto-seeded on first run (Worker A, Worker B)
- Admin: workers CRUD, global rate setter, weekly payroll dashboard with per-worker totals
- Worker: daily box report form, weekly log table with delete, week switcher
- Auto weekly aggregation using ISO weeks (YYYY-Www)
- Payslip PDF export per worker per week (reportlab)
- All figures in AUD

## Backlog / Next
- P1: Per-worker rate overrides (opt-in)
- P1: Monthly payroll view + CSV export
- P1: Email payslip on generation (Resend)
- P2: Overtime / holiday-rate multipliers
- P2: Charts of weekly output per worker
- P2: Worker self-service password change
