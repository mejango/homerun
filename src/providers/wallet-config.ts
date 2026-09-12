/** Keep configuration checks separate from Para's lazily loaded SDK. */
const paraKey = process.env.NEXT_PUBLIC_PARA_API_KEY?.trim() ?? ''
export const PARA_AUTH_ENABLED = paraKey.length > 0 && paraKey.toLowerCase() !== 'placeholder'
