import { t } from "@lingui/core/macro";
import { Button } from "@rakazo/ui-web";
import { ExternalLink, MonitorPlay } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { isPreviewUrl, usePreviewPanel } from "../lib/preview-panel";

export type PreviewReachability = "checking" | "reachable" | "gone" | "unreachable";

/** HEAD on the preview URL (PIV-31, interface 2): 200 reachable, 410/502 gone. */
export async function checkPreviewReachable(
  url: string,
  signal?: AbortSignal,
): Promise<PreviewReachability> {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      credentials: "include",
      cache: "no-store",
      redirect: "manual",
      signal,
    });
    if (response.status === 200) return "reachable";
    if (response.status === 410 || response.status === 502) return "gone";
    return "unreachable";
  } catch {
    if (signal?.aborted) return "checking";
    return "unreachable";
  }
}

type PreviewCardProps = {
  artifactId: string;
  title: string;
  url: string;
  description?: string | null;
};

export function PreviewCard({ artifactId, title, url, description }: PreviewCardProps) {
  const panel = usePreviewPanel();
  const openButton = useRef<HTMLButtonElement>(null);
  const validUrl = isPreviewUrl(url);
  const [status, setStatus] = useState<PreviewReachability>(validUrl ? "checking" : "unreachable");

  useEffect(() => {
    if (!validUrl) return;
    const controller = new AbortController();
    setStatus("checking");
    void checkPreviewReachable(url, controller.signal).then((next) => {
      if (!controller.signal.aborted) setStatus(next);
    });
    return () => controller.abort();
  }, [url, validUrl]);

  const isOpen = panel?.source?.key === artifactId;
  const canOpen = validUrl && (status === "reachable" || status === "checking");
  const heading = t`Preview: ${title}`;

  return (
    <div
      data-testid="preview-card"
      data-status={status}
      className="flex w-[min(100%,360px)] flex-col gap-3 rounded-2xl border border-border bg-card px-4 py-3.5 text-left text-foreground"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <MonitorPlay className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14.5px] font-medium" title={heading}>
            {heading}
          </div>
          <div
            className="mt-0.5 flex items-start gap-1.5 text-[13px] text-muted-foreground"
            role="status"
          >
            <span
              aria-hidden="true"
              className={`mt-[7px] size-1.5 shrink-0 rounded-full ${
                status === "reachable"
                  ? "bg-success"
                  : status === "checking"
                    ? "bg-muted-foreground/50"
                    : "bg-destructive"
              }`}
            />
            <span>
              {status === "reachable"
                ? t`Reachable`
                : status === "checking"
                  ? t`Checking…`
                  : status === "gone"
                    ? t`No longer reachable – the bot needs to restart the server`
                    : t`Not reachable`}
            </span>
          </div>
          {description ? (
            <div className="mt-1.5 line-clamp-2 text-[13px] text-muted-foreground">
              {description}
            </div>
          ) : null}
        </div>
      </div>
      {canOpen ? (
        <div className="flex items-center gap-2">
          <Button
            ref={openButton}
            size="lg"
            aria-pressed={panel ? isOpen : undefined}
            onClick={() => {
              if (panel) {
                panel.open({ kind: "preview", key: artifactId, title, url }, openButton.current);
              } else {
                window.open(url, "_blank", "noopener,noreferrer");
              }
            }}
          >
            {t`Open`}
          </Button>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-[13.5px] font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
          >
            <ExternalLink className="size-3.5" aria-hidden="true" />
            {t`Open in new tab`}
          </a>
        </div>
      ) : null}
    </div>
  );
}
