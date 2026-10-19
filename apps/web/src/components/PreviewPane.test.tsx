// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isPreviewUrl,
  PREVIEW_IFRAME_SANDBOX,
  PREVIEW_SPLIT_STORAGE_KEY,
  PreviewPanelProvider,
  usePreviewPanel,
} from "../lib/preview-panel";
import { checkPreviewReachable, PreviewCard } from "./PreviewCard";
import { clampPreviewFraction, PreviewPane } from "./PreviewPane";

const URL_A = "/api/preview/sealed-a/";
const URL_B = "/api/preview/sealed-b/";

let width = 1400;

function installMatchMedia() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => {
      const max = Number(/max-width:\s*([\d.]+)px/.exec(query)?.[1] ?? Number.POSITIVE_INFINITY);
      return {
        matches: width <= max,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
    }),
  );
}

function mockHead(status: number) {
  const fetchMock = vi.fn(async () => new Response(null, { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Chat column stand-in so the pane can measure its sibling, like <main> in Shell. */
function Layout({ cards }: { cards: { id: string; title: string; url: string }[] }) {
  const panel = usePreviewPanel();
  return (
    <div style={{ display: "flex" }}>
      <main data-testid="chat">
        {cards.map((card) => (
          <PreviewCard key={card.id} artifactId={card.id} title={card.title} url={card.url} />
        ))}
        <span data-testid="source">{panel?.source?.key ?? "none"}</span>
      </main>
      <PreviewPane />
    </div>
  );
}

async function render(cards = [{ id: "a", title: "Weidekontrolle", url: URL_A }]) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <PreviewPanelProvider>
        <Layout cards={cards} />
      </PreviewPanelProvider>,
    );
  });
  await flush();
  return {
    container,
    pane: () => container.querySelector<HTMLElement>("[data-testid='preview-pane']"),
    frame: () => container.querySelector<HTMLIFrameElement>("[data-testid='preview-frame']"),
    button: (label: string, scope: ParentNode = container) =>
      Array.from(scope.querySelectorAll<HTMLElement>("button, a")).find(
        (element) =>
          element.textContent?.trim() === label || element.getAttribute("aria-label") === label,
      ),
    unmount: () => act(() => root.unmount()),
  };
}

function key(name: string) {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }),
    );
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  width = 1400;
  installMatchMedia();
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("preview card", () => {
  it("shows title, reachable status and both actions after HEAD 200", async () => {
    const fetchMock = mockHead(200);
    const view = await render();
    const card = view.container.querySelector("[data-testid='preview-card']");
    expect(card?.textContent).toContain("Preview: Weidekontrolle");
    expect(card?.getAttribute("data-status")).toBe("reachable");
    expect(fetchMock).toHaveBeenCalledWith(URL_A, expect.objectContaining({ method: "HEAD" }));
    expect(view.button("Open")).toBeTruthy();
    const tab = view.button("Open in new tab") as HTMLAnchorElement;
    expect(tab.getAttribute("href")).toBe(URL_A);
    expect(tab.getAttribute("target")).toBe("_blank");
    expect(tab.getAttribute("rel")).toBe("noopener noreferrer");
    await view.unmount();
  });

  it.each([410, 502])("explains a gone server on %i and offers no panel", async (status) => {
    mockHead(status);
    const view = await render();
    const card = view.container.querySelector("[data-testid='preview-card']");
    expect(card?.textContent).toContain(
      "No longer reachable – the bot needs to restart the server",
    );
    expect(view.button("Open")).toBeUndefined();
    expect(view.button("Open in new tab")).toBeUndefined();
    await view.unmount();
  });

  it("never frames a URL outside the preview proxy", async () => {
    const fetchMock = mockHead(200);
    const view = await render([{ id: "x", title: "x", url: "https://example.invalid/" }]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(view.button("Open")).toBeUndefined();
    expect(isPreviewUrl("/api/preview/abc/")).toBe(true);
    expect(isPreviewUrl("//example.invalid/api/preview/")).toBe(false);
    expect(isPreviewUrl("/api/preview/abc/../../rpc")).toBe(false);
    expect(isPreviewUrl("/api/preview/abc/%2e%2e/rpc")).toBe(false);
    expect(isPreviewUrl("/api/previewx/")).toBe(false);
    await view.unmount();
  });

  it("treats network errors and other statuses as not reachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("offline"))),
    );
    expect(await checkPreviewReachable(URL_A)).toBe("unreachable");
    mockHead(401);
    expect(await checkPreviewReachable(URL_A)).toBe("unreachable");
  });
});

