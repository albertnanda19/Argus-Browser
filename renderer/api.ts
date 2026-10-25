import { healthResponseSchema, type ApiInfo, type HealthResponse } from "../shared/contracts";

const HEALTH_TIMEOUT_MS = 2000;

export async function fetchHealth(apiInfo: ApiInfo): Promise<HealthResponse> {
  const response = await fetch(`${apiInfo.baseUrl}/v1/health`, {
    headers: {
      Authorization: `Bearer ${apiInfo.token}`,
    },
    signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Health request failed with status ${response.status}.`);
  }

  return healthResponseSchema.parse(await response.json());
}
