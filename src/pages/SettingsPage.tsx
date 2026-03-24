import { useEffect, useState } from 'react'

export function SettingsPage() {
  const [localSourceUrl, setLocalSourceUrl] = useState('')
  const [isConfiguringSource, setIsConfiguringSource] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  
  // Games folder settings
  const [gamesFolder, setGamesFolder] = useState<string | null>(null)
  const [isChangingFolder, setIsChangingFolder] = useState(false)
  
  // Uninstall modal
  const [showUninstallModal, setShowUninstallModal] = useState(false)
  const [isUninstalling, setIsUninstalling] = useState(false)

  useEffect(() => {
    void (async () => {
      const cached = await window.launcher.storeCachedGet()
      if (cached) {
        setLocalSourceUrl(cached.pageUrl)
        setUpdatedAt(cached.updatedAt)
      }
      
      // Load settings
      const settings = await window.launcher.settingsGet()
      setGamesFolder(settings.gamesFolderPath || null)
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
  
  const handleSelectGamesFolder = async () => {
    setIsChangingFolder(true)
    try {
      const selected = await window.launcher.settingsSelectGamesFolder()
      if (selected) {
        await window.launcher.settingsSetGamesFolder(selected)
        setGamesFolder(selected)
        alert('Dossier de stockage mis à jour ! Les jeux existants ont été migrés.')
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Erreur lors de la sélection du dossier')
    } finally {
      setIsChangingFolder(false)
    }
  }
  
  const handleResetGamesFolder = async () => {
    if (!confirm('Réinitialiser le dossier de stockage à l\'emplacement par défaut ?')) return
    setIsChangingFolder(true)
    try {
      await window.launcher.settingsSetGamesFolder(null)
      setGamesFolder(null)
      alert('Dossier de stockage réinitialisé !')
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Erreur lors de la réinitialisation')
    } finally {
      setIsChangingFolder(false)
    }
  }
  
  const handleUninstall = async () => {
    setIsUninstalling(true)
    try {
      await window.launcher.appUninstall()
      alert('GameScraper a été complètement désinstallé. L\'application va se fermer.')
      window.close()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Erreur lors de la désinstallation')
      setIsUninstalling(false)
      setShowUninstallModal(false)
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-8 text-3xl font-bold text-white">Paramètres</h1>
      
      <div className="space-y-6">
        {/* Source Configuration */}
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
        
        {/* Games Folder Configuration */}
        <section className="rounded-2xl bg-steam-panel border border-steam-border p-6">
          <h2 className="text-xl font-bold text-white mb-4">Dossier de Stockage des Jeux</h2>
          <p className="text-sm text-steam-muted mb-6">
            Choisissez l'emplacement où vos jeux seront téléchargés et installés.
          </p>
          
          <div className="space-y-4">
            <div className="rounded-xl bg-black/40 border border-steam-border px-4 py-3">
              <p className="text-xs text-steam-muted mb-1">Emplacement actuel</p>
              <p className="text-white font-mono text-sm break-all">
                {gamesFolder || 'Par défaut (dossier utilisateur)'}
              </p>
            </div>
            
            <div className="flex flex-col sm:flex-row gap-3">
              <button
                onClick={handleSelectGamesFolder}
                disabled={isChangingFolder}
                className="flex-1 rounded-xl bg-steam-accent px-6 py-3 text-steam-bg font-bold hover:brightness-110 disabled:opacity-50 transition-all"
              >
                {isChangingFolder ? 'Changement...' : 'Choisir un dossier'}
              </button>
              {gamesFolder && (
                <button
                  onClick={handleResetGamesFolder}
                  disabled={isChangingFolder}
                  className="rounded-xl bg-steam-border/50 px-6 py-3 text-white font-bold hover:bg-steam-border disabled:opacity-50 transition-all"
                >
                  Réinitialiser
                </button>
              )}
            </div>
          </div>
        </section>
        
        {/* Uninstall Section */}
        <section className="rounded-2xl bg-red-900/20 border border-red-500/30 p-6">
          <h2 className="text-xl font-bold text-red-400 mb-4">Zone de Danger</h2>
          <p className="text-sm text-steam-muted mb-6">
            Ces actions sont irréversibles. Utilisez-les avec précaution.
          </p>
          
          <button
            onClick={() => setShowUninstallModal(true)}
            className="w-full rounded-xl bg-red-600/80 px-6 py-3 text-white font-bold hover:bg-red-600 transition-all"
          >
            Désinstaller GameScraper complètement
          </button>
        </section>

        <section className="rounded-2xl bg-steam-panel border border-steam-border p-6">
          <h2 className="text-xl font-bold text-white mb-4">À propos</h2>
          <div className="space-y-2 text-sm text-steam-muted">
            <p>GameScraper Version 1.0.0</p>
            <p>Une application pour centraliser et gérer votre bibliothèque de jeux.</p>
          </div>
        </section>
      </div>
      
      {/* Uninstall Confirmation Modal */}
      {showUninstallModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-md rounded-2xl bg-steam-panel border border-red-500/50 p-6">
            <h3 className="text-xl font-bold text-red-400 mb-4">Confirmer la désinstallation</h3>
            <p className="text-steam-muted mb-4">
              Cette action va :
            </p>
            <ul className="list-disc list-inside text-steam-muted mb-6 space-y-1">
              <li>Supprimer tous les jeux installés</li>
              <li>Supprimer votre bibliothèque</li>
              <li>Supprimer tous les paramètres</li>
              <li>Fermer l'application</li>
            </ul>
            <p className="text-white font-bold mb-6">
              Cette action est irréversible. Êtes-vous sûr ?
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowUninstallModal(false)}
                disabled={isUninstalling}
                className="flex-1 rounded-xl bg-steam-border/50 px-4 py-3 text-white font-bold hover:bg-steam-border disabled:opacity-50 transition-all"
              >
                Annuler
              </button>
              <button
                onClick={handleUninstall}
                disabled={isUninstalling}
                className="flex-1 rounded-xl bg-red-600 px-4 py-3 text-white font-bold hover:bg-red-700 disabled:opacity-50 transition-all"
              >
                {isUninstalling ? 'Désinstallation...' : 'Confirmer'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
