import { parseArgs } from 'node:util';
import { openStore } from './store.mjs';

const usage = `Usage:
  npm run moderate -- stats
  npm run moderate -- list
  npm run moderate -- show <receipt>
  npm run moderate -- publish <receipt> --title <title> --summary <summary>
  npm run moderate -- discard <receipt>`;

function main(args) {
  const [command, ...rest] = args;
  if ((!command || ['help', '--help', '-h'].includes(command)) && !rest.length) {
    console.log(usage);
    return;
  }
  if (!['stats', 'list', 'show', 'publish', 'discard'].includes(command)) throw new Error(usage);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: command === 'publish' ? { title: { type: 'string' }, summary: { type: 'string' } } : {},
  });
  if (positionals.length !== (['list', 'stats'].includes(command) ? 0 : 1)) throw new Error(usage);
  const receipt = positionals[0]?.toUpperCase();
  if (receipt && !/^DR-[0-9A-F]{32}$/.test(receipt)) throw new Error('Invalid receipt.');
  if (command === 'publish' && (!values.title || !values.summary)) throw new Error(usage);

  const store = openStore();
  try {
    switch (command) {
      case 'stats':
        console.log(JSON.stringify(store.stats(), null, 2));
        break;
      case 'list':
        console.log(JSON.stringify(store.listPending(), null, 2));
        break;
      case 'show':
        console.log(JSON.stringify(store.getReport(receipt), null, 2));
        break;
      case 'publish':
        console.log('Published: /archive#' + store.publishReport(receipt, values.title, values.summary));
        break;
      case 'discard':
        store.discardReport(receipt);
        console.log('Record discarded.');
        break;
    }
  } finally {
    store.close();
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
