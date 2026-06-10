/**
 * Standalone config wizard — runs the interactive onboarding and exits
 * without starting the bot. Used by install.sh and the management script's
 * `setup` subcommand:
 *
 *   bun scripts/setup.ts                # first-time setup
 *   bun scripts/setup.ts --reconfigure  # edit existing config
 */

import { runOnboarding } from '../src/onboarding.js';
import { checkConfigExists } from '../src/config/index.js';

const reconfigure = process.argv.includes('--reconfigure') || checkConfigExists();
await runOnboarding(reconfigure);
console.log('');
console.log('✓ Configuration saved.');
console.log('  Start the bot:   claude-threads-install.sh install');
console.log('  Dashboard:       http://127.0.0.1:7777 (once the bot is running)');
process.exit(0);
