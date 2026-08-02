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

class BoxReportOut(BaseModel):
    id: str
    worker_id: str
    worker_name: str
    date: str
    boxes: int
    note: Optional[str] = None
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
        "week_key": iso_week_key(d),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.reports.insert_one(doc)
    doc.pop("_id", None)
    return doc

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
    await db.reports.create_index("id", unique=True)

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
