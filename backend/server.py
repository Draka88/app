from dotenv import load_dotenv
from pathlib import Path
ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

import os
import io
import math
import logging
import uuid
import secrets
import bcrypt
import httpx
import jwt
from datetime import datetime, timezone, timedelta, date, timedelta as td
from typing import List, Optional, Annotated

from fastapi import FastAPI, APIRouter, HTTPException, Depends, Request, Response
from fastapi.responses import StreamingResponse
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field, EmailStr, ConfigDict
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle

# ---------- DB ----------
mongo_url = os.environ["MONGO_URL"]
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ["DB_NAME"]]

# ---------- Email (Emergent-managed Resend proxy) ----------
EMAIL_BASE_URL = "https://integrations.emergentagent.com"
EMAIL_KEY = os.environ.get("EMERGENT_EMAIL_KEY")
EMAIL_FROM_NAME = os.environ.get("EMAIL_FROM_NAME", "Boxwise")
FRONTEND_URL = os.environ.get("FRONTEND_URL", "http://localhost:3000")
RESET_TOKEN_TTL_MIN = 30

async def _send_email(to_email: str, subject: str, html: str):
    if not EMAIL_KEY:
        raise RuntimeError("EMERGENT_EMAIL_KEY missing — cannot send email")
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(
            f"{EMAIL_BASE_URL}/api/v1/email/send",
            headers={"X-Email-Key": EMAIL_KEY},
            json={"to": [to_email], "subject": subject, "html": html, "from_name": EMAIL_FROM_NAME},
        )
        r.raise_for_status()
        return r.json()

# ---------- App ----------
app = FastAPI(title="Boxwise Payroll API")
api = APIRouter(prefix="/api")

# ---------- Auth helpers ----------
JWT_ALGO = "HS256"
JWT_SECRET = os.environ["JWT_SECRET"]

