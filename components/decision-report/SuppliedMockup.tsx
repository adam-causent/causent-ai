"use client";

import { useRef } from "react";
import type { ReportAssetView } from "@/lib/decision-reports/assets";

export function SuppliedMockup({ asset, readOnly, disabled, pending, error, onUpload, onRemove }: {
  asset: ReportAssetView | null;
  readOnly: boolean;
  disabled: boolean;
  pending: boolean;
  error: string | null;
  onUpload: (file: File) => void;
  onRemove: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/50 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-600">Supplied mock-up · optional</p>
        {asset ? <span className="text-[10px] font-medium text-teal-700">Sanitized · private</span> : null}
      </div>
      {asset ? (
        <div className="mt-3 overflow-hidden rounded-lg border border-slate-200 bg-white">
          {/* This URL is an authenticated route; the private Storage path never reaches the client. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={asset.previewUrl} alt="User-supplied product mock-up" className="max-h-72 w-full object-contain" />
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 px-3 py-2 text-[11px] text-[var(--text-muted)]">
            <span>{asset.width}×{asset.height} · {Math.ceil(asset.byteSize / 1024).toLocaleString()} KB</span>
            {!readOnly ? <div className="flex gap-2">
              <button type="button" disabled={disabled || pending} onClick={() => inputRef.current?.click()} className="font-semibold text-blue-700 disabled:opacity-45">Replace</button>
              <button type="button" disabled={disabled || pending} onClick={onRemove} className="font-semibold text-red-700 disabled:opacity-45">Remove</button>
            </div> : null}
          </div>
        </div>
      ) : (
        <div className="mt-3 flex min-h-28 flex-col items-center justify-center rounded-lg border border-dashed border-slate-200 bg-white/70 px-4 text-center">
          <p className="max-w-xs text-[12px] leading-5 text-[var(--text-muted)]">
            No mock-up supplied. Causent never generates or implies one.
          </p>
          {!readOnly ? <button type="button" disabled={disabled || pending} onClick={() => inputRef.current?.click()} className="mt-3 rounded-lg border border-[var(--border)] bg-white px-3 py-2 text-[11px] font-semibold text-[var(--text)] disabled:opacity-45">
            {disabled ? "Save report to upload" : pending ? "Processing…" : "Upload PNG or JPEG"}
          </button> : null}
        </div>
      )}
      {!readOnly ? <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg"
        className="sr-only"
        disabled={disabled || pending}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.currentTarget.value = "";
          if (file) onUpload(file);
        }}
      /> : null}
      <p className="mt-2 text-[10px] leading-4 text-[var(--text-subtle)]">One PNG/JPEG · 5 MB · 4096×4096 · 16 MP. Metadata and original bytes are discarded.</p>
      {error ? <p role="alert" className="mt-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-2 text-[11px] text-red-800">{error}</p> : null}
    </div>
  );
}
