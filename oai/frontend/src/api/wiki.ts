import { apiRequest } from './http'

export interface WikiArticle {
  title: string
  description: string | null
  extract: string
  thumbnail: string | null
  url: string
  lang: string
}

export function fetchRandomWikiArticle(token: string, lang = 'en'): Promise<WikiArticle> {
  return apiRequest(`/api/wiki/random?lang=${encodeURIComponent(lang)}`, token)
}