def hash_password(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()

def verify_password(pw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode(), hashed.encode())
    except Exception:
        return False

def create_token(user_id: str, role: str, minutes: int = 60 * 24 * 7) -> str:
    payload = {
        "sub": user_id,
        "role": role,
        "exp": datetime.now(timezone.utc) + timedelta(minutes=minutes),
        "type": "access",
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGO)

def iso_week_key(d: date) -> str:
    """Payroll week runs Wed → Tue. Key encodes the Wednesday anchor date, e.g. 'W2026-08-05'."""
    # weekday(): Mon=0 Tue=1 Wed=2 Thu=3 Fri=4 Sat=5 Sun=6
    wed = d - td(days=(d.weekday() - 2) % 7)
    return f"W{wed.isoformat()}"

def month_key(d: date) -> str:
    return f"{d.year}-{d.month:02d}"

def week_range(week_key: str):
    """Return (Wednesday, next Tuesday) for a Wed-anchored key. Handles legacy 'YYYY-Www' too."""
    if week_key.startswith("W"):
        wed = date.fromisoformat(week_key[1:])
    else:
        y, w = week_key.split("-W")
        monday = date.fromisocalendar(int(y), int(w), 1)
        wed = monday + td(days=2)
    tue = wed + td(days=6)
    return wed, tue

def format_week_label(week_key: str) -> str:
    wed, tue = week_range(week_key)
    return f"Wed {wed.strftime('%b %-d')} → Tue {tue.strftime('%b %-d')}, {tue.year}"

# ---------- Models ----------
class UserOut(BaseModel):
    id: str
    email: str
    name: str
    role: str
    employee_id: Optional[str] = None

class LoginIn(BaseModel):
    email: str
    password: str

class RegisterIn(BaseModel):
    email: str
    name: str
    password: str
    job_role: Optional[str] = None
    employee_id: Optional[str] = None

class WorkerCreate(BaseModel):
    email: str
    name: str
    password: str
    job_role: Optional[str] = None
    employee_id: Optional[str] = None

class WorkerUpdate(BaseModel):
    name: Optional[str] = None
    password: Optional[str] = None
    job_role: Optional[str] = None
    employee_id: Optional[str] = None
    assigned_worksite_ids: Optional[List[str]] = None

class WorkerClockIn(BaseModel):
    latitude: float
    longitude: float
    accuracy_m: Optional[float] = None
    worksite_id: Optional[str] = None

class ForgotPasswordIn(BaseModel):
    email: EmailStr

class ResetPasswordIn(BaseModel):
    token: str = Field(min_length=16, max_length=128)
    new_password: str = Field(min_length=6, max_length=200)

class BoxReportIn(BaseModel):
    boxes: int = Field(ge=0)
    date: Optional[str] = None  # YYYY-MM-DD (defaults to today)
    note: Optional[str] = None

class ScanIn(BaseModel):
    barcode: str = Field(min_length=1, max_length=200)
    format: Optional[str] = None  # e.g. "CODE_128", "EAN_13", "QR_CODE"

class WhitelistIn(BaseModel):
    date: str
    barcodes: List[str]
    replace: bool = False

class WhitelistEntryIn(BaseModel):
    date: str
    barcode: str

class WhitelistBulkIn(BaseModel):
    entries: List[WhitelistEntryIn]
    replace_week: Optional[str] = None  # YYYY-Www to clear before insert

class BarcodeGenIn(BaseModel):
    prefix: str = "BOX-"
    count: int = Field(ge=1, le=500)
    start: int = 1
    pad: int = 4
    template: str = "a4_3x8"
    add_to_whitelist_date: Optional[str] = None

class BoxReportOut(BaseModel):
    id: str
    worker_id: str
    worker_name: str
    date: str
    boxes: int
    note: Optional[str] = None
    barcode: Optional[str] = None
    source: Optional[str] = None
    week_key: str
    created_at: str

class RateIn(BaseModel):
    rate: float = Field(ge=0)

class PayConfigIn(BaseModel):
    worker_id: str
    date: str
    method: str
    hours: Optional[float] = None
    hourly_rate: Optional[float] = None

class AttendanceCorrectIn(BaseModel):
    hours: float = Field(ge=0, le=24)

class WorksiteIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    latitude: float
    longitude: float
    radius_m: int = Field(ge=5, le=5000, default=50)
    active: bool = True

class WorksiteUpdate(BaseModel):
    name: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    radius_m: Optional[int] = Field(default=None, ge=5, le=5000)
    active: Optional[bool] = None

class ScanClockIn(BaseModel):
    worker_id: str = Field(min_length=1, max_length=200)
    latitude: float
    longitude: float
    accuracy_m: Optional[float] = None
    worksite_id: Optional[str] = None

# ---------- Auth dependency ----------
async def get_current_user(request: Request) -> dict:
    token = request.cookies.get("access_token")
    if not token:
        auth = request.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            token = auth[7:]
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")
    user = await db.users.find_one({"id": payload["sub"]})
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    user.pop("password_hash", None)
    user.pop("_id", None)
    return user

async def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin required")
    return user

def set_auth_cookie(response: Response, token: str):
    response.set_cookie(
        key="access_token",
        value=token,
        httponly=True,
        secure=True,
        samesite="none",
        max_age=60 * 60 * 24 * 7,
        path="/",
    )

# ---------- Auth routes ----------
async def _next_employee_id() -> str:
    count = await db.users.count_documents({"role": "worker"})
    for i in range(count + 1, count + 500):
        candidate = f"EMP-{i:04d}"
        exists = await db.users.find_one({"employee_id": candidate})
        if not exists:
            return candidate
    return f"EMP-{uuid.uuid4().hex[:8].upper()}"

@api.post("/auth/login")
async def login(body: LoginIn, response: Response):
    email = body.email.strip().lower()
    user = await db.users.find_one({"email": email})
    if not user or not verify_password(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    token = create_token(user["id"], user["role"])
    set_auth_cookie(response, token)
    return {
        "token": token,
        "user": {
            "id": user["id"],
            "email": user["email"],
            "name": user["name"],
            "role": user["role"],
            "employee_id": user.get("employee_id"),
        },
    }

@api.post("/auth/logout")
async def logout(response: Response):
    response.delete_cookie("access_token", path="/")
    return {"ok": True}

# ---------- Password reset (workers only) ----------
def _build_reset_email_html(name: str, link: str, minutes: int) -> str:
    return f"""
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#fafaf9;padding:24px 0;font-family:Helvetica,Arial,sans-serif;">
      <tr><td align="center">
        <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="background:#ffffff;border:1px solid #e4e4e7;">
          <tr><td style="background:#09090b;padding:20px 24px;">
            <div style="display:inline-block;background:#eab308;color:#09090b;font-weight:700;letter-spacing:2px;font-size:11px;padding:3px 8px;">BOXWISE · WORKER</div>
            <div style="color:#ffffff;font-size:22px;font-weight:800;margin-top:8px;">Reset your password</div>
          </td></tr>
          <tr><td style="padding:24px;color:#3f3f46;font-size:14px;line-height:22px;">
            <p style="margin:0 0 12px 0;">Hi {name or "there"},</p>
            <p style="margin:0 0 12px 0;">We received a request to reset your Boxwise worker account password. Click the button below to choose a new one. This link expires in <b>{minutes} minutes</b>.</p>
            <p style="margin:20px 0;text-align:center;">
              <a href="{link}" style="display:inline-block;background:#eab308;color:#09090b;text-decoration:none;padding:12px 20px;font-weight:800;letter-spacing:1px;">RESET PASSWORD →</a>
            </p>
            <p style="margin:0 0 8px 0;font-size:12px;color:#71717a;">If the button doesn't work, copy this URL into your browser:</p>
            <p style="margin:0 0 16px 0;font-family:monospace;font-size:11px;color:#3f3f46;word-break:break-all;">{link}</p>
            <p style="margin:16px 0 0 0;font-size:12px;color:#71717a;">If you didn't request this, ignore this email — your password stays the same.</p>
          </td></tr>
        </table>
        <div style="color:#a1a1aa;font-size:11px;margin-top:12px;letter-spacing:1px;">BOXWISE · CURRENCY A$</div>
      </td></tr>
    </table>
    """

@api.post("/auth/forgot-password")
async def forgot_password(body: ForgotPasswordIn):
    """Always returns 200 so email existence is not leaked. Workers only — admin emails are silently ignored."""
    email = body.email.strip().lower()
    generic_ok = {"ok": True, "message": "If a worker account exists for that email, a reset link has been sent."}
    user = await db.users.find_one({"email": email})
    if not user or user.get("role") != "worker":
        return generic_ok

    now = datetime.now(timezone.utc)
    # Invalidate any previous unused tokens for this user
    await db.password_reset_tokens.update_many(
        {"user_id": user["id"], "used_at": None},
        {"$set": {"used_at": now.isoformat(), "invalidated": True}},
    )
    token = secrets.token_urlsafe(32)
    doc = {
        "id": str(uuid.uuid4()),
        "user_id": user["id"],
        "email": email,
        "token": token,
        "created_at": now.isoformat(),
        "expires_at": (now + timedelta(minutes=RESET_TOKEN_TTL_MIN)).isoformat(),
        "used_at": None,
    }
    await db.password_reset_tokens.insert_one(doc)
    reset_link = f"{FRONTEND_URL.rstrip('/')}/reset-password?token={token}"
    try:
        await _send_email(
            to_email=email,
            subject="Reset your Boxwise password",
            html=_build_reset_email_html(user.get("name") or "", reset_link, RESET_TOKEN_TTL_MIN),
        )
    except Exception as e:
        logger.exception("Password reset email failed for %s: %s", email, e)
        raise HTTPException(status_code=502, detail="Could not send reset email. Please try again later.")
    return generic_ok

@api.post("/auth/reset-password")
async def reset_password(body: ResetPasswordIn):
    now = datetime.now(timezone.utc)
    rec = await db.password_reset_tokens.find_one({"token": body.token, "used_at": None})
    if not rec:
        raise HTTPException(status_code=400, detail="This reset link is invalid or has already been used.")
    if datetime.fromisoformat(rec["expires_at"]) < now:
        raise HTTPException(status_code=400, detail="This reset link has expired. Please request a new one.")
    user = await db.users.find_one({"id": rec["user_id"], "role": "worker"})
    if not user:
        raise HTTPException(status_code=400, detail="Account is no longer eligible for reset.")
    await db.users.update_one({"id": user["id"]}, {"$set": {"password_hash": hash_password(body.new_password)}})
    await db.password_reset_tokens.update_one({"id": rec["id"]}, {"$set": {"used_at": now.isoformat()}})
    return {"ok": True, "message": "Password updated. You can now sign in with your new password."}

@api.post("/auth/register")
async def register(body: RegisterIn, response: Response):
    email = body.email.strip().lower()
    if len(body.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
    if len(body.name.strip()) < 2:
        raise HTTPException(status_code=400, detail="Name is required")
    existing = await db.users.find_one({"email": email})
    if existing:
        raise HTTPException(status_code=400, detail="An account with this email already exists")
    user_id = str(uuid.uuid4())
    emp_id = (body.employee_id or "").strip()
    if emp_id:
        clash = await db.users.find_one({"employee_id": emp_id})
        if clash:
            raise HTTPException(status_code=400, detail="Employee ID already in use")
    else:
        emp_id = await _next_employee_id()
    doc = {
        "id": user_id,
        "email": email,
        "name": body.name.strip(),
        "role": "worker",
        "employee_id": emp_id,
        "job_role": (body.job_role or "").strip() or None,
        "password_hash": hash_password(body.password),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "self_registered": True,
    }
    await db.users.insert_one(doc)
    token = create_token(user_id, "worker")
    set_auth_cookie(response, token)
    return {
        "token": token,
        "user": {"id": user_id, "email": email, "name": doc["name"], "role": "worker"},
    }

@api.get("/auth/me", response_model=UserOut)
async def me(user: dict = Depends(get_current_user)):
    return UserOut(
        id=user["id"],
        email=user["email"],
        name=user["name"],
        role=user["role"],
        employee_id=user.get("employee_id"),
    )

# ---------- Workers management (admin) ----------
@api.get("/workers")
async def list_workers(_: dict = Depends(require_admin)):
    rows = await db.users.find({"role": "worker"}, {"_id": 0, "password_hash": 0}).sort("name", 1).to_list(1000)
    return rows

@api.post("/workers")
async def create_worker(body: WorkerCreate, _: dict = Depends(require_admin)):
    email = body.email.strip().lower()
    existing = await db.users.find_one({"email": email})
    if existing:
        raise HTTPException(status_code=400, detail="Email already exists")
    emp_id = (body.employee_id or "").strip()
    if emp_id:
        clash = await db.users.find_one({"employee_id": emp_id})
        if clash:
            raise HTTPException(status_code=400, detail="Employee ID already in use")
    else:
        emp_id = await _next_employee_id()
    doc = {
        "id": str(uuid.uuid4()),
        "email": email,
        "name": body.name.strip(),
        "role": "worker",
        "employee_id": emp_id,
        "job_role": (body.job_role or "").strip() or None,
        "password_hash": hash_password(body.password),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.users.insert_one(doc)
    doc.pop("password_hash")
    doc.pop("_id", None)
    return doc

@api.patch("/workers/{worker_id}")
async def update_worker(worker_id: str, body: WorkerUpdate, _: dict = Depends(require_admin)):
    update: dict = {}
    if body.name:
        update["name"] = body.name.strip()
    if body.password:
        update["password_hash"] = hash_password(body.password)
    if body.job_role is not None:
        update["job_role"] = body.job_role.strip() or None
    if body.employee_id is not None:
        emp_id = body.employee_id.strip()
        if emp_id:
            clash = await db.users.find_one({"employee_id": emp_id, "id": {"$ne": worker_id}})
            if clash:
                raise HTTPException(status_code=400, detail="Employee ID already in use")
            update["employee_id"] = emp_id
    if body.assigned_worksite_ids is not None:
        ids = [s for s in (body.assigned_worksite_ids or []) if s]
        if ids:
            existing_ids = set(await db.worksites.distinct("id", {"id": {"$in": ids}}))
            unknown = [i for i in ids if i not in existing_ids]
            if unknown:
                raise HTTPException(status_code=400, detail=f"Unknown worksite ids: {unknown}")
        update["assigned_worksite_ids"] = ids
    if not update:
        raise HTTPException(status_code=400, detail="Nothing to update")
    res = await db.users.update_one({"id": worker_id, "role": "worker"}, {"$set": update})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Worker not found")
    return {"ok": True}

@api.delete("/workers/{worker_id}")
async def delete_worker(worker_id: str, _: dict = Depends(require_admin)):
    res = await db.users.delete_one({"id": worker_id, "role": "worker"})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Worker not found")
    await db.reports.delete_many({"worker_id": worker_id})
    return {"ok": True}

# ---------- Rate ----------
@api.get("/settings/rate")
async def get_rate(_: dict = Depends(get_current_user)):
    doc = await db.settings.find_one({"key": "rate_per_box"})
    return {"rate": float(doc["value"]) if doc else 0.0}

@api.put("/settings/rate")
async def set_rate(body: RateIn, _: dict = Depends(require_admin)):
    await db.settings.update_one(
        {"key": "rate_per_box"},
        {"$set": {"key": "rate_per_box", "value": float(body.rate), "updated_at": datetime.now(timezone.utc).isoformat()}},
        upsert=True,
    )
    return {"rate": float(body.rate)}

# ---------- Pay method configs (per worker, per day) ----------
@api.get("/pay-configs")
async def list_pay_configs(
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    worker_id: Optional[str] = None,
    _: dict = Depends(require_admin),
):
    q: dict = {}
    if from_date or to_date:
        rng: dict = {}
        if from_date: rng["$gte"] = from_date
        if to_date: rng["$lte"] = to_date
        q["date"] = rng
    if worker_id:
        q["worker_id"] = worker_id
    rows = await db.pay_configs.find(q, {"_id": 0}).sort([("date", -1), ("worker_id", 1)]).to_list(5000)
    return rows

@api.put("/pay-configs")
async def upsert_pay_config(body: PayConfigIn, user: dict = Depends(require_admin)):
    if body.method not in ("piece", "hourly"):
        raise HTTPException(status_code=400, detail="method must be 'piece' or 'hourly'")
    try:
        date.fromisoformat(body.date)
    except ValueError:
        raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")
    worker = await db.users.find_one({"id": body.worker_id, "role": "worker"}, {"_id": 0})
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    doc = {
        "id": str(uuid.uuid4()),
        "worker_id": body.worker_id,
        "worker_name": worker["name"],
        "date": body.date,
        "method": body.method,
        "hours": float(body.hours or 0) if body.method == "hourly" else 0.0,
        "hourly_rate": float(body.hourly_rate or 0) if body.method == "hourly" else 0.0,
        "updated_by": user["email"],
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.pay_configs.update_one(
        {"worker_id": body.worker_id, "date": body.date},
        {"$set": {k: v for k, v in doc.items() if k != "id"}, "$setOnInsert": {"id": doc["id"]}},
        upsert=True,
    )
    saved = await db.pay_configs.find_one({"worker_id": body.worker_id, "date": body.date}, {"_id": 0})
    return saved

@api.delete("/pay-configs")
async def delete_pay_config(worker_id: str, date_: str, _: dict = Depends(require_admin)):
    res = await db.pay_configs.delete_one({"worker_id": worker_id, "date": date_})
    return {"deleted": res.deleted_count}

# ---------- Attendance (clock-in / clock-out) ----------
def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371000.0
    p1 = math.radians(lat1); p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1); dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))

async def _resolve_worksite(lat: float, lng: float, worksite_id: Optional[str]):
    """Return (worksite_doc, distance_m, error_msg). If worksite_id is provided, only that site is checked."""
    if worksite_id:
        ws = await db.worksites.find_one({"id": worksite_id, "active": True}, {"_id": 0})
        if not ws:
            return None, None, "Selected work location is not available"
        d = _haversine_m(lat, lng, ws["latitude"], ws["longitude"])
        if d <= ws["radius_m"]:
            return ws, d, None
        return None, d, f"You are {int(d)}m from {ws['name']} (allowed radius {ws['radius_m']}m)"
    # No explicit site → find nearest active site whose radius contains us
    best = None; best_d = None
    async for ws in db.worksites.find({"active": True}, {"_id": 0}):
        d = _haversine_m(lat, lng, ws["latitude"], ws["longitude"])
        if d <= ws["radius_m"] and (best_d is None or d < best_d):
            best = ws; best_d = d
    if best is None:
        return None, None, "You are outside every registered work location"
    return best, best_d, None
async def _sync_pay_config_hours(worker_id: str, worker_name: str, date_s: str, hours: float, user_email: str):
    existing = await db.pay_configs.find_one({"worker_id": worker_id, "date": date_s})
    now_s = datetime.now(timezone.utc).isoformat()
    doc = {
        "worker_id": worker_id,
        "worker_name": worker_name,
        "date": date_s,
        "method": "hourly",
        "hours": round(float(hours), 2),
        "hourly_rate": float(existing["hourly_rate"]) if existing and existing.get("hourly_rate") else 0.0,
        "updated_by": user_email,
        "updated_at": now_s,
        "auto_from_attendance": True,
    }
    await db.pay_configs.update_one(
        {"worker_id": worker_id, "date": date_s},
        {"$set": doc, "$setOnInsert": {"id": str(uuid.uuid4())}},
        upsert=True,
    )

@api.post("/attendance/clock-in")
async def clock_in(body: WorkerClockIn, user: dict = Depends(get_current_user)):
    if user["role"] != "worker":
        raise HTTPException(status_code=403, detail="Only workers can clock in")
    site, dist, err = await _resolve_worksite(body.latitude, body.longitude, body.worksite_id)
    if err:
        raise HTTPException(
            status_code=403,
            detail={
                "message": "You are outside the designated work location. Clock In/Clock Out is not allowed.",
                "reason": err,
                "distance_m": None if dist is None else int(dist),
            },
        )
    worker = await db.users.find_one({"id": user["id"]}, {"_id": 0, "password_hash": 0})
    assigned = (worker or {}).get("assigned_worksite_ids") or []
    if assigned and site["id"] not in assigned:
        raise HTTPException(
            status_code=403,
            detail={
                "message": f"You are not assigned to {site['name']}.",
                "reason": "worker-not-assigned-to-worksite",
            },
        )

    today_s = date.today().isoformat()
    existing = await db.attendance.find_one({"worker_id": user["id"], "date": today_s})
    if existing:
        if existing.get("clock_out"):
            raise HTTPException(status_code=409, detail="Shift already completed for today")
        raise HTTPException(status_code=409, detail="Already clocked in")
    now = datetime.now(timezone.utc)
    doc = {
        "id": str(uuid.uuid4()),
        "worker_id": user["id"],
        "worker_name": user["name"],
        "date": today_s,
        "clock_in": now.isoformat(),
        "clock_out": None,
        "hours": None,
        "clock_in_lat": float(body.latitude),
        "clock_in_lng": float(body.longitude),
        "clock_in_accuracy_m": float(body.accuracy_m) if body.accuracy_m is not None else None,
        "clock_in_distance_m": int(dist) if dist is not None else None,
        "worksite_id": site["id"],
        "worksite_name": site["name"],
        "worksite_lat": site["latitude"],
        "worksite_lng": site["longitude"],
        "worksite_radius_m": site["radius_m"],
        "source": "worker_self",
        "updated_at": now.isoformat(),
    }
    await db.attendance.insert_one(doc)
    doc.pop("_id", None)
    return doc

@api.post("/attendance/clock-out")
async def clock_out(body: WorkerClockIn, user: dict = Depends(get_current_user)):
    if user["role"] != "worker":
        raise HTTPException(status_code=403, detail="Only workers can clock out")
    site, dist, err = await _resolve_worksite(body.latitude, body.longitude, body.worksite_id)
    if err:
        raise HTTPException(
            status_code=403,
            detail={
                "message": "You are outside the designated work location. Clock In/Clock Out is not allowed.",
                "reason": err,
                "distance_m": None if dist is None else int(dist),
            },
        )
    worker = await db.users.find_one({"id": user["id"]}, {"_id": 0, "password_hash": 0})
    assigned = (worker or {}).get("assigned_worksite_ids") or []
    if assigned and site["id"] not in assigned:
        raise HTTPException(
            status_code=403,
            detail={
                "message": f"You are not assigned to {site['name']}.",
                "reason": "worker-not-assigned-to-worksite",
            },
        )

    today_s = date.today().isoformat()
    existing = await db.attendance.find_one({"worker_id": user["id"], "date": today_s})
    if not existing:
        raise HTTPException(status_code=400, detail="You are not clocked in")
    if existing.get("clock_out"):
        raise HTTPException(status_code=409, detail="Already clocked out")
    now = datetime.now(timezone.utc)
    ci = datetime.fromisoformat(existing["clock_in"])
    hours = max(0.0, round((now - ci).total_seconds() / 3600, 2))
    await db.attendance.update_one(
        {"id": existing["id"]},
        {"$set": {
            "clock_out": now.isoformat(),
            "hours": hours,
            "clock_out_lat": float(body.latitude),
            "clock_out_lng": float(body.longitude),
            "clock_out_accuracy_m": float(body.accuracy_m) if body.accuracy_m is not None else None,
            "clock_out_distance_m": int(dist) if dist is not None else None,
            "clock_out_worksite_id": site["id"],
            "clock_out_worksite_name": site["name"],
            "updated_at": now.isoformat(),
        }},
    )
    await _sync_pay_config_hours(user["id"], user["name"], today_s, hours, user["email"])
    return {"id": existing["id"], "clock_in": existing["clock_in"], "clock_out": now.isoformat(), "hours": hours}

@api.get("/attendance/me")
async def my_attendance(date_: Optional[str] = None, limit: int = 30, user: dict = Depends(get_current_user)):
    q = {"worker_id": user["id"]}
    if date_:
        q["date"] = date_
        rows = await db.attendance.find(q, {"_id": 0}).to_list(1)
        return rows[0] if rows else None
    rows = await db.attendance.find(q, {"_id": 0}).sort("date", -1).to_list(max(1, min(120, int(limit))))
    return rows

@api.get("/attendance")
async def list_attendance(
    date_: Optional[str] = None,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    _: dict = Depends(require_admin),
):
    q: dict = {}
    if date_:
        q["date"] = date_
    elif from_date or to_date:
        rng: dict = {}
        if from_date: rng["$gte"] = from_date
        if to_date: rng["$lte"] = to_date
        q["date"] = rng
    rows = await db.attendance.find(q, {"_id": 0}).sort([("date", -1), ("clock_in", 1)]).to_list(5000)
    return rows

@api.patch("/attendance/{att_id}")
async def correct_attendance(att_id: str, body: AttendanceCorrectIn, user: dict = Depends(require_admin)):
    existing = await db.attendance.find_one({"id": att_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Attendance record not found")
    hours = round(float(body.hours), 2)
    await db.attendance.update_one(
        {"id": att_id},
        {"$set": {"hours": hours, "updated_at": datetime.now(timezone.utc).isoformat(), "corrected_by": user["email"]}},
    )
    # Cascade to pay_configs
    await _sync_pay_config_hours(existing["worker_id"], existing["worker_name"], existing["date"], hours, user["email"])
    return {"id": att_id, "hours": hours}

# ---------- Worksites (geofence) ----------
@api.get("/worksites")
async def list_worksites(only_active: bool = False, user: dict = Depends(get_current_user)):
    q = {"active": True} if only_active else {}
    rows = await db.worksites.find(q, {"_id": 0}).sort([("active", -1), ("name", 1)]).to_list(500)
    return rows

@api.post("/worksites")
async def create_worksite(body: WorksiteIn, user: dict = Depends(require_admin)):
    if not (-90 <= body.latitude <= 90) or not (-180 <= body.longitude <= 180):
        raise HTTPException(status_code=400, detail="Invalid coordinates")
    doc = {
        "id": str(uuid.uuid4()),
        "name": body.name.strip(),
        "latitude": float(body.latitude),
        "longitude": float(body.longitude),
        "radius_m": int(body.radius_m),
        "active": bool(body.active),
        "created_by": user["email"],
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.worksites.insert_one(doc)
    doc.pop("_id", None)
    return doc

@api.patch("/worksites/{worksite_id}")
async def update_worksite(worksite_id: str, body: WorksiteUpdate, user: dict = Depends(require_admin)):
    update: dict = {}
    if body.name is not None:
        update["name"] = body.name.strip()
    if body.latitude is not None:
        if not (-90 <= body.latitude <= 90):
            raise HTTPException(status_code=400, detail="Invalid latitude")
        update["latitude"] = float(body.latitude)
    if body.longitude is not None:
        if not (-180 <= body.longitude <= 180):
            raise HTTPException(status_code=400, detail="Invalid longitude")
        update["longitude"] = float(body.longitude)
    if body.radius_m is not None:
        update["radius_m"] = int(body.radius_m)
    if body.active is not None:
        update["active"] = bool(body.active)
    if not update:
        raise HTTPException(status_code=400, detail="Nothing to update")
    update["updated_at"] = datetime.now(timezone.utc).isoformat()
    update["updated_by"] = user["email"]
    res = await db.worksites.update_one({"id": worksite_id}, {"$set": update})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Worksite not found")
    saved = await db.worksites.find_one({"id": worksite_id}, {"_id": 0})
    return saved

@api.delete("/worksites/{worksite_id}")
async def delete_worksite(worksite_id: str, _: dict = Depends(require_admin)):
    res = await db.worksites.delete_one({"id": worksite_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Worksite not found")
    return {"ok": True}

# ---------- Supervisor-driven, geofenced clock-in / clock-out ----------
def _extract_worker_id(payload: str) -> str:
    v = (payload or "").strip()
    if v.startswith("BW-W:"):
        v = v[5:]
    return v

SELF_SCAN_MSG = (
    "You cannot scan your own QR code. "
    "Please ask another Supervisor to record your completed boxes or attendance."
)

async def _reject_self_scan(supervisor: dict, kind: str):
    """Log a rejected self-scan attempt and raise 409."""
    now = datetime.now(timezone.utc)
    await db.scan_rejections.insert_one({
        "id": str(uuid.uuid4()),
        "worker_id": supervisor["id"],
        "worker_name": supervisor["name"],
        "barcode": f"BW-W:{supervisor['id']}",
        "date": date.today().isoformat(),
        "created_at": now.isoformat(),
        "reason": "supervisor-self-scan",
        "kind": kind,
        "supervisor_id": supervisor["id"],
        "supervisor_name": supervisor["name"],
        "supervisor_email": supervisor["email"],
    })
    raise HTTPException(status_code=409, detail=SELF_SCAN_MSG)

@api.post("/attendance/scan-clock-in")
async def scan_clock_in(body: ScanClockIn, user: dict = Depends(require_admin)):
    """Supervisor scans a worker's QR to clock them IN. Requires supervisor's GPS to be inside a worksite radius."""
    wid = _extract_worker_id(body.worker_id)
    if wid == user["id"]:
        await _reject_self_scan(user, "clock_in")
    worker = await db.users.find_one({"id": wid, "role": "worker"}, {"_id": 0, "password_hash": 0})
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found for this QR code")

    site, dist, err = await _resolve_worksite(body.latitude, body.longitude, body.worksite_id)
    if err:
        raise HTTPException(
            status_code=403,
            detail={
                "message": "You are outside the designated work location. Clock In/Clock Out is not allowed.",
                "reason": err,
                "distance_m": None if dist is None else int(dist),
            },
        )

    assigned = worker.get("assigned_worksite_ids") or []
    if assigned and site["id"] not in assigned:
        raise HTTPException(
            status_code=403,
            detail={
                "message": f"{worker['name']} is not permitted to clock in at {site['name']}.",
                "reason": "worker-not-assigned-to-worksite",
            },
        )

    today_s = date.today().isoformat()
    existing = await db.attendance.find_one({"worker_id": worker["id"], "date": today_s})
    if existing:
        if existing.get("clock_out"):
            raise HTTPException(status_code=409, detail=f"{worker['name']}'s shift is already completed for today")
        raise HTTPException(status_code=409, detail=f"{worker['name']} is already clocked in")

    now = datetime.now(timezone.utc)
    doc = {
        "id": str(uuid.uuid4()),
        "worker_id": worker["id"],
        "worker_name": worker["name"],
        "date": today_s,
        "clock_in": now.isoformat(),
        "clock_out": None,
        "hours": None,
        "clock_in_lat": float(body.latitude),
        "clock_in_lng": float(body.longitude),
        "clock_in_accuracy_m": float(body.accuracy_m) if body.accuracy_m is not None else None,
        "clock_in_distance_m": int(dist) if dist is not None else None,
        "worksite_id": site["id"],
        "worksite_name": site["name"],
        "worksite_lat": site["latitude"],
        "worksite_lng": site["longitude"],
        "worksite_radius_m": site["radius_m"],
        "supervisor_id": user["id"],
        "supervisor_name": user["name"],
        "supervisor_email": user["email"],
        "updated_at": now.isoformat(),
    }
    await db.attendance.insert_one(doc)
    doc.pop("_id", None)
    return {**doc, "worker": {"id": worker["id"], "name": worker["name"], "job_role": worker.get("job_role")}}

@api.post("/attendance/scan-clock-out")
async def scan_clock_out(body: ScanClockIn, user: dict = Depends(require_admin)):
    """Supervisor scans a worker's QR to clock them OUT."""
    wid = _extract_worker_id(body.worker_id)
    if wid == user["id"]:
        await _reject_self_scan(user, "clock_out")
    worker = await db.users.find_one({"id": wid, "role": "worker"}, {"_id": 0, "password_hash": 0})
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found for this QR code")

    site, dist, err = await _resolve_worksite(body.latitude, body.longitude, body.worksite_id)
    if err:
        raise HTTPException(
            status_code=403,
            detail={
                "message": "You are outside the designated work location. Clock In/Clock Out is not allowed.",
                "reason": err,
                "distance_m": None if dist is None else int(dist),
            },
        )

    assigned = worker.get("assigned_worksite_ids") or []
    if assigned and site["id"] not in assigned:
        raise HTTPException(
            status_code=403,
            detail={
                "message": f"{worker['name']} is not permitted to clock out at {site['name']}.",
                "reason": "worker-not-assigned-to-worksite",
            },
        )

    today_s = date.today().isoformat()
    existing = await db.attendance.find_one({"worker_id": worker["id"], "date": today_s})
    if not existing:
        raise HTTPException(status_code=400, detail=f"{worker['name']} is not clocked in today")
    if existing.get("clock_out"):
        raise HTTPException(status_code=409, detail=f"{worker['name']} has already clocked out today")

    now = datetime.now(timezone.utc)
    ci = datetime.fromisoformat(existing["clock_in"])
    hours = max(0.0, round((now - ci).total_seconds() / 3600, 2))
    await db.attendance.update_one(
        {"id": existing["id"]},
        {"$set": {
            "clock_out": now.isoformat(),
            "hours": hours,
            "clock_out_lat": float(body.latitude),
            "clock_out_lng": float(body.longitude),
            "clock_out_accuracy_m": float(body.accuracy_m) if body.accuracy_m is not None else None,
            "clock_out_distance_m": int(dist) if dist is not None else None,
            "clock_out_worksite_id": site["id"],
            "clock_out_worksite_name": site["name"],
            "clock_out_supervisor_id": user["id"],
            "clock_out_supervisor_name": user["name"],
            "updated_at": now.isoformat(),
        }},
    )
    await _sync_pay_config_hours(worker["id"], worker["name"], today_s, hours, user["email"])
    updated = await db.attendance.find_one({"id": existing["id"]}, {"_id": 0})
    return {**updated, "worker": {"id": worker["id"], "name": worker["name"], "job_role": worker.get("job_role")}}

# ---------- Attendance exports ----------
@api.get("/attendance/xlsx")
async def attendance_xlsx(
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    _: dict = Depends(require_admin),
):
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    q: dict = {}
    if from_date or to_date:
        rng: dict = {}
        if from_date: rng["$gte"] = from_date
        if to_date: rng["$lte"] = to_date
        q["date"] = rng
    rows = await db.attendance.find(q, {"_id": 0}).sort([("date", 1), ("clock_in", 1)]).to_list(10000)

    wb = Workbook(); ws = wb.active; ws.title = "Attendance"
    yellow = PatternFill(start_color="FFEAB308", end_color="FFEAB308", fill_type="solid")
    dark = PatternFill(start_color="FF09090B", end_color="FF09090B", fill_type="solid")
    bold_white = Font(bold=True, color="FFFFFFFF", size=11)
    bold = Font(bold=True, size=11)
    thin = Side(border_style="thin", color="FFE4E4E7")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)

    ws["A1"] = "ATTENDANCE"; ws["A1"].font = Font(bold=True, size=22)
    ws["A2"] = f"Range: {from_date or 'all'} → {to_date or 'all'}"; ws["A2"].font = Font(color="FF71717A")

    headers = ["Worker", "Worker ID", "Date", "Clock In", "Clock Out", "Hours",
               "Worksite", "Worksite GPS", "Clock-In GPS", "Distance (m)",
               "Supervisor (In)", "Supervisor (Out)"]
    for i, h in enumerate(headers, 1):
        c = ws.cell(row=4, column=i, value=h)
        c.fill = dark; c.font = bold_white; c.alignment = Alignment(horizontal="left")

    r = 5
    total_hours = 0.0
    for a in rows:
        vals = [
            a.get("worker_name") or "",
            a.get("worker_id") or "",
            a.get("date") or "",
            (a.get("clock_in") or "")[:19].replace("T", " "),
            (a.get("clock_out") or "")[:19].replace("T", " "),
            float(a.get("hours") or 0),
            a.get("worksite_name") or "",
            f"{a.get('worksite_lat','')},{a.get('worksite_lng','')}" if a.get("worksite_lat") is not None else "",
            f"{a.get('clock_in_lat','')},{a.get('clock_in_lng','')}" if a.get("clock_in_lat") is not None else "",
            a.get("clock_in_distance_m") if a.get("clock_in_distance_m") is not None else "",
            a.get("supervisor_name") or "",
            a.get("clock_out_supervisor_name") or "",
        ]
        for i, v in enumerate(vals, 1):
            c = ws.cell(row=r, column=i, value=v); c.border = border
        total_hours += float(a.get("hours") or 0)
        r += 1
    ws.cell(row=r, column=1, value="TOTAL").font = bold
    ws.cell(row=r, column=6, value=round(total_hours, 2)).font = bold

    for col, w in zip("ABCDEFGHIJKL", [22, 26, 12, 20, 20, 8, 22, 26, 26, 12, 22, 22]):
        ws.column_dimensions[col].width = w

    return _xlsx_response(wb, f"attendance_{from_date or 'all'}_{to_date or 'all'}.xlsx")

@api.get("/attendance/pdf")
async def attendance_pdf(
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    _: dict = Depends(require_admin),
):
    q: dict = {}
    if from_date or to_date:
        rng: dict = {}
        if from_date: rng["$gte"] = from_date
        if to_date: rng["$lte"] = to_date
        q["date"] = rng
    rows = await db.attendance.find(q, {"_id": 0}).sort([("date", 1), ("clock_in", 1)]).to_list(10000)

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=12 * mm, rightMargin=12 * mm,
                            topMargin=12 * mm, bottomMargin=12 * mm)
    styles = getSampleStyleSheet()
    title = ParagraphStyle("t", parent=styles["Title"], fontName="Helvetica-Bold",
                           fontSize=22, textColor=colors.HexColor("#09090B"), spaceAfter=4)
    sub = ParagraphStyle("s", parent=styles["Normal"], fontName="Helvetica",
                         fontSize=10, textColor=colors.HexColor("#71717A"))
    story = []
    story.append(Paragraph("ATTENDANCE REPORT", title))
    story.append(Paragraph(f"Boxwise Payroll · Generated {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}", sub))
    story.append(Paragraph(f"Range: {from_date or 'all'} → {to_date or 'all'} · {len(rows)} shift(s)", sub))
    story.append(Spacer(1, 10))

    total_hours = round(sum(float(a.get("hours") or 0) for a in rows), 2)
    banner = Table([[
        Paragraph(f"<font color='#09090B'><b>SHIFTS</b></font><br/><font size=18 color='#09090B'><b>{len(rows)}</b></font>", styles["Normal"]),
        Paragraph(f"<font color='#09090B'><b>TOTAL HOURS</b></font><br/><font size=18 color='#09090B'><b>{total_hours:.2f}</b></font>", styles["Normal"]),
        Paragraph(f"<font color='#09090B'><b>WORKERS</b></font><br/><font size=18 color='#09090B'><b>{len({a.get('worker_id') for a in rows})}</b></font>", styles["Normal"]),
    ]], colWidths=[60 * mm, 60 * mm, 60 * mm])
    banner.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#EAB308")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
    ]))
    story.append(banner)
    story.append(Spacer(1, 12))

    data = [["Date", "Worker", "In", "Out", "Hrs", "Worksite", "GPS (in)", "Dist (m)"]]
    if not rows:
        data.append(["—"] * 8)
    for a in rows:
        gps_in = ""
        if a.get("clock_in_lat") is not None:
            gps_in = f"{a['clock_in_lat']:.5f},{a['clock_in_lng']:.5f}"
        data.append([
            a.get("date") or "",
            a.get("worker_name") or "",
            (a.get("clock_in") or "")[11:16],
            (a.get("clock_out") or "")[11:16] if a.get("clock_out") else "—",
            f"{float(a.get('hours') or 0):.2f}",
            a.get("worksite_name") or "—",
            gps_in,
            str(a.get("clock_in_distance_m")) if a.get("clock_in_distance_m") is not None else "—",
        ])
    tbl = Table(data, colWidths=[20*mm, 32*mm, 16*mm, 16*mm, 12*mm, 32*mm, 40*mm, 16*mm], repeatRows=1)
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#09090B")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#E4E4E7")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#FAFAF9")]),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    story.append(tbl)
    doc.build(story)

    fname = f"attendance_{from_date or 'all'}_{to_date or 'all'}.pdf"
    return StreamingResponse(
        io.BytesIO(buf.getvalue()),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )

async def _compute_earnings_for_range(worker_ids: list, from_date: str, to_date: str):
    """Return {worker_id: {days: [...], total_boxes, total_hours, total_earnings, total_scans}}, global_rate."""
    global_rate = await _rate()
    pipeline = [
        {"$match": {"worker_id": {"$in": worker_ids}, "date": {"$gte": from_date, "$lte": to_date}}},
        {"$group": {
            "_id": {"worker_id": "$worker_id", "date": "$date"},
            "boxes": {"$sum": "$boxes"},
            "scans": {"$sum": {"$cond": [{"$eq": ["$source", "scan"]}, 1, 0]}},
        }},
    ]
    boxes_map = {}
    async for a in db.reports.aggregate(pipeline):
        boxes_map[(a["_id"]["worker_id"], a["_id"]["date"])] = {"boxes": int(a["boxes"]), "scans": int(a["scans"])}
    cfgs = await db.pay_configs.find(
        {"worker_id": {"$in": worker_ids}, "date": {"$gte": from_date, "$lte": to_date}},
        {"_id": 0},
    ).to_list(10000)
    cfg_map = {(c["worker_id"], c["date"]): c for c in cfgs}

    keys = set(boxes_map.keys()) | set(cfg_map.keys())
    per_worker = {w: {"days": [], "total_boxes": 0, "total_hours": 0.0, "total_earnings": 0.0, "total_scans": 0} for w in worker_ids}
    for w, d in sorted(keys):
        if w not in per_worker:
            continue
        b = boxes_map.get((w, d), {"boxes": 0, "scans": 0})
        cfg = cfg_map.get((w, d))
        method = (cfg or {}).get("method", "piece")
        if method == "hourly":
            hours = float((cfg or {}).get("hours") or 0)
            rate = float((cfg or {}).get("hourly_rate") or 0)
            earn = round(hours * rate, 2)
        else:
            hours = 0.0
            rate = 0.0
            earn = round(b["boxes"] * global_rate, 2)
        per_worker[w]["days"].append({
            "date": d,
            "method": method,
            "boxes": b["boxes"],
            "scans": b["scans"],
            "hours": hours,
            "hourly_rate": rate,
            "piece_rate": global_rate if method == "piece" else 0.0,
            "earnings": earn,
        })
        per_worker[w]["total_boxes"] += b["boxes"]
        per_worker[w]["total_scans"] += b["scans"]
        per_worker[w]["total_hours"] += hours
        per_worker[w]["total_earnings"] += earn
    for w in per_worker:
        per_worker[w]["total_earnings"] = round(per_worker[w]["total_earnings"], 2)
        per_worker[w]["total_hours"] = round(per_worker[w]["total_hours"], 2)
    return per_worker, global_rate

# ---------- Reports ----------
@api.get("/workers/{worker_id}/scan-summary")
async def worker_scan_summary(worker_id: str, _: dict = Depends(require_admin)):
    """Day + week + month totals plus the last 25 scans for a specific worker."""
    worker = await db.users.find_one({"id": worker_id, "role": "worker"}, {"_id": 0, "password_hash": 0})
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    today = date.today()
    monday, sunday = week_range(iso_week_key(today))
    mkey = month_key(today)

    agg = await db.reports.aggregate([
        {"$match": {"worker_id": worker_id}},
        {"$group": {
            "_id": None,
            "day": {"$sum": {"$cond": [{"$eq": ["$date", today.isoformat()]}, "$boxes", 0]}},
            "week": {"$sum": {"$cond": [
                {"$and": [
                    {"$gte": ["$date", monday.isoformat()]},
                    {"$lte": ["$date", sunday.isoformat()]},
                ]}, "$boxes", 0]}},
            "month": {"$sum": {"$cond": [{"$eq": ["$month_key", mkey]}, "$boxes", 0]}},
            "all_time": {"$sum": "$boxes"},
        }},
    ]).to_list(1)
    tot = agg[0] if agg else {"day": 0, "week": 0, "month": 0, "all_time": 0}

    recent = await db.reports.find(
        {"worker_id": worker_id, "source": "supervisor_scan"},
        {"_id": 0},
    ).sort("created_at", -1).to_list(25)

    return {
        "worker": {
            "id": worker["id"],
            "name": worker["name"],
            "email": worker["email"],
            "employee_id": worker.get("employee_id"),
            "job_role": worker.get("job_role"),
        },
        "today": today.isoformat(),
        "week_key": iso_week_key(today),
        "month_key": mkey,
        "day_boxes": int(tot.get("day") or 0),
        "week_boxes": int(tot.get("week") or 0),
        "month_boxes": int(tot.get("month") or 0),
        "all_time_boxes": int(tot.get("all_time") or 0),
        "recent_scans": recent,
    }

@api.delete("/scans/{scan_id}")
async def delete_supervisor_scan(scan_id: str, reason: Optional[str] = None, user: dict = Depends(require_admin)):
    """Supervisor/admin removes an incorrect supervisor_scan. Logged for audit."""
    scan = await db.reports.find_one({"id": scan_id})
    if not scan:
        raise HTTPException(status_code=404, detail="Scan not found")
    if scan.get("source") != "supervisor_scan":
        raise HTTPException(status_code=400, detail="Only supervisor scans can be corrected here")
    now = datetime.now(timezone.utc)
    await db.scan_corrections.insert_one({
        "id": str(uuid.uuid4()),
        "scan_id": scan_id,
        "worker_id": scan.get("worker_id"),
        "worker_name": scan.get("worker_name"),
        "original_supervisor_id": scan.get("supervisor_id"),
        "original_supervisor_name": scan.get("supervisor_name"),
        "corrected_by_id": user["id"],
        "corrected_by_name": user["name"],
        "corrected_by_email": user["email"],
        "reason": (reason or "").strip() or None,
        "original_created_at": scan.get("created_at"),
        "corrected_at": now.isoformat(),
    })
    await db.reports.delete_one({"id": scan_id})
    return {"ok": True, "scan_id": scan_id}

# ---------- Legacy report create ----------
@api.post("/reports", response_model=BoxReportOut)
async def create_report(body: BoxReportIn, user: dict = Depends(get_current_user)):
    if user["role"] != "worker":
        raise HTTPException(status_code=403, detail="Only workers can report boxes")
    d = date.fromisoformat(body.date) if body.date else date.today()
    doc = {
        "id": str(uuid.uuid4()),
        "worker_id": user["id"],
        "worker_name": user["name"],
        "date": d.isoformat(),
        "boxes": int(body.boxes),
        "note": body.note,
        "source": "manual",
        "barcode": None,
        "week_key": iso_week_key(d),
        "month_key": month_key(d),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.reports.insert_one(doc)
    doc.pop("_id", None)
    return doc

# ---------- Barcode scans ----------
@api.post("/scans/for-worker")
async def create_worker_scan(body: dict, user: dict = Depends(require_admin)):
    """Supervisor scans a worker's QR name tag. Each scan = +1 box for that worker. No dedupe."""
    worker_qr = (body.get("worker_id") or body.get("barcode") or "").strip()
    if not worker_qr:
        raise HTTPException(status_code=400, detail="worker_id (or QR barcode) is required")
    if worker_qr.startswith("BW-W:"):
        worker_qr = worker_qr[5:]
    if worker_qr == user["id"]:
        await _reject_self_scan(user, "box_scan")
    worker = await db.users.find_one({"id": worker_qr, "role": "worker"}, {"_id": 0, "password_hash": 0})
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found for this QR code")
    now = datetime.now(timezone.utc)
    today = date.today()
    two_s_ago = (now - timedelta(seconds=2)).isoformat()
    burst = await db.reports.find_one({
        "worker_id": worker["id"],
        "supervisor_id": user["id"],
        "source": "supervisor_scan",
        "created_at": {"$gte": two_s_ago},
    })
    if burst:
        raise HTTPException(status_code=429, detail="Slow down — same worker scanned less than 2s ago")
    doc = {
        "id": str(uuid.uuid4()),
        "worker_id": worker["id"],
        "worker_name": worker["name"],
        "date": today.isoformat(),
        "boxes": 1,
        "barcode": f"BW-W:{worker['id']}",
        "source": "supervisor_scan",
        "supervisor_id": user["id"],
        "supervisor_name": user["name"],
        "supervisor_email": user["email"],
        "note": None,
        "week_key": iso_week_key(today),
        "month_key": month_key(today),
        "created_at": now.isoformat(),
    }
    await db.reports.insert_one(doc)
    doc.pop("_id", None)
    return {**doc, "worker": {"id": worker["id"], "name": worker["name"], "job_role": worker.get("job_role")}}

@api.post("/scans", response_model=BoxReportOut)
async def create_scan(body: ScanIn, user: dict = Depends(get_current_user)):
    if user["role"] != "worker":
        raise HTTPException(status_code=403, detail="Only workers can scan boxes")
    barcode = body.barcode.strip()
    now = datetime.now(timezone.utc)
    today = date.today()
    today_s = today.isoformat()
    # Day-level dedupe: same barcode can only count ONCE per day (any worker)
    existing = await db.reports.find_one({
        "source": "scan",
        "barcode": barcode,
        "date": today_s,
    })
    if existing:
        # Log the rejection for audit, but do not increment the count
        rej = {
            "id": str(uuid.uuid4()),
            "worker_id": user["id"],
            "worker_name": user["name"],
            "barcode": barcode,
            "date": today_s,
            "created_at": now.isoformat(),
            "reason": "duplicate-same-day",
            "original_worker_id": existing.get("worker_id"),
            "original_worker_name": existing.get("worker_name"),
            "original_scanned_at": existing.get("created_at"),
        }
        await db.scan_rejections.insert_one(rej)
        raise HTTPException(
            status_code=409,
            detail={
                "message": "This barcode has already been scanned today.",
                "barcode": barcode,
                "original_worker": existing.get("worker_name"),
                "original_time": existing.get("created_at"),
                "reason": "duplicate-same-day",
            },
        )

    # Whitelist enforcement (soft): if a whitelist exists for today, mark scans not in it as suspicious
    suspicious = False
    reason = None
    wl_count = await db.whitelist.count_documents({"date": today_s})
    if wl_count > 0:
        match = await db.whitelist.find_one({"date": today_s, "barcode": barcode})
        if not match:
            suspicious = True
            reason = "not-in-whitelist"
    doc = {
        "id": str(uuid.uuid4()),
        "worker_id": user["id"],
        "worker_name": user["name"],
        "date": today_s,
        "boxes": 1,
        "barcode": barcode,
        "barcode_format": body.format,
        "source": "scan",
        "note": None,
        "suspicious": suspicious,
        "suspicious_reason": reason,
        "week_key": iso_week_key(today),
        "month_key": month_key(today),
        "created_at": now.isoformat(),
    }
    await db.reports.insert_one(doc)
    doc.pop("_id", None)
    return doc

@api.get("/scans/rejections")
async def scan_rejections(
    limit: int = 100,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    _: dict = Depends(require_admin),
):
    limit = max(1, min(2000, int(limit)))
    q: dict = {}
    if from_date or to_date:
        rng: dict = {}
        if from_date:
            rng["$gte"] = from_date
        if to_date:
            rng["$lte"] = to_date
        q["date"] = rng
    rows = await db.scan_rejections.find(q, {"_id": 0}).sort("created_at", -1).to_list(limit)
    return rows

def _fetch_rejections(from_date: Optional[str], to_date: Optional[str]):
    q: dict = {}
    if from_date or to_date:
        rng: dict = {}
        if from_date:
            rng["$gte"] = from_date
        if to_date:
            rng["$lte"] = to_date
        q["date"] = rng
    return q

@api.get("/scans/rejections/csv")
async def rejections_csv(
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    _: dict = Depends(require_admin),
):
    q = _fetch_rejections(from_date, to_date)
    rows = await db.scan_rejections.find(q, {"_id": 0}).sort("created_at", -1).to_list(5000)
    def esc(v):
        s = "" if v is None else str(v)
        return f'"{s.replace(chr(34), chr(34)+chr(34))}"' if any(ch in s for ch in [',', '"', '\n']) else s
    lines = [
        f"# Boxwise Rejection Audit Log",
        f"# Range: {from_date or 'all'} → {to_date or 'all'}",
        f"# Generated: {datetime.now(timezone.utc).isoformat()}",
        "",
        "Rejected At,Date,Worker Attempted,Barcode,Reason,Original Worker,Original Scan Time",
    ]
    for r in rows:
        lines.append(",".join([
            esc(r.get("created_at")),
            esc(r.get("date")),
            esc(r.get("worker_name")),
            esc(r.get("barcode")),
            esc(r.get("reason")),
            esc(r.get("original_worker_name")),
            esc(r.get("original_scanned_at")),
        ]))
    body = "\n".join(lines).encode("utf-8")
    fname = f"rejections_{from_date or 'all'}_{to_date or 'all'}.csv"
    return StreamingResponse(
        io.BytesIO(body),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )

@api.get("/scans/rejections/pdf")
async def rejections_pdf(
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    _: dict = Depends(require_admin),
):
    q = _fetch_rejections(from_date, to_date)
    rows = await db.scan_rejections.find(q, {"_id": 0}).sort("created_at", -1).to_list(5000)

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=14 * mm, rightMargin=14 * mm,
        topMargin=14 * mm, bottomMargin=14 * mm,
    )
    styles = getSampleStyleSheet()
    title = ParagraphStyle("t", parent=styles["Title"], fontName="Helvetica-Bold",
                           fontSize=22, textColor=colors.HexColor("#09090B"), spaceAfter=4)
    sub = ParagraphStyle("s", parent=styles["Normal"], fontName="Helvetica",
                         fontSize=10, textColor=colors.HexColor("#71717A"))
    story = []
    story.append(Paragraph("REJECTION AUDIT LOG", title))
    story.append(Paragraph(f"Boxwise Payroll · Generated {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}", sub))
    story.append(Paragraph(f"Range: {from_date or 'all'} → {to_date or 'all'} · {len(rows)} rejected scan(s)", sub))
    story.append(Spacer(1, 10))

    # Yellow summary banner
    from collections import Counter
    workers_ct = Counter(r.get("worker_name") for r in rows)
    top_workers = ", ".join(f"{w} ({n})" for w, n in workers_ct.most_common(3)) or "—"
    banner = Table([[
        Paragraph(f"<font color='#09090B'><b>TOTAL</b></font><br/><font size=18 color='#09090B'><b>{len(rows)}</b></font>", styles["Normal"]),
        Paragraph(f"<font color='#09090B'><b>UNIQUE BARCODES</b></font><br/><font size=18 color='#09090B'><b>{len({r.get('barcode') for r in rows})}</b></font>", styles["Normal"]),
        Paragraph(f"<font color='#09090B'><b>TOP OFFENDERS</b></font><br/><font size=10 color='#09090B'><b>{top_workers}</b></font>", styles["Normal"]),
    ]], colWidths=[55 * mm, 55 * mm, 72 * mm])
    banner.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#EAB308")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
    ]))
    story.append(banner)
    story.append(Spacer(1, 12))

    data = [["Rejected At (UTC)", "Date", "Attempted by", "Barcode", "Reason", "Original by", "Original at"]]
    if not rows:
        data.append(["—", "—", "—", "No rejections in this range", "—", "—", "—"])
    for r in rows:
        data.append([
            (r.get("created_at") or "")[:19].replace("T", " "),
            r.get("date") or "",
            r.get("worker_name") or "",
            (r.get("barcode") or "")[:24],
            r.get("reason") or "",
            r.get("original_worker_name") or "",
            (r.get("original_scanned_at") or "")[:19].replace("T", " "),
        ])
    tbl = Table(data, colWidths=[32*mm, 20*mm, 26*mm, 30*mm, 25*mm, 24*mm, 32*mm], repeatRows=1)
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#09090B")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#E4E4E7")),
        ("BACKGROUND", (0, 1), (-1, -1), colors.white),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#FFF7ED")]),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    story.append(tbl)
    story.append(Spacer(1, 12))
    story.append(Paragraph(
        "<font size=8 color='#71717A'>Duplicate scans are blocked and do not affect payroll. This log is an "
        "audit trail for HR investigations only.</font>",
        styles["Normal"],
    ))
    doc.build(story)

    fname = f"rejections_{from_date or 'all'}_{to_date or 'all'}.pdf"
    return StreamingResponse(
        io.BytesIO(buf.getvalue()),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )

