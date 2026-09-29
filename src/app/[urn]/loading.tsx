import { ProjectPageShell } from '@/components/ProjectPage'
import { Skeleton, SkeletonLines } from '@/components/ui/Skeleton'

/** Between pages: the project layout's shapes, never a spinner or a sentence. */
export default function ProjectLoading() {
  return <ProjectPageShell>
    <div className="homerun-project-layout" aria-busy="true">
      <span className="sr-only" role="status">Loading project</span>
      <div className="mx-auto grid max-w-[1220px] gap-8 px-5 pt-7 sm:px-8">
        <div className="flex items-center gap-6">
          <Skeleton className="h-36 w-36 rounded-md" />
          <div className="grid gap-3"><Skeleton className="h-10 w-80 max-w-full" /><Skeleton className="h-4 w-40" /><Skeleton className="h-3 w-72 max-w-full" /></div>
        </div>
        <div className="grid gap-10 md:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
          <div className="grid gap-6"><Skeleton className="h-40 w-full rounded-md" /><SkeletonLines lines={5} /></div>
          <div className="grid gap-6"><Skeleton className="h-8 w-72" /><SkeletonLines lines={4} /><Skeleton className="aspect-video w-full rounded-md" /></div>
        </div>
      </div>
    </div>
  </ProjectPageShell>
}
