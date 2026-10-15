import React, { useState, useEffect, useRef } from 'react';
import {
  ShieldCheck,
  Send,
  Download,
  Copy,
  Check,
  AlertCircle,
  FileCheck2,
  File,
  X,
  RefreshCw,
  Zap,
  Globe,
  Radio,
  Lock,
  ArrowRight,
  Info,
} from 'lucide-react';
import type { ScreenState, SignalMessage } from '@nexashare/shared';
import { api, ApiError } from '../lib/api/client';
import { remainingSeconds } from '../lib/api/deadline';
import { SignalInbox } from '../lib/api/signal-inbox';
import {
  NexaShareTransferEngine,
  type TransferProgressSnapshot,
} from '../lib/webrtc/transfer-engine';
import { QRCodeDisplay } from '../components/QRCodeDisplay';

function detectDeviceLabel(): string {
  const ua = navigator.userAgent;
  let os = 'Perangkat';
  if (/Windows/i.test(ua)) os = 'Windows PC';
  else if (/Macintosh|Mac OS/i.test(ua)) os = 'Mac';
  else if (/iPhone|iPad/i.test(ua)) os = 'iPhone / iPad';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/Linux/i.test(ua)) os = 'Linux';

  let browser = 'Browser';
  if (/Edg/i.test(ua)) browser = 'Edge';
  else if (/Chrome/i.test(ua)) browser = 'Chrome';
  else if (/Safari/i.test(ua)) browser = 'Safari';
  else if (/Firefox/i.test(ua)) browser = 'Firefox';

  return `${os} (${browser})`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function NexaShareApp() {
  const [mode, setMode] = useState<'home' | 'send' | 'receive' | 'privacy'>('home');
  const [screenState, setScreenState] = useState<ScreenState>('idle');
  const [deviceLabel, setDeviceLabel] = useState<string>(detectDeviceLabel());

  // Session & Room State
  const [token, setToken] = useState<string | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [roomCode, setRoomCode] = useState<string>('');
  const [inviteUrl, setInviteUrl] = useState<string>('');
  const [expiryCountdown, setExpiryCountdown] = useState<number>(0);
  const [roomExpiresAt, setRoomExpiresAt] = useState<string | null>(null);
  const [pendingExpiresAt, setPendingExpiresAt] = useState<string | null>(null);
  const [approvalCountdown, setApprovalCountdown] = useState<number>(0);
  const [copiedLink, setCopiedLink] = useState<boolean>(false);

  // Guest State
  const [inputCode, setInputCode] = useState<string>('');
  const [pendingGuestRequest, setPendingGuestRequest] = useState<{
    requestId: string;
    deviceLabel: string;
    expiresAt: string;
  } | null>(null);

  // WebRTC & Transfer State
  const [routeType, setRouteType] = useState<'DIRECT' | 'RELAY' | 'UNKNOWN'>('UNKNOWN');
  const [peerDeviceLabel, setPeerDeviceLabel] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<TransferProgressSnapshot[]>([]);
  const [isDragOver, setIsDragOver] = useState<boolean>(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Incoming File Prompt
  const [incomingOffer, setIncomingOffer] = useState<{
    transferId: string;
    name: string;
    size: number;
    resolver: (decision: { accept: boolean; writableStream?: any }) => void;
  } | null>(null);

  const engineRef = useRef<NexaShareTransferEngine | null>(null);
  const hasConnectedRef = useRef(false);
  const pollTimerRef = useRef<number | null>(null);
  const signalInboxRef = useRef(new SignalInbox());
  const serverClockOffsetRef = useRef<number>(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Handle URL deep linking (e.g. /room/482-913 or ?code=482-913)
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const codeFromQuery = urlParams.get('code') || urlParams.get('room');
    let codeFromPath = '';
    if (window.location.pathname.startsWith('/room/')) {
      codeFromPath = window.location.pathname.replace('/room/', '').trim();
    }
    const initialCode = codeFromPath || codeFromQuery;
    if (initialCode) {
      const clean = initialCode.replace(/\D/g, '');
      const formatted = clean.length === 6 ? `${clean.slice(0, 3)}-${clean.slice(3, 6)}` : initialCode;
      setInputCode(formatted);
      setMode('receive');
    }
  }, []);

  // Native file pickers / mobile file providers can suspend the page. Resume
  // recovery on return without replacing the room or closing the channels.
  useEffect(() => {
    const resume = () => {
      if (document.visibilityState === 'visible') engineRef.current?.resumeConnection();
    };
    window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      window.removeEventListener('focus', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, []);

  // Calculate from the server deadline; browser timer throttling must not extend it.
  useEffect(() => {
    if (screenState === 'waiting_for_peer' && roomExpiresAt) {
      const update = () => {
        const remaining = remainingSeconds(roomExpiresAt, serverClockOffsetRef.current);
        setExpiryCountdown(remaining);
        if (remaining === 0) {
          setScreenState('expired');
          setPendingGuestRequest(null);
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
      };
      update();
      const timer = window.setInterval(update, 1000);
      return () => clearInterval(timer);
    }
  }, [screenState, roomExpiresAt]);

  useEffect(() => {
    const deadline = screenState === 'waiting_for_peer' ? pendingGuestRequest?.expiresAt
      : screenState === 'join_pending' ? pendingExpiresAt : null;
    if (!deadline) return;
    const update = () => {
      const remaining = remainingSeconds(deadline, serverClockOffsetRef.current);
      setApprovalCountdown(remaining);
      if (remaining === 0) {
        if (screenState === 'waiting_for_peer') {
          setPendingGuestRequest(null);
        } else {
          setPendingExpiresAt(null);
          setScreenState('expired');
          setErrorMessage('Waktu menunggu persetujuan habis. Silakan kirim permintaan lagi.');
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
      }
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [screenState, pendingGuestRequest, pendingExpiresAt]);

  // Clean up polling and engine on unmount
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      engineRef.current?.close();
    };
  }, []);

  // Initialize WebRTC Transfer Engine
  const setupTransferEngine = async (currentRole: 'HOST' | 'GUEST', curToken: string, curRoomId: string) => {
    try {
      const { iceServers } = await api.getIceServers(curToken);
      const relayConfigured = iceServers.some((server) =>
        (Array.isArray(server.urls) ? server.urls : [server.urls]).some((url) => /^turns?:/i.test(url))
      );

      const engine = new NexaShareTransferEngine({
        onSignalOffer: async (sdp) => {
          await api.sendSignal(curToken, curRoomId, 'webrtc:offer', currentRole === 'HOST' ? 'GUEST' : 'HOST', { sdp });
        },
        onSignalAnswer: async (sdp) => {
          await api.sendSignal(curToken, curRoomId, 'webrtc:answer', currentRole === 'HOST' ? 'GUEST' : 'HOST', { sdp });
        },
        onSignalIceCandidate: async (candidate) => {
          if (candidate) {
            await api.sendSignal(curToken, curRoomId, 'webrtc:ice-candidate', currentRole === 'HOST' ? 'GUEST' : 'HOST', { candidate });
          }
        },
        onSignalingError: (error) => {
          setScreenState('ice_failed');
          setErrorMessage(`Pertukaran informasi koneksi gagal: ${error.message}`);
        },
        onSignalRestart: async () => {
          await api.sendSignal(curToken, curRoomId, 'webrtc:restart', 'HOST', {});
        },
        onRefreshIceServers: async () => (await api.getIceServers(curToken)).iceServers,
        onConnectionStateChange: (state, route) => {
          setRouteType(route);
          if (state === 'connected') {
            hasConnectedRef.current = true;
            setIsReconnecting(false);
            setErrorMessage(null);
            setScreenState('ready');
          } else if (state === 'connecting') {
            if (hasConnectedRef.current) setIsReconnecting(true);
          } else if (state === 'failed') {
            setIsReconnecting(false);
            setScreenState('ice_failed');
            setErrorMessage(relayConfigured
              ? 'Koneksi langsung dan relay gagal. Coba jaringan lain atau periksa layanan relay.'
              : 'Koneksi langsung gagal. Untuk Wi-Fi berbeda atau data seluler, layanan relay perlu diaktifkan oleh pengelola aplikasi.');
          } else if (state === 'disconnected') {
            setScreenState('peer_disconnected');
          }
        },
        onIncomingFileOffer: (offer) => {
          return new Promise((resolve) => {
            setIncomingOffer({
              transferId: offer.transferId,
              name: offer.name,
              size: offer.size,
              resolver: resolve,
            });
          });
        },
        onProgress: (snapshot) => {
          setTransfers((prev) => {
            const idx = prev.findIndex((t) => t.transferId === snapshot.transferId);
            if (idx === -1) return [snapshot, ...prev];
            const updated = [...prev];
            updated[idx] = snapshot;
            return updated;
          });
        },
      });

      engineRef.current?.close();
      engineRef.current = engine;
      await engine.initialize(iceServers, currentRole === 'HOST');
    } catch (err: any) {
      console.error('Setup transfer engine error:', err);
      setScreenState('ice_failed');
      setErrorMessage(err.message || 'Gagal memulai koneksi transfer.');
      engineRef.current?.close();
      engineRef.current = null;
      throw err;
    }
  };

  // Signal Poller for Serverless Environment
  const startSignalPolling = (curToken: string, curRoomId: string, myRole: 'HOST' | 'GUEST') => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    signalInboxRef.current.clear();
    let polling = false;
    let lastPollAt = 0;

    const timer = window.setInterval(async () => {
      if (polling) return;
      if (engineRef.current?.isReady && Date.now() - lastPollAt < 2000) return;
      lastPollAt = Date.now();
      polling = true;
      try {
        const { signals, serverTime } = await api.pollSignals(curToken, curRoomId, 0);
        if (pollTimerRef.current !== timer) return;
        serverClockOffsetRef.current = serverTime - Date.now();
        await signalInboxRef.current.consume(signals, async (signal) => {
          if (pollTimerRef.current !== timer) return false;
          return handleIncomingSignal(signal, myRole, curToken, curRoomId);
        });
      } catch (err) {
        if (pollTimerRef.current !== timer) return;
        console.warn('Poll signal error:', err);
        if (err instanceof ApiError && [401, 403, 404].includes(err.status)) {
          clearInterval(timer);
          pollTimerRef.current = null;
          setRoomExpiresAt(null);
          setPendingGuestRequest(null);
          setPendingExpiresAt(null);
          setScreenState('peer_disconnected');
          setErrorMessage('Sesi koneksi tidak tersedia. Silakan buat atau gabung ke ruangan baru.');
        } else if (err instanceof ApiError && err.status === 503) {
          setErrorMessage(err.message);
        }
      } finally {
        polling = false;
      }
    }, 800);
    pollTimerRef.current = timer;
  };

  // Handle incoming signals from serverless inbox
  const handleIncomingSignal = async (
    signal: SignalMessage,
    myRole: 'HOST' | 'GUEST',
    curToken: string,
    curRoomId: string
  ) => {
    switch (signal.type) {
      case 'join:requested':
        if (myRole === 'HOST' && Date.parse(signal.payload.expiresAt) > Date.now() + serverClockOffsetRef.current) {
          setPendingGuestRequest({
            requestId: signal.payload.requestId,
            deviceLabel: signal.payload.deviceLabel || 'Perangkat Tamu',
            expiresAt: signal.payload.expiresAt,
          });
        }
        break;

      case 'join:approved':
        if (myRole === 'GUEST') {
          setScreenState('negotiating');
          await setupTransferEngine('GUEST', curToken, curRoomId);
        }
        break;

      case 'join:rejected':
        if (myRole === 'GUEST') {
          setScreenState('rejected');
          setErrorMessage(signal.payload.reason || 'Koneksi ditolak oleh pemilik ruangan.');
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
        }
        break;

      case 'webrtc:offer':
        if (!engineRef.current) return false;
        if (signal.payload.sdp) {
          await engineRef.current.handleRemoteOffer(signal.payload.sdp);
        }
        break;

      case 'webrtc:answer':
        if (!engineRef.current) return false;
        if (signal.payload.sdp) {
          await engineRef.current.handleRemoteAnswer(signal.payload.sdp);
        }
        break;

      case 'webrtc:ice-candidate':
        if (!engineRef.current) return false;
        if (signal.payload.candidate) {
          await engineRef.current.handleRemoteIceCandidate(signal.payload.candidate);
        }
        break;

      case 'webrtc:restart':
        if (!engineRef.current) return false;
        if (myRole === 'HOST') await engineRef.current.restartConnection();
        break;

      case 'room:closed':
        setScreenState('peer_disconnected');
        setErrorMessage('Sesi transfer telah ditutup oleh lawan transfer.');
        engineRef.current?.close();
        break;
    }
  };

  // Host: Create Room Flow
  const handleCreateRoom = async () => {
    try {
      hasConnectedRef.current = false;
      setIsReconnecting(false);
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
      engineRef.current?.close();
      engineRef.current = null;
      setErrorMessage(null);
      setScreenState('creating');
      const session = await api.createSession();
      setToken(session.token);

      const room = await api.createRoom(session.token, deviceLabel);
      setRoomId(room.roomId);
      setRoomCode(room.code);
      setInviteUrl(room.inviteUrl);
      serverClockOffsetRef.current = room.serverTime - Date.now();
      setRoomExpiresAt(room.expiresAt);
      setPendingGuestRequest(null);
      setExpiryCountdown(remainingSeconds(room.expiresAt, 0, room.serverTime));
      setScreenState('waiting_for_peer');
      setMode('send');

      startSignalPolling(session.token, room.roomId, 'HOST');
    } catch (err: any) {
      setErrorMessage(err.message || 'Gagal membuat ruang transfer.');
      setScreenState('idle');
    }
  };

  // Host: Approve Guest
  const handleApproveGuest = async () => {
    if (!token || !roomId || !pendingGuestRequest) return;
    try {
      setErrorMessage(null);
      setPeerDeviceLabel(pendingGuestRequest.deviceLabel);
      await api.approveJoin(token, roomId, pendingGuestRequest.requestId);
      setPendingGuestRequest(null);
      setScreenState('negotiating');
      await setupTransferEngine('HOST', token, roomId);
    } catch (err: any) {
      if (err instanceof ApiError && err.code === 'APPROVAL_FAILED') setPendingGuestRequest(null);
      setErrorMessage(err.message || 'Gagal menyetujui perangkat.');
    }
  };

  // Host: Reject Guest
  const handleRejectGuest = async () => {
    if (!token || !roomId || !pendingGuestRequest) return;
    try {
      await api.rejectJoin(token, roomId, pendingGuestRequest.requestId);
      setPendingGuestRequest(null);
    } catch (err: any) {
      console.error(err);
    }
  };

  // Guest: Join Room Flow
  const handleJoinRoom = async () => {
    if (!inputCode.trim()) return;
    try {
      hasConnectedRef.current = false;
      setIsReconnecting(false);
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
      engineRef.current?.close();
      engineRef.current = null;
      setErrorMessage(null);
      setPendingExpiresAt(null);
      setScreenState('join_pending');
      const session = await api.createSession();
      setToken(session.token);

      const joinRes = await api.requestJoin(session.token, inputCode, deviceLabel);
      setRoomId(joinRes.roomId);
      serverClockOffsetRef.current = joinRes.serverTime - Date.now();
      setPendingExpiresAt(joinRes.expiresAt);

      startSignalPolling(session.token, joinRes.roomId, 'GUEST');
    } catch (err: any) {
      setErrorMessage(err.message || 'Gagal bergabung dengan ruangan.');
      setScreenState('incorrect_code');
    }
  };

  // Send File Handler
  const handleSendFiles = async (files: FileList | null) => {
    if (!files || files.length === 0 || !engineRef.current) return;
    const engine = engineRef.current;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        await engine.sendFile(file);
      } catch (err: any) {
        if (engineRef.current !== engine) return;
        console.error('Gagal mengirim berkas:', err);
        setErrorMessage(err.message || 'Gagal mengirim berkas. Silakan coba lagi.');
        break;
      }
    }
  };

  // Copy invitation link
  const handleCopyLink = () => {
    const link = inviteUrl || `${window.location.origin}/room/${roomCode}`;
    navigator.clipboard.writeText(link).then(() => {
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2500);
    });
  };

  // Reset Session
  const handleResetSession = () => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    pollTimerRef.current = null;
    signalInboxRef.current.clear();
    engineRef.current?.close();
    engineRef.current = null;
    hasConnectedRef.current = false;
    setToken(null);
    setRoomId(null);
    setRoomCode('');
    setRoomExpiresAt(null);
    setPendingExpiresAt(null);
    setExpiryCountdown(0);
    setIsReconnecting(false);
    setTransfers([]);
    setPendingGuestRequest(null);
    setIncomingOffer(null);
    setScreenState('idle');
    setMode('home');
    setErrorMessage(null);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-between font-sans selection:bg-emerald-500 selection:text-slate-950">
      {/* Header */}
      <header className="border-b border-slate-800/80 bg-slate-950/70 backdrop-blur sticky top-0 z-40 px-4 py-3">
        <div className="max-w-4xl w-full mx-auto flex items-center justify-between">
          <button
            type="button"
            onClick={handleResetSession}
            className="min-h-[44px] px-2 flex items-center gap-2.5 font-extrabold text-xl tracking-tight text-white focus:outline-none focus:ring-2 focus:ring-emerald-400 rounded-lg"
          >
            <div className="h-4 w-4 rounded-full bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.8)]" />
            <span>NexaShare</span>
            <span className="text-[10px] font-mono tracking-widest uppercase bg-emerald-950/80 text-emerald-300 px-2 py-0.5 rounded border border-emerald-500/30">
              Serverless P2P
            </span>
          </button>

          <nav className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setMode('privacy')}
              className="min-h-[44px] px-3.5 text-xs sm:text-sm font-medium text-slate-400 hover:text-white transition rounded-lg hover:bg-slate-900 flex items-center gap-1.5"
            >
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <span>Privasi & Keamanan</span>
            </button>
          </nav>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-2xl w-full mx-auto px-4 py-6 flex flex-col gap-6">
        <div aria-live="polite" className="sr-only">
          Status sesi: {screenState}
        </div>

        {/* Global Alert / Zero-Storage Notice */}
        <section className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-4 text-xs sm:text-sm text-amber-200/90 flex items-start gap-3 shadow-lg">
          <Info className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div className="flex flex-col gap-0.5">
            <p className="font-semibold text-amber-300">
              Transfer Langsung Antar-Browser (Zero Cloud Storage)
            </p>
            <p className="text-amber-200/80 leading-relaxed">
              Isi berkas dikirim langsung antar-perangkat via WebRTC terenkripsi DTLS. Server hanya menyimpan metadata koneksi sementara.
            </p>
          </div>
        </section>

        {/* Error Banner */}
        {isReconnecting && (
          <div role="status" className="rounded-xl border border-sky-500/30 bg-sky-950/30 p-4 text-sm text-sky-200">
            Koneksi terganggu. Sedang menyambungkan kembali; tunggu sebelum mengirim berkas.
          </div>
        )}
        {errorMessage && (
          <div className="rounded-xl border border-rose-500/40 bg-rose-950/30 p-4 text-sm text-rose-200 flex items-center justify-between gap-3 animate-in fade-in">
            <div className="flex items-center gap-2.5">
              <AlertCircle className="w-5 h-5 text-rose-400 shrink-0" />
              <span>{errorMessage}</span>
            </div>
            <button
              type="button"
              onClick={() => setErrorMessage(null)}
              className="p-1 hover:bg-rose-900/50 rounded-lg text-rose-400"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* MODE: HOME */}
        {mode === 'home' && (
          <section className="my-auto flex flex-col gap-6 py-8">
            <div className="text-center flex flex-col gap-2">
              <h1 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight">
                Kirim Berkas Bebas Cloud.
              </h1>
              <p className="text-sm sm:text-base text-slate-400 max-w-md mx-auto">
                Transfer file ukuran besar antar-perangkat secara instan, aman, dan privat melalui jaringan WebRTC tanpa mengunggah berkas ke server.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-4">
              <button
                type="button"
                onClick={handleCreateRoom}
                className="group p-6 rounded-2xl border border-slate-800 bg-slate-900/90 hover:bg-slate-900 hover:border-emerald-500/60 transition shadow-xl text-left flex flex-col justify-between min-h-[160px] relative overflow-hidden focus:ring-2 focus:ring-emerald-400"
              >
                <div className="flex items-center justify-between w-full">
                  <div className="p-2.5 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                    <Send className="w-6 h-6" />
                  </div>
                  <span className="text-xs font-mono uppercase text-emerald-400 font-semibold tracking-wider">
                    Host Ruangan
                  </span>
                </div>
                <div>
                  <h2 className="text-xl font-bold text-white group-hover:text-emerald-300 transition">
                    Send Files
                  </h2>
                  <p className="text-xs text-slate-400 mt-1">
                    Buat ruang transfer, bagikan kode 6 digit atau QR untuk mulai mengirim berkas.
                  </p>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setMode('receive')}
                className="group p-6 rounded-2xl border border-slate-800 bg-slate-900/90 hover:bg-slate-900 hover:border-sky-500/60 transition shadow-xl text-left flex flex-col justify-between min-h-[160px] relative overflow-hidden focus:ring-2 focus:ring-sky-400"
              >
                <div className="flex items-center justify-between w-full">
                  <div className="p-2.5 rounded-xl bg-sky-500/10 text-sky-400 border border-sky-500/20">
                    <Download className="w-6 h-6" />
                  </div>
                  <span className="text-xs font-mono uppercase text-sky-400 font-semibold tracking-wider">
                    Gabung Ruangan
                  </span>
                </div>
                <div>
                  <h2 className="text-xl font-bold text-white group-hover:text-sky-300 transition">
                    Receive Files
                  </h2>
                  <p className="text-xs text-slate-400 mt-1">
                    Masukkan kode 6 digit dari perangkat pengirim dan terima berkas langsung.
                  </p>
                </div>
              </button>
            </div>
          </section>
        )}

        {/* MODE: SEND (Host) */}
        {mode === 'send' && (
          <section className="rounded-2xl border border-slate-800/90 bg-slate-900/90 backdrop-blur p-6 flex flex-col gap-6 shadow-2xl">
            {/* Header Status */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-5">
              <div>
                <p className="text-xs font-mono uppercase text-slate-400">Kode Transfer Ruangan</p>
                <p className="text-3xl font-mono font-extrabold tracking-wider text-emerald-400 mt-0.5">
                  {roomCode || 'Membuat kode...'}
                </p>
              </div>

              <div className="flex items-center gap-2">
                <span className="px-3 py-1.5 rounded-full text-xs font-mono bg-slate-800 text-slate-300 flex items-center gap-2 border border-slate-700">
                  <span
                    className={`h-2 w-2 rounded-full ${
                      screenState === 'ready'
                        ? 'bg-emerald-400 animate-pulse'
                        : screenState === 'waiting_for_peer'
                        ? 'bg-amber-400 animate-ping'
                        : 'bg-sky-400'
                    }`}
                  />
                  <span>Status: {isReconnecting ? 'reconnecting' : screenState}</span>
                </span>
                {routeType !== 'UNKNOWN' && (
                  <span className="px-2.5 py-1 rounded-full text-[10px] font-mono bg-emerald-950 text-emerald-300 border border-emerald-500/30">
                    {routeType} P2P
                  </span>
                )}
              </div>
            </div>

            {/* Waiting for peer / QR Display */}
            {screenState === 'waiting_for_peer' && (
              <div className="flex flex-col sm:flex-row items-center gap-6 p-4 rounded-xl bg-slate-950/60 border border-slate-800/80">
                <div className="shrink-0">
                  <QRCodeDisplay value={inviteUrl || `${window.location.origin}/room/${roomCode}`} size={160} />
                </div>
                <div className="flex flex-col gap-3 flex-1 text-center sm:text-left">
                  <h3 className="font-bold text-white text-base">Bagikan ke Perangkat Lawan</h3>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Scan QR code ini dengan kamera ponsel, atau salin tautan undangan langsung.
                  </p>
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={handleCopyLink}
                      className="min-h-[44px] px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center justify-center gap-2 transition flex-1 sm:flex-none border border-slate-700"
                    >
                      {copiedLink ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                      <span>{copiedLink ? 'Tautan Tersalin!' : 'Salin Tautan'}</span>
                    </button>
                    <span className="text-xs font-mono text-slate-400">
                      Kode berlaku: {Math.floor(expiryCountdown / 60)}:{(expiryCountdown % 60).toString().padStart(2, '0')}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Guest Join Request Prompt */}
            {(screenState === 'expired' || screenState === 'peer_disconnected' || screenState === 'ice_failed') && (
              <div className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-4 flex flex-col gap-3">
                <p className="text-sm text-amber-200">
                  {screenState === 'expired' ? 'Masa berlaku kode ruangan sudah habis.' : 'Koneksi belum tersedia. Coba lagi dengan kode baru.'}
                </p>
                <button type="button" onClick={handleCreateRoom} className="min-h-[44px] px-4 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-sm font-semibold self-start">
                  Buat Kode Baru
                </button>
              </div>
            )}

            {pendingGuestRequest && (
              <div className="rounded-xl border border-sky-500/50 bg-sky-950/30 p-5 flex flex-col gap-3.5 shadow-xl animate-in zoom-in-95">
                <div className="flex items-center gap-3">
                  <Radio className="w-5 h-5 text-sky-400 animate-pulse shrink-0" />
                  <div>
                    <h4 className="font-bold text-white text-sm">Permintaan Bergabung Masuk</h4>
                    <p className="text-xs text-sky-200/90 mt-0.5">
                      Perangkat <strong>"{pendingGuestRequest.deviceLabel}"</strong> ingin terhubung.
                    </p>
                    <p className="text-xs font-mono text-sky-200/90 mt-1">
                      Waktu persetujuan: {Math.floor(approvalCountdown / 60)}:{(approvalCountdown % 60).toString().padStart(2, '0')}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3 pt-1">
                  <button
                    type="button"
                    onClick={handleApproveGuest}
                    className="min-h-[44px] px-5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs tracking-wide transition shadow-lg flex-1 sm:flex-none"
                  >
                    Izinkan (Approve)
                  </button>
                  <button
                    type="button"
                    onClick={handleRejectGuest}
                    className="min-h-[44px] px-4 rounded-xl bg-slate-800 hover:bg-rose-950 hover:text-rose-300 text-slate-300 font-semibold text-xs transition border border-slate-700 flex-1 sm:flex-none"
                  >
                    Tolak (Reject)
                  </button>
                </div>
              </div>
            )}

            {/* File Drag and Drop Zone (Active when Ready) */}
            {screenState === 'ready' && (
              <div className="flex flex-col gap-4">
                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    setIsDragOver(true);
                  }}
                  onDragLeave={() => setIsDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setIsDragOver(false);
                    handleSendFiles(e.dataTransfer.files);
                  }}
                  onClick={() => fileInputRef.current?.click()}
                  className={`border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition flex flex-col items-center justify-center gap-3 min-h-[180px] ${
                    isDragOver
                      ? 'border-emerald-400 bg-emerald-950/20 scale-[0.99]'
                      : 'border-slate-700 hover:border-emerald-400 bg-slate-950/40 hover:bg-slate-950/70'
                  }`}
                >
                  <div className="p-3.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shadow-md">
                    <Send className="w-6 h-6" />
                  </div>
                  <div>
                    <p className="text-sm font-bold text-white">
                      Klik untuk memilih berkas atau seret & lepas (Drag & Drop) di sini
                    </p>
                    <p className="text-xs text-slate-400 mt-1">
                      Mendukung foto, video, ZIP, dokumen (bisa pilih banyak berkas sekaligus).
                    </p>
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    onClick={(event) => event.stopPropagation()}
                    multiple
                    onChange={(e) => handleSendFiles(e.target.files)}
                    className="sr-only"
                  />
                </div>
              </div>
            )}
          </section>
        )}

        {/* MODE: RECEIVE (Guest) */}
        {mode === 'receive' && (
          <section className="rounded-2xl border border-slate-800/90 bg-slate-900/90 backdrop-blur p-6 flex flex-col gap-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-4">
              <div>
                <h2 className="text-xl font-bold text-white">Gabung Ruang Transfer</h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Masukkan 6 digit kode yang diberikan oleh perangkat pengirim.
                </p>
              </div>
              <span className="px-3 py-1 rounded-full text-xs font-mono bg-slate-800 text-slate-300 border border-slate-700">
                {screenState}
              </span>
            </div>

            {screenState !== 'ready' && screenState !== 'transferring' ? (
              <div className="flex flex-col gap-4">
                <div>
                  <label className="block text-xs font-mono uppercase text-slate-400 mb-1.5">
                    Nama Perangkat Kamu
                  </label>
                  <input
                    type="text"
                    value={deviceLabel}
                    onChange={(e) => setDeviceLabel(e.target.value)}
                    className="min-h-[44px] w-full rounded-xl border border-slate-700 bg-slate-950 px-4 text-sm text-white focus:outline-none focus:border-sky-400"
                    placeholder="Contoh: Laptop Kantor"
                  />
                </div>

                <div>
                  <label className="block text-xs font-mono uppercase text-slate-400 mb-1.5">
                    Kode Ruangan (6 Digit)
                  </label>
                  <div className="flex flex-col sm:flex-row gap-3">
                    <input
                      type="text"
                      inputMode="numeric"
                      placeholder="Contoh: 482-913"
                      value={inputCode}
                      onChange={(e) => {
                        const digits = e.target.value.replace(/\D/g, '');
                        if (digits.length <= 6) {
                          setInputCode(
                            digits.length > 3 ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}` : digits
                          );
                        }
                      }}
                      className="min-h-[48px] flex-1 rounded-xl border border-slate-700 bg-slate-950 px-4 font-mono text-xl tracking-widest text-center text-emerald-400 focus:outline-none focus:border-sky-400"
                    />
                    <button
                      type="button"
                      disabled={screenState === 'join_pending'}
                      onClick={handleJoinRoom}
                      className="min-h-[48px] px-8 rounded-xl bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 font-bold text-sm tracking-wide transition shadow-lg flex items-center justify-center gap-2"
                    >
                      {screenState === 'join_pending' && <RefreshCw className="w-4 h-4 animate-spin" />}
                      <span>{screenState === 'join_pending' ? 'Menunggu Izin...' : 'Connect'}</span>
                    </button>
                  </div>
                </div>

                {screenState === 'join_pending' && (
                  <div className="p-4 rounded-xl bg-sky-950/30 border border-sky-500/30 text-xs text-sky-200 flex items-center gap-3 animate-pulse">
                    <Radio className="w-4 h-4 text-sky-400 shrink-0" />
                    <span>Menunggu persetujuan pengirim. Sisa waktu: {Math.floor(approvalCountdown / 60)}:{(approvalCountdown % 60).toString().padStart(2, '0')}</span>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                <div className="p-4 rounded-xl bg-emerald-950/30 border border-emerald-500/40 text-emerald-300 text-xs flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full bg-emerald-400 animate-pulse" />
                    <span className="font-semibold">Terhubung ke Pengirim via WebRTC ({routeType})</span>
                  </div>
                  <span className="font-mono text-[11px] bg-emerald-900/50 px-2 py-0.5 rounded">
                    DataChannel Siap
                  </span>
                </div>

                {/* Receiver can also send files bidirectionally */}
                <div
                  onClick={() => fileInputRef.current?.click()}
                  className="border border-dashed border-slate-700 hover:border-emerald-400 rounded-xl p-5 text-center cursor-pointer bg-slate-950/30 flex items-center justify-center gap-2 text-xs text-slate-300"
                >
                  <Send className="w-4 h-4 text-emerald-400" />
                  <span>Kirim berkas balik ke host? Klik di sini</span>
                  <input
                    ref={fileInputRef}
                    type="file"
                    onClick={(event) => event.stopPropagation()}
                    multiple
                    onChange={(e) => handleSendFiles(e.target.files)}
                    className="sr-only"
                  />
                </div>
              </div>
            )}
          </section>
        )}

        {/* Incoming File Prompt Modal */}
        {incomingOffer && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4">
            <div className="max-w-md w-full bg-slate-900 border border-emerald-500/40 rounded-2xl p-6 flex flex-col gap-4 shadow-2xl animate-in zoom-in-95">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  <File className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="font-bold text-white text-base">Menerima Tawaran Berkas</h3>
                  <p className="text-xs text-slate-400">Pengirim ingin mentransfer berkas berikut:</p>
                </div>
              </div>

              <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 flex flex-col gap-1">
                <span className="font-semibold text-sm text-emerald-300 truncate">{incomingOffer.name}</span>
                <span className="text-xs font-mono text-slate-400">{formatBytes(incomingOffer.size)}</span>
              </div>

              <div className="flex items-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    incomingOffer.resolver({ accept: true });
                    setIncomingOffer(null);
                  }}
                  className="min-h-[44px] flex-1 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs tracking-wide transition shadow-lg"
                >
                  Terima Berkas
                </button>
                <button
                  type="button"
                  onClick={() => {
                    incomingOffer.resolver({ accept: false });
                    setIncomingOffer(null);
                  }}
                  className="min-h-[44px] px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold text-xs transition border border-slate-700"
                >
                  Tolak
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Transfer Queue & Progress Cards */}
        {transfers.length > 0 && (
          <section className="rounded-2xl border border-slate-800/90 bg-slate-900/90 p-5 flex flex-col gap-4 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-mono uppercase tracking-wider text-slate-400 font-bold">
                Antrean & Riwayat Transfer Berkas
              </h3>
              <span className="text-xs font-mono text-slate-400">{transfers.length} berkas</span>
            </div>

            <div className="flex flex-col gap-3">
              {transfers.map((item) => (
                <div
                  key={item.transferId}
                  className="p-4 rounded-xl bg-slate-950/70 border border-slate-800/80 flex flex-col gap-2.5 transition"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2.5 truncate">
                      {item.state === 'COMPLETED' ? (
                        <FileCheck2 className="w-5 h-5 text-emerald-400 shrink-0" />
                      ) : (
                        <File className="w-5 h-5 text-sky-400 shrink-0" />
                      )}
                      <div className="truncate">
                        <p className="text-sm font-semibold text-white truncate">{item.fileName}</p>
                        <p className="text-xs font-mono text-slate-400 mt-0.5">
                          {formatBytes(item.processedBytes)} / {formatBytes(item.totalBytes)}
                          {item.speedBytesPerSec > 0 && ` • ${formatBytes(item.speedBytesPerSec)}/s`}
                          {item.etaSeconds !== null && ` • ETA: ${item.etaSeconds}s`}
                        </p>
                      </div>
                    </div>

                    <span
                      className={`text-[11px] font-mono font-bold px-2.5 py-1 rounded-md shrink-0 border ${
                        item.state === 'COMPLETED'
                          ? 'bg-emerald-950/80 text-emerald-300 border-emerald-500/30'
                          : item.state === 'FAILED'
                          ? 'bg-rose-950/80 text-rose-300 border-rose-500/30'
                          : 'bg-sky-950/80 text-sky-300 border-sky-500/30'
                      }`}
                    >
                      {item.state}
                    </span>
                  </div>

                  {/* Progress Bar */}
                  <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden">
                    <div
                      className={`h-full transition-all duration-300 rounded-full ${
                        item.state === 'COMPLETED' ? 'bg-emerald-400' : 'bg-sky-400'
                      }`}
                      style={{ width: `${Math.round(item.percentage)}%` }}
                    />
                  </div>

                  {/* Integrity Verified Badge */}
                  {item.state === 'COMPLETED' && item.sha256 && (
                    <div className="flex items-center justify-between text-[11px] text-emerald-400/90 pt-1 border-t border-slate-900">
                      <span className="flex items-center gap-1.5">
                        <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                        <span>SHA-256 Integritas Valid</span>
                      </span>
                      <span className="font-mono text-[10px] text-slate-500 truncate max-w-[200px]">
                        {item.sha256}
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* MODE: PRIVACY & ARCHITECTURE */}
        {mode === 'privacy' && (
          <section className="rounded-2xl border border-slate-800/90 bg-slate-900/90 p-6 flex flex-col gap-5 text-sm text-slate-300 leading-relaxed shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h2 className="text-xl font-bold text-white flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-emerald-400" />
                <span>Privasi & Transfer Antar-Browser</span>
              </h2>
              <button
                type="button"
                onClick={() => setMode('home')}
                className="p-1 rounded-lg text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex flex-col gap-4">
              <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 flex flex-col gap-1.5">
                <h4 className="font-bold text-white text-xs uppercase font-mono text-emerald-400">
                  1. Berkas Tidak Disimpan di Server
                </h4>
                <p className="text-xs text-slate-400">
                  Isi berkas ditransfer langsung antar browser melalui WebRTC <code>RTCDataChannel</code>. Server hanya menyimpan metadata sesi dan koneksi sementara yang dihapus otomatis sesuai masa berlakunya.
                </p>
              </div>

              <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 flex flex-col gap-1.5">
                <h4 className="font-bold text-white text-xs uppercase font-mono text-sky-400">
                  2. Enkripsi Ujung-ke-Ujung (DTLS)
                </h4>
                <p className="text-xs text-slate-400">
                  Seluruh paket data dienkripsi secara otomatis menggunakan protokol standar WebRTC DTLS (Datagram Transport Layer Security). Tidak ada pihak ketiga di jaringan yang dapat melihat isi berkas.
                </p>
              </div>

              <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 flex flex-col gap-1.5">
                <h4 className="font-bold text-white text-xs uppercase font-mono text-amber-400">
                  3. Verifikasi Integritas SHA-256
                </h4>
                <p className="text-xs text-slate-400">
                  Setiap berkas dihitung digest SHA-256 secara streaming saat dikirim dan saat diterima. Sistem memastikan berkas tidak rusak atau terpotong sebelum disimpan.
                </p>
              </div>

              <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 flex flex-col gap-1.5">
                <h4 className="font-bold text-white text-xs uppercase font-mono text-purple-400">
                  4. Kode Ruangan Sekali Pakai (TTL 5 Menit)
                </h4>
                <p className="text-xs text-slate-400">
                  Kode 6 digit dibuat menggunakan generator angka acak kriptografis (CSPRNG) dan otomatis kedaluwarsa setelah 5 menit atau setelah ruangan dipasangkan.
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setMode('home')}
              className="min-h-[44px] mt-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold self-start px-6 transition"
            >
              Kembali ke Beranda
            </button>
          </section>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-900 py-4 px-4 text-center text-xs text-slate-500">
        <div className="max-w-4xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2">
          <span>NexaShare — P2P File Transfer (Vercel Serverless Edition)</span>
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            <span>P2P • WebRTC DataChannel • DTLS Encrypted</span>
          </span>
        </div>
      </footer>
    </div>
  );
}
