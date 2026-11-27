import { z } from "zod";
import { getChannel } from "@/utils/channel";
import type { Vendor, VendorKind } from "@/utils/channel/types";
import { validateMediaProviderSource, validateTextProviderSource } from "@/utils/media/provider";

export const listSchema = z.strictObject({ kind: z.enum(["language", "media"]) });
export const sourceSchema = listSchema.extend({ id: z.string().max(96).regex(/^[a-z][a-zA-Z0-9]*$/) });

// ACT: 官方内置供应商在本地清单中注释下线：保留云端源码记录，不从内置列表发布，也不允许再走内置源码读取。
// weimetaai 唯元智创（WEIMETA AI）
// metaso 秘塔版 MiniMax
// apiMart APIMart
// compshare 优云智算
// deepSeek DeepSeek
const disabledVendorIds = new Set(["weimetaai", "metaso", "apimart", "compshare", "deepseek"]);
const weiyuntlFallbackVersions: Record<VendorKind, string> = { language: "1.0.0", media: "1.1.6" };

// ACT: 远端不可达时的基线清单项；正常路径下所有字段都由远端 TS 与响应头动态构建。
const weiyuntlVendor: Record<VendorKind, Vendor> = {
  language: {
    id: "weiyuntl",
    name: "智联天下",
    description: "智联天下提供 DeepSeek、GLM、Kimi、Qwen 文本生成 API。注册地址 https://token.weiyuntl.com/sign-up ，API Key 在控制台创建，接口文档 https://docs.token.weiyuntl.com",
    updateTime: Date.UTC(2026, 10, 27),
    version: weiyuntlFallbackVersions.language,
  },
  media: {
    id: "weiyuntl",
    name: "智联天下",
    description: "智联天下提供 Qwen Image 图片和 Seedance / Wan 视频生成 API。注册地址 https://token.weiyuntl.com/sign-up ，API Key 在控制台创建，接口文档 https://docs.token.weiyuntl.com",
    updateTime: Date.UTC(2026, 10, 25),
    version: weiyuntlFallbackVersions.media,
  },
};
const weiyuntlSourceUrls: Record<VendorKind, string> = {
  language: "https://res.token.weiyuntl.com/toonflow/weiyuntl-language.ts",
  media: "https://res.token.weiyuntl.com/toonflow/weiyuntl-media.ts",
};
const weiyuntlVendorPending: Partial<Record<VendorKind, Promise<Vendor>>> = {};

function descriptionFromReadme(readme: string | undefined) {
  if (!readme) return "";
  const lines = readme.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return (lines.length > 1 ? lines.slice(1) : lines).join(" ").replace(/\*\*/g, "").slice(0, 200);
}

function vendorFromSource(kind: VendorKind, parsed: { id: string; label: string; version?: string; readme?: string }, updateTime: number): Vendor {
  const fallback = weiyuntlVendor[kind];
  const version = parsed.version?.trim() || weiyuntlFallbackVersions[kind];
  return {
    id: parsed.id,
    name: parsed.label,
    description: descriptionFromReadme(parsed.readme) || fallback.description,
    updateTime,
    version: version.slice(0, 64),
  };
}

export async function list(kind: VendorKind, signal?: AbortSignal) {
  const data = await getChannel().getVendors(kind, { signal });
  const vendor = await readWeiyuntlVendor(kind);
  return [vendor, ...data.filter(item => {
    const id = item.id.toLowerCase();
    return !disabledVendorIds.has(id) && id !== vendor.id;
  })];
}

async function fetchWeiyuntlSource(kind: VendorKind, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(20000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(weiyuntlSourceUrls[kind], { signal: combined, cache: "no-store", redirect: "error" });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw Object.assign(new Error("读取智联天下供应商源码失败"), { status: 502 });
  }
  if (!response.ok) throw Object.assign(new Error("读取智联天下供应商源码失败"), { status: 502 });
  const source = await response.text();
  if (Buffer.byteLength(source, "utf8") > 2 * 1024 * 1024) throw Object.assign(new Error("供应商源码不能超过 2 MB"), { status: 502 });
  const modified = response.headers.get("last-modified");
  const parsedTime = modified ? Date.parse(modified) : NaN;
  const updateTime = Number.isSafeInteger(parsedTime) && parsedTime >= 0 ? parsedTime : weiyuntlVendor[kind].updateTime;
  return { source, updateTime };
}

async function readWeiyuntlVendor(kind: VendorKind) {
  if (!weiyuntlVendorPending[kind]) {
    // ACT: 不传调用方 signal，避免一个客户端断开让共享刷新失败；这里只用内部的 20 秒超时。
    weiyuntlVendorPending[kind] = fetchWeiyuntlSource(kind)
      .then(({ source, updateTime }) => {
        const parsed = kind === "language" ? validateTextProviderSource(source) : validateMediaProviderSource(source);
        const vendor = vendorFromSource(kind, parsed, updateTime);
        if (vendor.id !== weiyuntlVendor[kind].id) throw Object.assign(new Error("智联天下供应商源码 ID 与所选供应商不一致"), { status: 502 });
        return vendor;
      })
      .catch(() => weiyuntlVendor[kind])
      .finally(() => { weiyuntlVendorPending[kind] = undefined; });
  }
  return weiyuntlVendorPending[kind]!;
}

export async function getSource(id: string, kind: VendorKind, signal?: AbortSignal) {
  if (disabledVendorIds.has(id.toLowerCase())) {
    throw Object.assign(new Error("供应商已下线"), { status: 404 });
  }
  const source = id === weiyuntlVendor[kind].id
    ? (await fetchWeiyuntlSource(kind, signal)).source
    : (await getChannel().getVendorSource(id, kind, { signal })).source;
  // ACT: 在线源码只做 AST 校验，用户安装后才沿已有供应商运行入口加载。
  const parsed = kind === "language" ? validateTextProviderSource(source) : validateMediaProviderSource(source);
  if (parsed.id !== id || id.toLowerCase() === "toonflow") {
    throw Object.assign(new Error("供应商源码 ID 与所选供应商不一致或使用了账号保留 ID"), { status: 502 });
  }
  if ("configuration" in parsed) {
    const { configuration, ...metadata } = parsed;
    return { source, provider: { ...metadata, ...configuration } };
  }
  return { source, provider: parsed };
}
