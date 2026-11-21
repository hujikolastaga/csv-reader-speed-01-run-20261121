// Entrypoint for csv-reader-speed-01-run-20261121 on Node 22.
import { closeSync, openSync, readFileSync, writeFileSync, writevSync } from 'node:fs';
import { join } from 'node:path';
import { run, runJsonCases } from './solve.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const inBuf = readFileSync(join(INPUT_DIR, 'cases.json'));
const chunks = runJsonCases(inBuf);

if (chunks === null) {
  const cases = JSON.parse(inBuf.toString('utf8'));
  const answers = [];
  for (let i = 0; i < cases.length; i++) answers.push(run(cases[i].input));
  writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
} else {
  const fd = openSync(join(OUTPUT_DIR, 'answers.json'), 'w');
  try {
    const MAX_IOV = 512;
    let idx = 0;
    while (idx < chunks.length) {
      const end = Math.min(chunks.length, idx + MAX_IOV);
      const batch = chunks.slice(idx, end);
      let expected = 0;
      for (let i = 0; i < batch.length; i++) expected += batch[i].byteLength;
      let written = writevSync(fd, batch);
      while (written < expected) {
        let skipped = 0;
        const rem = [];
        for (let i = 0; i < batch.length; i++) {
          const buf = batch[i];
          if (skipped + buf.byteLength <= written) {
            skipped += buf.byteLength;
          } else {
            rem.push(skipped < written ? buf.subarray(written - skipped) : buf);
            skipped = written;
          }
        }
        expected -= written;
        written = writevSync(fd, rem);
        batch.splice(0, batch.length, ...rem);
      }
      idx = end;
    }
  } finally {
    closeSync(fd);
  }
}