describe("preview pane", () => {
  it("opens split next to the chat with the exact sandbox and no message handler", async () => {
    mockHead(200);
    const addListener = vi.spyOn(window, "addEventListener");
    const view = await render();
    act(() => view.button("Open")?.click());
    const pane = view.pane();
    expect(pane?.getAttribute("data-mode")).toBe("split");
    expect(pane?.style.flex).toBe("0.5 1 0px");
    expect(view.container.querySelector("[role='separator']")).toBeTruthy();
    const frame = view.frame();
    expect(frame?.getAttribute("src")).toBe(URL_A);
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts allow-forms allow-same-origin");
    expect(frame?.getAttribute("sandbox")).toBe(PREVIEW_IFRAME_SANDBOX);
    expect(frame?.getAttribute("sandbox")).not.toContain("allow-top-navigation");
    expect(frame?.getAttribute("sandbox")).not.toContain("allow-popups");
    expect(addListener.mock.calls.some(([type]) => type === "message")).toBe(false);
    await view.unmount();
  });

  it("has title and all header controls, reachable by keyboard", async () => {
    mockHead(200);
    const view = await render();
    act(() => view.button("Open")?.click());
    const pane = view.pane() as HTMLElement;
    expect(document.activeElement).toBe(pane);
    expect(pane.querySelector("h2")?.textContent).toBe("Weidekontrolle");
    for (const label of [
      "Phone (390 px)",
      "Desktop",
      "Reload",
      "Full screen",
      "Open in new tab",
      "Close preview",
    ]) {
      const control = view.button(label, pane);
      expect(control, label).toBeTruthy();
      expect(control?.getAttribute("tabindex")).not.toBe("-1");
    }
    expect(pane.querySelector("[role='separator']")?.getAttribute("tabindex")).toBe("0");
    const tab = view.button("Open in new tab", pane) as HTMLAnchorElement;
    expect(tab.getAttribute("rel")).toBe("noopener noreferrer");
    await view.unmount();
  });

  it("switches between phone (390 px centred) and desktop width", async () => {
    mockHead(200);
    const view = await render();
    act(() => view.button("Open")?.click());
    act(() => view.button("Phone (390 px)")?.click());
    expect(view.pane()?.getAttribute("data-device")).toBe("phone");
    expect(view.frame()?.parentElement?.style.width).toBe("390px");
    act(() => view.button("Desktop")?.click());
    expect(view.pane()?.getAttribute("data-device")).toBe("desktop");
    expect(view.frame()?.parentElement?.style.width).toBe("");
    await view.unmount();
  });

  it("reloads the frame", async () => {
    mockHead(200);
    const view = await render();
    act(() => view.button("Open")?.click());
    const before = view.frame();
    act(() => view.button("Reload")?.click());
    expect(view.frame()).not.toBe(before);
    expect(view.frame()?.getAttribute("src")).toBe(URL_A);
    await view.unmount();
  });

  it("full screen: first Esc leaves it, second Esc closes and focus returns to the card", async () => {
    mockHead(200);
    const view = await render();
    const open = view.button("Open") as HTMLElement;
    act(() => open.click());
    act(() => view.button("Full screen")?.click());
    expect(view.pane()?.getAttribute("data-mode")).toBe("fullscreen");
    expect(view.container.querySelector("[role='separator']")).toBeNull();
    key("Escape");
    expect(view.pane()?.getAttribute("data-mode")).toBe("split");
    key("Escape");
    expect(view.pane()).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.activeElement).toBe(open);
    await view.unmount();
  });

  it("close button closes and returns focus to the card", async () => {
    mockHead(200);
    const view = await render();
    const open = view.button("Open") as HTMLElement;
    act(() => open.click());
    act(() => view.button("Close preview")?.click());
    expect(view.pane()).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.activeElement).toBe(open);
    await view.unmount();
  });

  it("keeps one pane per window: another card switches the content", async () => {
    mockHead(200);
    const view = await render([
      { id: "a", title: "Erste", url: URL_A },
      { id: "b", title: "Zweite", url: URL_B },
    ]);
    const opens = Array.from(view.container.querySelectorAll("button")).filter(
      (button) => button.textContent === "Open",
    );
    act(() => opens[0]?.click());
    act(() => opens[1]?.click());
    expect(view.container.querySelectorAll("[data-testid='preview-pane']")).toHaveLength(1);
    expect(view.frame()?.getAttribute("src")).toBe(URL_B);
    expect(view.pane()?.querySelector("h2")?.textContent).toBe("Zweite");
    await view.unmount();
  });

  it("below 900 px opens as overlay without divider, close on top", async () => {
    width = 600;
    installMatchMedia();
    mockHead(200);
    const view = await render();
    act(() => view.button("Open")?.click());
    const pane = view.pane() as HTMLElement;
    expect(pane.getAttribute("data-mode")).toBe("overlay");
    expect(pane.className).toContain("fixed inset-0");
    expect(pane.querySelector("[role='separator']")).toBeNull();
    expect(view.button("Full screen", pane)).toBeUndefined();
    expect(pane.querySelector("header [aria-label='Close preview']")).toBeTruthy();
    key("Escape");
    expect(view.pane()).toBeNull();
    await view.unmount();
  });

  it("drags the divider with pointer events, clamps to the minimums and remembers the split", async () => {
    mockHead(200);
    const view = await render();
    act(() => view.button("Open")?.click());
    const chat = view.container.querySelector("[data-testid='chat']") as HTMLElement;
    const pane = view.pane() as HTMLElement;
    // Chat 0..600, preview 600..1200 → 1200 px to share.
    chat.getBoundingClientRect = () => ({ left: 0, right: 600 }) as DOMRect;
    pane.getBoundingClientRect = () => ({ left: 600, right: 1200 }) as DOMRect;
    const divider = pane.querySelector("[role='separator']") as HTMLElement;
    const pointer = (type: string, clientX: number) =>
      act(() => {
        const event = new MouseEvent(type, { bubbles: true, clientX, button: 0 });
        Object.defineProperty(event, "pointerId", { value: 1 });
        divider.dispatchEvent(event);
      });
    pointer("pointerdown", 600);
    pointer("pointermove", 400);
    expect(Number.parseFloat(view.pane()?.style.flex ?? "")).toBeCloseTo(800 / 1200, 5);
    pointer("pointermove", 100); // chat would drop below 320 px
    expect(Number.parseFloat(view.pane()?.style.flex ?? "")).toBeCloseTo(1 - 320 / 1200, 3);
    pointer("pointermove", 1100); // preview would drop below 360 px
    pointer("pointerup", 1100);
    expect(Number.parseFloat(view.pane()?.style.flex ?? "")).toBeCloseTo(360 / 1200, 3);
    expect(Number(localStorage.getItem(PREVIEW_SPLIT_STORAGE_KEY))).toBeCloseTo(0.3, 3);
    await view.unmount();

    const again = await render();
    act(() => again.button("Open")?.click());
    expect(again.pane()?.style.flex).toBe("0.3 1 0px");
    await again.unmount();
  });

  it("divider also resizes with arrow keys", async () => {
    mockHead(200);
    const view = await render();
    act(() => view.button("Open")?.click());
    const divider = view.pane()?.querySelector("[role='separator']") as HTMLElement;
    expect(divider.getAttribute("aria-valuenow")).toBe("50");
    act(() => {
      divider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(divider.getAttribute("aria-valuenow")).toBe("52");
    await view.unmount();
  });
});

