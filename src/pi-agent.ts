/**
 * FlowLink Pi Coding Agent SDK integration.
 * Pi runs in a worker thread; the renderer only receives bounded prompt/result
 * IPC. Workflow changes must be explicitly applied after schema validation.
 */

import { app, session } from "electron";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";

import { perfSinceAppStart } from "./perf.js";

export interface PiPromptOptions {
  prompt: string;
  cwd: string;
  timeoutMs?: number;
}

export interface PiPromptResult {
  ok: boolean;
  text: string;
  error?: string;
}

interface PiSettings {
  provider?: string;
  model?: string;
  thinkingLevel?: "off" | "low" | "medium" | "high";
  timeoutMs?: number;
  autoRefine?: boolean;
}

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const DEFAULT_PROVIDER = "opencode-go";
const DEFAULT_MODEL = "kimi-k3";
interface PiWorkerResponse {
  type: "prompt-result";
  id: number;
  ok: boolean;
  text?: string;
  error?: string;
}

interface PiWorkerProxyRequest {
  type: "resolve-proxy";
  requestId: number;
  url: string;
}

type PiWorkerMessage = PiWorkerResponse | PiWorkerProxyRequest;

type PiProxyOptions =
  | { mode: "environment" }
  | { mode: "system" }
  | { mode: "explicit"; url: string };

interface PendingPiRequest {
  resolve: (response: PiWorkerResponse) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

let piWorker: Worker | undefined;
let nextPiRequestId = 0;
const pendingPiRequests = new Map<number, PendingPiRequest>();

function getConfigDirectory(): string {
  return path.join(app.getAppPath(), "config");
}

function getAuthPath(): string {
  // Development: keep the credentials file in the project.
  // Packaged application: keep credentials outside the application bundle.
  return app.isPackaged
    ? path.join(app.getPath("userData"), "pi-auth.json")
    : path.join(getConfigDirectory(), "pi-auth.json");
}

function getSettingsPath(): string {
  return path.join(getConfigDirectory(), "pi-settings.json");
}

function readSettings(): Required<PiSettings> {
  const defaults: Required<PiSettings> = {
    provider: DEFAULT_PROVIDER,
    model: DEFAULT_MODEL,
    thinkingLevel: "medium",
    timeoutMs: 120_000,
    autoRefine: true,
  };

  const settingsPath = getSettingsPath();

  if (!existsSync(settingsPath)) {
    return defaults;
  }

  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as PiSettings;

    const validLevels = ["off", "low", "medium", "high"] as const;
    const thinkingLevel = validLevels.includes(
      parsed.thinkingLevel as (typeof validLevels)[number],
    )
      ? parsed.thinkingLevel!
      : defaults.thinkingLevel;

    return {
      provider:
        typeof parsed.provider === "string" && parsed.provider.trim()
          ? parsed.provider.trim()
          : defaults.provider,
      model:
        typeof parsed.model === "string" && parsed.model.trim()
          ? parsed.model.trim()
          : defaults.model,
      thinkingLevel,
      timeoutMs:
        Number.isFinite(parsed.timeoutMs) && parsed.timeoutMs! >= 5_000
          ? Math.min(parsed.timeoutMs!, 600_000)
          : defaults.timeoutMs,
      autoRefine: typeof parsed.autoRefine === "boolean" ? parsed.autoRefine : defaults.autoRefine,
    };
  } catch {
    throw new Error(`Cannot parse Pi settings file: ${settingsPath}`);
  }
}

/** 录制停止后的自动细化开关（config/pi-settings.json `autoRefine`，缺省开启）。 */
export function isAutoRefineEnabled(): boolean {
  try {
    return readSettings().autoRefine;
  } catch {
    return true;
  }
}

function validateAuthFile(provider: string): void {
  const authPath = getAuthPath();

  if (!existsSync(authPath)) {
    throw new Error(
      `Pi credentials file not found: ${authPath}. ` +
        "Create pi-auth.json and configure the API key for the selected provider.",
    );
  }

  let auth: Record<string, unknown>;

  try {
    auth = JSON.parse(readFileSync(authPath, "utf8"));
  } catch {
    throw new Error(`Pi credentials file is not valid JSON: ${authPath}`);
  }

  const credential = auth[provider] as
    | { type?: string; key?: string }
    | undefined;

  if (
    !credential ||
    credential.type !== "api_key" ||
    typeof credential.key !== "string" ||
    !credential.key.trim() ||
    credential.key.includes("PASTE_YOUR_")
  ) {
    throw new Error(
      `No usable API key was found for provider "${provider}" ` +
        `in ${authPath}. Check the provider name and key.`,
    );
  }
}

function getPiProxyOptions(): PiProxyOptions {
  const explicitArg = process.argv.find((arg) => arg.startsWith("--pi-proxy="));
  if (explicitArg !== undefined) {
    const url = explicitArg.slice("--pi-proxy=".length).trim();
    if (!url) throw new Error("--pi-proxy requires a proxy URL.");
    return { mode: "explicit", url };
  }
  if (process.argv.includes("--pi-proxy")) {
    throw new Error("Use --pi-proxy=<URL> to specify a Pi proxy.");
  }
  if (process.argv.includes("--pi-system-proxy")) return { mode: "system" };
  return { mode: "environment" };
}

function rejectPiWorkerRequests(worker: Worker, error: Error): void {
  if (piWorker !== worker) return;
  piWorker = undefined;
  for (const [id, request] of pendingPiRequests) {
    clearTimeout(request.timer);
    request.reject(error);
    pendingPiRequests.delete(id);
  }
}

