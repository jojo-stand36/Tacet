// A line-based interactive CLI for PTY adapter tests (#15): shows `fake> `, answers each line.
// `SLOW` prints for about five seconds; Ctrl-C drops it and shows the prompt again. `ENV` prints
// the names (never values) of its environment variables. `EXIT` exits with code 3. `PRINT_SECRET`
// prints the value of FAKE_SECRET. With FAKE_SLOW_CANCEL set, Ctrl-C takes a second: the turn
// goes on printing meanwhile, and lines typed meanwhile are ignored, as a busy CLI might.
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'fake> ' });
let slow;
const stop = () => {
  clearInterval(slow);
  slow = undefined;
};
let cancelling = false;
rl.on('SIGINT', () => {
  if (process.env.FAKE_SLOW_CANCEL) {
    cancelling = true;
    setTimeout(() => {
      stop();
      process.stdout.write('^C cancelled\n');
      cancelling = false;
      rl.prompt();
    }, 1000);
    return;
  }
  stop();
  process.stdout.write('^C\n');
  rl.prompt();
});
rl.on('line', (line) => {
  if (cancelling) return;
  if (line === 'PRINT_SECRET') {
    console.log(`value: ${process.env.FAKE_SECRET}`);
    rl.prompt();
    return;
  }
  if (line === 'SLOW') {
    let n = 0;
    slow = setInterval(() => {
      process.stdout.write(`slow ${++n}\n`);
      if (n === 25) {
        stop();
        rl.prompt();
      }
    }, 200);
    return;
  }
  if (line === 'EXIT') process.exit(3);
  if (line === 'ENV') console.log(`names: ${Object.keys(process.env).sort().join(',')}`);
  else console.log(`echo: ${line}`);
  rl.prompt();
});
setTimeout(() => rl.prompt(), 200);
