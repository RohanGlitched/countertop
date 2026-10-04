import type { CallToolResult } from "@modelcontextprotocol/client";
import { callTool, connect, hasView, mountView, type Connection, type MountedView } from "./host";
import { canListen, listen, speak, stopSpeaking } from "./voice";

type Block =
  | { text: string }
  | { toolUse: { toolUseId: string; name: string; input: Record<string, unknown> } }
  | { toolResult: { toolUseId: string; content: { text: string }[]; status?: "success" | "error" } };
interface Message {
  role: "user" | "assistant";
  content: Block[];
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const device = $<HTMLDivElement>("device");
const viewHost = $<HTMLDivElement>("view");
const empty = $<HTMLDivElement>("empty");
const caption = $<HTMLParagraphElement>("caption");
const talkBtn = $<HTMLButtonElement>("talk");
const sayForm = $<HTMLFormElement>("say");
const utter = $<HTMLInputElement>("utter");
const sendBtn = $<HTMLButtonElement>("send");
const voiceBox = $<HTMLInputElement>("voice");
const statusEl = $<HTMLParagraphElement>("status");
const connectForm = $<HTMLFormElement>("connect");
const urlInput = $<HTMLInputElement>("url");
const serverEl = $<HTMLParagraphElement>("server");
const toolsEl = $<HTMLOListElement>("tools");
const countEl = $<HTMLSpanElement>("count");
const logEl = $<HTMLOListElement>("log");
const modelEl = $<HTMLParagraphElement>("model");
const dialog = $<HTMLDialogElement>("argsDialog");

let conn: Connection | null = null;
let view: MountedView | null = null;
let messages: Message[] = [];
let busy = false;
let modelReady = false;
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

function setPhase(p: "idle" | "listening" | "thinking" | "speaking") {
  device.dataset.phase = p;
  busy = p !== "idle";
  const ready = Boolean(conn);
  talkBtn.disabled = !ready || !modelReady || !canListen() || (busy && p !== "listening");
  utter.disabled = !ready || !modelReady || busy;
  sendBtn.disabled = !ready || !modelReady || busy;
  talkBtn.textContent = p === "listening" ? "Listening… tap to stop" : p === "thinking" ? "Thinking…" : p === "speaking" ? "Speaking…" : "Talk";
}

function status(text: string, error = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", error);
}

function log(who: "you" | "assistant" | "tool" | "note", text: string) {
  logEl.querySelector(".none")?.remove();
  const li = document.createElement("li");
  li.dataset.who = who;
  if (who === "tool") {
    const code = document.createElement("code");
    code.textContent = text;
    li.append(code);
  } else li.textContent = text;
  logEl.append(li);
  logEl.scrollTop = logEl.scrollHeight; // scroll the log, not the page
}

function showCaption(text: string, who: "you" | "assistant") {
  caption.hidden = !text;
  caption.dataset.who = who;
  caption.textContent = who === "you" ? `“${text}”` : text;
}

async function show(name: string, args: Record<string, unknown>, result: CallToolResult) {
  if (!conn) return;
  if (!hasView(conn, name)) return;
  try {
    const next = await mountView(viewHost, conn, name, args, result, "dark");
    if (next) {
      view?.dispose();
      view = next;
      empty.hidden = true;
    }
  } catch (e) {
    status(`The ${name} view didn't load: ${e instanceof Error ? e.message : e}`, true);
  }
}

function textOf(r: CallToolResult) {
  return r.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => ({ text: c.text }));
}

/* ---------- connecting ---------- */

connectForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  await open(urlInput.value.trim());
});
document.querySelectorAll<HTMLButtonElement>("[data-url]").forEach((b) =>
  b.addEventListener("click", () => {
    urlInput.value = b.dataset.url!;
    open(b.dataset.url!);
  }),
);

async function open(url: string) {
  if (!url) return;
  status("Connecting…");
  try {
    conn = await connect(url);
    messages = [];
    serverEl.textContent = `${conn.name}: ${conn.tools.length} tools${conn.instructions ? ", with instructions for the model" : ""}.`;
    renderTools();
    status(modelReady ? "Connected. Talk, type, or run a tool directly." : "Connected. Run a tool from the list (no model is configured on this deployment).");
    try {
      localStorage.setItem("countertop.url", url);
    } catch {}
    const u = new URL(location.href);
    u.searchParams.set("server", url);
    history.replaceState(null, "", u);
  } catch (err) {
    conn = null;
    status(`Couldn't connect: ${err instanceof Error ? err.message : err}. Check the URL is a Streamable HTTP endpoint that allows this origin (CORS).`, true);
  }
  setPhase("idle");
}

function renderTools() {
  toolsEl.replaceChildren();
  countEl.textContent = conn ? String(conn.tools.length) : "";
  for (const t of conn?.tools ?? []) {
    const li = document.createElement("li");
    const head = document.createElement("div");
    head.className = "toolHead";
    const name = document.createElement("code");
    name.textContent = t.name;
    head.append(name);
    if (hasView(conn!, t.name)) {
      const tag = document.createElement("span");
      tag.className = "viewTag";
      tag.textContent = "view";
      head.append(tag);
    }
    const run = document.createElement("button");
    run.type = "button";
    run.className = "run";
    run.textContent = "Run";
    run.addEventListener("click", () => openArgs(t.name));
    head.append(run);
    const p = document.createElement("p");
    p.textContent = t.description ?? t.title ?? "";
    li.append(head, p);
    toolsEl.append(li);
  }
}

/* ---------- running a tool by hand ---------- */

