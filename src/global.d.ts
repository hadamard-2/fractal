import type { FractalAgentApi } from '@/shared/agent-contract';
import type { ConversationApi } from '@/shared/conversation-contract';
import type { FractalSettingsApi } from '@/shared/settings-contract';

declare global {
  interface Window {
    fractal: {
      conversations: ConversationApi;
      settings: FractalSettingsApi;
      /** @deprecated Compile-only until the renderer migration; not exposed by preload. */
      agent: FractalAgentApi;
    };
  }
}

export {};