# ---------- Whitelist ----------
@api.post("/whitelist")
async def upload_whitelist(body: WhitelistIn, user: dict = Depends(require_admin)):
    try:
        date.fromisoformat(body.date)
    except ValueError:
        raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")
    # Clean list: strip, dedupe, drop empties
    seen = set()
    cleaned = []
    for b in body.barcodes:
        b = (b or "").strip()
        if not b or b in seen:
            continue
        seen.add(b)
        cleaned.append(b)
    if body.replace:
        await db.whitelist.delete_many({"date": body.date})
    now_s = datetime.now(timezone.utc).isoformat()
    if cleaned:
        # Bulk upsert
        ops = []
        for b in cleaned:
            ops.append({
                "date": body.date,
                "barcode": b,
                "uploaded_by": user["email"],
                "uploaded_at": now_s,
            })
        # Ensure no duplicates against existing
        existing = await db.whitelist.distinct("barcode", {"date": body.date})
        to_insert = [d for d in ops if d["barcode"] not in existing]
        if to_insert:
            await db.whitelist.insert_many(to_insert)
    total = await db.whitelist.count_documents({"date": body.date})
    return {
        "date": body.date,
        "added": len(cleaned) if body.replace else max(0, total - len(await db.whitelist.distinct("barcode", {"date": body.date, "barcode": {"$in": list(seen)}}))),
        "requested": len(cleaned),
        "total": total,
    }

