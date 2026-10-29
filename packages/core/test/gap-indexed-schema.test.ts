import { describe, expect, it } from 'vitest';
import { buildSchema, parse, validate } from 'graphql';
import * as documents from '../src/graph/documents/indexed-completeness';

// Projection of pre-existing observed serving introspection, 2026-10-09.
// Source SHA256 9a89a35abeb10d86741ffcb688cc1fce44678f46164deeced92d88164862cfb5.
// Field/argument types and defaults preserved; unused fields and enum values omitted.
// Offline compatibility only, not deployed population or current availability.
const schema = buildSchema(`scalar BigInt

input Block_height {
  hash: Bytes
  number: Int
  number_gte: Int
}

scalar Bytes

type EducationHubContract {
  id: Bytes!
  organization: Organization!
}

input EducationHubContract_filter {
  organization: String
}

type EducationModule {
  id: String!
}

type EligibilityModuleContract {
  id: Bytes!
}

type ExecutorContract {
  id: Bytes!
}

type MembershipAuthorityContract {
  id: Bytes!
  acceptedMembershipCount: Int!
  isRouterBound: Boolean!
  cutoverAt: BigInt
}

type ModuleCompletion {
  id: String!
  educationHub: EducationHubContract!
  module: EducationModule!
  moduleId: BigInt!
  learner: Bytes!
  completedAt: BigInt!
  completedAtBlock: BigInt!
  transactionHash: Bytes!
}

input ModuleCompletion_filter {
  id_gt: String
  educationHub: String
  educationHub_: EducationHubContract_filter
}

enum ModuleCompletion_orderBy {
  id
}

"""Defines the order direction, either ascending or descending"""
enum OrderDirection {
  asc
}

type Organization {
  id: Bytes!
  executorContract: ExecutorContract
  eligibilityModule: EligibilityModuleContract
  membershipAuthority: MembershipAuthorityContract
}

type ParticipationTokenContract {
  id: Bytes!
  organization: Organization!
  totalSupply: BigInt!
}

type Query {
  organization(
    id: ID!
    """
    The block at which the query should be executed. Can either be a \`{ hash: Bytes }\` value containing a block hash, a \`{ number: Int }\` containing the block number, or a \`{ number_gte: Int }\` containing the minimum block number. In the case of \`number_gte\`, the query will be executed on the latest block only if the subgraph has progressed to or past the minimum block number. Defaults to the latest block when omitted.
    """
    block: Block_height
  ): Organization
  participationTokenContract(
    id: ID!
    """
    The block at which the query should be executed. Can either be a \`{ hash: Bytes }\` value containing a block hash, a \`{ number: Int }\` containing the block number, or a \`{ number_gte: Int }\` containing the minimum block number. In the case of \`number_gte\`, the query will be executed on the latest block only if the subgraph has progressed to or past the minimum block number. Defaults to the latest block when omitted.
    """
    block: Block_height
  ): ParticipationTokenContract
  tokenBalances(
    first: Int = 100
    orderBy: TokenBalance_orderBy
    orderDirection: OrderDirection
    where: TokenBalance_filter
    """
    The block at which the query should be executed. Can either be a \`{ hash: Bytes }\` value containing a block hash, a \`{ number: Int }\` containing the block number, or a \`{ number_gte: Int }\` containing the minimum block number. In the case of \`number_gte\`, the query will be executed on the latest block only if the subgraph has progressed to or past the minimum block number. Defaults to the latest block when omitted.
    """
    block: Block_height
  ): [TokenBalance!]!
  educationHubContract(
    id: ID!
    """
    The block at which the query should be executed. Can either be a \`{ hash: Bytes }\` value containing a block hash, a \`{ number: Int }\` containing the block number, or a \`{ number_gte: Int }\` containing the minimum block number. In the case of \`number_gte\`, the query will be executed on the latest block only if the subgraph has progressed to or past the minimum block number. Defaults to the latest block when omitted.
    """
    block: Block_height
  ): EducationHubContract
  moduleCompletions(
    first: Int = 100
    orderBy: ModuleCompletion_orderBy
    orderDirection: OrderDirection
    where: ModuleCompletion_filter
    """
    The block at which the query should be executed. Can either be a \`{ hash: Bytes }\` value containing a block hash, a \`{ number: Int }\` containing the block number, or a \`{ number_gte: Int }\` containing the minimum block number. In the case of \`number_gte\`, the query will be executed on the latest block only if the subgraph has progressed to or past the minimum block number. Defaults to the latest block when omitted.
    """
    block: Block_height
  ): [ModuleCompletion!]!
  subjectMemberships(
    first: Int = 100
    orderBy: SubjectMembership_orderBy
    orderDirection: OrderDirection
    where: SubjectMembership_filter
    """
    The block at which the query should be executed. Can either be a \`{ hash: Bytes }\` value containing a block hash, a \`{ number: Int }\` containing the block number, or a \`{ number_gte: Int }\` containing the minimum block number. In the case of \`number_gte\`, the query will be executed on the latest block only if the subgraph has progressed to or past the minimum block number. Defaults to the latest block when omitted.
    """
    block: Block_height
  ): [SubjectMembership!]!
  """Access to subgraph metadata"""
  _meta(block: Block_height): _Meta_
}

enum RuleKind {
  None
  Grant
  Ban
}

type Subject {
  id: String!
  authority: MembershipAuthorityContract!
  organization: Organization!
  subjectId: BigInt!
  kind: SubjectKind!
  defaultAllow: Boolean!
  vouchConfig: SubjectVouchConfig
}

enum SubjectKind {
  Role
  Group
}

type SubjectMembership {
  id: String!
  subject: Subject!
  authority: MembershipAuthorityContract!
  organization: Organization!
  user: Bytes!
  accepted: Boolean!
  ruleKind: RuleKind!
  emailVerified: Boolean!
  vouchCount: Int!
  vouchEpoch: BigInt!
}

input SubjectMembership_filter {
  id_gt: String
  authority: String
  organization: String
}

enum SubjectMembership_orderBy {
  id
}

type SubjectVouchConfig {
  quorum: Int!
  epoch: BigInt!
}

type TokenBalance {
  id: String!
  participationToken: ParticipationTokenContract!
  account: Bytes!
  balance: BigInt!
  updatedAtBlock: BigInt!
}

input TokenBalance_filter {
  id_gt: String
  participationToken: String
}

enum TokenBalance_orderBy {
  id
}

type _Block_ {
  """The hash of the block"""
  hash: Bytes
  """The block number"""
  number: Int!
  """Integer representation of the timestamp stored in blocks for the chain"""
  timestamp: Int
}

"""The type for the top-level _meta field"""
type _Meta_ {
  """
  Information about a specific subgraph block. The hash of the block
  will be null if the _meta field has a block constraint that asks for
  a block number. It will be filled if the _meta field has no block constraint
  and therefore asks for the latest  block
  """
  block: _Block_!
  """The deployment ID"""
  deployment: String!
  """If \`true\`, the subgraph encountered indexing errors at some past block"""
  hasIndexingErrors: Boolean!
}`);

describe('indexed totals observed POP serving-schema compatibility', () => {
  for (const [name, document] of Object.entries(documents)) if (!name.includes('CASHOUT')) {
    it(name, () => expect(validate(schema, parse(document)).map(error => error.message)).toEqual([]));
  }
});
