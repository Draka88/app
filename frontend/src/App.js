import "./App.css";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sonner";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import Login from "./pages/Login";
import Register from "./pages/Register";
import WorkerDashboard from "./pages/WorkerDashboard";
import AdminPayroll from "./pages/AdminPayroll";
import AdminWorkers from "./pages/AdminWorkers";
import AdminSettings from "./pages/AdminSettings";
import AdminReports from "./pages/AdminReports";

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
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }
  if (user.role === "admin") {
    return (
      <Routes>
        <Route path="/" element={<AdminPayroll />} />
        <Route path="/reports" element={<AdminReports />} />
        <Route path="/workers" element={<AdminWorkers />} />
        <Route path="/settings" element={<AdminSettings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    );
  }
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