@api.get("/whitelist")
async def list_whitelist(date_: str = "", _: dict = Depends(require_admin)):
    if not date_:
        date_ = date.today().isoformat()
    rows = await db.whitelist.find({"date": date_}, {"_id": 0}).sort("barcode", 1).to_list(10000)
    return {"date": date_, "total": len(rows), "barcodes": rows}

@api.delete("/whitelist")
async def clear_whitelist(date_: str, _: dict = Depends(require_admin)):
    res = await db.whitelist.delete_many({"date": date_})
    return {"deleted": res.deleted_count, "date": date_}

@api.get("/whitelist/dates")
async def whitelist_dates(_: dict = Depends(require_admin)):
    dates = await db.whitelist.distinct("date")
    dates.sort(reverse=True)
    return {"dates": dates}

@api.post("/whitelist/bulk")
async def upload_whitelist_bulk(body: WhitelistBulkIn, user: dict = Depends(require_admin)):
    """Bulk upload: pass a list of {date, barcode} entries covering multiple days at once."""
    # Optional: wipe an entire week first
    if body.replace_week:
        try:
            monday, sunday = week_range(body.replace_week)
        except Exception:
            raise HTTPException(status_code=400, detail="replace_week must be YYYY-Www")
        week_days = [(monday + td(days=i)).isoformat() for i in range(7)]
        await db.whitelist.delete_many({"date": {"$in": week_days}})

    # Clean + dedupe entries locally
    seen = set()
    valid = []
    for e in body.entries:
        b = (e.barcode or "").strip()
        d = (e.date or "").strip()
        if not b or not d:
            continue
        try:
            date.fromisoformat(d)
        except ValueError:
            continue
        key = (d, b)
        if key in seen:
            continue
        seen.add(key)
        valid.append({"date": d, "barcode": b})

    if not valid:
        raise HTTPException(status_code=400, detail="No valid barcodes to upload")

    # Filter out entries that already exist
    days = list({e["date"] for e in valid})
    existing_pairs = set()
    async for r in db.whitelist.find({"date": {"$in": days}}, {"_id": 0, "date": 1, "barcode": 1}):
        existing_pairs.add((r["date"], r["barcode"]))
    to_insert = [
        {**e, "uploaded_by": user["email"], "uploaded_at": datetime.now(timezone.utc).isoformat()}
        for e in valid if (e["date"], e["barcode"]) not in existing_pairs
    ]
    if to_insert:
        await db.whitelist.insert_many(to_insert)

    # Report totals per day
    per_day = {}
    for e in valid:
        per_day[e["date"]] = per_day.get(e["date"], 0) + 1
    day_totals = {}
    for d in days:
        day_totals[d] = await db.whitelist.count_documents({"date": d})
    return {
        "requested": len(valid),
        "inserted": len(to_insert),
        "skipped": len(valid) - len(to_insert),
        "days_affected": len(days),
        "per_day_totals": day_totals,
    }

