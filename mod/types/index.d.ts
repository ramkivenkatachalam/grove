export type FeatureState = 'working' | 'waiting' | 'ready' | 'offline'

export type Pr = {
  number: number
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  ci: 'pass' | 'fail' | 'running' | 'none'
  isDraft: boolean
  review: string
  findings: number
  url: string
}

export type Feature = {
  name: string
  state: FeatureState
  message: string
  ports: Record<string, number>
  updatedAt: number
  pr: Pr | null
}

declare module 'claude-code' {
  interface PluginState {
    'feature-hub': { features: Feature[]; self: string | null; isHidden: boolean }
  }
}
