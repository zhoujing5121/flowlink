import { parentPort } from "node:worker_threads";
import { join } from "node:path";

import { perf } from "../infra/perf.js";
import type { PiSkillConfig } from "./pi-config.js";
import { appLog, appLogFields } from "../infra/app-logger.js";
import {
	assertGenerationToolRegistry,
	buildReadAllowlist,
	createRestrictedReadTool,
	toSdkSkills,
} from "./pi-skill-session.js";

interface PiRuntimeConfig {
  authPath: string;
  configDir: string;
  provider: string;
  model: string;
}

interface PiWorkerPromptRequest extends PiRuntimeConfig {
  type: "prompt";
  id: number;
  prompt: string;
  systemPrompt: string;
  cwd: string;
  thinkingLevel: "off" | "low" | "medium" | "high";
  proxy:
    | { mode: "environment" }
    | { mode: "system" }
    | { mode: "explicit"; url: string };
  /** 生成模式（pi:generateFlow / pi:repairFlow）：注入内置 Skills 并仅暴露受限 read 工具。 */
  skills?: PiSkillConfig[];
}

/** 预热请求：只加载 SDK 并按 key 填充运行时缓存，不发起 provider 请求。 */
interface PiWorkerPrewarmRequest extends PiRuntimeConfig {
  type: "prewarm";
  id: number;
}

type PiWorkerRequest = PiWorkerPromptRequest | PiWorkerPrewarmRequest;

interface PiProxyResolutionResult {
  type: "proxy-resolution-result";
  requestId: number;
  proxyRules?: string;
  error?: string;
}

if (!parentPort) {
  throw new Error("Pi agent worker must be started as a worker thread");
}
const workerPort = parentPort;

interface PiSessionLike {
  messages: Array<{
    role: string;
    errorMessage?: string;
    stopReason?: string;
  }>;
  prompt(message: string): Promise<void>;
  getLastAssistantText(): string | undefined;
  getActiveToolNames(): string[];
  dispose(): void;
}

type PiSdk = typeof import("@earendil-works/pi-coding-agent");
type ModelRuntime = import("@earendil-works/pi-coding-agent").ModelRuntime;
type PiModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;
let piSdkPromise: Promise<PiSdk> | undefined;
let runtimePromise: Promise<{
  pi: PiSdk;
  modelRuntime: ModelRuntime;
  model: PiModel;
}> | undefined;
let runtimeKey = "";
let nextProxyRequestId = 0;
let configuredProxyKey: string | undefined;
const pendingProxyResolutions = new Map<
  number,
  { resolve: (proxyRules: string) => void; reject: (error: Error) => void }
>();

async function loadPiSdk(): Promise<PiSdk> {
  if (!piSdkPromise) {
    piSdkPromise = (async () => {
      const { install } = await import("undici");
      install();
      return import("@earendil-works/pi-coding-agent");
    })();
  }
  return piSdkPromise;
}

function requestSystemProxy(url: string): Promise<string> {
  const requestId = ++nextProxyRequestId;
  return new Promise((resolve, reject) => {
    pendingProxyResolutions.set(requestId, { resolve, reject });
    workerPort.postMessage({ type: "resolve-proxy", requestId, url });
  });
}

async function createProxyDispatcher(
  proxy: PiWorkerPromptRequest["proxy"],
  baseUrl: string,
) {
  const { Agent, EnvHttpProxyAgent, ProxyAgent, Socks5ProxyAgent, setGlobalDispatcher } =
    await import("undici");
  const setDispatcher = (
    key: string,
    dispatcher: import("undici").Dispatcher,
  ) => {
    if (configuredProxyKey === key) return;
    setGlobalDispatcher(dispatcher);
    configuredProxyKey = key;
  };

  if (proxy.mode === "environment") {
    setDispatcher("environment", new EnvHttpProxyAgent());
    return;
  }

  if (proxy.mode === "explicit") {
    let url: URL;
    try {
      url = new URL(proxy.url);
    } catch {
      throw new Error("--pi-proxy must be a valid http://, https://, or socks5:// URL.");
    }
    if (url.protocol === "socks5:") {
      setDispatcher(`explicit:${url.href}`, new Socks5ProxyAgent(url));
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("--pi-proxy must use http://, https://, or socks5://.");
    }
    setDispatcher(`explicit:${url.href}`, new ProxyAgent(url.href));
    return;
  }

  const rules = await requestSystemProxy(baseUrl);
  const route = rules.split(";")[0]?.trim();
  if (!route) throw new Error("Windows returned no system proxy route for Pi.");
  if (route.toUpperCase() === "DIRECT") {
    setDispatcher(`system:${route}`, new Agent());
    return;
  }

  const [type, address] = route.split(/\s+/, 2);
  if (!type || !address) {
    throw new Error("Windows returned an unsupported system proxy route for Pi.");
  }
  if (type.toUpperCase() === "SOCKS5") {
    setDispatcher(`system:${route}`, new Socks5ProxyAgent(`socks5://${address}`));
    return;
  }
  if (type.toUpperCase() === "PROXY" || type.toUpperCase() === "HTTP") {
    setDispatcher(`system:${route}`, new ProxyAgent(`http://${address}`));
    return;
  }
  if (type.toUpperCase() === "HTTPS") {
    setDispatcher(`system:${route}`, new ProxyAgent(`https://${address}`));
    return;
  }
  throw new Error(`Windows returned an unsupported system proxy type: ${type}.`);
}

