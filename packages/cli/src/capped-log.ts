import { fstatSync, ftruncateSync, readSync, writeSync } from 'node:fs';

/** The most the background run's log may hold (#273). */
export const LOG_CAP_BYTES = 4 * 1024 * 1024;

/** The end of `buffer`, at most `max` bytes, starting at a whole UTF-8 character. */
function lastBytes(buffer: Buffer, max: number): Buffer {
  let start = Math.max(0, buffer.length - max);
  // Continuation bytes are 10xxxxxx: move past them to the start of a character.
  while (start < buffer.length && ((buffer[start] as number) & 0xc0) === 0x80) start++;
  return buffer.subarray(start);
}

/**
 * Lines to `fd`, the background run's log (#273): opened for reading and appending, its standard
 * output and error. Before each line the file's own size is checked, so bytes written to it
 * around this writer (a warning or a crash Node prints) count too. A line that would take it past
 * `maxBytes` first cuts the file to its newest half, from a whole line, after a note that earlier
 * lines were dropped. The log stays under the cap and always ends with the latest lines; a line
 * longer than half the cap keeps its end.
 */
export function cappedLog(fd: number, maxBytes = LOG_CAP_BYTES): (line: string) => void {
  const note = Buffer.from(`[earlier lines dropped to keep this log under ${maxBytes} bytes]\n`);
  const half = Math.floor(maxBytes / 2);
  if (note.length >= half) throw new Error(`a log cap of ${maxBytes} bytes is too small`);
  return (line) => {
    const text = lastBytes(Buffer.from(`${line}\n`), half);
    const size = fstatSync(fd).size;
    if (size + text.length > maxBytes) {
      // The newest lines that fit beside the note in half the cap.
      const keep = Math.min(size, half - note.length);
      const tail = Buffer.alloc(keep);
      const read = readSync(fd, tail, 0, keep, size - keep);
      const newline = tail.subarray(0, read).indexOf(10);
      const kept = newline >= 0 ? tail.subarray(newline + 1, read) : Buffer.alloc(0);
      // Opened for appending: once cut, the writes go on from its new end.
      ftruncateSync(fd, 0);
      writeSync(fd, Buffer.concat([note, kept]));
    }
    writeSync(fd, text);
  };
}
