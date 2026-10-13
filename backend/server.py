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

# ---------- CORS Middleware (Ditambahkan agar frontend Vercel bisa akses) ----------
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",                # Untuk development lokal
        "https://workers-box-system.vercel.app",  # URL Vercel Anda
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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
    email = body.email.strip().lower()
    generic_ok = {"ok": True, "message": "If a worker account exists for that email, a reset link has been sent."}
    user = await db.users.find_one({"email": email})
    if not user or user.get("role") != "worker":
        return generic_ok

    now = datetime.now(timezone.utc)
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
        clash = await db.users