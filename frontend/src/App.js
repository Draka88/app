import "./App.css";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sonner";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import Login from "./pages/Login";
import Register from "./pages/Register";
import ForgotPassword from "./pages/ForgotPassword";
import ResetPassword from "./pages/ResetPassword";
import SupervisorScan from "./pages/SupervisorScan";
import AdminPayroll from "./pages/AdminPayroll";
import AdminWorkers from "./pages/AdminWorkers";
import AdminSettings from "./pages/AdminSettings";
import AdminReports from "./pages/AdminReports";
import AdminWhitelist from "./pages/AdminWhitelist";
import AdminGenerator from "./pages/AdminGenerator";
import AdminPayConfig from "./pages/AdminPayConfig";
import AdminWorksites from "./pages/AdminWorksites";
import AdminAttendance from "./pages/AdminAttendance";
import AdminQRCodes from "./pages/AdminQRCodes";
import AdminDuplicates from "./pages/AdminDuplicates";
import WorkerDashboard from "./pages/WorkerDashboard";

function Loading() {
  return (
    <div className="min-h-screen grid place-items-center bg-[var(--bg)]">
      <div className="font-heading text-2xl text-zinc-700 animate-pulse">
        Boxwise · Loading
      </div>
    </div>
  );
}

function AppRoutes() {
  const { user } = useAuth();
  if (user === null) return <Loading />;
  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }
  if (user.role === "admin") {
    return (
      <Routes>
        <Route path="/" element={<SupervisorScan />} />
        <Route path="/payroll" element={<AdminPayroll />} />
        <Route path="/reports" element={<AdminReports />} />
        <Route path="/workers" element={<AdminWorkers />} />
        <Route path="/whitelist" element={<AdminWhitelist />} />
        <Route path="/generator" element={<AdminGenerator />} />
        <Route path="/payconfig" element={<AdminPayConfig />} />
        <Route path="/worksites" element={<AdminWorksites />} />
        <Route path="/attendance" element={<AdminAttendance />} />
        <Route path="/qr-codes" element={<AdminQRCodes />} />
        <Route path="/duplicates" element={<AdminDuplicates />} />
        <Route path="/settings" element={<AdminSettings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    );
  }
  // Worker: personal dashboard only (own attendance + payroll)
  return (
    <Routes>
      <Route path="/" element={<WorkerDashboard />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function App() {
  return (
    <div className="App">
      <BrowserRouter>
        <AuthProvider>
          <AppRoutes />
          <Toaster position="top-right" richColors closeButton />
        </AuthProvider>
      </BrowserRouter>
    </div>
  );
}

export default App;
