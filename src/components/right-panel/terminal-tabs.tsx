export type TerminalTab = {
  id: string;
  // The project directory the terminal was asked to start in.
  cwd: string;
  // The lowest number free among open tabs when this one was created; it
  // never changes while the tab is open, so labels don't shift as others close.
  number: number;
  // Text to paste at the shell's first prompt, cleared once it has been placed.
  paste?: string;
  // The shell's name, once it has started.
  shell?: string;
  // The directory the shell actually started in, once known.
  startedIn?: string;
  exited?: boolean;
};

// A lone terminal needs no number; once there are several, each shows its own.
export function terminalTabLabel(tab: TerminalTab, openCount: number): string {
  return openCount > 1 ? `Terminal ${tab.number}` : 'Terminal';
}

export function nextTerminalNumber(tabs: TerminalTab[]): number {
  const used = new Set(tabs.map((tab) => tab.number));
  let number = 1;
  while (used.has(number)) number++;
  return number;
}
