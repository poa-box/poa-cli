import type { Argv } from 'yargs';
import { requestHandler } from './request';
import { approveHandler } from './approve';
import { cancelHandler } from './cancel';
import { requestsHandler } from './requests';
import { balanceHandler } from './balance';

export function registerTokenCommands(yargs: Argv) {
  return yargs
    .command('request', 'Request participation tokens (members only; minted on approval)', requestHandler.builder, requestHandler.handler)
    .command('approve', 'Approve a token request — MINTS the requested PT to the requester', approveHandler.builder, approveHandler.handler)
    .command('cancel', 'Cancel a pending token request (requester or approver)', cancelHandler.builder, cancelHandler.handler)
    .command('requests', 'List token requests', requestsHandler.builder, requestsHandler.handler)
    .command('balance', 'Check participation token balance', balanceHandler.builder, balanceHandler.handler)
    .demandCommand(1, 'Please specify a token action');
}
