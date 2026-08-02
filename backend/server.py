from dotenv import load_dotenv
from pathlib import Path
ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

import os
import io
import logging
import uuid
import bcrypt
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
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"

def month_key(d: date) -> str:
    return f"{d.year}-{d.month:02d}"

def week_range(week_key: str):
    y, w = week_key.split("-W")
    monday = date.fromisocalendar(int(y), int(w), 1)
    sunday = monday + td(days=6)
    return monday, sunday

# ---------- Models ----------
class UserOut(BaseModel):
    id: str
    email: str
    name: str
    role: str

class LoginIn(BaseModel):
    email: str
    password: str

class RegisterIn(BaseModel):
    email: str
    name: str
    password: str
    job_role: Optional[str] = None

class WorkerCreate(BaseModel):
    email: str
    name: str
    password: str
    job_role: Optional[str] = None

class WorkerUpdate(BaseModel):
    name: Optional[str] = None
    password: Optional[str] = None
    job_role: Optional[str] = None

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
        "user": {"id": user["id"], "email": user["email"], "name": user["name"], "role": user["role"]},
    }

@api.post("/auth/logout")
async def logout(response: Response):
    response.delete_cookie("access_token", path="/")
    return {"ok": True}

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
    doc = {
        "id": user_id,
        "email": email,
        "name": body.name.strip(),
        "role": "worker",
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
    return UserOut(id=user["id"], email=user["email"], name=user["name"], role=user["role"])

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
    doc = {
        "id": str(uuid.uuid4()),
        "email": email,
        "name": body.name.strip(),
        "role": "worker",
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

# ---------- Reports ----------
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
@api.post("/scans", response_model=BoxReportOut)
async def create_scan(body: ScanIn, user: dict = Depends(get_current_user)):
    if user["role"] != "worker":
        raise HTTPException(status_code=403, detail="Only workers can scan boxes")
    barcode = body.barcode.strip()
    now = datetime.now(timezone.utc)
    # Fat-finger / accidental double-scan protection: same worker + barcode within 10s
    ten_s_ago = (now - timedelta(seconds=10)).isoformat()
    dup = await db.reports.find_one({
        "worker_id": user["id"],
        "barcode": barcode,
        "created_at": {"$gte": ten_s_ago},
    })
    if dup:
        raise HTTPException(status_code=409, detail="Duplicate scan — same barcode within 10 seconds")
    today = date.today()
    today_s = today.isoformat()
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
        match_key = "date"
    elif period == "month":
        k = key or month_key(today)
        match_key = "month_key"
    else:
        k = key or iso_week_key(today)
        match_key = "week_key"

    is_admin = user["role"] == "admin"
    if is_admin:
        workers = await db.users.find({"role": "worker"}, {"_id": 0, "password_hash": 0}).to_list(1000)
    else:
        me = await db.users.find_one({"id": user["id"]}, {"_id": 0, "password_hash": 0})
        workers = [me] if me else []

    pipeline = [
        {"$match": {match_key: k, **({} if is_admin else {"worker_id": user["id"]})}},
        {"$group": {
            "_id": "$worker_id",
            "boxes": {"$sum": "$boxes"},
            "scans": {"$sum": {"$cond": [{"$eq": ["$source", "scan"]}, 1, 0]}},
            "manual": {"$sum": {"$cond": [{"$eq": ["$source", "scan"]}, 0, "$boxes"]}},
        }},
    ]
    agg = await db.reports.aggregate(pipeline).to_list(10000)
    m = {a["_id"]: a for a in agg}
    rate = await _rate()
    rows = []
    for w in workers:
        st = m.get(w["id"], {"boxes": 0, "scans": 0, "manual": 0})
        rows.append({
            "worker_id": w["id"],
            "name": w["name"],
            "email": w["email"],
            "job_role": w.get("job_role"),
            "boxes": int(st.get("boxes", 0)),
            "scans": int(st.get("scans", 0)),
            "manual": int(st.get("manual", 0)),
            "earnings": round(int(st.get("boxes", 0)) * rate, 2),
        })
    rows.sort(key=lambda r: r["boxes"], reverse=True)
    return {
        "period": period,
        "key": k,
        "rate": rate,
        "total_boxes": sum(r["boxes"] for r in rows),
        "total_scans": sum(r["scans"] for r in rows),
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
    pipeline = [
        {"$match": {"worker_id": user["id"], "week_key": wk}},
        {"$group": {"_id": "$worker_id", "boxes": {"$sum": "$boxes"}}},
    ]
    agg = await db.reports.aggregate(pipeline).to_list(1)
    total_boxes = int(agg[0]["boxes"]) if agg else 0
    rate = await _rate()
    monday, sunday = week_range(wk)
    return {
        "week_key": wk,
        "week_start": monday.isoformat(),
        "week_end": sunday.isoformat(),
        "total_boxes": total_boxes,
        "rate": rate,
        "earnings": round(total_boxes * rate, 2),
    }

@api.get("/summary/weekly")
async def weekly_summary(week: Optional[str] = None, _: dict = Depends(require_admin)):
    wk = week or iso_week_key(date.today())
    workers = await db.users.find({"role": "worker"}, {"_id": 0, "password_hash": 0}).to_list(1000)
    pipeline = [
        {"$match": {"week_key": wk}},
        {"$group": {"_id": "$worker_id", "boxes": {"$sum": "$boxes"}}},
    ]
    agg = await db.reports.aggregate(pipeline).to_list(10000)
    boxes_map = {a["_id"]: int(a["boxes"]) for a in agg}
    rate = await _rate()
    monday, sunday = week_range(wk)
    rows = []
    for w in workers:
        boxes = boxes_map.get(w["id"], 0)
        rows.append({
            "worker_id": w["id"],
            "name": w["name"],
            "email": w["email"],
            "job_role": w.get("job_role"),
            "boxes": boxes,
            "earnings": round(boxes * rate, 2),
        })
    rows.sort(key=lambda r: r["boxes"], reverse=True)
    return {
        "week_key": wk,
        "week_start": monday.isoformat(),
        "week_end": sunday.isoformat(),
        "rate": rate,
        "total_boxes": sum(r["boxes"] for r in rows),
        "total_earnings": round(sum(r["earnings"] for r in rows), 2),
        "rows": rows,
    }

@api.get("/weeks")
async def list_weeks(user: dict = Depends(get_current_user)):
    q = {} if user["role"] == "admin" else {"worker_id": user["id"]}
    weeks = await db.reports.distinct("week_key", q)
    weeks.sort(reverse=True)
    current = iso_week_key(date.today())
    if current not in weeks:
        weeks.insert(0, current)
    return {"weeks": weeks, "current": current}

# ---------- Payslip PDF ----------
def _build_payslip_pdf(*, company: str, worker_name: str, worker_email: str,
                      week_key: str, week_start: str, week_end: str,
                      rate: float, entries: list, total_boxes: int, earnings: float) -> bytes:
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

    # Yellow banner - week totals
    banner = Table([[
        Paragraph(f"<font color='#09090B'><b>TOTAL BOXES</b></font><br/><font size=18 color='#09090B'><b>{total_boxes}</b></font>", styles["Normal"]),
        Paragraph(f"<font color='#09090B'><b>RATE / BOX</b></font><br/><font size=18 color='#09090B'><b>A${rate:.2f}</b></font>", styles["Normal"]),
        Paragraph(f"<font color='#09090B'><b>TOTAL EARNINGS</b></font><br/><font size=18 color='#09090B'><b>A${earnings:.2f}</b></font>", styles["Normal"]),
    ]], colWidths=[57 * mm, 57 * mm, 57 * mm])
    banner.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#EAB308")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 12),
        ("RIGHTPADDING", (0, 0), (-1, -1), 12),
        ("TOPPADDING", (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
    ]))
    story.append(banner)
    story.append(Spacer(1, 14))

    story.append(Paragraph("<b>DAILY BOX REPORTS</b>", styles["Heading4"]))
    data = [["Date", "Boxes", "Rate", "Amount (AUD)", "Note"]]
    for e in entries:
        data.append([e["date"], str(e["boxes"]), f"A${rate:.2f}", f"A${e['boxes'] * rate:.2f}", e.get("note") or ""])
    if not entries:
        data.append(["—", "0", f"A${rate:.2f}", "A$0.00", "No entries this week"])
    data.append(["TOTAL", str(total_boxes), "", f"A${earnings:.2f}", ""])

    tbl = Table(data, colWidths=[28 * mm, 22 * mm, 22 * mm, 30 * mm, 70 * mm])
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#09090B")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#E4E4E7")),
        ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#FAFAFA")),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("ALIGN", (1, 0), (3, -1), "RIGHT"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story.append(tbl)
    story.append(Spacer(1, 20))
    story.append(Paragraph(f"<font size=8 color='#71717A'>Generated {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')} · Currency: AUD · This payslip is auto-computed from reported box counts × the configured rate.</font>", styles["Normal"]))

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
    entries = await db.reports.find({"worker_id": worker_id, "week_key": wk}, {"_id": 0}).sort("date", 1).to_list(1000)
    total_boxes = sum(int(e["boxes"]) for e in entries)
    rate = await _rate()
    earnings = round(total_boxes * rate, 2)
    monday, sunday = week_range(wk)
    pdf_bytes = _build_payslip_pdf(
        company="Boxwise Payroll",
        worker_name=worker["name"],
        worker_email=worker["email"],
        week_key=wk,
        week_start=monday.isoformat(),
        week_end=sunday.isoformat(),
        rate=rate,
        entries=entries,
        total_boxes=total_boxes,
        earnings=earnings,
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

# ---------- Barcode label generator ----------
def _build_barcodes_pdf(codes: list) -> bytes:
    from reportlab.pdfgen import canvas
    from reportlab.graphics.barcode import code128
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    W, H = A4
    cols, rows = 3, 8
    margin_x, margin_y = 10 * mm, 12 * mm
    label_w = (W - 2 * margin_x) / cols
    label_h = (H - 2 * margin_y) / rows
    idx = 0
    while idx < len(codes):
        for row in range(rows):
            for col in range(cols):
                if idx >= len(codes):
                    break
                x = margin_x + col * label_w
                y = H - margin_y - (row + 1) * label_h
                c.setStrokeColorRGB(0.85, 0.85, 0.85)
                c.setLineWidth(0.3)
                c.rect(x + 2, y + 2, label_w - 4, label_h - 4)
                code_val = codes[idx]
                bc = code128.Code128(code_val, barHeight=13 * mm, barWidth=0.42 * mm, humanReadable=False)
                bc_x = x + (label_w - bc.width) / 2
                bc_y = y + 10 * mm
                bc.drawOn(c, bc_x, bc_y)
                c.setFont("Helvetica-Bold", 9)
                c.setFillColorRGB(0, 0, 0)
                c.drawCentredString(x + label_w / 2, y + 5 * mm, code_val)
                c.setFont("Helvetica", 6)
                c.setFillColorRGB(0.5, 0.5, 0.5)
                c.drawCentredString(x + label_w / 2, y + 2 * mm, "BOXWISE")
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

    pdf = _build_barcodes_pdf(codes)
    filename = f"barcodes_{prefix.rstrip('-') or 'BOX'}_{body.start}-{body.start + body.count - 1}.pdf"
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
