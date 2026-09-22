import { createJBCenterClient, type JBCenterClient } from '@bananapus/nana-sdk-core/jbcenter'
import { jbCenterBaseUrl } from '@/lib/jbcenter-config'

/**
 * The browser's Juicebox Center client for intents, search and sponsored deploys.
 *
 * Approved web clients call Center directly and let the browser send its
 * `Origin`. Never add a Center API key here: a NEXT_PUBLIC key is public, and
 * server keys are for non-browser integrations only.
 */
export const jbCenterClient: JBCenterClient = createJBCenterClient({ baseUrl: jbCenterBaseUrl() })
