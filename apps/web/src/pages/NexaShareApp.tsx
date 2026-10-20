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
  Radio,
  Lock,
  ArrowRight,
  Camera,
  MessageSquare,
  FileText,
  Clipboard,
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
import { QRScannerModal } from '../components/QRScannerModal';
import { TextShareWorkspace, type SharedClip } from '../components/TextShareWorkspace';

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
  const [showScanner, setShowScanner] = useState<boolean>(false);
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

  // Text Sharing State
  const [activeTab, setActiveTab] = useState<'files' | 'text'>('files');
  const [sharedClips, setSharedClips] = useState<SharedClip[]>([]);
  const [unreadTextCount, setUnreadTextCount] = useState<number>(0);
  const [textToast, setTextToast] = useState<SharedClip | null>(null);
  const [copiedToastClipId, setCopiedToastClipId] = useState<string | null>(null);

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
        onIncomingText: (message) => {
          const newClip: SharedClip = {
            id: message.transferId,
            text: message.text,
            sender: 'peer',
            senderLabel: message.senderLabel || peerDeviceLabel || 'Perangkat Lawan',
            timestamp: message.timestamp || Date.now(),
          };
          setSharedClips((prev) => [newClip, ...prev]);
          setTextToast(newClip);
          setUnreadTextCount((count) => count + 1);
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
      const dynamicInvite = typeof window !== 'undefined' && window.location?.origin
        ? `${window.location.origin}/room/${room.code}`
        : room.inviteUrl;
      setInviteUrl(dynamicInvite);
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
  const handleJoinRoom = async (codeToJoin?: string) => {
    const targetCode = (typeof codeToJoin === 'string' ? codeToJoin : inputCode).trim();
    if (!targetCode) return;
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

      const joinRes = await api.requestJoin(session.token, targetCode, deviceLabel);
      setRoomId(joinRes.roomId);
      serverClockOffsetRef.current = joinRes.serverTime - Date.now();
      setPendingExpiresAt(joinRes.expiresAt);

      startSignalPolling(session.token, joinRes.roomId, 'GUEST');
    } catch (err: any) {
      setErrorMessage(err.message || 'Gagal bergabung dengan ruangan.');
      setScreenState('incorrect_code');
    }
  };

  const handleScanSuccess = (scannedCode: string) => {
    setInputCode(scannedCode);
    setShowScanner(false);
    handleJoinRoom(scannedCode);
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
    const link = (typeof window !== 'undefined' && window.location?.origin && roomCode)
      ? `${window.location.origin}/room/${roomCode}`
      : inviteUrl;
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
    setSharedClips([]);
    setUnreadTextCount(0);
    setTextToast(null);
    setActiveTab('files');
    setPendingGuestRequest(null);
    setIncomingOffer(null);
    setScreenState('idle');
    setMode('home');
    setErrorMessage(null);
  };

  // Send Text Handler
  const handleSendText = (text: string) => {
    if (!text.trim() || !engineRef.current) return;
    try {
      const msg = engineRef.current.sendText(text, deviceLabel);
      const myClip: SharedClip = {
        id: msg.transferId,
        text: msg.text,
        sender: 'self',
        senderLabel: deviceLabel,
        timestamp: msg.timestamp,
      };
      setSharedClips((prev) => [myClip, ...prev]);
    } catch (err: any) {
      console.error('Gagal mengirim teks:', err);
      setErrorMessage(err.message || 'Gagal mengirim teks.');
    }
  };

  const handleSwitchTab = (tab: 'files' | 'text') => {
    setActiveTab(tab);
    if (tab === 'text') {
      setUnreadTextCount(0);
    }
  };

  const statusLabels: Record<string, string> = {
    idle: 'Siap menghubungkan', creating: 'Membuat ruang', waiting_for_peer: 'Menunggu perangkat',
    join_pending: 'Menunggu izin', connected: 'Terhubung', negotiating: 'Menghubungkan', ready: 'Siap mengirim',
    transferring: 'Mengirim berkas', verifying: 'Memeriksa berkas', completed: 'Selesai', expired: 'Kode kedaluwarsa',
    room_full: 'Ruang sudah terisi', rejected: 'Ditolak', incorrect_code: 'Kode tidak ditemukan',
    rate_limited: 'Coba lagi sebentar', signaling_lost: 'Koneksi terganggu', ice_failed: 'Gagal terhubung',
    peer_disconnected: 'Perangkat terputus', transfer_failed: 'Transfer gagal', cancelled: 'Dibatalkan',
  };
  const transferLabels: Record<string, string> = {
    QUEUED: 'Dalam antrean', OFFERED: 'Menunggu penerima', ACCEPTED: 'Diterima', SENDING: 'Mengirim',
    RECEIVING: 'Menerima', VERIFYING: 'Memeriksa', COMPLETED: 'Selesai', REJECTED: 'Ditolak',
    CANCELLED: 'Dibatalkan', FAILED: 'Gagal', INTERRUPTED: 'Terputus',
  };
  return (
    <div className="app-shell">
      {/* Header */}
      <header className="site-header">
        <div className="header-inner">
          <button
            type="button"
            onClick={handleResetSession}
            className="min-h-[44px] px-2 flex items-center gap-2.5 font-extrabold text-xl tracking-tight text-white focus:outline-none focus:ring-2 focus:ring-emerald-400 rounded-lg"
          >
            <span className="brand-symbol" aria-hidden="true"><i /><i /></span>
            <span>NexaShare</span>
          </button>

          <nav className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setMode('privacy')}
              className="min-h-[44px] px-3.5 text-xs sm:text-sm font-medium text-slate-400 hover:text-white transition rounded-lg hover:bg-slate-900 flex items-center gap-1.5"
            >
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <span>Privasi</span>
            </button>
          </nav>
        </div>
      </header>

      {/* Main Content */}
      <main className="main-content">
        <div aria-live="polite" className="sr-only">
          Status sesi: {statusLabels[screenState]}
        </div>

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
              aria-label="Tutup pesan kesalahan" onClick={() => setErrorMessage(null)}
              className="p-1 hover:bg-rose-900/50 rounded-lg text-rose-400"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {mode === 'home' && (
          <section className="home-layout" aria-labelledby="home-title">
            <div className="hero-copy">
              <p className="eyebrow"><span /> DARI PERANGKAT KE PERANGKAT</p>
              <h1 id="home-title">Kirim berkas ke<br /><em>perangkat lain.</em></h1>
              <p className="hero-description">Kirim foto, video, atau dokumen ke perangkat lain. Buka browser, bagikan kode, lalu mulai transfer.</p>
              <div className="hero-note"><Lock size={15} strokeWidth={1.5} /><span>Terenkripsi. Berkas tidak disimpan di server.</span></div>
            </div>
            <div className="transfer-workspace">
              <div className="glass-panel start-panel">
                <div className="panel-caption"><span>RUANG TRANSFER</span><i /></div>
                <div className="device-illustration" aria-hidden="true">
                  <div className="device-sheet sheet-back"><File size={25} strokeWidth={1.2} /><i /><i /></div>
                  <div className="device-sheet sheet-front"><Send size={28} strokeWidth={1.2} /><span>nexa.</span></div>
                  <span className="illustration-orbit" />
                </div>
                <div className="start-heading"><h2>Mau berbagi apa hari ini?</h2><p>Hubungkan dua perangkat untuk memulai.</p></div>
                <button type="button" className="button button-primary start-send" onClick={handleCreateRoom}><Send size={18} />Kirim berkas<ArrowRight size={18} className="push-right" /></button>
                <button type="button" className="receive-action" onClick={() => setMode('receive')}><span className="receive-icon"><Download size={19} /></span><span><strong>Terima berkas</strong><small>Sudah punya kode? Gabung di sini.</small></span><ArrowRight size={18} className="push-right" /></button>
                <div className="panel-footnote"><Lock size={12} /> Tanpa akun. Cukup satu kode.</div>
              </div>
              <span className="workspace-caption">Biarkan kedua browser terbuka selama transfer.</span>
            </div>
          </section>
        )}
        {mode !== 'home' && <button type="button" className="back-button" onClick={handleResetSession}><ArrowRight size={15} className="rotate-180" /> Kembali ke beranda</button>}

        {/* MODE: SEND (Host) */}
        {mode === 'send' && (
          <section className="glass-panel session-panel flex flex-col gap-6">
            {/* Header Status */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-5">
              <div>
                <p className="text-xs font-mono uppercase text-slate-400">Kode ruangan</p>
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
                  <span>{isReconnecting ? 'Menyambungkan kembali' : statusLabels[screenState]}</span>
                </span>
                {routeType !== 'UNKNOWN' && (
                  <span className="px-2.5 py-1 rounded-full text-[10px] font-mono bg-emerald-950 text-emerald-300 border border-emerald-500/30">
                    {routeType === 'RELAY' ? 'Melalui relay' : 'Koneksi langsung'}
                  </span>
                )}
              </div>
            </div>

            {/* Waiting for peer / QR Display */}
            {screenState === 'waiting_for_peer' && (
              <div className="flex flex-col sm:flex-row items-center gap-6 p-4 rounded-xl bg-slate-950/60 border border-slate-800/80">
                <div className="shrink-0">
                  <QRCodeDisplay value={(typeof window !== 'undefined' && window.location?.origin && roomCode) ? `${window.location.origin}/room/${roomCode}` : (inviteUrl || `${window.location.origin}/room/${roomCode}`)} size={160} />
                </div>
                <div className="flex flex-col gap-3 flex-1 text-center sm:text-left">
                  <h3 className="font-bold text-white text-base">Hubungkan perangkat lain</h3>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Pindai kode QR ini atau bagikan tautan ke perangkat penerima.
                  </p>
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={handleCopyLink}
                      className="min-h-[44px] px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center justify-center gap-2 transition flex-1 sm:flex-none border border-slate-700"
                    >
                      {copiedLink ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                      <span>{copiedLink ? 'Tautan tersalin' : 'Salin tautan'}</span>
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
                    <h4 className="font-bold text-white text-sm">Izinkan perangkat ini?</h4>
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
                    Izinkan
                  </button>
                  <button
                    type="button"
                    onClick={handleRejectGuest}
                    className="min-h-[44px] px-4 rounded-xl bg-slate-800 hover:bg-rose-950 hover:text-rose-300 text-slate-300 font-semibold text-xs transition border border-slate-700 flex-1 sm:flex-none"
                  >
                    Tolak
                  </button>
                </div>
              </div>
            )}

            {/* File & Text Share Workspace (Active when Ready) */}
            {screenState === 'ready' && (
              <div className="flex flex-col gap-4">
                {/* Tabs Switcher: Berkas vs Teks */}
                <div className="flex items-center gap-2 p-1 rounded-xl bg-slate-950/80 border border-slate-800">
                  <button
                    type="button"
                    onClick={() => handleSwitchTab('files')}
                    className={`flex-1 min-h-[40px] flex items-center justify-center gap-2 rounded-lg text-xs font-semibold transition ${
                      activeTab === 'files'
                        ? 'bg-emerald-500 text-slate-950 shadow-md font-bold'
                        : 'text-slate-400 hover:text-white hover:bg-slate-800/50'
                    }`}
                  >
                    <FileText className="w-4 h-4" />
                    <span>Transfer Berkas</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSwitchTab('text')}
                    className={`flex-1 min-h-[40px] flex items-center justify-center gap-2 rounded-lg text-xs font-semibold transition relative ${
                      activeTab === 'text'
                        ? 'bg-emerald-500 text-slate-950 shadow-md font-bold'
                        : 'text-slate-400 hover:text-white hover:bg-slate-800/50'
                    }`}
                  >
                    <MessageSquare className="w-4 h-4" />
                    <span>Teks & Clipboard</span>
                    {unreadTextCount > 0 && activeTab !== 'text' && (
                      <span className="px-1.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-emerald-400 text-slate-950 animate-pulse">
                        {unreadTextCount}
                      </span>
                    )}
                  </button>
                </div>

                {activeTab === 'files' ? (
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
                    role="button" tabIndex={0} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); fileInputRef.current?.click(); } }} onClick={() => fileInputRef.current?.click()}
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
                        Pilih berkas atau seret ke sini
                      </p>
                      <p className="text-xs text-slate-400 mt-1">
                        Kamu bisa memilih beberapa foto, video, atau dokumen sekaligus.
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
                ) : (
                  <TextShareWorkspace
                    sharedClips={sharedClips}
                    onSendText={handleSendText}
                    onClearClips={() => setSharedClips([])}
                    peerDeviceLabel={peerDeviceLabel}
                  />
                )}
              </div>
            )}
          </section>
        )}

        {/* MODE: RECEIVE (Guest) */}
        {mode === 'receive' && (
          <section className="glass-panel session-panel flex flex-col gap-6">
            <div className="flex items-center justify-between border-b border-slate-800 pb-4">
              <div>
                <h2 className="text-xl font-bold text-white">Masuk dengan kode.</h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Masukkan 6 digit kode yang diberikan oleh perangkat pengirim.
                </p>
              </div>
              <span className="px-3 py-1 rounded-full text-xs font-mono bg-slate-800 text-slate-300 border border-slate-700">
                {statusLabels[screenState]}
              </span>
            </div>

            {screenState !== 'ready' && screenState !== 'transferring' ? (
              <div className="flex flex-col gap-4">
                <div>
                  <label htmlFor="device-label" className="block text-xs font-mono uppercase text-slate-400 mb-1.5">
                    Nama perangkatmu
                  </label>
                  <input
                    id="device-label" type="text"
                    value={deviceLabel}
                    onChange={(e) => setDeviceLabel(e.target.value)}
                    className="min-h-[44px] w-full rounded-xl border border-slate-700 bg-slate-950 px-4 text-sm text-white focus:outline-none focus:border-sky-400"
                    placeholder="Contoh: Laptop Kantor"
                  />
                </div>

                <div>
                  <label htmlFor="join-code" className="block text-xs font-mono uppercase text-slate-400 mb-1.5">
                    Kode ruangan
                  </label>
                  <div className="join-controls">
                    <input
                      id="join-code" type="text"
                      inputMode="numeric"
                      placeholder="000-000"
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
                      onClick={() => setShowScanner(true)}
                      className="min-h-[48px] px-4 rounded-xl border border-emerald-500/40 bg-emerald-950/40 hover:bg-emerald-900/60 text-emerald-300 font-bold text-xs tracking-wide transition shadow-lg flex items-center justify-center gap-2 hover:border-emerald-400 shrink-0"
                      title="Buka scanner kamera untuk scan QR pengirim"
                    >
                      <Camera className="w-4 h-4 text-emerald-400" />
                      <span>Pindai QR</span>
                    </button>
                    <button
                      type="button"
                      disabled={screenState === 'join_pending' || !inputCode.trim()}
                      onClick={() => handleJoinRoom()}
                      className="min-h-[48px] px-7 rounded-xl bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 font-bold text-sm tracking-wide transition shadow-lg flex items-center justify-center gap-2 shrink-0"
                    >
                      {screenState === 'join_pending' && <RefreshCw className="w-4 h-4 animate-spin" />}
                      <span>{screenState === 'join_pending' ? 'Menunggu Izin...' : 'Hubungkan'}</span>
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

                {/* Tabs Switcher: Berkas vs Teks */}
                <div className="flex items-center gap-2 p-1 rounded-xl bg-slate-950/80 border border-slate-800">
                  <button
                    type="button"
                    onClick={() => handleSwitchTab('files')}
                    className={`flex-1 min-h-[40px] flex items-center justify-center gap-2 rounded-lg text-xs font-semibold transition ${
                      activeTab === 'files'
                        ? 'bg-emerald-500 text-slate-950 shadow-md font-bold'
                        : 'text-slate-400 hover:text-white hover:bg-slate-800/50'
                    }`}
                  >
                    <FileText className="w-4 h-4" />
                    <span>Transfer Berkas</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSwitchTab('text')}
                    className={`flex-1 min-h-[40px] flex items-center justify-center gap-2 rounded-lg text-xs font-semibold transition relative ${
                      activeTab === 'text'
                        ? 'bg-emerald-500 text-slate-950 shadow-md font-bold'
                        : 'text-slate-400 hover:text-white hover:bg-slate-800/50'
                    }`}
                  >
                    <MessageSquare className="w-4 h-4" />
                    <span>Teks & Clipboard</span>
                    {unreadTextCount > 0 && activeTab !== 'text' && (
                      <span className="px-1.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-emerald-400 text-slate-950 animate-pulse">
                        {unreadTextCount}
                      </span>
                    )}
                  </button>
                </div>

                {activeTab === 'files' ? (
                  /* Receiver can also send files bidirectionally */
                  <div
                    role="button" tabIndex={0} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); fileInputRef.current?.click(); } }} onClick={() => fileInputRef.current?.click()}
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
                ) : (
                  <TextShareWorkspace
                    sharedClips={sharedClips}
                    onSendText={handleSendText}
                    onClearClips={() => setSharedClips([])}
                    peerDeviceLabel={peerDeviceLabel}
                  />
                )}
              </div>
            )}
          </section>
        )}

        {/* Incoming File Prompt Modal */}
        {incomingOffer && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4">
            <div role="dialog" aria-modal="true" aria-label="Terima berkas" className="max-w-md w-full glass-panel incoming-modal p-6 flex flex-col gap-4 shadow-2xl animate-in zoom-in-95">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  <File className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="font-bold text-white text-base">Ada berkas untukmu.</h3>
                  <p className="text-xs text-slate-400">Terima berkas dari perangkat yang terhubung?</p>
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
          <section className="glass-panel session-panel flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-mono uppercase tracking-wider text-slate-400 font-bold">
                Transfer berkas
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
                      className={`transfer-state text-[11px] font-mono font-bold px-2.5 py-1 rounded-md shrink-0 border ${
                        item.state === 'COMPLETED'
                          ? 'bg-emerald-950/80 text-emerald-300 border-emerald-500/30'
                          : item.state === 'FAILED'
                          ? 'bg-rose-950/80 text-rose-300 border-rose-500/30'
                          : 'bg-sky-950/80 text-sky-300 border-sky-500/30'
                      }`}
                    >
                      {transferLabels[item.state] || item.state}
                    </span>
                  </div>

                  {/* Progress Bar */}
                  <div role="progressbar" aria-label={`Transfer ${item.fileName}`} aria-valuenow={Math.round(item.percentage)} aria-valuemin={0} aria-valuemax={100} className="w-full bg-slate-800 rounded-full h-1 overflow-hidden">
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
                        <span>Integritas berkas terverifikasi</span>
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
          <section className="glass-panel session-panel privacy-panel flex flex-col gap-5 text-sm leading-relaxed">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h2 className="text-xl font-bold text-white flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-emerald-400" />
                <span>Privasi berkasmu</span>
              </h2>
              <button
                type="button"
                aria-label="Tutup informasi privasi" onClick={() => setMode('home')}
                className="p-1 rounded-lg text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex flex-col gap-4">
              <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 flex flex-col gap-1.5">
                <h4 className="font-bold text-white text-xs uppercase font-mono text-emerald-400">
                  1. Berkas tanpa penyimpanan cloud
                </h4>
                <p className="text-xs text-slate-400">
                  Kedua browser bertukar berkas melalui koneksi WebRTC. Server menyimpan metadata koneksi sementara untuk mempertemukan perangkat. Relay, jika diperlukan, meneruskan data terenkripsi.
                </p>
              </div>

              <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 flex flex-col gap-1.5">
                <h4 className="font-bold text-white text-xs uppercase font-mono text-sky-400">
                  2. Koneksi terenkripsi
                </h4>
                <p className="text-xs text-slate-400">
                  WebRTC mengenkripsi berkas selama perjalanan dengan DTLS, termasuk ketika koneksi menggunakan relay.
                </p>
              </div>

              <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 flex flex-col gap-1.5">
                <h4 className="font-bold text-white text-xs uppercase font-mono text-amber-400">
                  3. Pemeriksaan isi berkas
                </h4>
                <p className="text-xs text-slate-400">
                  NexaShare membandingkan SHA-256 pada kedua perangkat untuk memeriksa apakah penerima mendapatkan berkas secara utuh.
                </p>
              </div>

              <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 flex flex-col gap-1.5">
                <h4 className="font-bold text-white text-xs uppercase font-mono text-purple-400">
                  4. Kamu menentukan siapa yang bergabung
                </h4>
                <p className="text-xs text-slate-400">
                  Kode ruangan berlaku selama lima menit untuk menghubungkan perangkat. Pengirim harus menyetujui permintaan bergabung sebelum transfer dimulai.
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
      <footer className="site-footer">
        <div className="footer-inner">
          <span>Berbagi, sesederhana itu.</span>
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            <span>Transfer terenkripsi antar-browser</span>
          </span>
        </div>
      </footer>

      {/* Floating Toast for Incoming Text */}
      {textToast && (
        <aside aria-label="Notifikasi teks baru" className="fixed bottom-6 right-6 z-50 max-w-sm w-full p-2">
          <div className="p-4 rounded-2xl bg-slate-900 border border-emerald-500/40 shadow-2xl flex flex-col gap-2.5 backdrop-blur-md">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-emerald-400 flex items-center gap-1.5">
                <MessageSquare className="w-3.5 h-3.5" />
                <span>Teks baru dari {textToast.senderLabel || 'Perangkat Lawan'}</span>
              </span>
              <button
                type="button"
                aria-label="Tutup notifikasi"
                onClick={() => setTextToast(null)}
                className="text-slate-400 hover:text-white p-1 rounded transition"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <p className="text-xs text-slate-300 line-clamp-2 font-mono bg-slate-950/70 p-2.5 rounded-lg border border-slate-800 break-words">
              {textToast.text}
            </p>
            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(textToast.text).then(() => {
                    setCopiedToastClipId(textToast.id);
                    setTimeout(() => {
                      setCopiedToastClipId(null);
                      setTextToast(null);
                    }, 1500);
                  });
                }}
                className="flex-1 min-h-[38px] px-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center justify-center gap-1.5 transition shadow"
              >
                {copiedToastClipId === textToast.id ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-slate-950" />
                    <span>Tersalin!</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5 text-slate-950" />
                    <span>Salin Cepat</span>
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={() => {
                  handleSwitchTab('text');
                  setTextToast(null);
                }}
                className="px-3 min-h-[38px] rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700 transition"
              >
                Buka Tab
              </button>
            </div>
          </div>
        </aside>
      )}

      {/* In-App QR Camera Scanner Modal */}
      <QRScannerModal
        isOpen={showScanner}
        onClose={() => setShowScanner(false)}
        onScanSuccess={handleScanSuccess}
      />
    </div>
  );
}
