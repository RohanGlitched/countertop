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

let captionTimer = 0;
const MODEL_NAMES: [RegExp, string][] = [
  [/claude-haiku-4-5/, "Claude Haiku 4.5"],
  [/claude-3-5-haiku/, "Claude 3.5 Haiku"],
  [/nova-lite/, "Amazon Nova Lite"],
];
const modelName = (id: string) => MODEL_NAMES.find(([re]) => re.test(id))?.[1] ?? id;

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
  while (logEl.children.length > 200) logEl.firstElementChild?.remove();
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
    const withViews = conn.tools.filter((t) => hasView(conn!, t.name)).length;
    empty.hidden = false;
    empty.querySelector(".big")!.textContent = `Connected to ${conn.name}.`;
    empty.querySelector("p:not(.big)")!.textContent = modelReady
      ? `${withViews ? `${withViews} of its ${conn.tools.length} tools draw a view here. ` : ""}Ask it something, or press Run on a tool.`
      : `${withViews ? `${withViews} of its ${conn.tools.length} tools draw a view here. ` : ""}Press Run on a tool to see it on the screen.`;
    try {
      if (!fromQuery) localStorage.setItem("countertop.url", url);
    } catch {}
    const u = new URL(location.href);
    u.searchParams.set("server", url);
    history.replaceState(null, "", u);
  } catch (err) {
    conn = null;
    const why = err instanceof Error ? err.message : String(err);
    status(
      /failed to fetch|networkerror|load failed/i.test(why)
        ? "Couldn't reach that address from the browser. Check it's a Streamable HTTP MCP endpoint (usually ending in /mcp) and that the server allows this origin (CORS)."
        : `Couldn't connect: ${why}`,
      true,
    );
  }
  setPhase("idle");
}
let fromQuery = false;

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

/** A first guess at arguments: defaults, enums, examples, and the "e.g. X" a description offers. */
function example(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  type Prop = { type?: string; enum?: unknown[]; default?: unknown; examples?: unknown[]; description?: string; minimum?: number };
  const props = (schema?.properties ?? {}) as Record<string, Prop>;
  const required = new Set((schema?.required as string[]) ?? []);
  const hinted = (v: Prop) => {
    const m = v.description?.match(/\be\.g\.?,?\s+['"“]?([^'"”,;.)]+)/i);
    return m?.[1]?.trim();
  };
  for (const [k, v] of Object.entries(props)) {
    const hint = hinted(v);
    const value = v.default ?? v.examples?.[0] ?? v.enum?.[0] ?? (v.type === "number" || v.type === "integer" ? (v.minimum ?? 1) : v.type === "boolean" ? false : hint ?? "");
    // Required fields always appear; optional ones appear when the schema gives something useful to start from.
    if (required.has(k) || (hint !== undefined && v.type !== "number" && v.type !== "integer") || v.enum || v.default !== undefined) out[k] = value;
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

/** Bad JSON keeps the dialog open with the message next to the text, instead of throwing the typing away. */
$<HTMLButtonElement>("argsRun").addEventListener("click", (e) => {
  const err = $<HTMLParagraphElement>("argsErr");
  try {
    const v = JSON.parse($<HTMLTextAreaElement>("args").value || "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Arguments must be a JSON object, like {\"place\": \"SE1 7PB\"}.");
    err.textContent = "";
  } catch (x) {
    e.preventDefault();
    err.textContent = x instanceof SyntaxError ? `That isn't valid JSON: ${x.message}` : x instanceof Error ? x.message : String(x);
  }
});

dialog.addEventListener("close", async () => {
  if (dialog.returnValue !== "run" || !conn || busy) return;
  const name = dialog.dataset.tool!;
  const args = JSON.parse($<HTMLTextAreaElement>("args").value || "{}") as Record<string, unknown>;
  log("tool", `${name}(${JSON.stringify(args)})`);
  setPhase("thinking");
  try {
    const r = await callTool(conn, name, args);
    const first = textOf(r)[0]?.text ?? (r.isError ? "The tool returned an error." : "Done.");
    if (r.isError) status(first, true);
    else await show(name, args, r);
    log("note", first);
  } finally {
    setPhase("idle");
  }
});

/** The host, not the prompt, is the last line of defence: a tool that may change something asks the person first. */
function okToRun(name: string): boolean {
  const t = conn?.tools.find((x) => x.name === name);
  const ann = (t?.annotations ?? {}) as { readOnlyHint?: boolean };
  if (ann.readOnlyHint === true) return true;
  return confirm(`The model wants to run "${name}", which may change something on the server. Run it?`);
}

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
  clearTimeout(captionTimer);
  const before = messages;
  let history: Message[] = [...messages, { role: "user" as const, content: [{ text: said }] }].slice(-30);
  while (history.length > 1 && !(history[0].role === "user" && history[0].content.some((b) => "text" in b))) history = history.slice(1);
  messages = history;
  let finished = false;
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
          const res = okToRun(name)
            ? await callTool(conn, name, input)
            : ({ isError: true, content: [{ type: "text" as const, text: "The person declined to run this tool." }] } as CallToolResult);
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
      finished = true;
      await speak(reply, "en-GB", !voiceBox.checked);
      break;
    }
    if (!finished) {
      // Six steps without an answer: close the turn so the next one isn't rejected by the model.
      messages = [...messages, { role: "assistant", content: [{ text: "I couldn't finish that one." }] }];
      log("assistant", "I couldn't finish that one.");
      showCaption("I couldn't finish that one.", "assistant");
    }
  } catch (e) {
    // A failed turn leaves no half-finished tool call behind, and no stale question on the screen.
    messages = before;
    caption.hidden = true;
    status(e instanceof Error ? e.message : String(e), true);
  } finally {
    setPhase("idle");
    captionTimer = window.setTimeout(() => device.dataset.phase === "idle" && (caption.hidden = true), 7000);
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
    modelReady = Boolean(j.model) && j.reachable !== false;
    modelEl.textContent = modelReady
      ? `Model: ${modelName(j.model)} on Amazon Bedrock.`
      : j.model
        ? `${modelName(j.model)} on Amazon Bedrock isn't reachable right now. The tool console still works.`
        : "No model on this deployment: run tools from the list.";
  } catch {
    modelEl.textContent = "No model on this deployment: run tools from the list.";
  }
  const fromUrl = new URL(location.href).searchParams.get("server");
  let saved: string | null = null;
  try {
    saved = localStorage.getItem("countertop.url");
  } catch {}
  // A server named in the link is connected to but not remembered: the next visit starts from the last one you chose.
  fromQuery = Boolean(fromUrl);
  const start = fromUrl || saved;
  if (start) {
    urlInput.value = start;
    await open(start);
  }
  setPhase("idle");
})();
