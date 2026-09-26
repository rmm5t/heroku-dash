import {errorMessage} from './api.js'

// Resource ownership is independent of the sidebar's team filter. Couplings
// often contain only a pipeline ID/name, so enrich them from the catalog first.
export async function resolveHierarchy(api, catalog, {app = null, pipeline = null}) {
  const known = pipeline && catalog.pipelines.find(item => item.id === pipeline.id)
  const result = {
    pipeline: pipeline ? {...known, ...pipeline} : null,
    team: {name: 'Personal'},
    errors: {},
  }
  try {
    if (result.pipeline && !app?.team && !Object.hasOwn(result.pipeline, 'owner')) {
      result.pipeline = await api.get(`/pipelines/${encodeURIComponent(result.pipeline.id)}`)
    }
    const owner = result.pipeline?.owner
    const team = app?.team ?? (owner?.type === 'team' ? {id: owner.id, name: owner.name} : null)
    if (team) {
      const cached = catalog.teams.find(item => item.id === team.id || (team.name && item.name === team.name))
      result.team = team.name ? team : cached ?? await api.get(`/teams/${encodeURIComponent(team.id)}`)
    }
  } catch (error) {
    result.team = {name: 'Team unavailable'}
    result.errors.hierarchy = errorMessage(error)
  }
  return result
}
