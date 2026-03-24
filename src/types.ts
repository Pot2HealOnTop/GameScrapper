export type LibraryGame = {
  id: string
  name: string
  /** Page catalogue (liste) */
  storePageUrl: string
  /** Page « fiche jeu » (URL du lien cliqué au magasin) */
  detailPageUrl: string
  coverImageUrl?: string | null
  /** Quand le jeu a été ajouté à la bibliothèque */
  addedToLibraryAt: string | null
  /** Lien Mega / Mediafire / fichier direct utilisé pour l’installation */
  downloadUrl: string | null
  installDir: string
  exePath: string | null
  installedAt: string | null
  playTimeSeconds: number
  lastPlayedAt: string | null
  currentSessionStartedAt: string | null
}

export type StoreItem = {
  id: string
  name: string
  /** Page de détail du jeu (pas le lien de téléchargement direct) */
  detailPageUrl: string
  coverImageUrl: string | null
}

export type DetailScrapeResult = {
  detailPageUrl: string
  title: string
  coverImageUrl: string | null
  description: string | null
  releaseDate?: string | null
  developer?: string | null
  publisher?: string | null
  genres?: string[] | null
  screenshots?: string[] | null
  systemRequirements?: {
    minimum?: string | null
    recommended?: string | null
  } | null
  downloadCandidates: { url: string; label: string }[]
}
