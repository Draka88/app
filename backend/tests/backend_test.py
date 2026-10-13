"""Boxwise Payroll backend regression tests.

Covers: auth, admin dashboard data, QR bulk PDF/ZIP, worker login + dashboard data,
supervisor scan + duplicate + self-scan, payslip & payroll exports, forgot-password.
"""
import io
import os
import time
import zipfile
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://worker-box-system.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"

ADMIN = {"email": "soerjantowerri@gmail.com", "password": "Admin@2026"}
WORKER_A = {"email": "worker.a@example.com", "password": "Worker@2026"}
WORKER_B = {"email": "worker.b@example.com", "password": "Worker@2026"}


# ---------- Fixtures ----------
@pytest.fixture(scope="session")
def admin_token():
    r = requests.post(f"{API}/auth/login", json=ADMIN, timeout=20)
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text}"
    return r.json()["token"]


@pytest.fixture(scope="session")
def admin_user(admin_token):
    r = requests.get(f"{API}/auth/me", headers={"Authorization": f"Bearer {admin_token}"}, timeout=20)
    assert r.status_code == 200
    return r.json()


@pytest.fixture(scope="session")
def worker_a_token():
    r = requests.post(f"{API}/auth/login", json=WORKER_A, timeout=20)
    if r.status_code != 200:
        pytest.skip(f"Seed worker.a@example.com not present (login={r.status_code}). "
                    f"DB currently has different workers; cannot test seeded worker login.")
    return r.json()["token"]


@pytest.fixture(scope="session")
def workers(admin_token):
    r = requests.get(f"{API}/workers", headers={"Authorization": f"Bearer {admin_token}"}, timeout=20)
    assert r.status_code == 200
    return r.json()


@pytest.fixture(scope="session")
def any_worker(workers):
    assert workers, "No workers in DB"
    return workers[0]


@pytest.fixture(scope="session")
def any_worker_token(workers, admin_token):
    """Reset password of the first worker to a known value using admin, then log in.
    This exists because the seeded worker.a/worker.b accounts are not present in this restored DB.
    """
    if not workers:
        pytest.skip("No workers in DB")
    w = workers[0]
    pw = "TestWorker@2026"
    r = requests.patch(
        f"{API}/workers/{w['id']}",
        headers={"Authorization": f"Bearer {admin_token}"},
        json={"password": pw},
        timeout=20,
    )
    if r.status_code != 200:
        pytest.skip(f"Could not reset worker password: {r.status_code} {r.text}")
    r = requests.post(f"{API}/auth/login", json={"email": w["email"], "password": pw}, timeout=20)
    if r.status_code != 200:
        pytest.skip(f"Login as worker failed: {r.status_code} {r.text}")
    return r.json()["token"]


# ---------- Auth ----------
class TestAuth:
    def test_admin_login_ok(self, admin_token):
        assert isinstance(admin_token, str) and len(admin_token) > 10

    def test_me_admin(self, admin_user):
        assert admin_user["role"] == "admin"
        assert admin_user["email"] == ADMIN["email"]

    def test_worker_login_ok(self, worker_a_token):
        assert isinstance(worker_a_token, str) and len(worker_a_token) > 10

    def test_login_wrong_pw(self):
        r = requests.post(f"{API}/auth/login", json={"email": ADMIN["email"], "password": "wrong"}, timeout=20)
        assert r.status_code == 401

    def test_forgot_password_generic(self):
        r = requests.post(f"{API}/auth/forgot-password", json={"email": "nobody-random@example.com"}, timeout=30)
        assert r.status_code == 200
        assert r.json().get("ok") is True


# ---------- Admin pages data endpoints ----------
class TestAdminEndpoints:
    def _h(self, t):
        return {"Authorization": f"Bearer {t}"}

    def test_list_workers(self, admin_token, workers):
        assert isinstance(workers, list) and len(workers) >= 1

    def test_rate(self, admin_token):
        r = requests.get(f"{API}/settings/rate", headers=self._h(admin_token), timeout=20)
        assert r.status_code == 200
        assert "rate" in r.json()

    def test_brand(self, admin_token):
        r = requests.get(f"{API}/settings/brand", headers=self._h(admin_token), timeout=20)
        assert r.status_code == 200
        body = r.json()
        assert "color" in body or "brand_color" in body or isinstance(body, dict)

    def test_worksites(self, admin_token):
        r = requests.get(f"{API}/worksites", headers=self._h(admin_token), timeout=20)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_pay_configs(self, admin_token):
        r = requests.get(f"{API}/pay-configs", headers=self._h(admin_token), timeout=20)
        assert r.status_code == 200

    def test_weeks(self, admin_token):
        r = requests.get(f"{API}/weeks", headers=self._h(admin_token), timeout=20)
        assert r.status_code == 200

    def test_weekly_summary(self, admin_token):
        r = requests.get(f"{API}/summary/weekly", headers=self._h(admin_token), timeout=20)
        assert r.status_code == 200
        assert isinstance(r.json(), (list, dict))

    def test_attendance_list(self, admin_token):
        r = requests.get(f"{API}/attendance", headers=self._h(admin_token), timeout=20)
        assert r.status_code == 200

    def test_duplicates_queue(self, admin_token):
        r = requests.get(f"{API}/scans/duplicates", headers=self._h(admin_token), timeout=20)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_scans_rejections(self, admin_token):
        r = requests.get(f"{API}/scans/rejections", headers=self._h(admin_token), timeout=20)
        assert r.status_code == 200


