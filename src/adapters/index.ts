/**
 * Adapter registry bootstrap (spec §37): built-in adapters register
 * platform, capabilities, routes, normalizers and verifiers without any
 * core modification. v2 registers seven platform adapters — youtube,
 * x, reddit, tiktok, douyin, instagram, threads — plus the generic-web
 * catch-all. Nothing here pretends a capability exists that a route
 * does not actually deliver.
 */
import type { PlatformAdapter, UAALConfig } from "../core/contracts.js";
import { HttpLayer } from "../core/http.js";
import { YouTubeAdapter } from "./youtube/adapter.js";
import { XAdapter } from "./x/adapter.js";
import { GenericWebAdapter } from "./generic-web/adapter.js";
import { RedditAdapter } from "./reddit/adapter.js";
import { TikTokAdapter } from "./tiktok/adapter.js";
import { DouyinAdapter } from "./douyin/adapter.js";
import { InstagramAdapter } from "./instagram/adapter.js";
import { ThreadsAdapter } from "./threads/adapter.js";

export function getBuiltinAdapters(config: UAALConfig): PlatformAdapter[] {
  const http = new HttpLayer({ politenessMs: config.politenessMs ?? 400, allowLoopback: config.allowLoopbackHttp === true });
  return [
    new YouTubeAdapter(http, config),
    new XAdapter(http),
    new TikTokAdapter(http),
    new DouyinAdapter(http),
    new InstagramAdapter(http),
    new ThreadsAdapter(http),
    new RedditAdapter(http),
    new GenericWebAdapter(http)
  ];
}

export { YouTubeAdapter, XAdapter, RedditAdapter, TikTokAdapter, DouyinAdapter, InstagramAdapter, ThreadsAdapter, GenericWebAdapter };
