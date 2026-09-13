'use client'

import { useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { getAddress, isAddress, zeroAddress } from 'viem'
import { environmentForChainIds } from '@/lib/chains'
import './operator-profile.css'

export type OperatorProfileProps = {
  role?: 'Owner' | 'Operator'
  name?: string | null
  introduction?: string | null
  photoUrl?: string | null
  /** Undefined omits the address row; null shows that no address is specified. */
  address?: string | null
  addressLabel?: string
  chainId?: number
  /** The review step already supplies its own section heading. */
  showHeading?: boolean
}

function imageSource(value?: string | null): string | null {
  if (!value || /[\u0000-\u001f\u007f\\]/.test(value)) return null
  if (value.startsWith('/') && !value.startsWith('//')) return value
  if (value.length <= 1_500_000 && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return value
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? value : null
  } catch { return null }
}

/** A public introduction, independent of the addresses that hold project permissions. */
export function OperatorProfile({ role = 'Operator', name, introduction, photoUrl, address, addressLabel = 'Address', chainId, showHeading = true }: OperatorProfileProps) {
  const [failedPhoto, setFailedPhoto] = useState<string | null>(null)
  const displayName = name?.trim()
  const bio = introduction?.trim()
  const photo = imageSource(photoUrl)
  const wallet = address?.trim()
  const account = wallet && isAddress(wallet, { strict: false }) && wallet.toLowerCase() !== zeroAddress ? getAddress(wallet) : null
  const networkQuery = chainId && environmentForChainIds([chainId]) === 'testnet' ? '?network=testnet' : ''
  if (!displayName && !bio && (!photo || photo === failedPhoto) && address === undefined) return null
  return <section className="operator-profile" aria-label={`${role} introduction`}>
    {showHeading && <h2>{role}</h2>}
    <div className={`operator-profile-body${photo && photo !== failedPhoto ? ' has-photo' : ''}`}>
      {photo && photo !== failedPhoto && <Image unoptimized src={photo} alt={displayName ? `${displayName}, ${role.toLowerCase()}` : `Project ${role.toLowerCase()}`} width={128} height={128} className="operator-profile-photo" onError={() => setFailedPhoto(photo)} />}
      <div className="operator-profile-copy">
        {displayName && <p className="operator-profile-name">{displayName}</p>}
        {address !== undefined && <p className="operator-profile-address">{account ? <><span>{addressLabel}</span><Link href={`/account/${account}${networkQuery}`}>{account}</Link></> : <span>Address not specified</span>}</p>}
        {bio && <p className="operator-profile-introduction">{bio}</p>}
      </div>
    </div>
  </section>
}
