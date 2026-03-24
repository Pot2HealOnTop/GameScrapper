import { FormEvent, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

interface SteamGame {
  id: number
  name: string
  header_image: string
}

export function DashboardPage() {
  const [featured, setFeatured] = useState<SteamGame[]>([])
  const [topSellers, setTopSellers] = useState<SteamGame[]>([])
  const [newReleases, setNewReleases] = useState<SteamGame[]>([])
  const [specials, setSpecials] = useState<SteamGame[]>([])
  const [comingSoon, setComingSoon] = useState<SteamGame[]>([])
  const [loading, setLoading] = useState(true)
  const [localNames, setLocalNames] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState<SteamGame[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    void (async () => {
      try {
        const [data, cached] = await Promise.all([
          window.launcher.storeFetchDashboard(),
          window.launcher.storeCachedGet(),
        ])
        const names = (cached?.items || []).map((i) => i.name).filter(Boolean)
        setLocalNames(names)

        if (data.featured?.length) setFeatured(data.featured)
        if (data.topSellers?.length) setTopSellers(data.topSellers)
        if (data.newReleases?.length) setNewReleases(data.newReleases)
        if (data.specials?.length) setSpecials(data.specials)
        if (data.comingSoon?.length) setComingSoon(data.comingSoon)
      } catch (e) {
        console.error('Erreur chargement dashboard', e)
        setFeatured([])
        setTopSellers([])
        setNewReleases([])
        setSpecials([])
        setComingSoon([])
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const normalizedLocalSet = useMemo(() => {
    const clean = (name: string) =>
      name
        .replace(/[®™]/g, '')
        .replace(/\(.*?\)/g, '')
        .replace(/\[.*?\]/g, '')
        .replace(/(download|free|gratuit|pc game|full version|direct link).*/gi, '')
        .split(':')[0]
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
    return new Set(localNames.map(clean).filter((s) => s.length >= 2))
  }, [localNames])

  const matchesLocal = (steamName: string) => {
    if (normalizedLocalSet.size === 0) return false
    const key = steamName
      .replace(/[®™]/g, '')
      .split(':')[0]
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
    return normalizedLocalSet.has(key)
  }

  const filteredFeatured = useMemo(() => featured.filter((g) => matchesLocal(g.name)), [featured, normalizedLocalSet])
  const filteredTopSellers = useMemo(() => topSellers.filter((g) => matchesLocal(g.name)), [topSellers, normalizedLocalSet])
  const filteredNewReleases = useMemo(() => newReleases.filter((g) => matchesLocal(g.name)), [newReleases, normalizedLocalSet])
  const filteredSpecials = useMemo(() => specials.filter((g) => matchesLocal(g.name)), [specials, normalizedLocalSet])
  const filteredComingSoon = useMemo(() => comingSoon.filter((g) => matchesLocal(g.name)), [comingSoon, normalizedLocalSet])

  const handleGameClick = (game: SteamGame) => {
    const tempId = `steam-${game.id}`
    navigate(`/game/${tempId}`, { 
      state: { 
        searchMode: true, 
        appId: game.id,
        gameName: game.name,
        coverImageUrl: game.header_image
      } 
    })
  }

  const handleSearch = async (e: FormEvent) => {
    e.preventDefault()
    if (!search.trim()) {
      setSearchResults([])
      return
    }
    setIsSearching(true)
    try {
      const results = await window.launcher.storeSearchSteam(search)
      const filtered = results.filter((g) => matchesLocal(g.name))
      setSearchResults(filtered)
    } catch (e) {
      console.error('Erreur recherche Steam', e)
      setSearchResults([])
    } finally {
      setIsSearching(false)
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-steam-accent animate-pulse text-xl font-bold">Chargement du magasin...</div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-10 pb-20">
      <header className="mb-6">
        <h1 className="text-4xl font-extrabold text-white mb-2 tracking-tight">Magasin</h1>
        <p className="text-steam-muted">Affiche uniquement les jeux disponibles dans votre Source</p>
      </header>

      <section className="rounded-2xl bg-steam-panel border border-steam-border p-6">
        <form onSubmit={handleSearch} className="relative w-full max-w-2xl">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher un jeu (Steam) disponible dans ma Source..."
            className="w-full rounded-xl bg-black/40 border border-steam-border px-6 py-4 text-white outline-none focus:border-steam-accent focus:ring-1 focus:ring-steam-accent transition-all pl-14"
          />
          <svg className="absolute left-5 top-1/2 -translate-y-1/2 w-6 h-6 text-steam-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          {isSearching && (
            <div className="absolute right-5 top-1/2 -translate-y-1/2">
              <div className="w-5 h-5 border-2 border-steam-accent border-t-transparent rounded-full animate-spin"></div>
            </div>
          )}
        </form>

        {search.trim() && (
          <div className="mt-6">
            {searchResults.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
                {searchResults.map((game) => (
                  <button
                    key={game.id}
                    onClick={() => handleGameClick(game)}
                    className="text-left group rounded-xl overflow-hidden bg-black/20 border border-white/10 hover:border-steam-accent transition-all duration-300 hover:-translate-y-1"
                  >
                    <div className="aspect-[460/215] w-full overflow-hidden">
                      <img src={game.header_image} alt={game.name} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                    </div>
                    <div className="p-4">
                      <h3 className="text-sm font-bold text-white truncate group-hover:text-steam-accent transition-colors">{game.name}</h3>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              !isSearching && <p className="text-steam-muted italic">Aucun résultat disponible dans votre Source.</p>
            )}
          </div>
        )}
      </section>

      {normalizedLocalSet.size === 0 && (
        <div className="rounded-2xl border border-dashed border-steam-border bg-black/20 p-10 text-center">
          <p className="text-steam-muted">Aucune Source configurée : le Magasin ne peut pas filtrer les jeux.</p>
        </div>
      )}

      {filteredFeatured.length > 0 && (
        <section>
          <h2 className="text-2xl font-bold text-white mb-6 flex items-center gap-3">
            <span className="text-steam-accent">⭐</span> À la une
          </h2>
          <div className="flex gap-6 overflow-x-auto pb-2">
            {filteredFeatured.map((game) => (
              <button
                key={game.id}
                onClick={() => handleGameClick(game)}
                className="text-left group relative w-[520px] flex-none rounded-xl overflow-hidden bg-steam-panel border border-steam-border hover:border-steam-accent transition-all duration-300 hover:shadow-[0_0_30px_rgba(139,92,246,0.3)] hover:-translate-y-1 block"
              >
                <div className="aspect-[460/215] w-full overflow-hidden">
                  <img
                    src={game.header_image}
                    alt={game.name}
                    className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                    loading="lazy"
                  />
                </div>
                <div className="p-4 bg-gradient-to-t from-steam-panel to-transparent absolute bottom-0 w-full">
                  <h3 className="text-lg font-bold text-white mb-1 group-hover:text-steam-accent transition-colors">
                    {game.name}
                  </h3>
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="text-2xl font-bold text-white mb-6 flex items-center gap-3">
          <span className="text-steam-accent">🔥</span> Meilleures ventes
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {filteredTopSellers.map((game) => (
            <button key={game.id} onClick={() => handleGameClick(game)} className="text-left group relative rounded-xl overflow-hidden bg-steam-panel border border-steam-border hover:border-steam-accent transition-all duration-300 hover:shadow-[0_0_30px_rgba(139,92,246,0.3)] hover:-translate-y-1 block">
              <div className="aspect-[460/215] w-full overflow-hidden">
                <img src={game.header_image} alt={game.name} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" />
              </div>
              <div className="p-4 bg-gradient-to-t from-steam-panel to-transparent absolute bottom-0 w-full">
                <h3 className="text-lg font-bold text-white mb-1 group-hover:text-steam-accent transition-colors">{game.name}</h3>
              </div>
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-2xl font-bold text-white mb-6 flex items-center gap-3">
          <span className="text-steam-accent">✨</span> Nouveautés
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {filteredNewReleases.map((game) => (
            <button key={game.id} onClick={() => handleGameClick(game)} className="text-left group relative rounded-xl overflow-hidden bg-steam-panel border border-steam-border hover:border-steam-accent transition-all duration-300 hover:shadow-[0_0_30px_rgba(139,92,246,0.3)] hover:-translate-y-1 block">
              <div className="aspect-[460/215] w-full overflow-hidden">
                <img src={game.header_image} alt={game.name} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" />
              </div>
              <div className="p-4 bg-gradient-to-t from-steam-panel to-transparent absolute bottom-0 w-full">
                <h3 className="text-lg font-bold text-white mb-1 group-hover:text-steam-accent transition-colors">{game.name}</h3>
              </div>
            </button>
          ))}
        </div>
      </section>

      {filteredSpecials.length > 0 && (
        <section>
          <h2 className="text-2xl font-bold text-white mb-6 flex items-center gap-3">
            <span className="text-steam-accent">💫</span> À ne pas manquer
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {filteredSpecials.map((game) => (
              <button key={game.id} onClick={() => handleGameClick(game)} className="text-left group relative rounded-xl overflow-hidden bg-steam-panel border border-steam-border hover:border-steam-accent transition-all duration-300 hover:shadow-[0_0_30px_rgba(139,92,246,0.3)] hover:-translate-y-1 block">
                <div className="aspect-[460/215] w-full overflow-hidden">
                  <img src={game.header_image} alt={game.name} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" loading="lazy" />
                </div>
                <div className="p-4 bg-gradient-to-t from-steam-panel to-transparent absolute bottom-0 w-full">
                  <h3 className="text-lg font-bold text-white mb-1 group-hover:text-steam-accent transition-colors">{game.name}</h3>
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      {filteredComingSoon.length > 0 && (
        <section>
          <h2 className="text-2xl font-bold text-white mb-6 flex items-center gap-3">
            <span className="text-steam-accent">🕒</span> Prochainement
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {filteredComingSoon.map((game) => (
              <button key={game.id} onClick={() => handleGameClick(game)} className="text-left group relative rounded-xl overflow-hidden bg-steam-panel border border-steam-border hover:border-steam-accent transition-all duration-300 hover:shadow-[0_0_30px_rgba(139,92,246,0.3)] hover:-translate-y-1 block">
                <div className="aspect-[460/215] w-full overflow-hidden">
                  <img src={game.header_image} alt={game.name} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" loading="lazy" />
                </div>
                <div className="p-4 bg-gradient-to-t from-steam-panel to-transparent absolute bottom-0 w-full">
                  <h3 className="text-lg font-bold text-white mb-1 group-hover:text-steam-accent transition-colors">{game.name}</h3>
                </div>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
