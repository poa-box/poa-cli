import type { Argv } from 'yargs';
import { statusHandler } from './status';
import { depositHandler } from './deposit';
import { registerHandler } from './register';

export function registerPaymasterCommands(yargs: Argv) {
  return yargs
    .command('status', 'View paymaster registration, balance, budgets, and solidarity state', statusHandler.builder, statusHandler.handler)
    .command('deposit', 'Fund an org\'s gas sponsorship balance (permissionless; no withdraw on the deployed hub)', depositHandler.builder, depositHandler.handler)
    .command('register', 'Register an org with the PaymasterHub (sends via PoaManager owner, or prints the exact registrar call)', registerHandler.builder, registerHandler.handler)
    .demandCommand(1, 'Please specify a paymaster action: status, deposit, or register')
    .epilogue('Guide: see docs/guides/gas-sponsorship.md');
}
