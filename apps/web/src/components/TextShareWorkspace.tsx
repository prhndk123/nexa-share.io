import React, { useState } from 'react';
import {
  MessageSquare,
  Send,
  Copy,
  Check,
  Clipboard,
  ClipboardPaste,
  ExternalLink,
  Trash2,
} from 'lucide-react';

export interface SharedClip {
  id: string;
  text: string;
  sender: 'self' | 'peer';
  senderLabel?: string;
  timestamp: number;
}

export interface TextShareWorkspaceProps {
  sharedClips: SharedClip[];
  onSendText: (text: string) => void;
  onClearClips: () => void;
  peerDeviceLabel?: string | null;
}

function isUrl(str: string): boolean {
  try {
    const url = new URL(str.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function TextShareWorkspace({
  sharedClips,
  onSendText,
  onClearClips,
  peerDeviceLabel,
}: TextShareWorkspaceProps) {
  const [textInput, setTextInput] = useState('');
  const [copiedClipId, setCopiedClipId] = useState<string | null>(null);

  const handleSend = () => {
    const trimmed = textInput.trim();
    if (!trimmed) return;
    onSendText(textInput);
    setTextInput('');
  };

  const handlePasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setTextInput((prev) => (prev ? `${prev}\n${text}` : text));
      }
    } catch (err) {
      console.warn('Gagal membaca clipboard:', err);
    }
  };

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedClipId(id);
      setTimeout(() => {
        setCopiedClipId((cur) => (cur === id ? null : cur));
      }, 2000);
    });
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Input Composer */}
      <div className="p-4 rounded-2xl bg-slate-950/70 border border-slate-800/80 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <label
            htmlFor="text-share-input"
            className="text-xs font-semibold text-slate-300 flex items-center gap-2"
          >
            <MessageSquare className="w-3.5 h-3.5 text-emerald-400" />
            <span>Kirim Teks Langsung / Clipboard</span>
          </label>
          <span className="text-[11px] font-mono text-slate-500">
            {textInput.length.toLocaleString()} karakter
          </span>
        </div>

        <textarea
          id="text-share-input"
          rows={3}
          value={textInput}
          onChange={(e) => setTextInput(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="Ketik teks, paste link URL, snippet kode, atau catatan di sini... (Ctrl+Enter untuk kirim)"
          className="w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-400 resize-none font-sans"
        />

        <div className="flex items-center justify-between gap-2 pt-1 flex-wrap">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handlePasteClipboard}
              className="min-h-[40px] px-3.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium flex items-center gap-2 border border-slate-700 transition"
              title="Tempel teks dari clipboard perangkat"
            >
              <ClipboardPaste className="w-4 h-4 text-emerald-400" />
              <span>Tempel Clipboard</span>
            </button>
            {textInput && (
              <button
                type="button"
                onClick={() => setTextInput('')}
                className="min-h-[40px] px-2.5 rounded-xl hover:bg-slate-800 text-slate-400 hover:text-slate-200 text-xs transition"
                title="Hapus teks yang belum dikirim"
              >
                Hapus
              </button>
            )}
          </div>

          <button
            type="button"
            disabled={!textInput.trim()}
            onClick={handleSend}
            className="min-h-[40px] px-5 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 font-bold text-xs tracking-wide transition shadow-lg flex items-center gap-2"
          >
            <Send className="w-4 h-4" />
            <span>Kirim Teks</span>
          </button>
        </div>
      </div>

      {/* Shared Clips History */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between pt-1">
          <h3 className="text-xs font-mono uppercase tracking-wider text-slate-400 font-bold flex items-center gap-2">
            <Clipboard className="w-3.5 h-3.5 text-emerald-400" />
            <span>Riwayat Teks & Clipboard ({sharedClips.length})</span>
          </h3>
          {sharedClips.length > 0 && (
            <button
              type="button"
              onClick={onClearClips}
              className="text-[11px] text-slate-500 hover:text-rose-400 flex items-center gap-1 transition"
            >
              <Trash2 className="w-3 h-3" />
              <span>Bersihkan</span>
            </button>
          )}
        </div>

        {sharedClips.length === 0 ? (
          <div className="p-6 rounded-2xl border border-dashed border-slate-800 text-center flex flex-col items-center justify-center gap-2 bg-slate-950/20 min-h-[140px]">
            <MessageSquare className="w-6 h-6 text-slate-600" />
            <p className="text-xs text-slate-300 font-medium">Belum ada teks yang dibagikan.</p>
            <p className="text-[11px] text-slate-500 max-w-sm leading-relaxed">
              Ketik teks atau klik <strong>Tempel Clipboard</strong> di atas untuk langsung mengirim ke perangkat yang terhubung.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5 max-h-[460px] overflow-y-auto pr-0.5">
            {sharedClips.map((clip) => {
              const urlDetected = isUrl(clip.text);
              return (
                <div
                  key={clip.id}
                  className={`p-3.5 rounded-xl border transition flex flex-col gap-2.5 ${
                    clip.sender === 'self'
                      ? 'bg-slate-950/60 border-slate-800/80'
                      : 'bg-emerald-950/15 border-emerald-500/25'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 truncate">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-mono font-semibold truncate ${
                          clip.sender === 'self'
                            ? 'bg-slate-800 text-slate-300'
                            : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                        }`}
                      >
                        {clip.sender === 'self' ? 'Saya' : (clip.senderLabel || peerDeviceLabel || 'Perangkat Lawan')}
                      </span>
                      <span className="text-[10px] font-mono text-slate-500 shrink-0">
                        {new Date(clip.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      {urlDetected && (
                        <a
                          href={clip.text.trim()}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="min-h-[30px] px-2.5 rounded-lg bg-sky-950/60 hover:bg-sky-900/60 text-sky-300 text-[11px] font-medium border border-sky-500/30 flex items-center gap-1.5 transition"
                          title="Buka link di tab baru"
                        >
                          <ExternalLink className="w-3 h-3" />
                          <span>Buka Tautan</span>
                        </a>
                      )}
                      <button
                        type="button"
                        onClick={() => handleCopy(clip.id, clip.text)}
                        className={`min-h-[30px] px-2.5 rounded-lg text-[11px] font-semibold flex items-center gap-1.5 transition ${
                          copiedClipId === clip.id
                            ? 'bg-emerald-500 text-slate-950 font-bold'
                            : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700'
                        }`}
                        title="Salin teks ke clipboard"
                      >
                        {copiedClipId === clip.id ? (
                          <>
                            <Check className="w-3 h-3 text-slate-950" />
                            <span>Tersalin!</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3 h-3" />
                            <span>Salin</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>

                  <div className="p-3 rounded-lg bg-slate-950 border border-slate-900 text-xs text-slate-200 whitespace-pre-wrap break-words font-mono select-all leading-relaxed max-h-[220px] overflow-y-auto">
                    {clip.text}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
