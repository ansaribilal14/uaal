/**
 * Environment detector (spec §12): identifies non-sensitive execution
 * characteristics used ONLY for route compatibility. Collects no personal
 * information; never fingerprints users.
 */
import { findBinary } from "./security/exec.js";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import type { EnvironmentProfile } from "./contracts.js";

const CI_VARS: Array<[string, string]> = [
  ["GITHUB_ACTIONS", "github-actions"],
  ["GITLAB_CI", "gitlab-ci"],
  ["CIRCLECI", "circleci"],
  ["TRAVIS", "travis"],
  ["JENKINS_URL", "jenkins"],
  ["BUILDKITE", "buildkite"],
  ["TF_BUILD", "azure-devops"],
  ["BITBUCKET_BUILD_NUMBER", "bitbucket"],
  ["DRONE", "drone"],
  ["CI", "generic-ci"]
];

const CLOUD_VARS: Array<[string, string]> = [
  ["AWS_EXECUTION_ENV", "aws"],
  ["AWS_LAMBDA_FUNCTION_NAME", "aws-lambda"],
  ["K_SERVICE", "gcp-cloudrun"],
  ["GOOGLE_CLOUD_PROJECT", "gcp"],
  ["FUNCTIONS_WORKER_RUNTIME", "azure-functions"],
  ["WEBSITE_INSTANCE_ID", "azure"]
];

export async function detectEnvironment(overrides?: Partial<EnvironmentProfile>): Promise<EnvironmentProfile> {
  const binaries: Record<string, string | false> = {};
  for (const b of ["yt-dlp", "ffmpeg", "ffprobe", "python3", "docker", "curl"]) {
    binaries[b] = await findBinary(b);
  }

  let containerized = false;
  try {
    await fs.access("/.dockerenv");
    containerized = true;
  } catch {
    /* not docker */
  }
  if (!containerized) {
    try {
      const cgroup = await fs.readFile("/proc/1/cgroup", "utf8").catch(() => "");
      if (cgroup.includes("docker") || cgroup.includes("containerd") || cgroup.includes("kubepods")) containerized = true;
    } catch {
      /* not linux */
    }
  }

  let ci = false;
  let ciProvider: string | undefined;
  for (const [v, name] of CI_VARS) {
    if (process.env[v]) {
      ci = true;
      ciProvider = name;
      break;
    }
  }

  let cloud: string | undefined;
  for (const [v, name] of CLOUD_VARS) {
    if (process.env[v]) {
      cloud = name;
      break;
    }
  }

  const envClass: EnvironmentProfile["envClass"] = ci ? "ci" : containerized ? "container" : cloud ? "cloud" : "local";

  const network = await probeNetwork();

  const profile: EnvironmentProfile = {
    os: os.platform(),
    osVersion: os.release(),
    arch: os.arch(),
    runtime: "node",
    runtimeVersion: process.version,
    containerized,
    ci,
    ciProvider,
    cloud,
    envClass,
    binaries,
    network,
    fs: { tmpWritable: await probeTmpWritable() },
    detectedAt: new Date().toISOString(),
    ...overrides
  };
  return profile;
}

async function probeNetwork(): Promise<{ ipv4: boolean; ipv6: boolean }> {
  const dnsPromises = await import("node:dns/promises");
  const result = { ipv4: false, ipv6: false };
  await Promise.all([
    dnsPromises
      .lookup("api.github.com", { family: 4 })
      .then(() => (result.ipv4 = true))
      .catch(() => {}),
    dnsPromises
      .lookup("api.github.com", { family: 6 })
      .then(() => (result.ipv6 = true))
      .catch(() => {})
  ]);
  return result;
}

async function probeTmpWritable(): Promise<boolean> {
  try {
    const testFile = `${os.tmpdir()}/.uaal-write-test-${Date.now()}`;
    await fs.writeFile(testFile, "ok");
    await fs.unlink(testFile);
    return true;
  } catch {
    return false;
  }
}