function getPiWorker(): Worker {
  if (piWorker) return piWorker;

  perfSinceAppStart("pi:worker-spawned");
  const worker = new Worker(new URL("./pi-agent-worker.js", import.meta.url));
  piWorker = worker;
  worker.unref();
  worker.on("message", (response: PiWorkerMessage) => {
    if (response.type === "resolve-proxy") {
      void resolvePiSystemProxy(worker, response);
      return;
    }
    const request = pendingPiRequests.get(response.id);
    if (!request) return;
    clearTimeout(request.timer);
    pendingPiRequests.delete(response.id);
    request.resolve(response);
    if (pendingPiRequests.size === 0) worker.unref();
  });
  worker.on("error", (error) => rejectPiWorkerRequests(worker, error));
  worker.on("exit", (code) => {
    if (piWorker !== worker) return;
    rejectPiWorkerRequests(
      worker,
      new Error(`Pi worker exited unexpectedly (code ${code})`),
    );
  });
  return worker;
}

async function resolvePiSystemProxy(
  worker: Worker,
  request: PiWorkerProxyRequest,
): Promise<void> {
  try {
    const target = new URL(request.url);
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new Error("Pi provider URL must use HTTP or HTTPS.");
    }
    const proxyRules = await session.defaultSession.resolveProxy(target.href);
    if (piWorker === worker) {
      worker.postMessage({
        type: "proxy-resolution-result",
        requestId: request.requestId,
        proxyRules,
      });
    }
  } catch {
    if (piWorker === worker) {
      worker.postMessage({
        type: "proxy-resolution-result",
        requestId: request.requestId,
        error: "Could not resolve the Windows system proxy for the Pi provider.",
      });
    }
  }
}

function sendPiWorkerRequest(
  prompt: string,
  cwd: string,
  settings: Required<PiSettings>,
  proxy: PiProxyOptions,
  timeoutMs: number,
): Promise<PiWorkerResponse> {
  const worker = getPiWorker();
  const id = ++nextPiRequestId;
  worker.ref();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      rejectPiWorkerRequests(worker, new Error(`Pi timed out after ${timeoutMs} ms`));
      void worker.terminate();
    }, timeoutMs);

    pendingPiRequests.set(id, { resolve, reject, timer });
    try {
      worker.postMessage({
        type: "prompt",
        id,
        prompt,
        cwd,
        authPath: getAuthPath(),
        configDir: getConfigDirectory(),
        provider: settings.provider,
        model: settings.model,
        thinkingLevel: settings.thinkingLevel,
        proxy,
      });
    } catch (error) {
      clearTimeout(timer);
      pendingPiRequests.delete(id);
      if (pendingPiRequests.size === 0) worker.unref();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function sendPiWorkerPrewarm(
  settings: Required<PiSettings>,
): Promise<PiWorkerResponse> {
  const worker = getPiWorker();
  const id = ++nextPiRequestId;
  worker.ref();

  // 预热没有面向用户的超时：worker 崩溃时由 error/exit 回调统一收尾。
  return new Promise((resolve, reject) => {
    pendingPiRequests.set(id, { resolve, reject });
    try {
      worker.postMessage({
        type: "prewarm",
        id,
        authPath: getAuthPath(),
        configDir: getConfigDirectory(),
        provider: settings.provider,
        model: settings.model,
      });
    } catch (error) {
      pendingPiRequests.delete(id);
      if (pendingPiRequests.size === 0) worker.unref();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

let piPrewarmDone = false;

/**
 * Idle prewarm: load the Pi SDK and fill the runtime cache (keyed by
 * authPath/provider/model) so the first real prompt only pays session
 * creation plus the provider round trip. Never contacts the provider;
 * Pi being unconfigured or invalid is a normal state and stays silent.
 */
export async function prewarmPi(): Promise<void> {
  if (piPrewarmDone) return;
  try {
    const settings = readSettings();
    validateAuthFile(settings.provider);
    const response = await sendPiWorkerPrewarm(settings);
    if (response.ok) piPrewarmDone = true;
  } catch {
    // Settings changes between prewarm and first prompt naturally miss the
    // runtime cache (different key) and re-create; no invalidation needed.
  }
}

export function disposePiWorker(): void {
  const worker = piWorker;
  if (!worker) return;
  rejectPiWorkerRequests(worker, new Error("Pi worker stopped because FlowLink is closing"));
  void worker.terminate();
}

export async function piStatus(): Promise<{
  available: boolean;
  integration: "sdk";
  package: string;
  error?: string;
}> {
  try {
    const settings = readSettings();
    validateAuthFile(settings.provider);

    return {
      available: true,
      integration: "sdk",
      package: PACKAGE_NAME,
    };
  } catch (error) {
    return {
      available: false,
      integration: "sdk",
      package: PACKAGE_NAME,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runPiPrompt(
  options: PiPromptOptions,
): Promise<PiPromptResult> {
  const prompt = String(options.prompt || "").trim();

  if (!prompt) {
    throw new Error("Pi prompt cannot be empty");
  }

  if (prompt.length > 100_000) {
    throw new Error("Pi prompt exceeds the 100,000 character limit");
  }

  try {
    const settings = readSettings();
    validateAuthFile(settings.provider);
    const proxy = getPiProxyOptions();
    const timeoutMs = Math.max(
      5_000,
      Math.min(options.timeoutMs ?? settings.timeoutMs, 600_000),
    );

    const response = await sendPiWorkerRequest(
      prompt,
      options.cwd,
      settings,
      proxy,
      timeoutMs,
    );
    return response.ok
      ? { ok: true, text: response.text || "" }
      : { ok: false, text: "", error: response.error || "Pi agent request failed" };
  } catch (error) {
    return {
      ok: false,
      text: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