@api.get("/scans/suspicious")
async def suspicious_scans(limit: int = 100, _: dict = Depends(require_admin)):
    rows = await db.reports.find(
        {"source": "scan", "suspicious": True},
        {"_id": 0},
    ).sort("created_at", -1).to_list(max(1, min(500, int(limit))))
    return rows

@api.get("/scans/me")
async def my_scans(limit: int = 100, user: dict = Depends(get_current_user)):
    limit = max(1, min(500, int(limit)))
    rows = await db.reports.find(
        {"worker_id": user["id"], "source": "scan"},
        {"_id": 0},
    ).sort("created_at", -1).to_list(limit)
    return rows

@api.get("/scans/recent")
async def recent_scans(limit: int = 25, _: dict = Depends(require_admin)):
    limit = max(1, min(200, int(limit)))
    rows = await db.reports.find(
        {"source": "scan"},
        {"_id": 0},
    ).sort("created_at", -1).to_list(limit)
    return rows

@api.get("/scans/all")
async def all_scans(
    worker_id: Optional[str] = None,
    barcode: Optional[str] = None,
    limit: int = 500,
    user: dict = Depends(get_current_user),
):
    q: dict = {"source": "scan"}
    if user["role"] != "admin":
        q["worker_id"] = user["id"]
    elif worker_id:
        q["worker_id"] = worker_id
    if barcode:
        q["barcode"] = barcode
    limit = max(1, min(1000, int(limit)))
    rows = await db.reports.find(q, {"_id": 0}).sort("created_at", -1).to_list(limit)
    return rows

