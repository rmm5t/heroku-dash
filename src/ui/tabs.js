// Registry order defines the displayed tab order and numeric shortcuts.
export const TAB_DEFINITIONS = [
  {
    name: 'Overview', icon: 'overview', requiredSections: ['app', 'formation', 'addons'], browserPath: 'activity',
    columns: [
      {label: 'Item / Process', min: 14, weight: 1, max: 24},
      {label: 'Size / Value', min: 10, weight: 3},
      {label: 'Qty', width: 4, right: true},
      {label: 'Status/Action', width: 13},
    ],
  },
  {
    name: 'Resources', icon: 'resources', requiredSections: ['app', 'formation', 'dynos'], resourceKind: 'dynos', browserPath: 'resources',
    columns: [
      {label: 'Process / Dyno', min: 14, weight: 1, max: 26},
      {label: 'Size', min: 12, weight: 4},
      {label: 'Qty', width: 4, right: true},
      {label: 'State / Action', width: 14},
      {label: 'Age', width: 9, hideBelow: 72},
    ],
  },
  {
    name: 'Add-ons', icon: 'addons', requiredSections: ['app', 'addons', 'attachments'], resourceKind: 'addons', browserPath: 'resources',
    columns: [
      {label: 'Add-on', min: 16, weight: 2},
      {label: 'Service', min: 14, weight: 1, hideBelow: 78},
      {label: 'Plan', min: 12, weight: 1},
      {label: 'State', width: 19},
    ],
  },
  {name: 'Config', icon: 'config', requiredSections: [], browserPath: 'settings'},
  {
    name: 'Settings', icon: 'settings', requiredSections: ['app', 'domains', 'buildpacks'], browserPath: 'settings',
    columns: [
      {label: 'Setting / Type', width: 14},
      {label: 'Value', min: 16, weight: 4},
      {label: 'Status / Action', width: 22},
    ],
  },
  {
    name: 'Releases', icon: 'releases', requiredSections: ['app', 'releases'], browserPath: 'activity',
    columns: [
      {label: 'Version', width: 7},
      {label: 'Status', width: 10},
      {label: 'Age', width: 8, hideBelow: 72},
      {label: 'User', min: 16, weight: 1, max: 36},
      {label: 'Description', min: 12, weight: 2},
    ],
  },
  {
    name: 'Metrics', icon: 'metrics', requiredSections: ['app', 'formation', 'dynos'], browserPath: 'metrics',
    columns: [
      {label: 'Metric / Process', compact: 'Metric', min: 14, weight: 3},
      {label: 'Scope / Limit', compact: 'Scope/Limit', min: 11, weight: 1, max: 18},
      {label: 'Latest', min: 11, weight: 1, max: 18, right: true},
      {label: 'Trend / State', compact: 'Trend/State', min: 26, weight: 4, max: 48},
    ],
  },
]

export const TABS = TAB_DEFINITIONS.map(tab => tab.name)

export function tabDefinition(name) { return TAB_DEFINITIONS.find(tab => tab.name === name) }

export function pendingSections(tab, data) {
  return (tabDefinition(tab)?.requiredSections ?? []).filter(section => data.pending?.includes(section))
}
