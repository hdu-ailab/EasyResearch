import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatTranscript } from "../src/components/ChatTranscript";
import { getMarkdownRuntimeMetrics } from "../src/components/markdown/client";
import { I18nProvider } from "../src/i18n/I18nProvider";
import { PreferencesProvider } from "../src/preferences/PreferencesProvider";
import type { SessionMessageView } from "../src/session-reducer";
import "./benchmark.css";
import { createTranscriptFixture, FINAL_STREAM_TEXT, STREAM_DELTAS } from "./fixture";
import { createWorkProbe, type WorkBenchmarkMetrics } from "./probe";

declare global {
  interface Window {
    __easyresearchWorkBenchmark?: {
      run(): Promise<WorkBenchmarkMetrics>;
    };
  }
}

const fixture = createTranscriptFixture();

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function BenchmarkApp() {
  const [messages, setMessages] = useState(fixture.messages);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  useEffect(() => {
    window.__easyresearchWorkBenchmark = {
      async run() {
        await nextFrame();
        await nextFrame();
        const viewport = document.querySelector<HTMLElement>("[data-testid='transcript-viewport'] section");
        if (!viewport) throw new Error("benchmark transcript viewport is missing");
        const probe = createWorkProbe(viewport);

        const scroll = async (target: number, frames: number) => {
          const start = viewport.scrollTop;
          for (let index = 1; index <= frames; index += 1) {
            viewport.scrollTop = start + (target - start) * (index / frames);
            await nextFrame();
            probe.sample();
          }
        };

        await scroll(0, 45);
        await scroll(viewport.scrollHeight, 60);
        await scroll(0, 60);
        await scroll(viewport.scrollHeight, 45);

        let source = "";
        for (const delta of STREAM_DELTAS) {
          source += delta;
          const next = source;
          setMessages((current) =>
            current.map((message) =>
              message.key === "stream-assistant" ? { ...message, text: next, streaming: true } : message,
            ),
          );
          await new Promise((resolve) => setTimeout(resolve, 0));
          probe.sample();
        }
        setMessages((current) =>
          current.map((message) =>
            message.key === "stream-assistant" ? { ...message, text: source, streaming: false } : message,
          ),
        );
        await nextFrame();
        await nextFrame();
        probe.sample();

        const final = messagesRef.current.find((message) => message.key === "stream-assistant") as
          | SessionMessageView
          | undefined;
        return {
          ...probe.finish(),
          finalTextExact: source === FINAL_STREAM_TEXT && final?.text === FINAL_STREAM_TEXT,
          markdownRuntime: getMarkdownRuntimeMetrics(),
        };
      },
    };
    return () => {
      delete window.__easyresearchWorkBenchmark;
    };
  }, []);

  return (
    <div
      className="bg-v2-background-bg-base"
      data-benchmark-shell
      style={{ display: "flex", height: "100vh", minWidth: 0, width: "100vw" }}
    >
      <ChatTranscript
        messages={messages}
        tools={fixture.tools}
        summaries={fixture.summaries}
        hydrationScope="benchmark"
        hydrationRevision={1}
      />
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("benchmark root is missing");
createRoot(root).render(
  <StrictMode>
    <PreferencesProvider>
      <I18nProvider>
        <BenchmarkApp />
      </I18nProvider>
    </PreferencesProvider>
  </StrictMode>,
);
