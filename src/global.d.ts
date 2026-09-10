import type { FractalAgentApi } from '@/shared/agent-contract';
import type { FractalSettingsApi } from '@/shared/settings-contract';

declare global {
  interface Window {
    fractal: { agent: FractalAgentApi; settings: FractalSettingsApi };
  }
}

export {};
