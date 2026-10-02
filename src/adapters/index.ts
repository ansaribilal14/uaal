/**
 * Adapter registry bootstrap (spec §37): built-in adapters register
 * platform, capabilities, routes, normalizers and verifiers without any
 * core modification. Future adapters (Instagram, TikTok, Facebook,
 * Telegram) plug in the same way — see docs/ADAPTER_GUIDE.md. They are
 * deliberately NOT registered here (spec §38: do not pretend they exist).
 */
import type { PlatformAdapter, UAALConfig } from "../core/contracts.js";
import { HttpLayer } from "../core/http.js";
import { YouTubeAdapter } from "./youtube/adapter.js";
import { XAdapter } from "./x/adapter.js";
import { GenericWebAdapter } from "./generic-web/adapter.js";
import { RedditAdapter } from "./reddit/adapter.js";

export function getBuiltinAdapters(config: UAALConfig): PlatformAdapter[] {
  const http = new HttpLayer({ politenessMs: config.politenessMs ?? 400, allowLoopback: config.allowLoopbackHttp === true });
  return [new YouTubeAdapter(http), new XAdapter(http), new RedditAdapter(http), new GenericWebAdapter(http)];
}

export { YouTubeAdapter, XAdapter, RedditAdapter, GenericWebAdapter };
