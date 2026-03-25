import { FormEvent, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { StoreItem } from '../types'

export function StorePage() {
  const [localItems, setLocalItems] = useState<StoreItem[]>([])
  const [localSearch, setLocalSearch] = useState('')
  const [localSourceUrl, setLocalSourceUrl] = useState('')
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [isConfiguringSource, setIsConfiguringSource] = useState(false)
  
  // Pagination mode
  const [isPaginatedMode, setIsPaginatedMode] = useState(false)
  const [pageCount, setPageCount] = useState(3)
  const [progressPhase, setProgressPhase] = useState<string>('')
  const [progressCurrent, setProgressCurrent] = useState(0)
  const [progressTotal, setProgressTotal] = useState(0)

  useEffect(() => {
    void (async () => {
      try {
        const cached = await window.launcher.storeCachedGet()
        if (cached) {
          setLocalSourceUrl(cached.pageUrl)
          // Cast items to ensure they have the new fields
          setLocalItems((cached.items || []) as StoreItem[])
          setUpdatedAt(cached.updatedAt)
        }
      } finally {
        setLoading(false)
      }
    })()
    
    // Subscribe to progress updates
    const unsub = window.launcher.onStoreProgress((p) => {
      if (p.phase === 'fetch') {
        setProgressPhase('Récupération des pages...')
      } else if (p.phase === 'parse') {
        setProgressPhase(`Analyse... ${(p as any).count || 0} jeux trouvés`)
      } else if (p.phase === 'covers') {
        setProgressPhase('Enrichissement avec Steam...')
        setProgressCurrent((p as any).current || 0)
        setProgressTotal((p as any).total || 0)
      } else if (p.phase === 'save') {
        setProgressPhase('Sauvegarde...')
      } else if (p.phase === 'done') {
        setProgressPhase('')
        setProgressCurrent(0)
        setProgressTotal(0)
      }
    })
    
    return () => unsub()
  }, [])

  const filteredLocalItems = useMemo(() => {
    const q = localSearch.trim().toLowerCase()
    if (!q) return localItems
    return localItems.filter((it) => it.name.toLowerCase().includes(q))
  }, [localItems, localSearch])

  const handleSaveSource = async (e: FormEvent) => {
    e.preventDefault()
    if (!localSourceUrl.trim()) return

    setIsConfiguringSource(true)
    try {
      let res
      if (isPaginatedMode) {
        res = await window.launcher.storeScrapePaginated(localSourceUrl, pageCount)
      } else {
        res = await window.launcher.storeScrape(localSourceUrl)
      }
      setLocalItems(res.items)
      setUpdatedAt(new Date().toISOString())
      alert(`Source locale mise à jour avec succès ! ${res.items.length} jeux trouvés.`)
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Erreur lors de la configuration')
    } finally {
      setIsConfiguringSource(false)
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-steam-accent animate-pulse text-xl font-bold">Chargement de la source...</div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-6xl pb-20">
      <div className="mb-10">
        <h1 className="text-4xl font-extrabold text-white tracking-tight">Source</h1>
        <p className="text-steam-muted mt-1">Gérez votre source locale de téléchargement</p>
      </div>

      <div className="mb-10 rounded-2xl bg-steam-panel border border-steam-border p-6">
        <h3 className="text-lg font-bold text-white mb-4">Configuration de la source</h3>
        
        {/* Mode toggle */}
        <div className="flex gap-4 mb-4">
          <button
            type="button"
            onClick={() => setIsPaginatedMode(false)}
            className={`px-4 py-2 rounded-lg font-medium transition-all ${
              !isPaginatedMode 
                ? 'bg-steam-accent text-steam-bg' 
                : 'bg-black/40 text-steam-muted hover:text-white'
            }`}
          >
            Page unique
          </button>
          <button
            type="button"
            onClick={() => setIsPaginatedMode(true)}
            className={`px-4 py-2 rounded-lg font-medium transition-all ${
              isPaginatedMode 
                ? 'bg-steam-accent text-steam-bg' 
                : 'bg-black/40 text-steam-muted hover:text-white'
            }`}
          >
            Multi-pages (Steam)
          </button>
        </div>
        
        {isPaginatedMode && (
          <div className="mb-4 p-4 rounded-xl bg-blue-900/20 border border-blue-500/30">
            <p className="text-sm text-blue-300 mb-2">
              Mode pagination avec enrichissement Steam
            </p>
            <p className="text-xs text-steam-muted mb-2">
              Collez l'URL d'une page quelconque (ex: ?lcp_page1=3). Le système détectera automatiquement 
              le numéro de page et scrapera toutes les pages de 1 à N.
            </p>
            <p className="text-xs text-steam-muted">
              Les images et métadonnées seront récupérées automatiquement depuis Steam.
            </p>
          </div>
        )}
        
        <form onSubmit={handleSaveSource} className="space-y-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <input
              type="url"
              value={localSourceUrl}
              onChange={(e) => setLocalSourceUrl(e.target.value)}
              placeholder={isPaginatedMode ? "https://site.com/jeux/?lcp_page1=3#anchor" : "https://exemple.com/jeux"}
              className="flex-1 rounded-xl bg-black/40 border border-steam-border px-4 py-3 text-white outline-none focus:border-steam-accent"
              required
            />
            {isPaginatedMode && (
              <div className="flex items-center gap-2 sm:w-auto">
                <label className="text-sm text-steam-muted whitespace-nowrap">Pages:</label>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={pageCount}
                  onChange={(e) => setPageCount(Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))}
                  className="w-20 rounded-xl bg-black/40 border border-steam-border px-3 py-3 text-white outline-none focus:border-steam-accent"
                />
              </div>
            )}
            <button
              type="submit"
              disabled={isConfiguringSource}
              className="rounded-xl bg-steam-accent px-8 py-3 text-steam-bg font-bold hover:brightness-110 disabled:opacity-50 transition-all"
            >
              {isConfiguringSource ? 'Analyse...' : 'Actualiser la source'}
            </button>
          </div>
          
          {/* Progress bar */}
          {isConfiguringSource && progressPhase && (
            <div className="space-y-2">
              <div className="flex justify-between text-xs text-steam-muted">
                <span>{progressPhase}</span>
                {progressTotal > 0 && (
                  <span>{progressCurrent} / {progressTotal}</span>
                )}
              </div>
              {progressTotal > 0 && (
                <div className="h-2 rounded-full bg-black/40 overflow-hidden">
                  <div 
                    className="h-full bg-steam-accent transition-all duration-300"
                    style={{ width: `${Math.round((progressCurrent / progressTotal) * 100)}%` }}
                  />
                </div>
              )}
            </div>
          )}
        </form>
        {updatedAt && (
          <p className="mt-3 text-[11px] text-steam-muted">
            Dernière mise à jour : {new Date(updatedAt).toLocaleString('fr-FR')}
          </p>
        )}
      </div>

      <div className="mb-8">
        <div className="relative w-full max-w-md">
          <input
            type="text"
            value={localSearch}
            onChange={(e) => setLocalSearch(e.target.value)}
            placeholder="Rechercher dans ma source..."
            className="w-full rounded-xl bg-steam-panel border border-steam-border px-5 py-3 text-white outline-none focus:border-steam-accent transition-all pl-12"
          />
          <svg
            className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-steam-muted"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
      </div>

      {filteredLocalItems.length > 0 ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {filteredLocalItems.map((item) => (
            <Link
              key={item.id}
              to={`/game/${item.id}`}
              state={{ storeItem: item, pageUrl: localSourceUrl }}
              className="group relative flex flex-col overflow-hidden rounded-lg border border-white/5 bg-black/20 transition-all hover:border-steam-accent/50 hover:bg-black/40"
            >
              <div className="aspect-[3/4] overflow-hidden bg-black/40">
                {item.coverImageUrl ? (
                  <img
                    src={item.coverImageUrl}
                    alt={item.name}
                    className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                    loading="lazy"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center p-4 text-center">
                    <span className="text-[10px] font-medium uppercase tracking-wider text-steam-muted">{item.name}</span>
                  </div>
                )}
              </div>
              <div className="p-2.5">
                <h3
                  className="truncate text-xs font-bold text-white group-hover:text-steam-accent"
                  title={item.name}
                >
                  {item.name}
                </h3>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="py-20 text-center border border-dashed border-steam-border rounded-2xl">
          <p className="text-steam-muted">Aucun jeu trouvé dans votre source locale.</p>
        </div>
      )}
    </div>
  )
}
