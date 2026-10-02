export function dynoSizeLabel(size) {
  const specs = [size.name]
  if (Number.isFinite(size.memory)) specs.push(`${size.memory} GB RAM`)
  if (Number.isFinite(size.compute)) {
    const sharing = size.dedicated === true ? ' (dedicated)' : size.dedicated === false ? ' (shared)' : ''
    specs.push(`${size.compute} vCPU${size.compute === 1 ? '' : 's'}${sharing}`)
  }
  return specs.join(' · ')
}
