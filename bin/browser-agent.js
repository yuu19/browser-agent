#!/usr/bin/env node

import { main } from '../src/cli.js';

main(process.argv.slice(2)).catch((error) => {
  console.error(`browser-agent: ${error.message}`);
  if (process.env.BROWSER_AGENT_DEBUG === '1' && error.stack) {
    console.error(error.stack);
  }
  process.exitCode = 1;
});