function example(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const props = (schema?.properties ?? {}) as Record<string, { type?: string; enum?: unknown[]; default?: unknown }>;
  const required = new Set((schema?.required as string[]) ?? []);
  for (const [k, v] of Object.entries(props)) {
    if (!required.has(k)) continue;
    out[k] = v.default ?? v.enum?.[0] ?? (v.type === "number" || v.type === "integer" ? 0 : v.type === "boolean" ? false : "");
  }
  return out;
}

function openArgs(name: string) {
  const t = conn?.tools.find((x) => x.name === name);
  if (!t) return;
  $<HTMLHeadingElement>("argsTitle").textContent = name;
  $<HTMLParagraphElement>("argsDesc").textContent = t.description ?? "";
  $<HTMLTextAreaElement>("args").value = JSON.stringify(example(t.inputSchema as Record<string, unknown>), null, 2);
  $<HTMLParagraphElement>("argsErr").textContent = "";
  dialog.dataset.tool = name;
  dialog.showModal();
}

dialog.addEventListener("close", async () => {
  if (dialog.returnValue !== "run" || !conn) return;
  const name = dialog.dataset.tool!;
  let args: Record<string, unknown>;
  try {
    args = JSON.parse($<HTMLTextAreaElement>("args").value || "{}");
  } catch {
    status("Those arguments aren't valid JSON.", true);
    return;
  }
  log("tool", `${name}(${JSON.stringify(args)})`);
  setPhase("thinking");
  const r = await callTool(conn, name, args);
  const first = textOf(r)[0]?.text ?? (r.isError ? "The tool returned an error." : "Done.");
  if (r.isError) status(first, true);
  else await show(name, args, r);
  log("note", first);
  setPhase("idle");
});

/* ---------- the conversation ---------- */

function specs() {
  return (conn?.tools ?? []).map((t) => {
    const { $schema: _drop, ...schema } = (t.inputSchema ?? { type: "object" }) as Record<string, unknown>;
    return { name: t.name, description: t.description ?? t.title ?? t.name, inputSchema: schema };
  });
}

async function ask(said: string) {
  if (!conn || !said.trim()) return;
  stopSpeaking();
  status("");
  log("you", said);
  showCaption(said, "you");
  setPhase("thinking");
  let history: Message[] = [...messages, { role: "user" as const, content: [{ text: said }] }].slice(-30);
  while (history.length > 1 && !(history[0].role === "user" && history[0].content.some((b) => "text" in b))) history = history.slice(1);
  messages = history;
  try {
    for (let step = 0; step < 6; step++) {
      const r = await fetch("/api/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages, tools: specs(), serverName: conn.name, instructions: conn.instructions, timeZone: tz }),
      });
      const turn = await r.json();
      if (!r.ok) throw new Error(turn.error ?? "The model didn't answer.");
      messages = [...messages, turn.message];
      if (turn.stop === "tool_use") {
        const results: Block[] = [];
        for (const b of turn.message.content as Block[]) {
          if (!("toolUse" in b)) continue;
          const { toolUseId, name, input } = b.toolUse;
          log("tool", `${name}(${JSON.stringify(input)})`);
          const res = await callTool(conn, name, input);
          const texts = textOf(res);
          results.push({ toolResult: { toolUseId, content: texts.length ? texts : [{ text: "Done." }], status: res.isError ? "error" : "success" } });
          if (!res.isError) await show(name, input, res);
        }
        messages = [...messages, { role: "user", content: results }];
        continue;
      }
      const reply = (turn.message.content as Block[])
        .filter((b): b is { text: string } => "text" in b)
        .map((b) => b.text)
        .join(" ")
        .trim();
      log("assistant", reply);
      showCaption(reply, "assistant");
      setPhase("speaking");
      await speak(reply, "en-GB", !voiceBox.checked);
      break;
    }
  } catch (e) {
    status(e instanceof Error ? e.message : String(e), true);
  } finally {
    setPhase("idle");
    setTimeout(() => device.dataset.phase === "idle" && (caption.hidden = true), 6000);
  }
}

sayForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (busy) return;
  const v = utter.value;
  utter.value = "";
  ask(v);
});

let stopListen: (() => void) | null = null;
talkBtn.addEventListener("click", async () => {
  if (device.dataset.phase === "listening") return stopListen?.();
  if (busy) return;
  stopSpeaking();
  setPhase("listening");
  showCaption("Listening…", "you");
  try {
    const l = listen("en-GB", (t) => showCaption(t, "you"));
    stopListen = l.stop;
    const heard = await l.done;
    stopListen = null;
    setPhase("idle");
    if (heard) await ask(heard);
    else caption.hidden = true;
  } catch (e) {
    status(e instanceof Error ? e.message : String(e), true);
    setPhase("idle");
    caption.hidden = true;
  }
});

/* ---------- start ---------- */

(async () => {
  try {
    const r = await fetch("/api/turn");
    const j = await r.json();
    modelReady = Boolean(j.model);
    modelEl.textContent = modelReady ? `Model: ${j.model} on Amazon Bedrock.` : "No model on this deployment: run tools from the list.";
  } catch {
    modelEl.textContent = "No model on this deployment: run tools from the list.";
  }
  const fromUrl = new URL(location.href).searchParams.get("server");
  let saved: string | null = null;
  try {
    saved = localStorage.getItem("countertop.url");
  } catch {}
  const start = fromUrl || saved;
  if (start) {
    urlInput.value = start;
    await open(start);
  }
  setPhase("idle");
})();
