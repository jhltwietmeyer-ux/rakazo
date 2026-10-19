import { t } from "@lingui/core/macro";
import { ExternalLink, Maximize2, Minimize2, Monitor, RotateCw, Smartphone, X } from "lucide-react";
import type { KeyboardEvent, PointerEvent } from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  isPreviewUrl,
  PREVIEW_IFRAME_SANDBOX,
  PREVIEW_MIN_CHAT_PX,
  PREVIEW_MIN_PANE_PX,
  PREVIEW_OVERLAY_BELOW_PX,
  PREVIEW_PHONE_WIDTH_PX,
  type PreviewSource,
  usePreviewPanel,
} from "../lib/preview-panel";
import { SandboxedHtmlViewer, sandboxedHtmlDocument } from "./SandboxedHtmlViewer";

const NARROW_QUERY = `(max-width: ${PREVIEW_OVERLAY_BELOW_PX - 0.02}px)`;

function subscribeNarrow(onChange: () => void) {
  if (typeof window.matchMedia !== "function") return () => undefined;
  const query = window.matchMedia(NARROW_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function readNarrow() {
  if (typeof window.matchMedia === "function") return window.matchMedia(NARROW_QUERY).matches;
  return window.innerWidth < PREVIEW_OVERLAY_BELOW_PX;
}

/** True below 900 px: the preview becomes a full-window overlay. */
export function usePreviewNarrow(): boolean {
  return useSyncExternalStore(subscribeNarrow, readNarrow, () => false);
}

/** Clamp the preview share so chat keeps 320 px and the preview 360 px. */
export function clampPreviewFraction(fraction: number, totalPx: number): number {
  if (totalPx <= 0) return fraction;
  const min = PREVIEW_MIN_PANE_PX / totalPx;
  const max = 1 - PREVIEW_MIN_CHAT_PX / totalPx;
  if (min > max) return 0.5;
  return Math.min(max, Math.max(min, fraction));
}

function openHtmlInNewTab(html: string) {
  // The tab gets the same sandboxed shell as the panel: the artifact's own
  // scripts run in an opaque origin, never in the app's origin.
  const blob = new Blob([sandboxedHtmlDocument(html)], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank", "noopener,noreferrer");
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function isInsideDialog(target: EventTarget | null): boolean {
  return (
    target instanceof Element && Boolean(target.closest("[role='dialog'],[role='alertdialog']"))
  );
}

export function PreviewPane() {
  const panel = usePreviewPanel();
  const narrow = usePreviewNarrow();
  const paneRef = useRef<HTMLElement>(null);
  const [reloadCount, setReloadCount] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragTotal = useRef(0);

  const source = panel?.source ?? null;
  const fullscreen = Boolean(panel?.fullscreen);
  const overlay = narrow || fullscreen;

  // Move focus into the region when it opens or switches content.
  useEffect(() => {
    if (source) paneRef.current?.focus({ preventScroll: true });
  }, [source]);

  useEffect(() => {
    if (!panel || !source) return;
    const { close, setFullscreen } = panel;
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented || isInsideDialog(event.target)) return;
      event.preventDefault();
      if (fullscreen) setFullscreen(false);
      else close();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [panel, source, fullscreen]);

  if (!panel || !source) return null;
  const { close, setFraction, device, setDevice, setFullscreen, fraction } = panel;

  function totalWidth(): number {
    const pane = paneRef.current;
    const chat = pane?.previousElementSibling;
    if (!pane || !chat) return 0;
    return pane.getBoundingClientRect().right - chat.getBoundingClientRect().left;
  }

  function fractionAt(clientX: number): number {
    const pane = paneRef.current;
    if (!pane) return fraction;
    const total = dragTotal.current || totalWidth();
    const right = pane.getBoundingClientRect().right;
    return clampPreviewFraction((right - clientX) / total, total);
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    dragTotal.current = totalWidth();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    setFraction(fractionAt(event.clientX), false);
  }

  function onPointerEnd(event: PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    setDragging(false);
    setFraction(fractionAt(event.clientX), true);
    dragTotal.current = 0;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function onSeparatorKey(event: KeyboardEvent<HTMLDivElement>) {
    const total = totalWidth();
    const step = event.shiftKey ? 0.1 : 0.02;
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = fraction + step;
    if (event.key === "ArrowRight") next = fraction - step;
    if (event.key === "Home") next = 1;
    if (event.key === "End") next = 0;
    if (next === null) return;
    event.preventDefault();
    setFraction(clampPreviewFraction(next, total), true);
  }

  const percent = Math.round(fraction * 100);
  const frameTitle = t`Preview: ${source.title}`;
  const iconButton =
    "inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring aria-pressed:bg-muted aria-pressed:text-foreground";

  return (
    <section
      ref={paneRef}
      tabIndex={-1}
      aria-label={frameTitle}
      data-testid="preview-pane"
      data-mode={narrow ? "overlay" : fullscreen ? "fullscreen" : "split"}
      data-device={device}
      style={overlay ? undefined : { flex: `${fraction} 1 0px`, minWidth: PREVIEW_MIN_PANE_PX }}
      className={
        overlay
          ? "fixed inset-0 z-50 flex flex-col bg-background outline-none"
          : "relative flex min-h-0 min-w-0 flex-col border-s border-sidebar-border bg-background outline-none"
      }
    >
      {!overlay ? (
        // biome-ignore lint/a11y/useSemanticElements: a focusable, draggable vertical splitter has no native element.
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t`Resize preview`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          tabIndex={0}
          data-testid="preview-divider"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onKeyDown={onSeparatorKey}
          className="group absolute inset-y-0 -start-1.5 z-10 w-3 cursor-col-resize touch-none outline-none"
        >
          <span
            aria-hidden="true"
            className={`absolute inset-y-0 start-1/2 w-px -translate-x-1/2 transition-colors group-hover:bg-ring group-focus-visible:bg-ring ${dragging ? "bg-ring" : "bg-transparent"}`}
          />
        </div>
      ) : null}

      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-2.5">
        <h2 className="min-w-0 flex-1 truncate ps-1.5 text-[14px] font-medium" title={source.title}>
          {source.title}
        </h2>
        <fieldset
          aria-label={t`Width`}
          className="m-0 flex min-w-0 items-center rounded-lg border-0 bg-muted/60 p-0.5"
        >
          <button
            type="button"
            className={iconButton}
            aria-pressed={device === "phone"}
            aria-label={t`Phone (390 px)`}
            title={t`Phone (390 px)`}
            onClick={() => setDevice("phone")}
          >
            <Smartphone className="size-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            className={iconButton}
            aria-pressed={device === "desktop"}
            aria-label={t`Desktop`}
            title={t`Desktop`}
            onClick={() => setDevice("desktop")}
          >
            <Monitor className="size-4" aria-hidden="true" />
          </button>
        </fieldset>
        <button
          type="button"
          className={iconButton}
          aria-label={t`Reload`}
          title={t`Reload`}
          onClick={() => setReloadCount((count) => count + 1)}
        >
          <RotateCw className="size-4" aria-hidden="true" />
        </button>
        {!narrow ? (
          <button
            type="button"
            className={iconButton}
            aria-pressed={fullscreen}
            aria-label={fullscreen ? t`Exit full screen` : t`Full screen`}
            title={fullscreen ? t`Exit full screen (Esc)` : t`Full screen`}
            onClick={() => setFullscreen(!fullscreen)}
          >
            {fullscreen ? (
              <Minimize2 className="size-4" aria-hidden="true" />
            ) : (
              <Maximize2 className="size-4" aria-hidden="true" />
            )}
          </button>
        ) : null}
        {source.kind === "preview" ? (
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            className={iconButton}
            aria-label={t`Open in new tab`}
            title={t`Open in new tab`}
          >
            <ExternalLink className="size-4" aria-hidden="true" />
          </a>
        ) : (
          <button
            type="button"
            className={iconButton}
            aria-label={t`Open in new tab`}
            title={t`Open in new tab`}
            onClick={() => openHtmlInNewTab(source.html)}
          >
            <ExternalLink className="size-4" aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          className={iconButton}
          aria-label={t`Close preview`}
          title={t`Close (Esc)`}
          onClick={close}
          data-testid="preview-close"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </header>

      <div
        className={`relative min-h-0 flex-1 ${device === "phone" ? "flex justify-center overflow-auto bg-muted/50 py-3" : ""}`}
      >
        <div
          className={
            device === "phone"
              ? "h-full shrink-0 overflow-hidden rounded-xl border border-border bg-white shadow-sm"
              : "h-full w-full bg-white"
          }
          style={
            device === "phone" ? { width: PREVIEW_PHONE_WIDTH_PX, maxWidth: "100%" } : undefined
          }
        >
          <PreviewFrame
            key={`${source.key}:${reloadCount}`}
            source={source}
            title={frameTitle}
            blockPointer={dragging}
          />
        </div>
      </div>
    </section>
  );
}

function PreviewFrame({
  source,
  title,
  blockPointer,
}: {
  source: PreviewSource;
  title: string;
  blockPointer: boolean;
}) {
  if (source.kind === "html") {
    return (
      <div className={`h-full w-full ${blockPointer ? "pointer-events-none" : ""}`}>
        <SandboxedHtmlViewer html={source.html} title={title} />
      </div>
    );
  }
  if (!isPreviewUrl(source.url)) return null;
  return (
    <iframe
      title={title}
      src={source.url}
      sandbox={PREVIEW_IFRAME_SANDBOX}
      referrerPolicy="no-referrer"
      data-testid="preview-frame"
      className={`h-full w-full border-0 bg-white ${blockPointer ? "pointer-events-none" : ""}`}
    />
  );
}
