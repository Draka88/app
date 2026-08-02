import { useEffect, useRef, useState } from "react";

let scannerLoaded = null;
function loadScanner() {
  if (window.Html5Qrcode) return Promise.resolve(window.Html5Qrcode);
  if (scannerLoaded) return scannerLoaded;
  scannerLoaded = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js";
    s.async = true;
    s.onload = () => resolve(window.Html5Qrcode);
    s.onerror = () => reject(new Error("Failed to load scanner"));
    document.head.appendChild(s);
  });
  return scannerLoaded;
}

/**
 * BarcodeScanner
 * Props:
 *  - onDetected(text, format): called on successful scan
 *  - cooldownMs: min ms between reported scans (default 1500)
 */
export default function BarcodeScanner({ onDetected, cooldownMs = 1500 }) {
  const containerId = "bw-scanner";
  const scannerRef = useRef(null);
  const lastScanRef = useRef({ text: "", ts: 0 });
  const [status, setStatus] = useState("loading"); // loading | scanning | error | stopped
  const [error, setError] = useState("");
  const [cameraId, setCameraId] = useState(null);
  const [cameras, setCameras] = useState([]);

  useEffect(() => {
    let cancelled = false;
    let inst = null;

    (async () => {
      try {
        const Html5Qrcode = await loadScanner();
        if (cancelled) return;
        const devices = await Html5Qrcode.getCameras();
        if (!devices || devices.length === 0) {
          setError("No camera found");
          setStatus("error");
          return;
        }
        setCameras(devices);
        // Prefer back camera
        const back = devices.find((d) => /back|rear|environment/i.test(d.label)) || devices[devices.length - 1];
        const id = back.id;
        setCameraId(id);
        inst = new Html5Qrcode(containerId, { verbose: false });
        scannerRef.current = inst;
        await inst.start(
          id,
          { fps: 12, qrbox: { width: 260, height: 160 } },
          (decodedText, decodedResult) => {
            const now = Date.now();
            if (decodedText === lastScanRef.current.text && now - lastScanRef.current.ts < cooldownMs) return;
            lastScanRef.current = { text: decodedText, ts: now };
            const fmt = decodedResult?.result?.format?.formatName || null;
            onDetected(decodedText, fmt);
          },
          () => { /* per-frame errors ignored */ }
        );
        if (!cancelled) setStatus("scanning");
      } catch (e) {
        setError(e?.message || String(e));
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      const s = scannerRef.current;
      if (s) {
        s.stop().catch(() => {}).finally(() => {
          try { s.clear(); } catch {}
        });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchCamera = async () => {
    if (cameras.length < 2) return;
    const idx = cameras.findIndex((c) => c.id === cameraId);
    const next = cameras[(idx + 1) % cameras.length];
    setCameraId(next.id);
    const s = scannerRef.current;
    if (!s) return;
    try {
      await s.stop();
      await s.start(next.id, { fps: 12, qrbox: { width: 260, height: 160 } },
        (decodedText, decodedResult) => {
          const now = Date.now();
          if (decodedText === lastScanRef.current.text && now - lastScanRef.current.ts < cooldownMs) return;
          lastScanRef.current = { text: decodedText, ts: now };
          const fmt = decodedResult?.result?.format?.formatName || null;
          onDetected(decodedText, fmt);
        },
        () => {}
      );
    } catch (e) {
      setError(String(e));
      setStatus("error");
    }
  };

  return (
    <div className="w-full" data-testid="barcode-scanner">
      <div className="relative bg-zinc-950 border-2 border-zinc-950 aspect-[4/3] max-h-[380px] overflow-hidden">
        <div id={containerId} className="absolute inset-0 [&>video]:!w-full [&>video]:!h-full [&>video]:!object-cover" />
        {/* Overlay reticle */}
        <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
          <div className="w-[70%] h-[45%] max-w-[280px] max-h-[180px] border-2 border-yellow-500 relative">
            <span className="absolute -top-1 -left-1 w-4 h-4 border-t-4 border-l-4 border-yellow-500"></span>
            <span className="absolute -top-1 -right-1 w-4 h-4 border-t-4 border-r-4 border-yellow-500"></span>
            <span className="absolute -bottom-1 -left-1 w-4 h-4 border-b-4 border-l-4 border-yellow-500"></span>
            <span className="absolute -bottom-1 -right-1 w-4 h-4 border-b-4 border-r-4 border-yellow-500"></span>
          </div>
        </div>
        <div className="absolute bottom-0 left-0 right-0 bg-zinc-950/80 text-white px-3 py-1.5 text-[10px] font-heading tracking-widest flex items-center justify-between">
          <span data-testid="scanner-status">
            {status === "scanning" && "SCANNING · POINT AT BARCODE"}
            {status === "loading" && "STARTING CAMERA…"}
            {status === "error" && "CAMERA ERROR"}
          </span>
          {cameras.length > 1 && (
            <button onClick={switchCamera} className="text-yellow-500 hover:underline" data-testid="switch-camera">
              Switch camera
            </button>
          )}
        </div>
      </div>
      {status === "error" && (
        <div className="mt-2 border-2 border-red-600 bg-red-50 text-red-700 px-3 py-2 text-xs" data-testid="scanner-error">
          {error || "Could not access camera."}
          <div className="mt-1 text-red-500">
            Grant camera permission in your browser and reload. On desktop, HTTPS is required.
          </div>
        </div>
      )}
    </div>
  );
}
