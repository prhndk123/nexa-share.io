import React, { useEffect, useRef, useState, useCallback } from 'react';
import { X, Camera, SwitchCamera, Zap, AlertTriangle, RefreshCw } from 'lucide-react';
import jsQR from 'jsqr';

interface QRScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onScanSuccess: (code: string) => void;
}

export function QRScannerModal({ isOpen, onClose, onScanSuccess }: QRScannerModalProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number | null>(null);

  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [hasTorch, setHasTorch] = useState<boolean>(false);
  const [isTorchOn, setIsTorchOn] = useState<boolean>(false);

  // Stop camera tracks cleanly
  const stopCamera = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  // Parse code from scanned text (URL or raw code)
  const parseScannedCode = (text: string): string | null => {
    const trimmed = text.trim();
    // 1. Check if URL contains /room/XXX-XXX
    const roomUrlMatch = trimmed.match(/\/room\/(\d{3}-?\d{3})/i);
    if (roomUrlMatch) {
      const raw = roomUrlMatch[1].replace(/\D/g, '');
      if (raw.length === 6) return `${raw.slice(0, 3)}-${raw.slice(3, 6)}`;
    }

    // 2. Check if URL query param ?code=XXX-XXX
    const queryMatch = trimmed.match(/[?&](?:code|room)=(\d{3}-?\d{3})/i);
    if (queryMatch) {
      const raw = queryMatch[1].replace(/\D/g, '');
      if (raw.length === 6) return `${raw.slice(0, 3)}-${raw.slice(3, 6)}`;
    }

    // 3. Raw 6 digit number or format 123-456
    const cleanDigits = trimmed.replace(/\D/g, '');
    if (cleanDigits.length === 6) {
      return `${cleanDigits.slice(0, 3)}-${cleanDigits.slice(3, 6)}`;
    }

    return null;
  };

  // Start Camera
  const startCamera = useCallback(async () => {
    stopCamera();
    setErrorMessage(null);
    setHasPermission(null);

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Browser ini tidak mendukung akses kamera langsung.');
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: facingMode },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      // Check torch support
      const track = stream.getVideoTracks()[0];
      const capabilities = (track?.getCapabilities?.() || {}) as any;
      setHasTorch(Boolean(capabilities?.torch));
      setIsTorchOn(false);

      setHasPermission(true);
    } catch (err: any) {
      console.warn('Camera access error:', err);
      setHasPermission(false);
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setErrorMessage('Izin kamera ditolak. Silakan izinkan akses kamera di pengaturan browser.');
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        setErrorMessage('Kamera tidak ditemukan pada perangkat ini.');
      } else {
        setErrorMessage('Gagal membuka kamera: ' + (err.message || 'Terjadi kesalahan'));
      }
    }
  }, [facingMode, stopCamera]);

  // Torch toggle
  const toggleTorch = async () => {
    if (!streamRef.current || !hasTorch) return;
    const track = streamRef.current.getVideoTracks()[0];
    if (!track) return;
    try {
      const nextTorch = !isTorchOn;
      await (track as any).applyConstraints({
        advanced: [{ torch: nextTorch }],
      });
      setIsTorchOn(nextTorch);
    } catch (err) {
      console.warn('Torch toggle failed:', err);
    }
  };

  // Switch Camera (Environment vs User)
  const toggleFacingMode = () => {
    setFacingMode((prev) => (prev === 'environment' ? 'user' : 'environment'));
  };

  // Scanning Loop
  useEffect(() => {
    if (!isOpen || !hasPermission) return;

    let isScanning = true;
    const hasNativeBarcode = typeof (window as any).BarcodeDetector === 'function';
    let nativeDetector: any = null;
    if (hasNativeBarcode) {
      try {
        nativeDetector = new (window as any).BarcodeDetector({ formats: ['qr_code'] });
      } catch {}
    }

    const scanFrame = async () => {
      if (!isScanning) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;

      if (video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        try {
          let foundText: string | null = null;

          // 1. Try Native BarcodeDetector (super fast in Chrome Android)
          if (nativeDetector) {
            try {
              const barcodes = await nativeDetector.detect(video);
              if (barcodes && barcodes.length > 0) {
                foundText = barcodes[0].rawValue;
              }
            } catch {
              // Fallback to jsQR below
            }
          }

          // 2. Fallback to jsQR with hidden canvas
          if (!foundText && canvas) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (ctx && canvas.width > 0 && canvas.height > 0) {
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const qr = jsQR(imageData.data, imageData.width, imageData.height, {
                inversionAttempts: 'attemptBoth',
              });
              if (qr && qr.data) {
                foundText = qr.data;
              }
            }
          }

          if (foundText) {
            const parsedCode = parseScannedCode(foundText);
            if (parsedCode) {
              // Success! Haptic feedback
              if ('vibrate' in navigator) {
                try {
                  navigator.vibrate(60);
                } catch {}
              }
              isScanning = false;
              stopCamera();
              onScanSuccess(parsedCode);
              onClose();
              return;
            }
          }
        } catch (err) {
          console.debug('Scan frame error:', err);
        }
      }

      if (isScanning) {
        animFrameRef.current = requestAnimationFrame(scanFrame);
      }
    };

    animFrameRef.current = requestAnimationFrame(scanFrame);

    return () => {
      isScanning = false;
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
    };
  }, [isOpen, hasPermission, onClose, onScanSuccess, stopCamera]);

  // Open/Close Lifecycle
  useEffect(() => {
    if (isOpen) {
      startCamera();
    } else {
      stopCamera();
    }
    return () => stopCamera();
  }, [isOpen, startCamera, stopCamera]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/85 backdrop-blur-md animate-in fade-in duration-200">
      <div role="dialog" aria-modal="true" aria-labelledby="scanner-title" className="glass-panel scanner-modal relative w-full max-w-md overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-800/80 flex items-center justify-between bg-slate-900/90 z-10">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <Camera className="w-5 h-5" />
            </div>
            <div>
              <h3 id="scanner-title" className="font-bold text-white text-base">Pindai kode QR</h3>
              <p className="text-xs text-slate-400">Arahkan kamera ke kode QR pengirim</p>
            </div>
          </div>
          <button
            type="button"
            aria-label="Tutup pemindai QR" onClick={onClose}
            className="p-2 rounded-full text-slate-400 hover:text-white hover:bg-slate-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Viewfinder Area */}
        <div className="relative w-full aspect-square bg-black flex items-center justify-center overflow-hidden">
          <video
            ref={videoRef}
            playsInline
            muted
            className="w-full h-full object-cover"
          />
          <canvas ref={canvasRef} className="hidden" />

          {/* Scanner Overlay Box */}
          {hasPermission && (
            <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
              {/* Outer darkened mask */}
              <div className="absolute inset-0 border-[40px] sm:border-[50px] border-black/50" />

              {/* Viewfinder Target Reticle */}
              <div className="relative w-56 h-56 rounded-2xl border-2 border-emerald-400/80 shadow-[0_0_20px_rgba(16,185,129,0.3)]">
                {/* 4 Corners */}
                <div className="absolute -top-1 -left-1 w-6 h-6 border-t-4 border-l-4 border-emerald-400 rounded-tl-lg" />
                <div className="absolute -top-1 -right-1 w-6 h-6 border-t-4 border-r-4 border-emerald-400 rounded-tr-lg" />
                <div className="absolute -bottom-1 -left-1 w-6 h-6 border-b-4 border-l-4 border-emerald-400 rounded-bl-lg" />
                <div className="absolute -bottom-1 -right-1 w-6 h-6 border-b-4 border-r-4 border-emerald-400 rounded-br-lg" />

                {/* Animated Laser Scanning Line */}
                <div className="absolute inset-x-2 h-0.5 bg-gradient-to-r from-transparent via-emerald-400 to-transparent shadow-[0_0_12px_#10b981] animate-bounce" />
              </div>
            </div>
          )}

          {/* Loading / Error States */}
          {hasPermission === null && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-950/90 text-slate-300">
              <RefreshCw className="w-8 h-8 text-emerald-400 animate-spin" />
              <p className="text-sm font-medium">Menghubungkan kamera...</p>
            </div>
          )}

          {hasPermission === false && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 bg-slate-950 text-center">
              <div className="p-3.5 rounded-full bg-rose-500/10 text-rose-400 border border-rose-500/20">
                <AlertTriangle className="w-8 h-8" />
              </div>
              <div>
                <p className="text-sm font-bold text-white mb-1">Kamera Tidak Tersedia</p>
                <p className="text-xs text-slate-400 max-w-xs leading-relaxed">{errorMessage}</p>
              </div>
              <button
                type="button"
                onClick={startCamera}
                className="px-5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-white border border-slate-700 transition"
              >
                Coba Lagi
              </button>
            </div>
          )}
        </div>

        {/* Footer Controls */}
        <div className="px-5 py-4 border-t border-slate-800/80 bg-slate-900 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {hasTorch && (
              <button
                type="button"
                onClick={toggleTorch}
                className={`p-2.5 rounded-xl border text-xs font-semibold transition flex items-center gap-1.5 ${
                  isTorchOn
                    ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                    : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700'
                }`}
              >
                <Zap className="w-4 h-4" />
                <span>{isTorchOn ? 'Senter Aktif' : 'Senter'}</span>
              </button>
            )}

            <button
              type="button"
              onClick={toggleFacingMode}
              className="p-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 text-xs font-semibold transition flex items-center gap-1.5"
            >
              <SwitchCamera className="w-4 h-4" />
              <span>Ganti Kamera</span>
            </button>
          </div>

          <button
            type="button"
            aria-label="Tutup pemindai QR" onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-400 hover:text-white transition"
          >
            Tutup
          </button>
        </div>
      </div>
    </div>
  );
}
