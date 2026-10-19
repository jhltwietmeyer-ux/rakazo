import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

/**
 * Sandbox for live previews served by /api/preview (PIV-31, interface 4).
 * One constant so the decision lives in one place and the test pins it.
 */
export const PREVIEW_IFRAME_SANDBOX = "allow-scripts allow-forms allow-same-origin";

/** Only our own proxy route may be framed; anything else is rejected. */
export const PREVIEW_URL_PREFIX = "/api/preview/";

export const PREVIEW_SPLIT_STORAGE_KEY = "rakazo:preview-split";
export const PREVIEW_MIN_CHAT_PX = 320;
export const PREVIEW_MIN_PANE_PX = 360;
/** Below this window width the preview is a full-window overlay instead of a split. */
export const PREVIEW_OVERLAY_BELOW_PX = 900;
export const PREVIEW_PHONE_WIDTH_PX = 390;
const DEFAULT_FRACTION = 0.5;

export type PreviewSource =
  | { kind: "preview"; key: string; title: string; url: string }
  | { kind: "html"; key: string; title: string; html: string };

export type PreviewDevice = "desktop" | "phone";

type PreviewPanelValue = {
  source: PreviewSource | null;
  /** Share of the chat+preview width taken by the preview, 0..1. */
  fraction: number;
  device: PreviewDevice;
  fullscreen: boolean;
  open: (source: PreviewSource, returnFocus?: HTMLElement | null) => void;
  close: () => void;
  setFraction: (fraction: number, persist?: boolean) => void;
  setDevice: (device: PreviewDevice) => void;
  setFullscreen: (fullscreen: boolean) => void;
};

const PreviewPanelContext = createContext<PreviewPanelValue | null>(null);

export function isPreviewUrl(url: string): boolean {
  if (!url.startsWith(PREVIEW_URL_PREFIX)) return false;
  // No scheme-relative, traversal or encoded tricks; the proxy validates too.
  return !/(^|\/)\.\.(\/|$)|\/\/|\\|%2e%2e|%2f|%5c/i.test(url.slice(PREVIEW_URL_PREFIX.length));
}

export function readStoredFraction(): number {
  try {
    const saved = Number(localStorage.getItem(PREVIEW_SPLIT_STORAGE_KEY));
    if (saved > 0 && saved < 1) return saved;
  } catch {
    /* Storage may be disabled. */
  }
  return DEFAULT_FRACTION;
}

export function PreviewPanelProvider({ children }: { children: ReactNode }) {
  const [source, setSource] = useState<PreviewSource | null>(null);
  const [fraction, setFractionState] = useState(readStoredFraction);
  const [device, setDevice] = useState<PreviewDevice>("desktop");
  const [fullscreen, setFullscreen] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);

  const open = useCallback((next: PreviewSource, focusTarget?: HTMLElement | null) => {
    returnFocus.current = focusTarget ?? null;
    setSource(next);
  }, []);

  const close = useCallback(() => {
    setSource(null);
    setFullscreen(false);
    const target = returnFocus.current;
    returnFocus.current = null;
    if (target?.isConnected) window.setTimeout(() => target.focus(), 0);
  }, []);

  const setFraction = useCallback((next: number, persist = true) => {
    const clamped = Math.min(0.95, Math.max(0.05, next));
    setFractionState(clamped);
    if (!persist) return;
    try {
      localStorage.setItem(PREVIEW_SPLIT_STORAGE_KEY, String(Math.round(clamped * 1000) / 1000));
    } catch {
      /* Storage may be disabled. */
    }
  }, []);

  const value = useMemo(
    () => ({
      source,
      fraction,
      device,
      fullscreen,
      open,
      close,
      setFraction,
      setDevice,
      setFullscreen,
    }),
    [source, fraction, device, fullscreen, open, close, setFraction],
  );
  return <PreviewPanelContext.Provider value={value}>{children}</PreviewPanelContext.Provider>;
}

/** Null outside the chat shell (e.g. the Artifacts page), where cards keep their dialog. */
export function usePreviewPanel(): PreviewPanelValue | null {
  return useContext(PreviewPanelContext);
}
