import type { CreateValues } from '../../src/components/CreateFlow'
import { buildFundProjectMetadata } from '../../src/lib/fund-project-metadata'
import { CREATE_DEFAULTS } from '../../web/create-model.mjs'

export const FULL_SETUP_OWNER = '0x1111111111111111111111111111111111111111'
export const FULL_SETUP_OPERATOR = '0x3333333333333333333333333333333333333333'

/** Every text a creator types, each string distinct, so a page that drops one is caught by name. */
export const FULL_SETUP_TEXT = {
  name: 'Neighborhood Workshop',
  fundTokenName: 'Workshop Bench FUND',
  fundTicker: 'WKSHP',
  location: 'Florianópolis, Brazil',
  description: 'Shared tools that earn revenue through community use.',
  revenueDescription: 'Members pay monthly for bench time, and visitors pay by the hour.',
  minimumRevenueConsequences: 'The Owner cuts machine hours and reports the shortfall to holders.',
  ownerName: 'Ada Rios',
  ownerIntroduction: 'She keeps the workshop running.',
  operatorName: 'Bruno Lima',
  operatorIntroduction: 'He maintains the machines and the books.',
} as const

/** A setup the create form accepts, with none of its optional text left blank. */
export const FULL_SETUP = {
  ...CREATE_DEFAULTS,
  ...FULL_SETUP_TEXT,
  minimumRevenue: 7_500,
  purchaseBudget: 250_000,
  opsReserve: 50_000,
  monthlyRent: 10_000,
  monthlyCosts: 6_000,
  rentGrowthPercent: 3,
  costGrowthPercent: 2,
  ownerMode: 'existing',
  ownerWallet: FULL_SETUP_OWNER,
  ownerIsOperator: false,
  operatorMode: 'existing',
  operatorWallet: FULL_SETUP_OPERATOR,
  networks: ['base'],
  networkEnvironment: 'production',
  photo: '',
  ownerPhoto: '',
  operatorPhoto: '',
} as unknown as CreateValues

/** The pin a publication of that setup writes, as a published page reads it back. */
export const FULL_SETUP_PIN = buildFundProjectMetadata(FULL_SETUP) as Record<string, unknown>
