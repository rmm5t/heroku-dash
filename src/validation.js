const DYNO_QUANTITY_ERROR = 'Dyno quantity must be a non-negative integer.'

export function validateConfigKey(key, message = 'Config keys must start with a letter or underscore and contain only letters, digits, and underscores.') {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) throw new Error(message)
}

export function validateDynoQuantity(quantity, message = DYNO_QUANTITY_ERROR) {
  if (!Number.isSafeInteger(quantity) || quantity < 0) throw new Error(message)
}

export function parseDynoQuantity(value, message = DYNO_QUANTITY_ERROR) {
  // Prompt input accepts decimal digits only; the API requires a number.
  if (!/^\d+$/.test(value)) throw new Error(message)
  const quantity = Number(value)
  validateDynoQuantity(quantity, message)
  return quantity
}

export function validateDynoSize(size, message = 'Enter a dyno size, such as Standard-1X.') {
  if (!size?.trim()) throw new Error(message)
}