async function createRuntime(request: PiRuntimeConfig) {
  const key = `${request.authPath}\0${request.provider}\0${request.model}`;
  if (runtimePromise && runtimeKey === key) return runtimePromise;

  runtimeKey = key;
  runtimePromise = (async () => {
    const timing = perf("pi:runtime");
    const pi = await loadPiSdk();
    timing.mark("sdk-imported");
    const modelsPath =
      request.provider === "custom"
        ? join(request.configDir, "models.json")
        : undefined;
    const modelRuntime = await pi.ModelRuntime.create({
      authPath: request.authPath,
      modelsPath,
    });
    timing.mark("model-runtime-created");
    const model = modelRuntime.getModel(request.provider, request.model);
    if (!model) {
      throw new Error(
        `Pi does not recognize model "${request.provider}/${request.model}". ` +
          "Check the model ID and update the Pi model catalog if needed.",
      );
    }
    return { pi, modelRuntime, model };
  })();

  try {
    return await runtimePromise;
  } catch (error) {
    runtimePromise = undefined;
    runtimeKey = "";
    throw error;
  }
}

async function createResourceLoader(
  pi: PiSdk,
  request: PiWorkerPromptRequest,
) {
  // 生成模式：noSkills 短路默认/用户/项目发现后，skillsOverride 恒被应用——
  // 只有 FlowLink 内置 Skills 进入会话（SDK 1.5.1 源码级行为）。
  const generationSkills = request.skills ? toSdkSkills(request.skills) : undefined;
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: request.cwd,
    agentDir: request.configDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => request.systemPrompt,
    appendSystemPromptOverride: () => [],
    ...(generationSkills
      ? {
          skillsOverride: () => ({
            skills: generationSkills,
            diagnostics: [],
          }),
        }
      : {}),
  });
  await resourceLoader.reload();
  return resourceLoader;
}

async function runPrompt(request: PiWorkerPromptRequest): Promise<string> {
  if (!request.systemPrompt || !request.systemPrompt.trim()) {
    throw new Error("Pi system prompt is missing; check config/prompts.json.");
  }
  const timing = perf("pi:prompt");
  const { pi, modelRuntime, model } = await createRuntime(request);
  await createProxyDispatcher(request.proxy, model.baseUrl);
  const resourceLoader = await createResourceLoader(pi, request);
  // 会话按请求分两种模式：
  // - 文本模式（advice 等非生成调用）：noTools "all"，模型无任何工具、无 Skills。
  // - 生成模式（pi:generateFlow / pi:repairFlow）：noTools "builtin" 剔除内置工具但保留
  //   customTools，tools allowlist ["read"] 与以 "read" 注册的自定义受限工具组合，
  //   最终模型可调用工具仅此一个（创建后断言注册表）。
  const generated = request.skills !== undefined;
  const skills = request.skills;
  const created = await pi.createAgentSession({
    cwd: request.cwd,
    model,
    modelRuntime,
    sessionManager: pi.SessionManager.inMemory(),
    resourceLoader,
    ...(generated
      ? {
          noTools: "builtin" as const,
          tools: ["read"],
          customTools: [createRestrictedReadTool({ allowlist: buildReadAllowlist(skills!) })],
        }
      : { noTools: "all" as const }),
    thinkingLevel: request.thinkingLevel,
  });
  timing.mark("session-created");
  const session = created.session as PiSessionLike;
  if (generated) {
    const activeTools = session.getActiveToolNames();
    appLog(
      "info",
      "pi-worker",
      appLogFields({
        req: request.id,
        mode: "generation",
        skills: skills!.map((skill) => skill.name).join("|"),
        activeTools: activeTools.join(","),
      }),
    );
    assertGenerationToolRegistry(activeTools);
  } else {
    appLog("info", "pi-worker", appLogFields({ req: request.id, mode: "text", tools: "none" }));
  }

  try {
    await session.prompt(request.prompt);
    timing.mark("provider-response");
    const text = session.getLastAssistantText() || "";
    if (text.trim()) return text;

    const lastAssistant = session.messages
      .slice()
      .reverse()
      .find((message) => message.role === "assistant");
    const providerError = lastAssistant?.errorMessage?.trim();
    const stopReason = lastAssistant?.stopReason;
    throw new Error(
      providerError
        ? `Pi provider request failed: ${providerError}`
        : `Pi returned no text${stopReason ? ` (stop reason: ${stopReason})` : ""}. ` +
            "Check the provider, model availability, and API credentials.",
    );
  } finally {
    session.dispose();
  }
}

parentPort.on("message", (message: PiWorkerRequest | PiProxyResolutionResult) => {
  if (message.type === "proxy-resolution-result") {
    const pending = pendingProxyResolutions.get(message.requestId);
    if (!pending) return;
    pendingProxyResolutions.delete(message.requestId);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.proxyRules || "");
    return;
  }

  const request = message;
  if (request.type === "prewarm") {
    void createRuntime(request).then(
      () =>
        workerPort.postMessage({
          type: "prompt-result",
          id: request.id,
          ok: true,
          text: "",
        }),
      (error: unknown) =>
        workerPort.postMessage({
          type: "prompt-result",
          id: request.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
    return;
  }
  void runPrompt(request).then(
    (text) => {
      appLog("info", "pi-worker", appLogFields({ req: request.id, ok: true, textChars: text.length }));
      workerPort.postMessage({ type: "prompt-result", id: request.id, ok: true, text });
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      appLog("error", "pi-worker", appLogFields({ req: request.id, ok: false, error: message.slice(0, 300) }));
      workerPort.postMessage({
        type: "prompt-result",
        id: request.id,
        ok: false,
        error: message,
      });
    },
  );
});