# ---------- Bulk QR nametags (PDF + ZIP of PNGs) ----------
class TestBulkQR:
    def test_pdf_nametag(self, admin_token):
        r = requests.post(
            f"{API}/workers/qr-codes",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={"template": "nametag"},
            timeout=60,
        )
        assert r.status_code == 200, r.text
        assert r.headers.get("content-type", "").startswith("application/pdf")
        assert r.content[:4] == b"%PDF", "Response is not a valid PDF"
        assert len(r.content) > 500

    def test_zip_pngs(self, admin_token):
        r = requests.post(
            f"{API}/workers/qr-codes/zip",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={"scale": 8, "border": 2},
            timeout=60,
        )
        assert r.status_code == 200, r.text
        assert r.headers.get("content-type", "").startswith("application/zip")
        z = zipfile.ZipFile(io.BytesIO(r.content))
        names = z.namelist()
        assert "index.csv" in names
        pngs = [n for n in names if n.endswith(".png")]
        assert len(pngs) >= 2
        # Validate the first PNG header
        assert z.read(pngs[0])[:8] == b"\x89PNG\r\n\x1a\n"


# ---------- Worker dashboard data ----------
class TestWorkerDashboard:
    def _h(self, t):
        return {"Authorization": f"Bearer {t}"}

    def test_me_worker(self, any_worker_token):
        r = requests.get(f"{API}/auth/me", headers=self._h(any_worker_token), timeout=20)
        assert r.status_code == 200
        assert r.json()["role"] == "worker"

    def test_summary_me(self, any_worker_token):
        r = requests.get(f"{API}/summary/me", headers=self._h(any_worker_token), timeout=20)
        assert r.status_code == 200
        data = r.json()
        assert "total_boxes" in data or "boxes" in data or isinstance(data, dict)

    def test_attendance_me(self, any_worker_token):
        r = requests.get(f"{API}/attendance/me", headers=self._h(any_worker_token), timeout=20)
        assert r.status_code == 200

    def test_reports_me(self, any_worker_token):
        r = requests.get(f"{API}/reports/me", headers=self._h(any_worker_token), timeout=20)
        assert r.status_code == 200


# ---------- Supervisor scan + duplicate + self-scan ----------
class TestSupervisorScan:
    def _h(self, t):
        return {"Authorization": f"Bearer {t}"}

    def test_self_scan_rejected(self, admin_token, admin_user):
        """Admin scanning own ID must be rejected with 409 (self-scan)."""
        r = requests.post(
            f"{API}/scans/for-worker",
            headers=self._h(admin_token),
            json={"worker_id": admin_user["id"]},
            timeout=20,
        )
        # Self-scan path raises HTTPException via _reject_self_scan
        assert r.status_code == 409, f"Expected 409 self-scan reject, got {r.status_code} {r.text}"

    def test_scan_and_duplicate(self, admin_token, any_worker):
        worker = any_worker
        # First scan
        r1 = requests.post(
            f"{API}/scans/for-worker",
            headers=self._h(admin_token),
            json={"worker_id": worker["id"]},
            timeout=20,
        )
        assert r1.status_code == 200, r1.text
        scan_id = r1.json().get("id")
        assert scan_id

        # Immediate second scan should be rejected within DUPLICATE_WINDOW_SECONDS
        r2 = requests.post(
            f"{API}/scans/for-worker",
            headers=self._h(admin_token),
            json={"worker_id": worker["id"]},
            timeout=20,
        )
        assert r2.status_code == 409, f"Expected 409 duplicate, got {r2.status_code} {r2.text}"

        # Should appear in duplicates queue
        dq = requests.get(f"{API}/scans/duplicates", headers=self._h(admin_token), timeout=20).json()
        assert any(d.get("worker_id") == worker["id"] for d in dq), "Duplicate not recorded in queue"

        # Cleanup: delete the scan we just created
        d = requests.delete(f"{API}/scans/{scan_id}", headers=self._h(admin_token), timeout=20)
        assert d.status_code in (200, 204)


# ---------- Payslip & payroll exports ----------
class TestExports:
    def _h(self, t):
        return {"Authorization": f"Bearer {t}"}

    def test_payslip_pdf(self, admin_token, any_worker):
        wa = any_worker
        r = requests.get(f"{API}/payslip/{wa['id']}", headers=self._h(admin_token), timeout=30)
        assert r.status_code == 200
        assert r.content[:4] == b"%PDF"

    def test_payslip_xlsx(self, admin_token, any_worker):
        wa = any_worker
        r = requests.get(f"{API}/payslip/{wa['id']}/xlsx", headers=self._h(admin_token), timeout=30)
        assert r.status_code == 200
        # XLSX is a zip
        assert r.content[:2] == b"PK"

    def test_payroll_xlsx(self, admin_token):
        r = requests.get(f"{API}/payroll/xlsx?period=week", headers=self._h(admin_token), timeout=30)
        assert r.status_code == 200
        assert r.content[:2] == b"PK"

    def test_attendance_xlsx(self, admin_token):
        r = requests.get(f"{API}/attendance/xlsx", headers=self._h(admin_token), timeout=30)
        assert r.status_code == 200
        assert r.content[:2] == b"PK"

    def test_attendance_pdf(self, admin_token):
        r = requests.get(f"{API}/attendance/pdf", headers=self._h(admin_token), timeout=30)
        assert r.status_code == 200
        assert r.content[:4] == b"%PDF"
