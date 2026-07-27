import type { Argv } from 'yargs';
import { listHandler } from './list';
import { viewHandler } from './view';
import { activityHandler } from './activity';
import { updateMetadataHandler } from './update-metadata';
import { setMetadataAdminHandler } from './set-metadata-admin';
import { deployHandler } from './deploy';
import { deployConfigHandler } from './deploy-config';
import { statusHandler } from './status';
import { rolesHandler } from './roles';
import { membersHandler } from './members';
import { auditHandler } from './audit';
import { exploreHandler } from './explore';
import { healthScoreHandler } from './health-score';
import { auditExternalHandler } from './audit-external';
import { auditAllHandler } from './audit-all';
import { outreachHandler } from './outreach';
import { auditSnapshotHandler } from './audit-snapshot';
import { auditSafeHandler } from './audit-safe';
import { auditFullHandler } from './audit-full';
import { auditGovernorHandler } from './audit-governor';
import { gaasStatusHandler } from './gaas-status';
import { publishHandler } from './publish';
import { leaderboardHandler } from './leaderboard';
import { auditRequestHandler } from './audit-request';
import { portfolioHandler } from './portfolio';
import { shareHandler } from './share';
import { publicationsHandler } from './publications';
import { compareHandler } from './compare';
import { compareTimeWindowHandler } from './compare-time-window';
import { probeAccessHandler } from './probe-access';
import { auditVetokenHandler } from './audit-vetoken';
import { auditParticipationHandler } from './audit-participation';

export function registerOrgCommands(yargs: Argv) {
  return yargs
    .command('list', 'List organizations', listHandler.builder, listHandler.handler)
    .command('view', 'View organization details', viewHandler.builder, viewHandler.handler)
    .command('status', 'Quick org health summary', statusHandler.builder, statusHandler.handler)
    .command('activity', 'Recent org activity (agent heartbeat)', activityHandler.builder, activityHandler.handler)
    .command('update-metadata', 'Update organization metadata', updateMetadataHandler.builder, updateMetadataHandler.handler)
    .command('set-metadata-admin', 'Propose changing the org metadata-admin hat (governance vote)', setMetadataAdminHandler.builder, setMetadataAdminHandler.handler)
    .command('deploy', 'Deploy a new organization', deployHandler.builder, deployHandler.handler)
    .command('deploy-config', 'Generate a deploy config file', deployConfigHandler.builder, deployConfigHandler.handler)
    .command('roles', 'List org roles with hat IDs and vouch requirements', rolesHandler.builder, rolesHandler.handler)
    .command('members', 'List org members with activity metrics', membersHandler.builder, membersHandler.handler)
    .command('audit', 'Generate governance transparency audit', auditHandler.builder, auditHandler.handler)
    .command('explore', 'Scan all POP orgs across chains', exploreHandler.builder, exploreHandler.handler)
    .command('health-score', 'Compute org health score (0-100)', healthScoreHandler.builder, healthScoreHandler.handler)
    .command('audit-external', 'Generate governance audit for any POP org', auditExternalHandler.builder, auditExternalHandler.handler)
    .command('audit-all', 'Ecosystem health report — audit all POP orgs', auditAllHandler.builder, auditAllHandler.handler)
    .command('outreach', 'Generate engagement message for a target org', outreachHandler.builder, outreachHandler.handler)
    .command('audit-snapshot', 'Audit governance for any Snapshot DAO', auditSnapshotHandler.builder, auditSnapshotHandler.handler)
    .command('audit-safe', 'Audit treasury for any Safe multisig', auditSafeHandler.builder, auditSafeHandler.handler)
    .command('audit-full', 'Combined governance + treasury audit for any DAO', auditFullHandler.builder, auditFullHandler.handler)
    .command('audit-governor', 'Audit on-chain Governor DAO governance', auditGovernorHandler.builder, auditGovernorHandler.handler)
    .command('gaas-status', 'GaaS pipeline dashboard — audits, distribution, revenue', gaasStatusHandler.builder, gaasStatusHandler.handler)
    .command('publish', 'Convert IPFS content to shareable HTML page with Open Graph tags', publishHandler.builder, publishHandler.handler)
    .command('leaderboard', 'Governance health leaderboard — rank multiple DAOs', leaderboardHandler.builder, leaderboardHandler.handler)
    .command('audit-request', 'Generate a governance audit request with pricing', auditRequestHandler.builder, auditRequestHandler.handler)
    .command('portfolio', 'Generate shareable HTML audit portfolio page', portfolioHandler.builder, portfolioHandler.handler)
    .command('share', 'Generate platform-ready posts from IPFS content', shareHandler.builder, shareHandler.handler)
    .command('publications', 'Index all shareable IPFS content from completed tasks', publicationsHandler.builder, publicationsHandler.handler)
    .command('compare', 'Head-to-head governance comparison of two Snapshot DAOs', compareHandler.builder, compareHandler.handler)
    .command('compare-time-window', 'Re-audit a stored AUDIT_DB entry and report drift (codifies the asymmetric-drift research finding)', compareTimeWindowHandler.builder, compareTimeWindowHandler.handler)
    .command('probe-access', 'Burner-callStatic access-control probe — map a contract\'s gating model in <5 min, zero gas', probeAccessHandler.builder, probeAccessHandler.handler)
    .command('audit-vetoken', 'On-chain top-holder probe for veCRV-family VotingEscrow contracts (task #383)', auditVetokenHandler.builder, auditVetokenHandler.handler)
    .command('audit-participation', 'Governance participation metrics for external Governor contracts (task #422)', auditParticipationHandler.builder, auditParticipationHandler.handler)
    .demandCommand(1, 'Please specify an org action')
    .epilogue('Guide: see docs/guides/org-admin.md');
}