describe("html artifacts in the pane", () => {
  it("render through the existing sandboxed viewer, never with same-origin", async () => {
    function OpenHtml() {
      const panel = usePreviewPanel();
      return (
        <button
          type="button"
          onClick={() =>
            panel?.open({ kind: "html", key: "art", title: "Nachweis", html: "<p>hi</p>" })
          }
        >
          open-html
        </button>
      );
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <PreviewPanelProvider>
          <div>
            <main>
              <OpenHtml />
            </main>
            <PreviewPane />
          </div>
        </PreviewPanelProvider>,
      );
    });
    act(() => container.querySelector("button")?.click());
    const frame = container.querySelector("[data-testid='preview-pane'] iframe");
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame?.getAttribute("srcdoc")).toContain("Content-Security-Policy");
    expect(container.querySelector("h2")?.textContent).toBe("Nachweis");
    act(() => root.unmount());
  });
});

describe("clampPreviewFraction", () => {
  it("keeps 320 px chat and 360 px preview", () => {
    expect(clampPreviewFraction(0.99, 1000)).toBeCloseTo(0.68, 5);
    expect(clampPreviewFraction(0.01, 1000)).toBeCloseTo(0.36, 5);
    expect(clampPreviewFraction(0.5, 1000)).toBe(0.5);
  });
});
