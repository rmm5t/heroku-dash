const money = value => Number.isFinite(value) ? new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD'}).format(value) : 'Unavailable'
const ram = value => Number.isFinite(value) ? `${value >= 1024 ? value / 1024 : value} ${value >= 1024 ? 'GB' : 'MB'}` : 'Unavailable'
const field = (name, value) => `${name.padEnd(17)} ${value ?? 'Unavailable'}`

function unavailable(resources, kind) {
  if (!resources?.provider?.available) return resources?.provider?.message ?? 'Install heroku-resources and restart dash to show costs and limits.'
  if (resources.errors?.[kind]) return `Costs / limits unavailable: ${resources.errors[kind]}`
  if (!resources.data?.[kind]) return 'Loading costs and limits from heroku-resources…'
  return null
}

export function dynoDetails(resources, kind, name) {
  const note = unavailable(resources, 'dynos')
  if (note) return `\n\nCOST & ALLOCATION\n${note}`
  const item = resources.data.dynos[kind]?.[name]
  if (!item) return '\n\nCOST & ALLOCATION\nNo matching dyno specification available.'
  const process = kind === 'formations'
  const price = item.ecoPlan ? 'Shared $5/month account plan (not per dyno)'
    : Number.isFinite(item.monthlyCost) ? `${money(item.monthlyCost)}/month${process ? ' for this process' : ' per dyno (full-month rate)'}` : 'Unavailable'
  return `\n\nCOST & ALLOCATION\n${[
    field('RAM / dyno', ram(item.ramPerDynoMb)),
    ...(process ? [field('Allocated RAM', ram(item.allocatedRamMb))] : []),
    field('CPU / dyno', item.cpuPerDyno),
    ...(process ? [field('CPU allocation', item.cpu)] : []),
    field('Estimated cost', price),
    ...(process && !item.ecoPlan && Number.isFinite(item.unitMonthlyCost) ? [field('Size rate', `${money(item.unitMonthlyCost)}/dyno/month`)] : []),
    field('Source', `heroku-resources ${resources.provider.version ?? ''}`),
  ].join('\n')}\n\nAllocations are size limits, not live usage.\nCosts are USD full-month estimates; actual billing is prorated.`
}

export function addonDetails(resources, id) {
  const note = unavailable(resources, 'addons')
  if (note) return `\n\nCOST & LIMITS\n${note}`
  const item = resources.data.addons.byId[id]
  if (!item || item.error) return `\n\nCOST & LIMITS\n${item?.error ?? 'No matching add-on information available.'}`
  const cost = item.contract ? 'Contract pricing (amount unknown)' : item.metered ? 'Metered / usage-based pricing'
    : Number.isFinite(item.costCents) && item.costUnit ? `${money(item.costCents / 100)}/${item.costUnit}` : 'Unavailable'
  return `\n\nCOST & LIMITS\n${[
    field('Billed cost', cost),
    field('Billing app', item.billingApp),
    field('Billed plan', item.plan),
    field('Active plan', item.activePlan),
    field('Provider status', item.providerStatus),
    field('Connection limit', item.maxConnections),
    field('RAM limit', item.ram),
    field('Disk capacity', item.diskSize),
    field('Source', `heroku-resources ${resources.provider.version ?? ''}`),
  ].join('\n')}${item.shared ? '\n\nShared attachment: the add-on is billed to its owning app.' : ''}${item.planChangePending ? '\n\nPlan change pending: limits describe the active plan; cost reflects the billed plan.' : ''}\n\nLimits are capacity, not current usage. Prices are USD; unavailable limits are not zero.`
}
