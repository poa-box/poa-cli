/**
 * Role Application Queries
 * Ported from frontend queries.js
 */

export const FETCH_USER_ROLE_APPLICATIONS = `
  query FetchUserRoleApplications($eligibilityModuleId: Bytes!, $applicant: Bytes!) {
    roleApplications(
      where: { eligibilityModule: $eligibilityModuleId, applicant: $applicant, active: true }
      first: 50
    ) {
      id
      hatId
      applicant
      applicantUsername
      applicationHash
      active
      appliedAt
    }
  }
`;

export const FETCH_ALL_ROLE_APPLICATIONS = `
  query FetchAllRoleApplications($eligibilityModuleId: Bytes!) {
    roleApplications(
      where: { eligibilityModule: $eligibilityModuleId, active: true }
      orderBy: appliedAt
      orderDirection: desc
      first: 200
    ) {
      id
      hatId
      applicant
      applicantUsername
      applicationHash
      active
      appliedAt
    }
  }
`;
