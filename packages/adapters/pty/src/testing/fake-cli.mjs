// A line-based interactive CLI for PTY adapter tests (#15): shows `fake> `, answers each line.
// `SLOW` prints for about five seconds; Ctrl-C drops it and shows the prompt again. `ENV` prints
// the names (never values) of its environment variables. `EXIT` exits with code 3.
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'fake> ' });
let slow;
const stop = () => {
  clearInterval(slow);
  slow = undefined;
};
rl.on('SIGINT', () => {
  stop();
  process.stdout.write('^C\n');
  rl.prompt();
});
rl.on('line', (line) => {
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
