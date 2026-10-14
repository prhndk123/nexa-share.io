import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';

interface QRCodeDisplayProps {
  value: string;
  size?: number;
}

export function QRCodeDisplay({ value, size = 180 }: QRCodeDisplayProps) {
  const [dataUrl, setDataUrl] = useState<string>('');

  useEffect(() => {
    if (!value) return;
    QRCode.toDataURL(value, {
      width: size,
      margin: 1.5,
      color: {
        dark: '#10b981', // Emerald 500
        light: '#020617', // Slate 950
      },
    })
      .then(setDataUrl)
      .catch((err) => console.error('Gagal membuat QR code:', err));
  }, [value, size]);

  if (!dataUrl) {
    return (
      <div
        style={{ width: size, height: size }}
        className="flex items-center justify-center rounded-xl bg-slate-900 border border-slate-800 text-xs text-slate-500 animate-pulse"
      >
        Membuat QR...
      </div>
    );
  }

  return (
    <div className="p-2.5 rounded-2xl bg-slate-900 border border-slate-800 shadow-xl inline-block">
      <img
        src={dataUrl}
        alt={`QR Code untuk ${value}`}
        width={size}
        height={size}
        className="rounded-xl block"
      />
    </div>
  );
}
