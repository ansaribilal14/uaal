/**
 * In-process usage: an agent runtime embeds UAAL directly — no subprocess,
 * no HTTP hop. This is the parent-agent → UAAL tool path (spec §24).
 */
import { UAAL } from "../index.js";
import type { UAALEnvelope } from "../index.js";

async function main(): Promise<void> {
  const uaal = await UAAL.create({
    config: {
      logLevel: "info",
      stateDir: "./state",
      artifactsDir: "./artifacts"
    }
  });

  // 1. "Tell me what this resource is" — no downloads (spec §18).
  const metadata: UAALEnvelope = await uaal.inspect({
    resource: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    capability: "metadata"
  });
  process.stdout.write(`${JSON.stringify({ status: metadata.status, title: (metadata.resource?.content as { title?: string })?.title }, null, 2)}\n`);

  // 2. "Get the actual media" — verified artifact or honest failure.
  const media: UAALEnvelope = await uaal.acquire({
    resource: "https://x.com/SpaceX/status/1732824684683784516",
    capability: "acquire",
    output: { format: ["video"] },
    policy: { maxRouteAttempts: 4 }
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        status: media.status,
        artifacts: media.artifacts?.map((a) => ({ id: a.artifactId, type: a.type, size: a.size, checksum: a.checksum })),
        verified: media.verification?.verified
      },
      null,
      2
    )}\n`
  );
  // The agent never needed to know which platform adapter, route, fallback,
  // parser, or verifier was used internally (spec §79).
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
