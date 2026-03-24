import { useEffect, useState } from 'react'

export function SettingsPage() {
  const [localSourceUrl, setLocalSourceUrl] = useState('')
  const [isConfiguringSource, setIsConfiguringSource] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      const cached = await window.launcher.storeCachedGet()
      if (cached) {
        setLocalSourceUrl(cached.pageUrl)
        setUpdatedAt(cached.updatedAt)
      }
    })()
  }, [])

  const handleSaveSource = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!localSourceUrl.trim()) return
    
    setIsConfiguringSource(true)
    try {
      await window.launcher.storeScrape(localSourceUrl)
      setUpdatedAt(new Date().toISOString())
      alert('Source mise à jour avec succès !')
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Erreur lors de la configuration')
    } finally {
      setIsConfiguringSource(false)
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-8 text-3xl font-bold text-white">Paramètres</h1>
      
      <div className="space-y-6">
        <section className="rounded-2xl bg-steam-panel border border-steam-border p-6">
          <h2 className="text-xl font-bold text-white mb-4">Configuration de la Source</h2>
          <p className="text-sm text-steam-muted mb-6">
            L'URL utilisée pour rechercher et télécharger les jeux dans l'onglet "Source".
          </p>
          <form onSubmit={handleSaveSource} className="flex flex-col sm:flex-row gap-3">
            <input
              type="url"
              value={localSourceUrl}
              onChange={(e) => setLocalSourceUrl(e.target.value)}
              placeholder="https://exemple.com/jeux"
              className="flex-1 rounded-xl bg-black/40 border border-steam-border px-4 py-3 text-white outline-none focus:border-steam-accent"
              required
            />
            <button
              type="submit"
              disabled={isConfiguringSource}
              className="rounded-xl bg-steam-accent px-8 py-3 text-steam-bg font-bold hover:brightness-110 disabled:opacity-50 transition-all"
            >
              {isConfiguringSource ? 'Analyse...' : 'Actualiser la source'}
            </button>
          </form>
          {updatedAt && (
            <p className="mt-3 text-[11px] text-steam-muted">
              Dernière mise à jour : {new Date(updatedAt).toLocaleString('fr-FR')}
            </p>
          )}
        </section>

        <section className="rounded-2xl bg-steam-panel border border-steam-border p-6">
          <h2 className="text-xl font-bold text-white mb-4">À propos</h2>
          <div className="space-y-2 text-sm text-steam-muted">
            <p>GameScraper Version 1.0.0</p>
            <p>Une application pour centraliser et gérer votre bibliothèque de jeux.</p>
          </div>
        </section>
      </div>
    </div>
  )
}