# ---------- Period summaries ----------
@api.get("/summary/period")
async def period_summary(
    period: str = "week",
    key: Optional[str] = None,
    user: dict = Depends(get_current_user),
):
    """period = day|week|month, key = YYYY-MM-DD | YYYY-Www | YYYY-MM"""
    today = date.today()
    if period == "day":
        k = key or today.isoformat()
        from_d = to_d = k
    elif period == "month":
        k = key or month_key(today)
        y, m = k.split("-"); y = int(y); m = int(m)
        from_d = date(y, m, 1).isoformat()
        if m == 12:
            to_d = (date(y + 1, 1, 1) - td(days=1)).isoformat()
        else:
            to_d = (date(y, m + 1, 1) - td(days=1)).isoformat()
    else:
        k = key or iso_week_key(today)
        monday, sunday = week_range(k)
        from_d = monday.isoformat(); to_d = sunday.isoformat()

    is_admin = user["role"] == "admin"
    if is_admin:
        workers = await db.users.find({"role": "worker"}, {"_id": 0, "password_hash": 0}).to_list(1000)
    else:
        me = await db.users.find_one({"id": user["id"]}, {"_id": 0, "password_hash": 0})
        workers = [me] if me else []

    per, rate = await _compute_earnings_for_range([w["id"] for w in workers], from_d, to_d)
    rows = []
    for w in workers:
        p = per.get(w["id"], {"total_boxes": 0, "total_hours": 0, "total_earnings": 0, "total_scans": 0, "days": []})
        piece_days = [d for d in p["days"] if d["method"] == "piece"]
        hourly_days = [d for d in p["days"] if d["method"] == "hourly"]
        rows.append({
            "worker_id": w["id"],
            "name": w["name"],
            "email": w["email"],
            "job_role": w.get("job_role"),
            "boxes": p["total_boxes"],
            "scans": p["total_scans"],
            "manual": max(0, p["total_boxes"] - p["total_scans"]),
            "hours": p["total_hours"],
            "piece_days": len(piece_days),
            "hourly_days": len(hourly_days),
            "earnings": p["total_earnings"],
            "days": p["days"],
        })
    rows.sort(key=lambda r: r["earnings"], reverse=True)
    return {
        "period": period,
        "key": k,
        "from": from_d,
        "to": to_d,
        "rate": rate,
        "total_boxes": sum(r["boxes"] for r in rows),
        "total_scans": sum(r["scans"] for r in rows),
        "total_hours": round(sum(r["hours"] for r in rows), 2),
        "total_earnings": round(sum(r["earnings"] for r in rows), 2),
        "rows": rows,
    }

@api.get("/reports/me")
async def my_reports(week: Optional[str] = None, user: dict = Depends(get_current_user)):
    q = {"worker_id": user["id"]}
    if week:
        q["week_key"] = week
    rows = await db.reports.find(q, {"_id": 0}).sort("date", -1).to_list(1000)
    return rows

@api.delete("/reports/{report_id}")
async def delete_report(report_id: str, user: dict = Depends(get_current_user)):
    q = {"id": report_id}
    if user["role"] != "admin":
        q["worker_id"] = user["id"]
    res = await db.reports.delete_one(q)
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Report not found")
    return {"ok": True}

# ---------- Weekly summaries ----------
async def _rate() -> float:
    doc = await db.settings.find_one({"key": "rate_per_box"})
    return float(doc["value"]) if doc else 0.0

@api.get("/summary/me")
async def my_summary(week: Optional[str] = None, user: dict = Depends(get_current_user)):
    wk = week or iso_week_key(date.today())
    monday, sunday = week_range(wk)
    per, rate = await _compute_earnings_for_range([user["id"]], monday.isoformat(), sunday.isoformat())
    p = per.get(user["id"], {"total_boxes": 0, "total_hours": 0, "total_earnings": 0, "days": []})
    return {
        "week_key": wk,
        "week_start": monday.isoformat(),
        "week_end": sunday.isoformat(),
        "total_boxes": p["total_boxes"],
        "total_hours": p["total_hours"],
        "rate": rate,
        "earnings": p["total_earnings"],
        "days": p["days"],
    }

@api.get("/summary/weekly")
async def weekly_summary(week: Optional[str] = None, _: dict = Depends(require_admin)):
    wk = week or iso_week_key(date.today())
    workers = await db.users.find({"role": "worker"}, {"_id": 0, "password_hash": 0}).to_list(1000)
    monday, sunday = week_range(wk)
    per, rate = await _compute_earnings_for_range([w["id"] for w in workers], monday.isoformat(), sunday.isoformat())
    rows = []
    for w in workers:
        p = per.get(w["id"], {"total_boxes": 0, "total_hours": 0, "total_earnings": 0, "days": []})
        methods = {d["method"] for d in p["days"]} or {"piece"}
        rows.append({
            "worker_id": w["id"],
            "name": w["name"],
            "email": w["email"],
            "job_role": w.get("job_role"),
            "boxes": p["total_boxes"],
            "hours": p["total_hours"],
            "methods": sorted(list(methods)),
            "earnings": p["total_earnings"],
        })
    rows.sort(key=lambda r: r["earnings"], reverse=True)
    return {
        "week_key": wk,
        "week_start": monday.isoformat(),
        "week_end": sunday.isoformat(),
        "rate": rate,
        "total_boxes": sum(r["boxes"] for r in rows),
        "total_hours": round(sum(r["hours"] for r in rows), 2),
        "total_earnings": round(sum(r["earnings"] for r in rows), 2),
        "rows": rows,
    }

@api.get("/weeks")
async def list_weeks(user: dict = Depends(get_current_user)):
    q = {} if user["role"] == "admin" else {"worker_id": user["id"]}
    weeks = await db.reports.distinct("week_key", q)
    # Ensure last 8 upcoming/current keys are present even without data
    today = date.today()
    for i in range(-8, 1):
        weeks.append(iso_week_key(today + td(days=i * 7)))
    weeks = sorted({w for w in weeks if w and w.startswith("W")}, reverse=True)
    current = iso_week_key(today)
    labeled = [{"key": w, "label": format_week_label(w), **dict(zip(("start", "end"), (r.isoformat() for r in week_range(w))))} for w in weeks]
    return {"weeks": weeks, "current": current, "labeled": labeled}

# ---------- Payslip PDF ----------
def _build_payslip_pdf(*, company: str, worker_name: str, worker_email: str,
                      week_key: str, week_start: str, week_end: str,
                      rate: float, days: list, total_boxes: int, total_hours: float, earnings: float) -> bytes:
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm,
                            topMargin=18 * mm, bottomMargin=18 * mm)
    styles = getSampleStyleSheet()
    title = ParagraphStyle("t", parent=styles["Title"], fontName="Helvetica-Bold",
                           fontSize=22, textColor=colors.HexColor("#09090B"), spaceAfter=4)
    sub = ParagraphStyle("s", parent=styles["Normal"], fontName="Helvetica",
                         fontSize=10, textColor=colors.HexColor("#71717A"))
    label = ParagraphStyle("l", parent=styles["Normal"], fontName="Helvetica-Bold", fontSize=9,
                           textColor=colors.HexColor("#71717A"))
    value = ParagraphStyle("v", parent=styles["Normal"], fontName="Helvetica-Bold", fontSize=12,
                           textColor=colors.HexColor("#09090B"))

    story = []
    story.append(Paragraph("PAYSLIP", title))
    story.append(Paragraph(f"{company}", sub))
    story.append(Spacer(1, 10))

    info = Table([
        [Paragraph("WORKER", label), Paragraph(worker_name, value),
         Paragraph("PAY PERIOD", label), Paragraph(f"{week_start} → {week_end}", value)],
        [Paragraph("EMAIL", label), Paragraph(worker_email, value),
         Paragraph("WEEK", label), Paragraph(week_key, value)],
    ], colWidths=[25 * mm, 60 * mm, 25 * mm, 60 * mm])
    info.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(info)
    story.append(Spacer(1, 12))

    banner = Table([[
        Paragraph(f"<font color='#09090B'><b>TOTAL BOXES</b></font><br/><font size=16 color='#09090B'><b>{total_boxes}</b></font>", styles["Normal"]),
        Paragraph(f"<font color='#09090B'><b>TOTAL HOURS</b></font><br/><font size=16 color='#09090B'><b>{total_hours:.2f}</b></font>", styles["Normal"]),
        Paragraph(f"<font color='#09090B'><b>PIECE RATE</b></font><br/><font size=16 color='#09090B'><b>A${rate:.2f}</b></font>", styles["Normal"]),
        Paragraph(f"<font color='#09090B'><b>TOTAL EARNINGS</b></font><br/><font size=16 color='#09090B'><b>A${earnings:.2f}</b></font>", styles["Normal"]),
    ]], colWidths=[42 * mm, 42 * mm, 42 * mm, 45 * mm])
    banner.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#EAB308")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    story.append(banner)
    story.append(Spacer(1, 14))

    story.append(Paragraph("<b>DAILY BREAKDOWN</b>", styles["Heading4"]))
    data = [["Date", "Method", "Boxes", "Hours", "Rate", "Amount (AUD)"]]
    for d in days:
        method = d.get("method", "piece")
        if method == "hourly":
            rate_str = f"A${d.get('hourly_rate',0):.2f}/hr"
            amount = f"A${d.get('earnings',0):.2f}"
            data.append([d["date"], "HOURLY", "—", f"{d.get('hours',0):.2f}", rate_str, amount])
        else:
            rate_str = f"A${rate:.2f}/box"
            amount = f"A${d.get('earnings',0):.2f}"
            data.append([d["date"], "PIECE", str(d.get("boxes", 0)), "—", rate_str, amount])
    if not days:
        data.append(["—", "PIECE", "0", "—", f"A${rate:.2f}/box", "A$0.00"])
    data.append(["TOTAL", "", str(total_boxes), f"{total_hours:.2f}", "", f"A${earnings:.2f}"])

    tbl = Table(data, colWidths=[26 * mm, 22 * mm, 20 * mm, 20 * mm, 30 * mm, 32 * mm])
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#09090B")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#E4E4E7")),
        ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#FAFAFA")),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("ALIGN", (2, 0), (5, -1), "RIGHT"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story.append(tbl)
    story.append(Spacer(1, 20))
    story.append(Paragraph(f"<font size=8 color='#71717A'>Generated {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')} · Currency: AUD · Method-aware payroll (Piece / Hourly per day).</font>", styles["Normal"]))

    doc.build(story)
    return buf.getvalue()

