import { commercialLlmPromptSha256 } from './commercial-llm.protocol';

export const COMMERCIAL_LLM_CASCADE_VERSION = 'commercial-qwen4b9b-shadow-v1';
export const COMMERCIAL_LLM_PRIMARY_TIMEOUT_MS = 3000;
export const COMMERCIAL_LLM_WORKSTATION_LEASE_MS = 10_000;
export const COMMERCIAL_LLM_WORKSTATION_HEARTBEAT_MS = 6000;
export const COMMERCIAL_LLM_WORKSTATION_FRAME_BYTES = 64 * 1024;
export const COMMERCIAL_LLM_WORKSTATION_REQUEST_BYTES = 32 * 1024;
export const COMMERCIAL_LLM_WORKSTATION_RESPONSE_BYTES = 16 * 1024;
const workstationTemplateSha256 =
  '7f0e529032c25183bcd66c7f238da2d377f43be754a94e2725a58c4e16d2ed67';
export const COMMERCIAL_LLM_WORKSTATION_IDENTITY = Object.freeze({
  protocolVersion: 1,
  modelAlias: 'qwen35-4b-commercial-primary',
  modelSha256: '8814232b85594dcd46c50e5b8b29324a7efe9e746edbe8a3d1df3d3fce7aad39',
  promptSha256: commercialLlmPromptSha256(workstationTemplateSha256),
  chatTemplateSha256: workstationTemplateSha256,
  runtimeVersion: 'llama.cpp-b11804',
  runtimeArtifactSha256: '0ed79c7a8ce3a5bead13b7c84c2524bb04d3027bcf36047a2ba4c2be5c8ce55c',
  runtimeSupportSha256: 'd55607757e3b8f8433aac08d072ab4dd54c09fbd6f304b013d6d86ed2e06996e',
});

const prefix = 'commercial-llm-shadow:v2:workstation';
export const COMMERCIAL_LLM_WORKSTATION_KEYS = Object.freeze({
  lease: `${prefix}:lease`,
  heartbeat: `${prefix}:heartbeat`,
  request: `${prefix}:request`,
  response: `${prefix}:response`,
});

export function commercialLlmWorkstationIdentityMatches(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === Object.keys(COMMERCIAL_LLM_WORKSTATION_IDENTITY).length &&
    Object.entries(COMMERCIAL_LLM_WORKSTATION_IDENTITY).every(
      ([key, expected]) => record[key] === expected,
    )
  );
}
