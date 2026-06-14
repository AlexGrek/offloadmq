import { apiRequest } from './http'

export interface GeneratedName {
  slug: string
  phrase: string
}

export interface RandomNamesResponse {
  names: GeneratedName[]
}

export function fetchRandomNames(token: string, count = 6): Promise<RandomNamesResponse> {
  return apiRequest(`/api/names/random?count=${count}`, token)
}
