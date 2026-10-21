import type { Argv } from 'yargs';
import { donateHandler } from './donate';
import { prefundHandler } from './prefund';
import { statusHandler } from './status';
import { depositHandler } from './deposit';
import { registerHandler } from './register';

export function registerPaymasterCommands(yargs: Argv) {
  return yargs
    .command('donate', 'Donate native tokens to the global solidarity fund', donateHandler.builder, donateHandler.handler)
    .command('prefund', 'Calculate exact v0.7 prefund from the final estimated operation', prefundHandler.builder, prefundHandler.handler)
    .command('status', 'View paymaster registration, balance, budgets, and solidarity state', statusHandler.builder, statusHandler.handler)
    .command('deposit', 'Fund an org\'s gas sponsorship balance (permissionless; no withdraw on the deployed hub)', depositHandler.builder, depositHandler.handler)
    .command('register', 'Register an org with the PaymasterHub (sends via PoaManager owner, or prints the exact registrar call)', registerHandler.builder, registerHandler.handler)
    .demandCommand(1, 'Please specify a paymaster action: status, deposit, or register')
    .epilogue('Guide: see docs/guides/gas-sponsorship.md');
}
