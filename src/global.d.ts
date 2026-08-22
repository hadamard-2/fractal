import type { FractalAgentApi } from '@/shared/agent-contract';

declare global {
  interface Window {
    fractal: { agent: FractalAgentApi };
  }
}

export {};
