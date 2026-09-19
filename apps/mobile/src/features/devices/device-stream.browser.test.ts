import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { DeviceStreamEvents } from "@t3tools/client-runtime/device/stream";

const transport = vi.hoisted(() => ({ clients: [] as { stop: ReturnType<typeof vi.fn> }[] }));
vi.mock("@t3tools/client-runtime/device/stream", () => ({
  createDeviceStreamClient: (
    target: { platform: string },
    _canvas: unknown,
    events: DeviceStreamEvents,
  ) => {
    const client = {
      start: () => {
        events.onStatus("connecting");
        if (target.platform === "ios") events.onMjpegFallback("https://device.test/stream.mjpeg");
        events.onStatus("streaming");
        events.onInputConnected(true);
      },
      stop: vi.fn(),
    };
    transport.clients.push(client);
    return client;
  },
}));

import { start, stop } from "./device-stream.browser";

class Element {
  readonly style = {};
  readonly listeners = new Map<string, () => void>();
  naturalWidth = 0;
  naturalHeight = 0;
  src = "";
  constructor(readonly tag: string) {}
  setAttribute() {}
  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }
  append() {}
  addEventListener(name: string, callback: () => void) {
    this.listeners.set(name, callback);
  }
}

function setup(platform: "ios" | "android" = "ios") {
  vi.useFakeTimers();
  const elements: Element[] = [];
  vi.stubGlobal("document", {
    documentElement: { style: {} },
    body: { style: {}, replaceChildren() {} },
    createElement: (tag: string) => {
      const element = new Element(tag);
      elements.push(element);
      return element;
    },
  });
  const postMessage = vi.fn();
  vi.stubGlobal("window", { ReactNativeWebView: { postMessage }, addEventListener() {} });
  const configuration = {
    platform,
    deviceId: "fixture-device",
    access: {
      httpBase: "https://device.test",
      wsBase: "wss://device.test",
      credentials: false,
      query: {},
    },
    colors: {
      background: "white",
      foreground: "black",
      muted: "gray",
      buttonBackground: "gray",
      buttonForeground: "black",
      buttonBorder: "gray",
    },
  };
  start(configuration);
  return {
    configuration,
    elements,
    messages: () =>
      postMessage.mock.calls.map(
        ([message]) => JSON.parse(message as string) as { type: string; status?: string },
      ),
  };
}

afterEach(() => {
  stop();
  transport.clients = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("mobile stream first frame and recovery", () => {
  it("keeps native feedback visible until MJPEG has an image, even without a load event", () => {
    const { elements, messages } = setup();
    expect(messages()).not.toContainEqual({ type: "status", status: "streaming" });
    expect(messages()).toContainEqual({ type: "input", connected: true });
    const image = elements.find((element) => element.tag === "img")!;
    image.naturalWidth = 400;
    image.naturalHeight = 800;
    vi.advanceTimersByTime(250);
    expect(messages()).toContainEqual({ type: "status", status: "streaming" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops a failed image stream and reports an actionable native error", () => {
    const { elements, messages } = setup();
    const image = elements.find((element) => element.tag === "img")!;
    image.listeners.get("error")!();
    expect(messages()).toContainEqual({
      type: "status",
      status: "error",
      detail: "Could not receive the device stream.",
    });
    expect(messages()).not.toContainEqual({ type: "unauthorized" });
    expect(transport.clients[0]!.stop).toHaveBeenCalledTimes(1);
    expect(image.src).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores image events from the previous attempt and cleans pending frame checks on close", () => {
    const { elements, messages, configuration } = setup();
    const oldImage = elements.find((element) => element.tag === "img")!;
    start(configuration);
    oldImage.listeners.get("error")!();
    oldImage.listeners.get("load")!();
    expect(messages().filter((message) => message.status === "error")).toEqual([]);
    expect(transport.clients[1]!.stop).not.toHaveBeenCalled();
    stop();
    expect(transport.clients[1]!.stop).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports decoded Android frames without MJPEG checks", () => {
    const { messages } = setup("android");
    expect(messages()).toContainEqual({ type: "status", status: "streaming" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
