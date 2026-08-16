import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { DashboardProblem } from "./problem.js";

export const DASHBOARD_ASSET_NAMES = ["dashboard.html", "dashboard.css", "dashboard.js"] as const;
export type DashboardAssetName = (typeof DASHBOARD_ASSET_NAMES)[number];

export interface DashboardAsset {
  readonly body: Buffer;
  readonly contentType: string;
  readonly cacheControl: "no-store" | "no-cache";
}

const metadata: Readonly<Record<DashboardAssetName, Omit<DashboardAsset, "body">>> = {
  "dashboard.html": { contentType: "text/html; charset=utf-8", cacheControl: "no-store" },
  "dashboard.css": { contentType: "text/css; charset=utf-8", cacheControl: "no-cache" },
  "dashboard.js": { contentType: "text/javascript; charset=utf-8", cacheControl: "no-cache" },
};

function assetPath(name: DashboardAssetName): string {
  const candidates = [
    fileURLToPath(new URL(`./assets/${name}`, import.meta.url)),
    fileURLToPath(new URL(`../assets/${name}`, import.meta.url)),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (path === undefined) {
    throw new DashboardProblem(
      503,
      "dashboard_asset_unavailable",
      "Service Unavailable",
      `packaged Dashboard asset ${name} is unavailable`,
    );
  }
  return path;
}

export function loadDashboardAsset(name: DashboardAssetName): DashboardAsset {
  return { body: readFileSync(assetPath(name)), ...metadata[name] };
}