@api.get("/payslip/{worker_id}")
async def payslip_pdf(worker_id: str, week: Optional[str] = None, user: dict = Depends(get_current_user)):
    if user["role"] != "admin" and user["id"] != worker_id:
        raise HTTPException(status_code=403, detail="Forbidden")
    worker = await db.users.find_one({"id": worker_id, "role": "worker"}, {"_id": 0, "password_hash": 0})
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    wk = week or iso_week_key(date.today())
    monday, sunday = week_range(wk)
    per, rate = await _compute_earnings_for_range([worker_id], monday.isoformat(), sunday.isoformat())
    p = per.get(worker_id, {"days": [], "total_boxes": 0, "total_hours": 0, "total_earnings": 0})

    pdf_bytes = _build_payslip_pdf(
        company="Boxwise Payroll",
        worker_name=worker["name"],
        worker_email=worker["email"],
        week_key=wk,
        week_start=monday.isoformat(),
        week_end=sunday.isoformat(),
        rate=rate,
        days=p["days"],
        total_boxes=p["total_boxes"],
        total_hours=p["total_hours"],
        earnings=p["total_earnings"],
    )
    filename = f"payslip_{worker['name'].replace(' ', '_')}_{wk}.pdf"
    return StreamingResponse(
        io.BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )

# ---------- Excel exports ----------
def _xlsx_response(wb, filename: str) -> StreamingResponse:
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )

@api.get("/payslip/{worker_id}/xlsx")
async def payslip_xlsx(worker_id: str, week: Optional[str] = None, user: dict = Depends(get_current_user)):
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    if user["role"] != "admin" and user["id"] != worker_id:
        raise HTTPException(status_code=403, detail="Forbidden")
    worker = await db.users.find_one({"id": worker_id, "role": "worker"}, {"_id": 0, "password_hash": 0})
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    wk = week or iso_week_key(date.today())
    entries = await db.reports.find({"worker_id": worker_id, "week_key": wk}, {"_id": 0}).sort("created_at", 1).to_list(1000)
    total_boxes = sum(int(e["boxes"]) for e in entries)
    rate = await _rate()
    earnings = round(total_boxes * rate, 2)
    monday, sunday = week_range(wk)

    wb = Workbook()
    ws = wb.active
    ws.title = "Payslip"
    yellow = PatternFill(start_color="FFEAB308", end_color="FFEAB308", fill_type="solid")
    dark = PatternFill(start_color="FF09090B", end_color="FF09090B", fill_type="solid")
    bold_white = Font(bold=True, color="FFFFFFFF", size=11)
    bold = Font(bold=True, size=11)
    thin = Side(border_style="thin", color="FFE4E4E7")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)

    ws["A1"] = "PAYSLIP"; ws["A1"].font = Font(bold=True, size=22)
    ws["A2"] = "Boxwise Payroll"; ws["A2"].font = Font(color="FF71717A")
    ws["A4"] = "Worker"; ws["B4"] = worker["name"]
    ws["A5"] = "Email"; ws["B5"] = worker["email"]
    ws["A6"] = "Job role"; ws["B6"] = worker.get("job_role") or "—"
    ws["A7"] = "Week"; ws["B7"] = wk
    ws["A8"] = "Pay period"; ws["B8"] = f"{monday.isoformat()} → {sunday.isoformat()}"
    for r in range(4, 9):
        ws.cell(row=r, column=1).font = bold

    ws["A10"] = "Total Boxes"; ws["B10"] = total_boxes
    ws["A11"] = "Rate / Box"; ws["B11"] = rate; ws["B11"].number_format = '"A$"#,##0.00'
    ws["A12"] = "Total Earnings"; ws["B12"] = earnings; ws["B12"].number_format = '"A$"#,##0.00'
    for r in range(10, 13):
        ws.cell(row=r, column=1).fill = yellow
        ws.cell(row=r, column=1).font = bold
        ws.cell(row=r, column=2).fill = yellow
        ws.cell(row=r, column=2).font = bold

    headers = ["Timestamp", "Date", "Barcode", "Source", "Boxes", "Rate (AUD)", "Amount (AUD)", "Note"]
    for i, h in enumerate(headers, 1):
        c = ws.cell(row=14, column=i, value=h)
        c.fill = dark; c.font = bold_white; c.alignment = Alignment(horizontal="left")
    row = 15
    for e in entries:
        vals = [
            e.get("created_at", ""),
            e.get("date", ""),
            e.get("barcode") or "—",
            e.get("source") or "manual",
            int(e.get("boxes", 0)),
            rate,
            int(e.get("boxes", 0)) * rate,
            e.get("note") or "",
        ]
        for i, v in enumerate(vals, 1):
            c = ws.cell(row=row, column=i, value=v)
            c.border = border
        ws.cell(row=row, column=6).number_format = '"A$"#,##0.00'
        ws.cell(row=row, column=7).number_format = '"A$"#,##0.00'
        row += 1
    ws.cell(row=row, column=1, value="TOTAL").font = bold
    ws.cell(row=row, column=5, value=total_boxes).font = bold
    ws.cell(row=row, column=7, value=earnings).font = bold
    ws.cell(row=row, column=7).number_format = '"A$"#,##0.00'

    for col, w in zip("ABCDEFGH", [22, 12, 22, 10, 8, 12, 14, 30]):
        ws.column_dimensions[col].width = w

    filename = f"payslip_{worker['name'].replace(' ', '_')}_{wk}.xlsx"
    return _xlsx_response(wb, filename)

@api.get("/payroll/xlsx")
async def payroll_xlsx(period: str = "week", key: Optional[str] = None, _: dict = Depends(require_admin)):
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment
    today = date.today()
    if period == "day":
        k = key or today.isoformat()
        match_key = "date"; label = f"Day {k}"
    elif period == "month":
        k = key or month_key(today)
        match_key = "month_key"; label = f"Month {k}"
    else:
        k = key or iso_week_key(today)
        match_key = "week_key"; label = f"Week {k}"

    workers = await db.users.find({"role": "worker"}, {"_id": 0, "password_hash": 0}).to_list(1000)
    pipeline = [
        {"$match": {match_key: k}},
        {"$group": {
            "_id": "$worker_id",
            "boxes": {"$sum": "$boxes"},
            "scans": {"$sum": {"$cond": [{"$eq": ["$source", "scan"]}, 1, 0]}},
        }},
    ]
    agg = await db.reports.aggregate(pipeline).to_list(10000)
    m = {a["_id"]: a for a in agg}
    rate = await _rate()

    wb = Workbook()
    ws = wb.active
    ws.title = "Payroll"
    yellow = PatternFill(start_color="FFEAB308", end_color="FFEAB308", fill_type="solid")
    dark = PatternFill(start_color="FF09090B", end_color="FF09090B", fill_type="solid")
    bold_white = Font(bold=True, color="FFFFFFFF", size=11)
    bold = Font(bold=True, size=11)

    ws["A1"] = "PAYROLL"; ws["A1"].font = Font(bold=True, size=22)
    ws["A2"] = label; ws["A2"].font = Font(color="FF71717A")
    ws["A3"] = "Rate / Box"; ws["B3"] = rate; ws["B3"].number_format = '"A$"#,##0.00'
    ws["A3"].fill = yellow; ws["B3"].fill = yellow
    ws["A3"].font = bold; ws["B3"].font = bold

    headers = ["Worker", "Role", "Email", "Scans", "Total Boxes", "Rate (AUD)", "Earnings (AUD)"]
    for i, h in enumerate(headers, 1):
        c = ws.cell(row=5, column=i, value=h)
        c.fill = dark; c.font = bold_white; c.alignment = Alignment(horizontal="left")

    row = 6
    total_boxes = 0
    total_earn = 0.0
    total_scans = 0
    workers_sorted = sorted(workers, key=lambda w: -(m.get(w["id"], {}).get("boxes", 0)))
    for w in workers_sorted:
        s = m.get(w["id"], {"boxes": 0, "scans": 0})
        boxes = int(s.get("boxes", 0))
        scans = int(s.get("scans", 0))
        earn = round(boxes * rate, 2)
        total_boxes += boxes; total_scans += scans; total_earn += earn
        ws.cell(row=row, column=1, value=w["name"])
        ws.cell(row=row, column=2, value=w.get("job_role") or "")
        ws.cell(row=row, column=3, value=w["email"])
        ws.cell(row=row, column=4, value=scans)
        ws.cell(row=row, column=5, value=boxes)
        ws.cell(row=row, column=6, value=rate).number_format = '"A$"#,##0.00'
        ws.cell(row=row, column=7, value=earn).number_format = '"A$"#,##0.00'
        row += 1
    ws.cell(row=row, column=1, value="TOTAL").font = bold
    ws.cell(row=row, column=4, value=total_scans).font = bold
    ws.cell(row=row, column=5, value=total_boxes).font = bold
    ws.cell(row=row, column=7, value=round(total_earn, 2)).font = bold
    ws.cell(row=row, column=7).number_format = '"A$"#,##0.00'

    for col, wd in zip("ABCDEFG", [24, 18, 28, 10, 14, 14, 16]):
        ws.column_dimensions[col].width = wd

    return _xlsx_response(wb, f"payroll_{k}.xlsx")

# ---------- Worker QR nametags ----------
def _build_nametag_pdf(workers: list) -> bytes:
    from reportlab.pdfgen import canvas
    from reportlab.graphics.barcode.qr import QrCodeWidget
    from reportlab.graphics.shapes import Drawing
    from reportlab.graphics import renderPDF
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    W, H = A4
    # 2 columns × 4 rows = 8 name tags per A4 page (large, printable)
    cols, rows = 2, 4
    margin_x, margin_y = 12 * mm, 12 * mm
    cell_w = (W - 2 * margin_x) / cols
    cell_h = (H - 2 * margin_y) / rows
    idx = 0
    while idx < len(workers):
        for r in range(rows):
            for col in range(cols):
                if idx >= len(workers):
                    break
                w = workers[idx]
                x = margin_x + col * cell_w
                y = H - margin_y - (r + 1) * cell_h
                # Border
                c.setStrokeColorRGB(0.15, 0.15, 0.15); c.setLineWidth(1.2)
                c.rect(x + 3, y + 3, cell_w - 6, cell_h - 6)
                # Yellow accent band
                c.setFillColorRGB(0.918, 0.702, 0.031)  # #eab308
                c.rect(x + 3, y + cell_h - 15, cell_w - 6, 12, fill=1, stroke=0)
                c.setFillColorRGB(0, 0, 0)
                c.setFont("Helvetica-Bold", 8)
                c.drawString(x + 6, y + cell_h - 12, "BOXWISE · WORKER ID")
                # QR
                qr = QrCodeWidget(f"BW-W:{w['id']}", barLevel="M")
                bounds = qr.getBounds()
                qw = bounds[2] - bounds[0]; qh = bounds[3] - bounds[1]
                target = min(cell_w * 0.42, cell_h * 0.55)
                d = Drawing(target, target, transform=[target / qw, 0, 0, target / qh, 0, 0])
                d.add(qr)
                renderPDF.draw(d, c, x + 8 * mm, y + 8 * mm)
                # Name + role on the right
                text_x = x + 8 * mm + target + 6 * mm
                c.setFont("Helvetica-Bold", 20)
                c.setFillColorRGB(0, 0, 0)
                c.drawString(text_x, y + cell_h - 30 * mm, w["name"][:22])
                c.setFont("Helvetica", 10)
                c.setFillColorRGB(0.4, 0.4, 0.4)
                if w.get("job_role"):
                    c.drawString(text_x, y + cell_h - 38 * mm, w["job_role"][:24])
                c.setFont("Helvetica-Oblique", 8)
                c.setFillColorRGB(0.5, 0.5, 0.5)
                c.drawString(text_x, y + 8 * mm, "Supervisor scans this tag = +1 box")
                idx += 1
        c.showPage()
    c.save()
    return buf.getvalue()

@api.get("/workers/{worker_id}/nametag")
async def worker_nametag(worker_id: str, _: dict = Depends(require_admin)):
    w = await db.users.find_one({"id": worker_id, "role": "worker"}, {"_id": 0, "password_hash": 0})
    if not w:
        raise HTTPException(status_code=404, detail="Worker not found")
    pdf = _build_nametag_pdf([w])
    filename = f"nametag_{w['name'].replace(' ', '_')}.pdf"
    return StreamingResponse(io.BytesIO(pdf), media_type="application/pdf",
                             headers={"Content-Disposition": f'attachment; filename="{filename}"'})

@api.get("/workers/nametags")
async def worker_nametags(_: dict = Depends(require_admin)):
    workers = await db.users.find({"role": "worker"}, {"_id": 0, "password_hash": 0}).sort("name", 1).to_list(1000)
    if not workers:
        raise HTTPException(status_code=404, detail="No workers to print")
    pdf = _build_nametag_pdf(workers)
    return StreamingResponse(io.BytesIO(pdf), media_type="application/pdf",
                             headers={"Content-Disposition": 'attachment; filename="worker_nametags.pdf"'})

