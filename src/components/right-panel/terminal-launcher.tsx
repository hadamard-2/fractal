import { createContext, useContext } from 'react';

/**
 * Opens a new terminal in the right panel with `text` waiting at its prompt,
 * unrun. Null outside the right workspace, or when no project is open.
 */
export type OpenTerminalWith = (text: string) => void;

export const TerminalLauncherContext = createContext<OpenTerminalWith | null>(null);

export const useTerminalLauncher = () => useContext(TerminalLauncherContext);
