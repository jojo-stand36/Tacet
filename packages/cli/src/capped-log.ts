import { ftruncateSync, writeSync } from 'node:fs';

/** The most the background run's log may hold (#273). */
export const LOG_CAP_BYTES = 4 * 1024 * 1024;

/**
 * Lines to `fd`, a log opened for appending, kept under `maxBytes` (#273): a line that would take
 * it past the cap empties the file first, with a note that earlier lines were dropped, so the log
 * always holds the newest lines. The background run of `tacet run --detach` (#201) writes its
 * output through this; anything written to the descriptor around it (a crash before this exists)
 * still lands in the same file.
 */
export function cappedLog(fd: number, maxBytes = LOG_CAP_BYTES): (line: string) => void {
  let size = 0;
  return (line) => {
    const text = `${line}\n`;
    const bytes = Buffer.byteLength(text);
    if (size + bytes > maxBytes) {
      // Opened for appending: once emptied, the next write goes to its start.
      ftruncateSync(fd, 0);
      const note = `[earlier lines dropped: this log keeps the last ${maxBytes} bytes]\n`;
      writeSync(fd, note);
      size = Buffer.byteLength(note);
    }
    // A single line over the cap is cut to fit, from its end.
    const buffer = Buffer.from(text);
    size += writeSync(fd, size + bytes > maxBytes ? buffer.subarray(-(maxBytes - size)) : buffer);
  };
}
