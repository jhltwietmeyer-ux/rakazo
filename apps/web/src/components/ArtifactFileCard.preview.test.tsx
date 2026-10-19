// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PreviewPanelProvider } from "../lib/preview-panel";
import { ArtifactFileCard } from "./ArtifactFileCard";
import { PreviewPane } from "./PreviewPane";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce(
        (text, part, index) => text + part + (index < values.length ? String(values[index]) : ""),
        "",
      ),
  }),
}));
vi.mock("../lib/artifact-open", () => ({
  fetchArtifactBytes: vi.fn(async () => new TextEncoder().encode("<h1>Nachweis</h1>")),
  downloadArtifactBytes: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

it("opens an HTML artifact from attach_file in the same preview pane", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <PreviewPanelProvider>
        <div>
          <main>
            <ArtifactFileCard
              target={{ botId: "bot-1" }}
              artifactId="artifact-1"
              name="nachweis.html"
              mimeType="text/html"
              size={20}
            />
          </main>
          <PreviewPane />
        </div>
      </PreviewPanelProvider>,
    );
  });
  const card = Array.from(container.querySelectorAll("button")).find((button) =>
    button.textContent?.includes("nachweis.html"),
  );
  await act(async () => {
    card?.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  const pane = container.querySelector("[data-testid='preview-pane']");
  expect(pane).toBeTruthy();
  expect(pane?.querySelector("h2")?.textContent).toBe("nachweis.html");
  const frame = pane?.querySelector("iframe");
  expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
  expect(frame?.getAttribute("srcdoc")).toContain("\\u003ch1>Nachweis\\u003c/h1>");
  // No dialog: the pane replaces it inside the chat.
  expect(document.querySelector("[role='dialog']")).toBeNull();
  act(() => root.unmount());
});