# ---------- Barcode label generator ----------
LABEL_TEMPLATES = {
    "a4_3x8": {
        "label": "A4 · 3×8 (24 per page) — default",
        "page": "A4", "cols": 3, "rows": 8,
        "top_mm": 12, "left_mm": 10, "cell_w_mm": None, "cell_h_mm": None,
        "gap_x_mm": 0, "gap_y_mm": 0,
    },
    "avery_l7159_a4": {
        "label": "Avery L7159 · A4 · 3×8 (24, 63.5×33.9mm)",
        "page": "A4", "cols": 3, "rows": 8,
        "top_mm": 13.3, "left_mm": 7.21, "cell_w_mm": 63.5, "cell_h_mm": 33.9,
        "gap_x_mm": 2.54, "gap_y_mm": 0,
    },
    "avery_l7160_a4": {
        "label": "Avery L7160 · A4 · 3×7 (21, 63.5×38.1mm)",
        "page": "A4", "cols": 3, "rows": 7,
        "top_mm": 15.15, "left_mm": 7.21, "cell_w_mm": 63.5, "cell_h_mm": 38.1,
        "gap_x_mm": 2.54, "gap_y_mm": 0,
    },
    "avery_l7163_a4": {
        "label": "Avery L7163 · A4 · 2×7 (14, 99.1×38.1mm)",
        "page": "A4", "cols": 2, "rows": 7,
        "top_mm": 15.15, "left_mm": 4.65, "cell_w_mm": 99.1, "cell_h_mm": 38.1,
        "gap_x_mm": 2.54, "gap_y_mm": 0,
    },
    "avery_5160_letter": {
        "label": "Avery 5160 · US Letter · 3×10 (30, 2.625×1in)",
        "page": "LETTER", "cols": 3, "rows": 10,
        "top_mm": 12.7, "left_mm": 4.85, "cell_w_mm": 66.68, "cell_h_mm": 25.4,
        "gap_x_mm": 3.05, "gap_y_mm": 0,
    },
    "avery_5163_letter": {
        "label": "Avery 5163 · US Letter · 2×5 (10, 4×2in)",
        "page": "LETTER", "cols": 2, "rows": 5,
        "top_mm": 12.7, "left_mm": 4.85, "cell_w_mm": 101.6, "cell_h_mm": 50.8,
        "gap_x_mm": 3.18, "gap_y_mm": 0,
    },
    "letter_3x8": {
        "label": "US Letter · 3×8 (24 per page, full-page)",
        "page": "LETTER", "cols": 3, "rows": 8,
        "top_mm": 12, "left_mm": 10, "cell_w_mm": None, "cell_h_mm": None,
        "gap_x_mm": 0, "gap_y_mm": 0,
    },
}

@api.get("/barcodes/templates")
async def barcode_templates(_: dict = Depends(require_admin)):
    return {
        "templates": [
            {"key": k, **{kk: vv for kk, vv in v.items()}, "per_page": v["cols"] * v["rows"]}
            for k, v in LABEL_TEMPLATES.items()
        ]
    }

def _build_barcodes_pdf(codes: list, template_key: str = "a4_3x8") -> bytes:
    from reportlab.pdfgen import canvas
    from reportlab.graphics.barcode import code128
    from reportlab.lib.pagesizes import A4 as _A4, letter as _LETTER
    tpl = LABEL_TEMPLATES.get(template_key) or LABEL_TEMPLATES["a4_3x8"]
    page_size = _A4 if tpl["page"] == "A4" else _LETTER
    W, H = page_size
    cols, rows = tpl["cols"], tpl["rows"]
    top = tpl["top_mm"] * mm
    left = tpl["left_mm"] * mm
    gap_x = tpl["gap_x_mm"] * mm
    gap_y = tpl["gap_y_mm"] * mm
    if tpl["cell_w_mm"] and tpl["cell_h_mm"]:
        cell_w = tpl["cell_w_mm"] * mm
        cell_h = tpl["cell_h_mm"] * mm
    else:
        cell_w = (W - 2 * left - (cols - 1) * gap_x) / cols
        cell_h = (H - 2 * top - (rows - 1) * gap_y) / rows

    bar_h = max(6 * mm, min(cell_h * 0.5, 16 * mm))
    ideal_bar_w = max(0.24, min(0.5, (cell_w * 0.7) / 130))
    code_font = max(6, min(11, int(cell_h / (5.2 * mm))))
    brand_font = max(4, code_font - 3)

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=page_size)

    def draw_cell(x, y, code_val):
        c.setStrokeColorRGB(0.9, 0.9, 0.9)
        c.setLineWidth(0.3)
        c.rect(x + 1, y + 1, cell_w - 2, cell_h - 2)
        bc = code128.Code128(code_val, barHeight=bar_h, barWidth=ideal_bar_w * mm, humanReadable=False)
        max_bw = cell_w * 0.86
        if bc.width > max_bw:
            scale = max_bw / bc.width
            bc = code128.Code128(code_val, barHeight=bar_h, barWidth=(ideal_bar_w * scale) * mm, humanReadable=False)
        bc_x = x + (cell_w - bc.width) / 2
        brand_y = y + 1.5 * mm
        code_y = brand_y + brand_font + 1
        bc_y = code_y + code_font + 1
        bc.drawOn(c, bc_x, bc_y)
        c.setFont("Helvetica-Bold", code_font)
        c.setFillColorRGB(0, 0, 0)
        c.drawCentredString(x + cell_w / 2, code_y, code_val)
        c.setFont("Helvetica", brand_font)
        c.setFillColorRGB(0.5, 0.5, 0.5)
        c.drawCentredString(x + cell_w / 2, brand_y, "BOXWISE")

    idx = 0
    while idx < len(codes):
        for row in range(rows):
            for col in range(cols):
                if idx >= len(codes):
                    break
                x = left + col * (cell_w + gap_x)
                y = H - top - (row + 1) * cell_h - row * gap_y
                draw_cell(x, y, codes[idx])
                idx += 1
        c.showPage()
    c.save()
    return buf.getvalue()

@api.post("/barcodes/generate")
async def generate_barcodes(body: BarcodeGenIn, user: dict = Depends(require_admin)):
    prefix = (body.prefix or "").strip()
    pad = max(1, min(12, int(body.pad)))
    codes = [f"{prefix}{str(n).zfill(pad)}" for n in range(body.start, body.start + body.count)]
    if not codes:
        raise HTTPException(status_code=400, detail="No codes generated")

    added_to_whitelist = 0
    if body.add_to_whitelist_date:
        try:
            date.fromisoformat(body.add_to_whitelist_date)
        except ValueError:
            raise HTTPException(status_code=400, detail="add_to_whitelist_date must be YYYY-MM-DD")
        existing = set(await db.whitelist.distinct("barcode", {"date": body.add_to_whitelist_date}))
        now_s = datetime.now(timezone.utc).isoformat()
        docs = [
            {"date": body.add_to_whitelist_date, "barcode": c, "uploaded_by": user["email"], "uploaded_at": now_s}
            for c in codes if c not in existing
        ]
        if docs:
            await db.whitelist.insert_many(docs)
            added_to_whitelist = len(docs)

    pdf = _build_barcodes_pdf(codes, body.template)
    filename = f"barcodes_{prefix.rstrip('-') or 'BOX'}_{body.template}_{body.start}-{body.start + body.count - 1}.pdf"
    return StreamingResponse(
        io.BytesIO(pdf),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Codes-Total": str(len(codes)),
            "X-Codes-First": codes[0],
            "X-Codes-Last": codes[-1],
            "X-Whitelisted": str(added_to_whitelist),
            "Access-Control-Expose-Headers": "X-Codes-Total, X-Codes-First, X-Codes-Last, X-Whitelisted",
        },
    )

@api.post("/barcodes/preview")
async def preview_barcodes(body: BarcodeGenIn, _: dict = Depends(require_admin)):
    prefix = (body.prefix or "").strip()
    pad = max(1, min(12, int(body.pad)))
    codes = [f"{prefix}{str(n).zfill(pad)}" for n in range(body.start, body.start + body.count)]
    # Suggest next start number to avoid clashes with existing whitelist barcodes with the same prefix
    return {"codes": codes, "total": len(codes)}

# ---------- Health ----------
@api.get("/")
async def root():
    return {"service": "boxwise", "status": "ok"}

app.include_router(api)

# ---------- CORS ----------
frontend_url = os.environ.get("FRONTEND_URL", "http://localhost:3000")
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=[frontend_url, "http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------- Startup ----------
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger("boxwise")

@app.on_event("startup")
async def startup():
    await db.users.create_index("email", unique=True)
    await db.users.create_index("id", unique=True)
    await db.reports.create_index([("worker_id", 1), ("week_key", 1)])
    await db.reports.create_index([("worker_id", 1), ("month_key", 1)])
    await db.reports.create_index([("worker_id", 1), ("barcode", 1), ("created_at", -1)])
    await db.reports.create_index([("source", 1), ("created_at", -1)])
    await db.reports.create_index("id", unique=True)
    await db.whitelist.create_index([("date", 1), ("barcode", 1)], unique=True)
    await db.reports.create_index([("source", 1), ("date", 1), ("barcode", 1)])
    await db.scan_rejections.create_index([("created_at", -1)])
    await db.scan_rejections.create_index([("date", 1), ("barcode", 1)])
    await db.pay_configs.create_index([("worker_id", 1), ("date", 1)], unique=True)
    await db.attendance.create_index([("worker_id", 1), ("date", 1)], unique=True)
    await db.worksites.create_index("id", unique=True)
    await db.users.create_index("employee_id", unique=True, sparse=True)
    await db.password_reset_tokens.create_index("token", unique=True)
    await db.password_reset_tokens.create_index([("user_id", 1), ("created_at", -1)])

    # Backfill employee_id for workers who don't have one
    async for w in db.users.find({"role": "worker", "employee_id": {"$exists": False}}):
        emp = await _next_employee_id()
        await db.users.update_one({"id": w["id"]}, {"$set": {"employee_id": emp}})

    # Backfill month_key + source for legacy rows (idempotent)
    async for r in db.reports.find({"month_key": {"$exists": False}}):
        try:
            d = date.fromisoformat(r["date"])
            await db.reports.update_one(
                {"id": r["id"]},
                {"$set": {"month_key": month_key(d), "source": r.get("source") or "manual"}},
            )
        except Exception:
            pass

    # Backfill Wed-anchored week_key on legacy 'YYYY-Www' rows or missing keys
    async for r in db.reports.find({"$or": [
        {"week_key": {"$exists": False}},
        {"week_key": {"$not": {"$regex": "^W"}}},
    ]}):
        try:
            d = date.fromisoformat(r["date"])
            await db.reports.update_one({"id": r["id"]}, {"$set": {"week_key": iso_week_key(d)}})
        except Exception:
            pass

    admin_email = os.environ["ADMIN_EMAIL"].strip().lower()
    admin_password = os.environ["ADMIN_PASSWORD"]
    existing = await db.users.find_one({"email": admin_email})
    if not existing:
        await db.users.insert_one({
            "id": str(uuid.uuid4()),
            "email": admin_email,
            "name": "Owner",
            "role": "admin",
            "password_hash": hash_password(admin_password),
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
        logger.info(f"Seeded admin {admin_email}")
    elif not verify_password(admin_password, existing["password_hash"]):
        await db.users.update_one({"email": admin_email}, {"$set": {"password_hash": hash_password(admin_password), "role": "admin"}})
        logger.info(f"Updated admin password for {admin_email}")

    # Default rate 0
    await db.settings.update_one({"key": "rate_per_box"}, {"$setOnInsert": {"key": "rate_per_box", "value": 0.0}}, upsert=True)

    # Seed sample workers if none exist (for easier first-run testing)
    worker_count = await db.users.count_documents({"role": "worker"})
    if worker_count == 0:
        samples = [
            ("worker.a@example.com", "Worker A", "Worker@2026"),
            ("worker.b@example.com", "Worker B", "Worker@2026"),
        ]
        for em, nm, pw in samples:
            await db.users.insert_one({
                "id": str(uuid.uuid4()),
                "email": em,
                "name": nm,
                "role": "worker",
                "password_hash": hash_password(pw),
                "created_at": datetime.now(timezone.utc).isoformat(),
            })
        logger.info("Seeded sample workers")

@app.on_event("shutdown")
async def shutdown():
    client.close()
