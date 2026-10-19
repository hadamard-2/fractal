import type { AccessApi, AttachmentsApi, ConversationApi, ModelsApi } from '@/shared/conversation-contract';
import type { ChangesApi } from '@/shared/changes-contract';
import type { FilesApi } from '@/shared/files-contract';
import type { MapApi } from '@/shared/map-contract';
import type { FractalSettingsApi } from '@/shared/settings-contract';
import type { TerminalApi } from '@/shared/terminal-contract';

declare global {
  interface Window {
    fractal: {
      conversations: ConversationApi;
      models: ModelsApi;
      access: AccessApi;
      map: MapApi;
      settings: FractalSettingsApi;
      terminals: TerminalApi;
      attachments: AttachmentsApi;
      files: FilesApi;
      changes: ChangesApi;
    };
  }
}

export {};
