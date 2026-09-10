/** Keep configuration checks separate from Para's lazily loaded SDK. */
export const PARA_AUTH_ENABLED = Boolean(process.env.NEXT_PUBLIC_PARA_API_KEY)
