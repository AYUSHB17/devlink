import { spawn } from 'child_process';

/** Opens the platform's terminal and runs a user-defined command (e.g. `ssh me@192.168.1.20`). */
export function runInTerminal(command: string): void {
  if (!command.trim()) throw new Error('empty command');
  if (process.platform === 'darwin') {
    const esc = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    spawn('osascript', ['-e', `tell application "Terminal" to do script "${esc}"`, '-e', 'tell application "Terminal" to activate'], {
      stdio: 'ignore',
      detached: true,
    }).unref();
  } else if (process.platform === 'win32') {
    // Windows Terminal if present, otherwise a plain cmd window
    spawn('cmd.exe', ['/c', 'start', '"DevLink"', 'cmd.exe', '/k', command], {
      stdio: 'ignore',
      detached: true,
      windowsVerbatimArguments: true,
    }).unref();
  } else {
    throw new Error('terminal shortcuts are only supported on macOS and Windows');
  }
}
