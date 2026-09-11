'use client'

import { useState } from 'react'
import Image from 'next/image'
import './operator-profile.css'

export type OperatorProfileProps = {
  name?: string | null
  introduction?: string | null
  photoUrl?: string | null
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
export function OperatorProfile({ name, introduction, photoUrl, showHeading = true }: OperatorProfileProps) {
  const [failedPhoto, setFailedPhoto] = useState<string | null>(null)
  const displayName = name?.trim()
  const bio = introduction?.trim()
  const photo = imageSource(photoUrl)
  if (!displayName && !bio && (!photo || photo === failedPhoto)) return null
  return <section className="operator-profile" aria-label="Operator introduction">
    {showHeading && <h2>Operator</h2>}
    <div className={`operator-profile-body${photo && photo !== failedPhoto ? ' has-photo' : ''}`}>
      {photo && photo !== failedPhoto && <Image unoptimized src={photo} alt={displayName ? `${displayName}, operator` : 'Project operator'} width={128} height={128} className="operator-profile-photo" onError={() => setFailedPhoto(photo)} />}
      <div className="operator-profile-copy">
        {displayName && <p className="operator-profile-name">{displayName}</p>}
        {bio && <p className="operator-profile-introduction">{bio}</p>}
      </div>
    </div>
  </section>
}
