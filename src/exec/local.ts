/**
 * Local execution provider (spec §29): routes run in-process. Remote
 * providers implement the same ExecutionProvider contract — see
 * src/workers/protocol.ts and docs/REMOTE_WORKERS.md.
 */
import type { AccessRoute, EnvironmentProfile, ExecutionContext, ExecutionProvider, ResourceRequest, RouteResult } from "../core/contracts.js";

export class LocalExecutionProvider implements ExecutionProvider {
  readonly id = "local" as const;

  supports(route: AccessRoute, environment: EnvironmentProfile): boolean {
    return route.environmentCompatibility.local === true;
  }

  async executeRoute(route: AccessRoute, request: ResourceRequest, ctx: ExecutionContext): Promise<RouteResult> {
    return route.execute(request, ctx);
  }
}
